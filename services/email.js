// services/email.js — Email alerts via Resend

import { Resend } from 'resend';
import { withRetry } from '../utils/helpers.js';
import { generateEmailSummary } from './claude.js';

const resend = new Resend(process.env.RESEND_API_KEY);

// Generate a Spanish summary using Claude
async function generateSpanishSummary(messages) {
  try {
    const { callClaude } = await import('./claude.js');
    const transcript = messages.map(m => `${m.role === 'user' ? 'Cliente' : 'Patty'}: ${m.content}`).join('\n');
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 120,
        system: 'Eres un asistente de logística de carga. Escribe UNA sola oración en español (máximo 40 palabras) resumiendo la consulta de envío. Incluye mercancía, origen, destino y urgencia si se mencionan. Sin viñetas, sin etiquetas, sin markdown.',
        messages: [{ role: 'user', content: transcript }]
      })
    });
    const data = await res.json();
    return data?.content?.[0]?.text || null;
  } catch { return null; }
}

export async function sendEmailAlert(tier, phone, messages, refNumber, fields, isLiveAgentRequest = false, isSLABreach = false) {
  if (tier === 3 && !isLiveAgentRequest && !isSLABreach) return;

  const cleanPhone  = phone.replace('whatsapp:', '');
  const isAOG       = tier === 1;
  const ref         = refNumber || '---';

  const subject     = isSLABreach
    ? `⚠ SLA BREACH — AOG NO ATENDIDO / UNATTENDED AOG [${ref}] — WhatsApp ${cleanPhone}`
    : isLiveAgentRequest
      ? `AGENTE EN VIVO SOLICITADO / LIVE AGENT REQUESTED [${ref}] — WhatsApp ${cleanPhone}`
      : isAOG
        ? `EMERGENCIA AOG / AOG EMERGENCY [${ref}] — WhatsApp ${cleanPhone}`
        : `Nueva Consulta / New Inquiry [${ref}] — WhatsApp ${cleanPhone}`;

  const accentColor = isSLABreach ? '#8B0000' : isLiveAgentRequest ? '#FF6600' : isAOG ? '#CC0000' : '#003366';
  const badgeColor  = isSLABreach ? '#8B0000' : isLiveAgentRequest ? '#FF6600' : isAOG ? '#CC0000' : '#0055A4';

  const badgeEN     = isSLABreach ? 'SLA BREACH — AOG UNATTENDED 15+ MIN' : isLiveAgentRequest ? 'LIVE AGENT REQUESTED' : isAOG ? 'TIER 1 — AOG EMERGENCY' : 'TIER 2 — STANDARD INQUIRY';
  const badgeES     = isSLABreach ? 'INCUMPLIMIENTO SLA — AOG SIN ATENDER +15 MIN' : isLiveAgentRequest ? 'AGENTE EN VIVO SOLICITADO' : isAOG ? 'TIER 1 — EMERGENCIA AOG' : 'TIER 2 — CONSULTA ESTÁNDAR';

  const urgencyEN   = isSLABreach ? 'CRITICAL — SLA BREACH' : isLiveAgentRequest ? 'LIVE AGENT' : isAOG ? 'AOG / CRITICAL' : 'STANDARD';
  const urgencyES   = isSLABreach ? 'CRÍTICO — INCUMPLIMIENTO SLA' : isLiveAgentRequest ? 'AGENTE EN VIVO' : isAOG ? 'AOG / CRÍTICO' : 'ESTÁNDAR';

  const origin          = fields?.origin          || '---';
  const destination     = fields?.destination     || '---';
  const commodity       = fields?.commodity       || '---';
  const weightDims      = fields?.weightDims      || '---';
  const company         = fields?.companyName     || '---';
  const contact         = fields?.contactName     || '---';
  const hazmat          = fields?.hazmat          || '---';
  const transportMode   = fields?.transportMode   || '---';
  const pickupAddress   = fields?.pickupAddress   || '---';
  const deliveryAddress = fields?.deliveryAddress || '---';

  // Generate both summaries in parallel
  const [summaryEN, summaryES] = await Promise.all([
    isLiveAgentRequest
      ? Promise.resolve('Customer has requested to speak with a live agent. Conversation transcript is below.')
      : generateEmailSummary(messages).catch(() => messages.find(m => m.role === 'user')?.content || ''),
    isLiveAgentRequest
      ? Promise.resolve('El cliente ha solicitado hablar con un agente en vivo. El historial de conversación se incluye abajo.')
      : generateSpanishSummary(messages).catch(() => null)
  ]);

  const convRows = messages.map(m => {
    const isCust = m.role === 'user';
    return `<tr><td style="padding:6px 0;border-top:1px solid #f0f0f0;">
      <span style="font-weight:700;color:${isCust ? '#0055A4' : '#007A33'};font-size:13px;">${isCust ? 'CLIENT' : 'ATW BOT'}:</span>
      <span style="font-size:13px;color:#333;margin-left:6px;">${m.content}</span>
    </td></tr>`;
  }).join('');

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:30px 0;">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#fff;border-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,0.08);">

  <!-- Header -->
  <tr><td style="background:${accentColor};padding:20px 30px;">
    <span style="font-size:22px;font-weight:700;color:#fff;letter-spacing:1px;">ATW CARGO</span>
    <span style="font-size:13px;color:rgba(255,255,255,0.8);margin-left:12px;">WhatsApp Bot Alert</span>
  </td></tr>

  <!-- Badge EN -->
  <tr><td style="background:${badgeColor};padding:8px 30px;">
    <span style="font-size:12px;font-weight:700;color:#fff;letter-spacing:1px;">${badgeEN}</span>
  </td></tr>

  <!-- Badge ES -->
  <tr><td style="background:${badgeColor};padding:6px 30px;border-top:1px solid rgba(255,255,255,0.15);">
    <span style="font-size:12px;font-weight:700;color:rgba(255,255,255,0.85);letter-spacing:1px;">${badgeES}</span>
  </td></tr>

  <!-- Summary EN -->
  <tr><td style="padding:20px 30px 4px;">
    <p style="margin:0 0 4px;font-size:11px;font-weight:700;color:#999;text-transform:uppercase;letter-spacing:1px;">Summary</p>
    <p style="margin:0 0 16px;font-size:15px;color:#333;line-height:1.6;">${summaryEN}</p>
  </td></tr>

  <!-- Summary ES -->
  ${summaryES ? `<tr><td style="padding:0 30px 16px;">
    <p style="margin:0 0 4px;font-size:11px;font-weight:700;color:#999;text-transform:uppercase;letter-spacing:1px;">Resumen</p>
    <p style="margin:0;font-size:15px;color:#555;line-height:1.6;font-style:italic;">${summaryES}</p>
  </td></tr>` : ''}

  <!-- Details table -->
  <tr><td style="padding:0 30px 8px;">
    <table cellpadding="0" cellspacing="0" width="100%" style="border:1px solid #e0e0e0;border-radius:4px;border-collapse:collapse;">
      <tr><td style="padding:10px 16px;font-size:13px;font-weight:700;color:#555;width:160px;border-bottom:1px solid #e0e0e0;">Reference / Ref.</td><td style="padding:10px 16px;font-size:13px;color:#333;border-bottom:1px solid #e0e0e0;font-weight:700;">${ref}</td></tr>
      <tr style="background:#f9f9f9;"><td style="padding:10px 16px;font-size:13px;font-weight:700;color:#555;border-bottom:1px solid #e0e0e0;">Client / Cliente</td><td style="padding:10px 16px;font-size:13px;color:#333;border-bottom:1px solid #e0e0e0;">${cleanPhone}</td></tr>
      <tr><td style="padding:10px 16px;font-size:13px;font-weight:700;color:#555;border-bottom:1px solid #e0e0e0;">Company / Empresa</td><td style="padding:10px 16px;font-size:13px;color:#333;border-bottom:1px solid #e0e0e0;">${company}</td></tr>
      <tr style="background:#f9f9f9;"><td style="padding:10px 16px;font-size:13px;font-weight:700;color:#555;border-bottom:1px solid #e0e0e0;">Contact / Contacto</td><td style="padding:10px 16px;font-size:13px;color:#333;border-bottom:1px solid #e0e0e0;">${contact}</td></tr>
      <tr><td style="padding:10px 16px;font-size:13px;font-weight:700;color:#555;border-bottom:1px solid #e0e0e0;">Origin / Origen</td><td style="padding:10px 16px;font-size:13px;color:#333;border-bottom:1px solid #e0e0e0;">${origin.toUpperCase()}</td></tr>
      <tr style="background:#f9f9f9;"><td style="padding:10px 16px;font-size:13px;font-weight:700;color:#555;border-bottom:1px solid #e0e0e0;">Destination / Destino</td><td style="padding:10px 16px;font-size:13px;color:#333;border-bottom:1px solid #e0e0e0;">${destination.toUpperCase()}</td></tr>
      <tr><td style="padding:10px 16px;font-size:13px;font-weight:700;color:#555;border-bottom:1px solid #e0e0e0;">Commodity / Mercancía</td><td style="padding:10px 16px;font-size:13px;color:#333;border-bottom:1px solid #e0e0e0;">${commodity}</td></tr>
      <tr style="background:#f9f9f9;"><td style="padding:10px 16px;font-size:13px;font-weight:700;color:#555;border-bottom:1px solid #e0e0e0;">Weight/Dims / Peso</td><td style="padding:10px 16px;font-size:13px;color:#333;border-bottom:1px solid #e0e0e0;">${weightDims}</td></tr>
      <tr><td style="padding:10px 16px;font-size:13px;font-weight:700;color:#555;border-bottom:1px solid #e0e0e0;">Hazmat / Mat. Peligrosa</td><td style="padding:10px 16px;font-size:13px;color:#333;border-bottom:1px solid #e0e0e0;">${hazmat}</td></tr>
      <tr style="background:#f9f9f9;"><td style="padding:10px 16px;font-size:13px;font-weight:700;color:#555;border-bottom:1px solid #e0e0e0;">Mode / Modo</td><td style="padding:10px 16px;font-size:13px;color:#333;border-bottom:1px solid #e0e0e0;">${transportMode}</td></tr>
      <tr><td style="padding:10px 16px;font-size:13px;font-weight:700;color:#555;border-bottom:1px solid #e0e0e0;">Pickup / Recogida</td><td style="padding:10px 16px;font-size:13px;color:#333;border-bottom:1px solid #e0e0e0;">${pickupAddress}</td></tr>
      <tr style="background:#f9f9f9;"><td style="padding:10px 16px;font-size:13px;font-weight:700;color:#555;border-bottom:1px solid #e0e0e0;">Delivery / Entrega</td><td style="padding:10px 16px;font-size:13px;color:#333;border-bottom:1px solid #e0e0e0;">${deliveryAddress}</td></tr>
      <tr><td style="padding:10px 16px;font-size:13px;font-weight:700;color:#555;">Urgency / Urgencia</td><td style="padding:10px 16px;font-size:13px;color:#333;">${urgencyEN} / ${urgencyES}</td></tr>
    </table>
  </td></tr>

  <!-- Conversation -->
  <tr><td style="padding:20px 30px 8px;">
    <p style="margin:0 0 4px;font-size:11px;font-weight:700;color:#999;text-transform:uppercase;letter-spacing:1px;">Conversation / Conversación</p>
    <table width="100%" cellpadding="0" cellspacing="0">${convRows}</table>
  </td></tr>

  <!-- Footer -->
  <tr><td style="background:#f4f4f4;padding:16px 30px;border-top:1px solid #e0e0e0;">
    <span style="font-size:12px;color:#999;">ATW WhatsApp Bot · ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET</span>
  </td></tr>

</table>
</td></tr>
</table>
</body></html>`;

  try {
    await withRetry(() => resend.emails.send({
      from: 'ATW Bot <onboarding@resend.dev>',
      to: ['digital@atwcargo.com'],
      subject,
      html
    }));
    console.log(`[Email] ${isLiveAgentRequest ? 'Live agent request' : `Tier ${tier}`} alert sent (${ref})`);
  } catch (err) { console.error('[Email] Failed:', err.message); }
}
