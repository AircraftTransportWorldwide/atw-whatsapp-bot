// ATW WhatsApp Bot v10.32 — server.js
// Clean entry point — routes and orchestration only
// All logic lives in /services and /utils

import express from 'express';
import twilio from 'twilio';

// ── Utils ──
import {
  redis,
  getMem, setMem,
  getTakeover, setTakeover, delTakeover,
  isDuplicate, isRateLimited,
  isBotMessage, markBotMessage,
  isChatwootDuplicate
} from './utils/redis.js';
import { sanitizeInput, generateRefNumber, bestName } from './utils/helpers.js';

// ── Services ──
import { callClaude, detectLanguage, extractFields, detectLiveAgentRequest, classifyTier, buildSystemPrompt } from './services/claude.js';
import { findOrCreateContact, getInquiryHistory, createTwentyInquiry, updateTwentyInquiry } from './services/twenty.js';
import { createMondayItem, updateMondayItem, enrichRecords } from './services/monday.js';
import { sendChatwootMessage, findOrCreateChatwootContact, findOrCreateChatwootConversation, postChatwootProfileNote, forwardAttachmentToChatwoot } from './services/chatwoot.js';
import { sendEmailAlert } from './services/email.js';
import { sendMorningBriefing } from './services/morning.js';

const app          = express();
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const FROM_NUMBER  = process.env.TWILIO_WHATSAPP_NUMBER;

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ── Constants ──
const MEMORY_LIMIT    = 10;
const TAKEOVER_RESUME = 2 * 60 * 60 * 1000;
const INACTIVITY_MS   = 5 * 60 * 1000;
const ATW_PHONE       = '+1 (305) 456-8400';
const SLA_AOG_MS      = 15 * 60 * 1000; // 15 minutes

// ── Test/novelty message detection ──
const TEST_PATTERNS = /^\s*(test|testing|prueba|probando|teste|testando|hola|hello|hi|hey|oi|ola|ping|check|checking)\s*[!?.]*\s*$/i;

// ── Qualified inquiry check ──
function isQualifiedInquiry(effectiveTier, fields, messageCount) {
  if (effectiveTier > 2) return false;
  let signals = 0;
  if (fields?.origin)      signals++;
  if (fields?.destination) signals++;
  if (fields?.commodity)   signals++;
  if (fields?.weightDims)  signals++;
  if (messageCount >= 3)   signals++;
  return signals >= 2;
}

// ── Confirmation summary — all fields collected? ──
function hasAllFields(fields) {
  return !!(fields?.origin && fields?.destination && fields?.commodity && fields?.weightDims);
}

function buildConfirmationMessage(fields, refNumber, lang) {
  const origin      = fields.origin.toUpperCase();
  const destination = fields.destination.toUpperCase();
  const commodity   = fields.commodity;
  const weight      = fields.weightDims;
  const ref         = refNumber || '---';
  const msgs = {
    en: `Just to confirm your inquiry (${ref}): ${commodity} from ${origin} to ${destination}, ${weight}. Is that correct? Our team will be in touch shortly.`,
    es: `Solo para confirmar su consulta (${ref}): ${commodity} de ${origin} a ${destination}, ${weight}. ¿Es correcto? Nuestro equipo estará en contacto en breve.`,
    pt: `Só para confirmar sua consulta (${ref}): ${commodity} de ${origin} para ${destination}, ${weight}. Está correto? Nossa equipe entrará em contato em breve.`
  };
  return msgs[lang] || msgs.en;
}

async function sendWhatsApp(to, body) {
  const msg = await twilioClient.messages.create({ from: FROM_NUMBER, to, body });
  await markBotMessage(msg.sid);
  console.log(`[Twilio] Sent to ${to}: ${msg.sid}`);
  return msg.sid;
}

function getAttachmentAck(lang) {
  return {
    es: 'Recibi tu archivo. Lo paso a nuestro equipo ahora.',
    pt: 'Recebi seu arquivo. Vou encaminha-lo para nossa equipe agora.',
    en: 'Got your file. Let me pass that along to our team.'
  }[lang] || 'Got your file. Let me pass that along to our team.';
}

// ── Time-ago helper ──
function timeAgo(ms) {
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// ── Is it 8am Miami time? ──
function isMorningBriefingTime() {
  const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false });
  return now.startsWith('08:0'); // fires between 08:00 and 08:09
}

// ─── Background scanners ───────────────────────────────────────────────────────
let morningBriefingSentToday = null;

setInterval(async () => {
  try {
    const keys = await redis.keys('mem:whatsapp:*');
    const allInquiries = [];

    for (const key of keys) {
      try {
        const raw = await redis.get(key);
        if (!raw) continue;
        const mem = JSON.parse(raw);
        const phone = key.replace('mem:', '');

        // ── Idle email scanner ──
        if (!mem.emailSent && mem.highestTier && mem.highestTier < 3 &&
            mem.lastMessageAt && Date.now() - mem.lastMessageAt >= INACTIVITY_MS &&
            mem.messages?.length && mem.inquiryQualified) {
          console.log(`[Idle] Conversation idle for ${phone} — sending email`);
          const fields = await extractFields(mem.messages);
          await sendEmailAlert(mem.highestTier, phone, mem.messages, mem.refNumber, fields);
          mem.emailSent = true;
          await redis.set(key, JSON.stringify(mem), { KEEPTTL: true });
        }

        // ── SLA breach scanner — AOG only ──
        if (mem.highestTier === 1 && mem.inquiryQualified && !mem.slaAlertSent) {
          const aogAge = Date.now() - (mem.aogCreatedAt || mem.lastMessageAt);
          if (aogAge >= SLA_AOG_MS) {
            // Check if an agent has taken over
            const chatwootConvId = mem.chatwootConvId;
            const takeover = chatwootConvId ? await getTakeover(chatwootConvId) : null;
            if (!takeover?.active) {
              console.log(`[SLA] AOG breach — no agent response in 15min for ${phone}`);
              // Send urgent SLA breach email
              await sendEmailAlert(1, phone, mem.messages, mem.refNumber, {
                origin: mem.lastFields?.origin,
                destination: mem.lastFields?.destination,
                commodity: mem.lastFields?.commodity,
                weightDims: mem.lastFields?.weightDims
              }, false, true); // true = sla breach
              mem.slaAlertSent = true;
              await redis.set(key, JSON.stringify(mem), { KEEPTTL: true });
            }
          }
        }

        // ── Collect for morning briefing ──
        if (mem.inquiryQualified && mem.highestTier < 3 && mem.lastMessageAt &&
            Date.now() - mem.lastMessageAt < 24 * 60 * 60 * 1000) {
          allInquiries.push({
            phone: phone.replace('whatsapp:', ''),
            tier: mem.highestTier,
            refNumber: mem.refNumber,
            language: mem.language,
            company: mem.lastFields?.companyName,
            contactName: mem.customerName || mem.profileName,
            origin: mem.lastFields?.origin,
            destination: mem.lastFields?.destination,
            commodity: mem.lastFields?.commodity,
            timeAgo: timeAgo(mem.lastMessageAt)
          });
        }

      } catch (err) { console.error('[Scanner] Error processing key:', err.message); }
    }

    // ── Morning briefing — fires once at 8am Miami ──
    const today = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York' });
    if (isMorningBriefingTime() && morningBriefingSentToday !== today && allInquiries.length > 0) {
      morningBriefingSentToday = today;
      console.log(`[Morning] Sending briefing with ${allInquiries.length} inquiries`);
      await sendMorningBriefing(allInquiries);
    }

  } catch (err) { console.error('[Scanner] Error:', err.message); }
}, 60 * 1000);

// ─── Inbound WhatsApp webhook ──────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.set('Content-Type', 'text/xml');
  res.send('<Response></Response>');

  // Twilio signature validation
  const twilioSig  = req.headers['x-twilio-signature'];
  const webhookUrl = `${process.env.WEBHOOK_BASE_URL || 'https://atw-whatsapp-bot-production.up.railway.app'}/webhook`;
  const isValid    = twilio.validateRequest(process.env.TWILIO_AUTH_TOKEN, twilioSig, webhookUrl, req.body);
  if (!isValid) { console.warn('[Security] Invalid Twilio signature — request rejected'); return; }

  const { From: from, Body: body, MessageSid: sid, MediaUrl0: mediaUrl, MediaContentType0: mediaType, NumMedia: numMedia, ProfileName: profileName } = req.body;
  if (!from || !sid) return;
  if (await isDuplicate(sid)) { console.log(`[Dedup] Skipped ${sid}`); return; }

  const text = sanitizeInput(body);
  console.log(`[Inbound] ${from}: ${text}`);
  if (await isRateLimited(from)) { console.log(`[RateLimit] Blocked ${from}`); return; }

  const now = Date.now();
  let mem = await getMem(from);
  const isFirstMessage = !mem || mem.messages.length === 0;
  if (!mem) mem = {
    messages: [], customerName: null, profileName: null,
    twentyContactId: null, twentyInquiryId: null, inquiryCreated: false,
    emailSent: false, mondayItemId: null,
    language: 'en', highestTier: 3,
    refNumber: null, refSentToCustomer: false,
    lastMessageAt: null, liveAgentRequested: false, disclaimerSent: false,
    inquiryQualified: false, isTestConversation: false,
    confirmationSent: false, aogCreatedAt: null, slaAlertSent: false,
    chatwootConvId: null, lastFields: {}
  };

  if (profileName?.trim()) mem.profileName = profileName.trim();
  mem.lastMessageAt = now;

  if (isFirstMessage) {
    mem.mondayItemId = null; mem.twentyInquiryId = null; mem.inquiryCreated = false;
    mem.emailSent = false; mem.refNumber = null; mem.refSentToCustomer = false;
    mem.highestTier = 3; mem.liveAgentRequested = false; mem.disclaimerSent = false;
    mem.inquiryQualified = false; mem.isTestConversation = false;
    mem.confirmationSent = false; mem.aogCreatedAt = null; mem.slaAlertSent = false;
    mem.lastFields = {};

    if (text && TEST_PATTERNS.test(text)) {
      mem.isTestConversation = true;
      console.log(`[Test] Novelty/test opener detected from ${from} — CRM/email deferred`);
    }
  }

  // ── Twenty contact + history ──
  let twentyContact = null, inquiryHistory = [];
  try {
    twentyContact = await findOrCreateContact(from, mem.profileName || null);
    if (twentyContact) {
      mem.twentyContactId = twentyContact.id;
      if (twentyContact.name && !mem.customerName) mem.customerName = twentyContact.name;
      inquiryHistory = await getInquiryHistory(twentyContact.id);
      if (inquiryHistory.length > 0) {
        const langMap = { EN: 'en', ES: 'es', PT: 'pt' };
        if (!mem.language || mem.language === 'en') mem.language = langMap[inquiryHistory[0].language] || 'en';
        if (isFirstMessage) console.log(`[Twenty] Returning customer with ${inquiryHistory.length} past inquiries`);
      }
    }
  } catch (err) { console.error('[Twenty] Contact lookup failed:', err.message); }

  // ── Chatwoot setup ──
  const chatwootContactId = await findOrCreateChatwootContact(from, mem.customerName || mem.profileName || from.replace('whatsapp:', ''));
  let chatwootConvId = null;
  if (chatwootContactId) chatwootConvId = await findOrCreateChatwootConversation(chatwootContactId);
  if (chatwootConvId) mem.chatwootConvId = chatwootConvId;
  if (isFirstMessage && twentyContact && chatwootConvId) {
    postChatwootProfileNote(chatwootConvId, twentyContact, from, inquiryHistory).catch(err => console.error('[Twenty] Profile note failed:', err.message));
  }

  // ── Attachments before takeover ──
  const hasMedia = parseInt(numMedia || '0') > 0;
  if (hasMedia && chatwootConvId) {
    await forwardAttachmentToChatwoot(chatwootConvId, mediaUrl, mediaType, text);
    const tc = await getTakeover(chatwootConvId);
    if (tc?.active) {
      if (now - tc.lastAgentMessage <= TAKEOVER_RESUME) return;
      await delTakeover(chatwootConvId);
      console.log(`[Takeover] Auto-resumed for conv ${chatwootConvId}`);
    }
    const recentText = mem.messages.filter(m => m.role === 'user').slice(-3).map(m => m.content).join(' ') || text || 'hello';
    mem.language = await detectLanguage(recentText);
    await setMem(from, mem);
    await sendWhatsApp(from, getAttachmentAck(mem.language));
    return;
  }

  // ── Takeover check ──
  if (chatwootConvId) {
    const ts = await getTakeover(chatwootConvId);
    if (ts?.active) {
      if (now - ts.lastAgentMessage > TAKEOVER_RESUME) { await delTakeover(chatwootConvId); console.log(`[Takeover] Auto-resumed for conv ${chatwootConvId}`); }
      else { await sendChatwootMessage(chatwootConvId, text || '[attachment]', 'incoming'); return; }
    }
  }

  if (!text) return;
  if (chatwootConvId) await sendChatwootMessage(chatwootConvId, text, 'incoming');

  mem.messages.push({ role: 'user', content: text });
  if (mem.messages.length > MEMORY_LIMIT * 2) mem.messages = mem.messages.slice(-MEMORY_LIMIT * 2);
  try { mem.language = await detectLanguage(text); } catch { /* keep existing */ }

  // ── Compliance disclaimer ──
  let pendingDisclaimer = null;
  if (!mem.disclaimerSent) {
    pendingDisclaimer = {
      es: 'ATW es un agente de carga autorizado. Al comunicarse con nosotros, usted acepta que su carga sea inspeccionada de acuerdo con las regulaciones de la TSA y el Departamento de Seguridad Nacional. ATW se reserva el derecho de modificar la ruta o mejorar la clase de reserva para cumplir con su ETA si los arreglos originales son cancelados o modificados, sin penalidades. Para asistencia urgente llame al ' + ATW_PHONE + '. Las respuestas pueden ser monitoreadas por control de calidad y cumplimiento.',
      pt: 'ATW é um despachante aduaneiro licenciado. Ao nos contatar, você consente com a triagem de carga em conformidade com os regulamentos da TSA e do Departamento de Segurança Interna. ATW reserva-se o direito de modificar o roteiro ou atualizar a classe de reserva para cumprir seu ETA se os arranjos originais forem cancelados ou modificados, sem penalidades. Para assistência urgente ligue para ' + ATW_PHONE + '. As respostas podem ser monitoradas para fins de qualidade e conformidade.',
      en: 'ATW is a licensed freight forwarder. By engaging with us, you consent to cargo screening in compliance with TSA and Department of Homeland Security regulations. ATW reserves the right to modify routing or upgrade booking class to meet your ETA if original arrangements are cancelled or modified, without penalties. For urgent assistance call ' + ATW_PHONE + '. Replies may be monitored for quality and compliance.'
    }[mem.language] || 'ATW is a licensed freight forwarder. By engaging with us, you consent to cargo screening in compliance with TSA and Department of Homeland Security regulations. ATW reserves the right to modify routing or upgrade booking class to meet your ETA if original arrangements are cancelled or modified, without penalties. For urgent assistance call ' + ATW_PHONE + '. Replies may be monitored for quality and compliance.';
    mem.disclaimerSent = true;
  }

  // ── Live agent detection ──
  let isLiveAgentRequest = false;
  if (!mem.liveAgentRequested) {
    try { isLiveAgentRequest = await detectLiveAgentRequest(text); } catch { /* skip */ }
  }
  if (isLiveAgentRequest) {
    mem.liveAgentRequested = true;
    console.log(`[LiveAgent] Request detected from ${from}`);
    const liveReply = { es: 'Claro, con gusto te conecto con uno de nuestros especialistas. Un miembro del equipo estara contigo en breve.', pt: 'Claro, vou conecta-lo com um de nossos especialistas. Um membro da equipe estara com voce em breve.', en: 'Of course, let me connect you with one of our team members. A specialist will be with you shortly.' }[mem.language] || 'Of course, let me connect you with one of our team members. A specialist will be with you shortly.';
    await sendWhatsApp(from, liveReply);
    if (chatwootConvId) {
      await sendChatwootMessage(chatwootConvId, liveReply, 'outgoing');
      await sendChatwootMessage(chatwootConvId, `LIVE AGENT REQUESTED\nPhone: ${from.replace('whatsapp:', '')}\nRef: ${mem.refNumber || 'not assigned'}\nLanguage: ${mem.language?.toUpperCase() || 'EN'}\nUse #takeover to take control.`, 'outgoing', true);
    }
    const fields = await extractFields(mem.messages).catch(() => ({}));
    await sendEmailAlert(mem.highestTier || 3, from, mem.messages, mem.refNumber, fields, true);
    mem.messages.push({ role: 'assistant', content: liveReply });
    await setMem(from, mem);
    return;
  }

  // ── Claude response ──
  const systemPrompt = buildSystemPrompt(mem.customerName, inquiryHistory, mem.refNumber);
  let reply;
  try { reply = await callClaude(mem.messages, systemPrompt); }
  catch (err) { console.error('[Claude] Error:', err.message); reply = `I'm having a technical issue. Please call us at ${ATW_PHONE} for immediate assistance.`; }
  if (!reply) return;

  mem.messages.push({ role: 'assistant', content: reply });
  await setMem(from, mem);

  // ── Tier classification ──
  const tier         = await classifyTier(text);
  const prevHighest  = mem.highestTier || 3;
  const isEscalation = tier < prevHighest;
  if (isEscalation) {
    mem.highestTier = tier;
    if (tier === 1 && !mem.aogCreatedAt) mem.aogCreatedAt = now; // start SLA clock
    console.log(`[Tier] Escalation: ${prevHighest} -> ${tier}`);
  } else { console.log(`[Tier] ${tier} for: "${text.slice(0, 60)}"`); }
  const effectiveTier = Math.min(tier, mem.highestTier || 3);

  if (effectiveTier <= 2 && !mem.refNumber) {
    mem.refNumber = generateRefNumber();
    console.log(`[Ref] Generated ${mem.refNumber}`);
  }

  // ── Send reply ──
  if (mem.refNumber && !mem.refSentToCustomer) {
    const langAck = { es: `Tu numero de referencia es ${mem.refNumber}. Guardalo para cualquier seguimiento.`, pt: `Seu numero de referencia e ${mem.refNumber}. Guarde-o para qualquier acompanhamento.`, en: `I've logged your inquiry under reference number ${mem.refNumber}. Please keep this handy for any follow-up.` }[mem.language] || `I've logged your inquiry under reference number ${mem.refNumber}. Please keep this handy for any follow-up.`;
    const refReply = `${reply}\n\n${langAck}`;
    mem.refSentToCustomer = true;
    await sendWhatsApp(from, refReply);
    if (chatwootConvId) await sendChatwootMessage(chatwootConvId, refReply, 'outgoing');
  } else {
    const finalReply = pendingDisclaimer ? `${reply}\n\n${pendingDisclaimer}` : reply;
    await sendWhatsApp(from, finalReply);
    if (chatwootConvId) await sendChatwootMessage(chatwootConvId, finalReply, 'outgoing');
  }
  await setMem(from, mem);

  // ── CRM enrichment — only for qualified inquiries ──
  if (effectiveTier <= 2) {
    let fields = {};
    try { fields = await extractFields(mem.messages); console.log(`[Extract] Fields: ${JSON.stringify(fields)}`); }
    catch (err) { console.error('[Extract] Failed:', err.message); }

    // Store latest fields for morning briefing + SLA scanner
    if (Object.keys(fields).length) mem.lastFields = fields;

    const messageCount = mem.messages.filter(m => m.role === 'user').length;
    const qualified    = isQualifiedInquiry(effectiveTier, fields, messageCount);

    if (qualified && mem.isTestConversation) {
      mem.isTestConversation = false;
      console.log(`[Test] Conversation from ${from} graduated to real inquiry`);
    }

    if (qualified && !mem.inquiryQualified) {
      mem.inquiryQualified = true;
      console.log(`[Qualify] Inquiry from ${from} now qualified — creating CRM/Monday records`);
    }

    if (mem.inquiryQualified) {
      try {
        if (!mem.inquiryCreated && mem.twentyContactId) {
          const inquiryId = await createTwentyInquiry(mem.twentyContactId, from, effectiveTier, mem, fields);
          if (inquiryId) { mem.twentyInquiryId = inquiryId; mem.inquiryCreated = true; await setMem(from, mem); }
        }
        if (!mem.mondayItemId) {
          const itemId = await createMondayItem(from, effectiveTier, mem, fields);
          if (itemId) { mem.mondayItemId = itemId; await setMem(from, mem); }
        } else {
          await enrichRecords(mem, from, fields, isEscalation);
        }
      } catch (err) { console.error('[Enrich] Failed:', err.message); }

      // ── Confirmation summary — send once all fields are collected ──
      if (!mem.confirmationSent && hasAllFields(fields)) {
        const confirmation = buildConfirmationMessage(fields, mem.refNumber, mem.language);
        await sendWhatsApp(from, confirmation);
        if (chatwootConvId) await sendChatwootMessage(chatwootConvId, confirmation, 'outgoing');
        mem.confirmationSent = true;
        console.log(`[Confirm] Summary sent to ${from}`);
      }

    } else {
      console.log(`[Qualify] Not yet qualified (tier:${effectiveTier}, signals: origin:${!!fields?.origin} dest:${!!fields?.destination} commodity:${!!fields?.commodity} msgs:${messageCount}) — CRM/Monday deferred`);
    }

    await setMem(from, mem);
  }
});

// ─── Chatwoot webhook ──────────────────────────────────────────────────────────
app.post('/chatwoot-webhook', async (req, res) => {
  res.sendStatus(200);
  const { event, message_type, content, conversation, private: isPrivate, attachments } = req.body;
  if (isPrivate) return;
  if (event !== 'message_created' || message_type !== 'outgoing') return;
  const convId = conversation?.id;
  const phone  = conversation?.meta?.sender?.identifier || conversation?.meta?.sender?.phone_number;
  if (!phone || !convId) return;
  const to    = phone.startsWith('whatsapp:') ? phone : `whatsapp:${phone}`;
  const text  = (content || '').trim();
  const msgId = req.body?.message?.id?.toString();
  if (await isChatwootDuplicate(convId, text, msgId)) { console.log(`[CW Dedup] Skipped duplicate for conv ${convId}`); return; }

  if (text.toLowerCase() === '#takeover') {
    await setTakeover(convId, { active: true, lastAgentMessage: Date.now() });
    await sendChatwootMessage(convId, 'Bot is now paused. You have full control. Type #done to hand back.', 'outgoing', true);
    console.log(`[Takeover] Agent took over conv ${convId}`);
    return;
  }

  if (text.toLowerCase() === '#done') {
    const mem = await getMem(to);
    if (mem) {
      const transcript = (mem.messages || []).map(m => `${m.role === 'user' ? 'Customer' : 'Patty'}: ${m.content}`).join('\n');
      if (mem.mondayItemId) updateMondayItem(mem.mondayItemId, to, mem, transcript).catch(err => console.error('[Monday] Final update failed:', err.message));
      if (mem.twentyInquiryId) updateTwentyInquiry(mem.twentyInquiryId, { status: 'CLOSED_AGENT', transcript }).catch(err => console.error('[Twenty] #done update failed:', err.message));
      if (!mem.emailSent && mem.highestTier && mem.highestTier < 3 && mem.inquiryQualified) {
        extractFields(mem.messages).then(fields => { sendEmailAlert(mem.highestTier, to, mem.messages, mem.refNumber, fields); mem.emailSent = true; setMem(to, mem); }).catch(err => console.error('[Email] #done email failed:', err.message));
      }
    }
    await delTakeover(convId);
    await sendChatwootMessage(convId, 'Bot has resumed.', 'outgoing', true);
    console.log(`[Takeover] Bot resumed for conv ${convId}`);
    return;
  }

  const ts = await getTakeover(convId);
  if (!ts?.active) return;
  if (msgId && await isBotMessage(msgId)) { console.log(`[Echo] Blocked bot echo for ${msgId}`); return; }
  ts.lastAgentMessage = Date.now();
  await setTakeover(convId, ts);
  if (text) { await sendWhatsApp(to, text); return; }
  if (attachments?.length > 0) {
    for (const att of attachments) {
      if (!att.data_url) continue;
      try { await twilioClient.messages.create({ from: FROM_NUMBER, to, body: att.name || '', mediaUrl: [att.data_url] }); }
      catch (err) { console.error('[Twilio] Attachment failed:', err.message); }
    }
  }
});

// ─── Health check ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.send('ATW WhatsApp Bot v10.32 — online'));

// ─── Start ─────────────────────────────────────────────────────────────────────
await redis.connect();
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[Boot] ATW Bot v10.32 running on port ${PORT}`));
