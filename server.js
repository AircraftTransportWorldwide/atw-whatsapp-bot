// ATW WhatsApp Bot v10.30
// Changes from v10.29:
// - Added compliance guardrail to Patty's prompt: never confirm legality/feasibility of shipments
// - Added opening disclaimer sent at start of every new conversation in customer's language

import express from 'express';
import fetch from 'node-fetch';
import twilio from 'twilio';
import { Resend } from 'resend';
import FormData from 'form-data';
import { createClient } from 'redis';

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const resend = new Resend(process.env.RESEND_API_KEY);

const redis = createClient({ url: process.env.REDIS_URL });
redis.on('error', err => console.error('[Redis] Error:', err));
redis.on('connect', () => console.log('[Redis] Connected'));
await redis.connect();

const MEMORY_TTL       = 24 * 60 * 60;
const TAKEOVER_TTL     = 3 * 60 * 60;
const DEDUP_TTL        = 24 * 60 * 60;
const RATE_TTL         = 10 * 60;
const RATE_MAX         = 15;
const MEMORY_LIMIT     = 10;
const TAKEOVER_RESUME  = 2 * 60 * 60 * 1000;
const INACTIVITY_MS    = 5 * 60 * 1000;
const SCAN_INTERVAL_MS = 60 * 1000;

async function getMem(phone) {
  const raw = await redis.get(`mem:${phone}`);
  return raw ? JSON.parse(raw) : null;
}
async function setMem(phone, data) {
  await redis.set(`mem:${phone}`, JSON.stringify(data), { EX: MEMORY_TTL });
}
async function getTakeover(convId) {
  const raw = await redis.get(`takeover:${convId}`);
  return raw ? JSON.parse(raw) : null;
}
async function setTakeover(convId, data) {
  await redis.set(`takeover:${convId}`, JSON.stringify(data), { EX: TAKEOVER_TTL });
}
async function delTakeover(convId) {
  await redis.del(`takeover:${convId}`);
}
async function isDuplicate(sid) {
  const exists = await redis.get(`dedup:${sid}`);
  if (exists) return true;
  await redis.set(`dedup:${sid}`, '1', { EX: DEDUP_TTL });
  return false;
}
async function isRateLimited(phone) {
  const key = `rate:${phone}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, RATE_TTL);
  return count > RATE_MAX;
}
async function isBotMessage(sid) {
  return !!(await redis.get(`botsent:${sid}`));
}
async function markBotMessage(sid) {
  await redis.set(`botsent:${sid}`, '1', { EX: DEDUP_TTL });
}
async function setTwentyCache(phone, data) {
  await redis.set(`twenty:${phone}`, JSON.stringify(data), { EX: 24 * 60 * 60 });
}
async function isChatwootDuplicate(convId, content, msgId) {
  const key = `cwdedup:${msgId || convId + ':' + content}`;
  const exists = await redis.get(key);
  if (exists) return true;
  await redis.set(key, '1', { EX: 60 });
  return false;
}

const CHATWOOT_URL     = process.env.CHATWOOT_API_URL;
const CHATWOOT_TOKEN   = process.env.CHATWOOT_API_TOKEN;
const CHATWOOT_ACCOUNT = process.env.CHATWOOT_ACCOUNT_ID || '1';
const CHATWOOT_INBOX   = process.env.CHATWOOT_INBOX_ID   || '4';
const TWENTY_API_URL   = process.env.TWENTY_API_URL;
const TWENTY_API_KEY   = process.env.TWENTY_API_KEY;
const FROM_NUMBER      = process.env.TWILIO_WHATSAPP_NUMBER;
const MONDAY_API_KEY   = process.env.MONDAY_API_KEY;
const MONDAY_BOARD_ID  = process.env.MONDAY_BOARD_ID;

const MONDAY_COLS = {
  phone:        'text_mm1dj5cb',
  tier:         'color_mm1dx2x3',
  source:       'text_mm1d77a4',
  reference:    'text_mm1dpm0d',
  language:     'color_mm1dqhvs',
  conversation: 'long_text_mm1d52b4',
  status:       'status',
  date:         'date4'
};

function generateRefNumber() {
  const now  = new Date();
  const yy   = String(now.getFullYear()).slice(2);
  const mm   = String(now.getMonth() + 1).padStart(2, '0');
  const dd   = String(now.getDate()).padStart(2, '0');
  const rand = String(Math.floor(1000 + Math.random() * 9000));
  return `ATW-${yy}${mm}${dd}-${rand}`;
}

async function withRetry(fn, retries = 3, delayMs = 500) {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); }
    catch (err) {
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, delayMs * (i + 1)));
    }
  }
}

function sanitizeInput(text) {
  return (text || '').trim().slice(0, 1000).replace(/<[^>]*>/g, '');
}

async function extractFields(messages) {
  try {
    const transcript = messages.map(m => `${m.role === 'user' ? 'Customer' : 'Patty'}: ${m.content}`).join('\n');
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 300,
        system: `You are a data extraction assistant for a freight forwarder. Extract shipment details from the conversation transcript.
Return ONLY a valid JSON object with these exact keys:
{
  "companyName": string or null,
  "contactName": string or null,
  "origin": string or null,
  "destination": string or null,
  "commodity": string or null,
  "weightDims": string or null
}
Rules:
- Use null for any field not clearly mentioned
- companyName: official company/business name only (e.g. "Advanced Hydraulics Inc")
- contactName: person's full name if mentioned (e.g. "Miguel Rivera")
- origin: city, airport, or country of shipment origin
- destination: city, airport, or country of shipment destination
- commodity: what is being shipped (e.g. "hydraulic pump", "aircraft engine")
- weightDims: weight and/or dimensions if mentioned (e.g. "50lb, 8x8x10in")
Return only the JSON object, no explanation, no markdown.`,
        messages: [{ role: 'user', content: transcript }]
      })
    });
    const data = await res.json();
    const text = data?.content?.[0]?.text || '{}';
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch (err) {
    console.error('[Extract] Field extraction failed:', err.message);
    return {};
  }
}

async function detectLiveAgentRequest(text) {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 5,
        system: 'Detect if the message is a request to speak with a human agent, live person, or real representative. Reply only with "yes" or "no".',
        messages: [{ role: 'user', content: text }]
      })
    });
    const data = await res.json();
    return data?.content?.[0]?.text?.trim().toLowerCase() === 'yes';
  } catch { return false; }
}

async function classifyTierClaude(text) {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 5,
        system: `Classify this freight inquiry message into one of three tiers. Reply with only the number 1, 2, or 3.
Tier 1 = AOG emergency: aircraft on ground, grounded plane, critical aviation emergency, needs parts immediately to get aircraft flying
Tier 2 = Standard freight: shipping cargo, freight quote, delivery, package, dangerous goods, oversized cargo — any real shipment need
Tier 3 = General: greetings, questions, thanks, unrelated topics, or anything not clearly a freight request
Important: "not AOG", "not an emergency", "no emergency" = Tier 2 or 3, never Tier 1`,
        messages: [{ role: 'user', content: text }]
      })
    });
    const data = await res.json();
    const t = parseInt(data?.content?.[0]?.text?.trim());
    return [1, 2, 3].includes(t) ? t : 3;
  } catch {
    const t = text.toLowerCase();
    const negated = /\b(not|no|sin|sem)\s+(an?\s+)?(aog|emergency|emergencia|urgent|urgente)\b/i.test(t);
    if (!negated && /\baog\b|aircraft on ground|grounded|plane down|\bemergency\b|\bemergencia\b/.test(t)) return 1;
    if (/shipment|cargo|freight|quote|ship|send|enviar|carga|flete|kg|lbs|dimensions/.test(t)) return 2;
    return 3;
  }
}

function bestName(mem, fields, cleanPhone) {
  return fields?.companyName || fields?.contactName || mem.customerName || mem.profileName || cleanPhone;
}

function buildSystemPrompt(customerName, inquiryHistory, refNumber) {
  let contextBlock = '';
  if (customerName && inquiryHistory?.length > 0) {
    const last   = inquiryHistory[0];
    const date   = new Date(last.createdAt).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    const wasAOG = inquiryHistory.some(i => i.tier === 'AOG_EMERGENCY');
    contextBlock = `You already know this customer. The
