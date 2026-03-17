// services/email.js — Email alerts via Resend

import { Resend } from 'resend';
import { withRetry } from '../utils/helpers.js';
import { generateEmailSummary } from './claude.js';

const resend = new Resend(process.env.RESEND_API_KEY);

export async function sendEmailAlert(tier, phone, messages, refNumber, fields, isLiveAgentRequest = false) {
  if (tier === 3 && !isLiveAgentRequest) return;
  const cleanPhone  = phone.replace('whatsapp:', '');
  const isAOG       = tier === 1;
  const ref         = refNumber || '---';
  const subject     = isLiveAgentRequest
    ? `LIVE AGENT REQUESTED [${ref}] — WhatsApp from ${cleanPhone}`
    : isAOG
      ? `AOG EMERGENCY [${ref}] — WhatsApp Inquiry from ${cleanPhone}`
      : `New Shipment Inquiry [${ref}] — WhatsApp from ${cleanPhone}`;
  const accentColor = isLiveAgentRequest ? '#FF6600' : isAOG ? '#CC0000' : '#003366';
  const badgeColor  = isLiveAgentRequest ? '#FF6600' : isAOG ? '#CC0000' : '#0055A4';
  const badgeText   = isLiveAgentRequest ? 'LIVE AGENT REQUESTED' : isAOG ? 'TIER 1 — AOG EMERGENCY' : 'TIER 2 — STANDARD INQUIRY';
  const urgency     = isLiveAgentRequest ? 'LIVE AGENT' : isAOG ? 'AOG / CRITICAL' : 'STANDARD';
  const summaryText = isLiveAgentRequest
    ? 'Customer has requested to speak with a live agent. Conversation transcript is below.'
    : await generateEmailSummary(messages) || messages.find(m => m.role === 'user')?.content || '';
  const origin      = fields?.origin || '---';
  const destination = fields?.destination || '---';
  const convRows    = messages.map(m => {
    const isCust = m.role === 'user';
    return `<tr><td style="padding:6px 0;border-top:1px solid #f0f0f0;"><span style="font-weight:700;color:${isCust ? '#0055A4' : '#007A33'};font-size:13px;">${isCust ? 'CLIENT' : 'ATW BOT'}:</span><span style="font-size:13px;color:#333;margin-left:6px;">${m.content}</span></td></tr>`;
  }).join('');
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,sans-serif;"><table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:30px 0;"><tr><td align="center"><table width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#fff;border-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,0.08);"><tr><td style="background:${accentColor};padding:20px 30px;"><span style="font-size:22px;font-weight:700;color:#fff;letter-spacing:1px;">ATW CARGO</span><span style="font-size:13px;color:rgba(255,255,255,0.8);margin-left:12px;">WhatsApp Bot Alert</span></td></tr><tr><td style="background:${badgeColor};padding:10px 30px;"><span style="font-size:13px;font-weight:700;color:#fff;letter-spacing:1px;">${badgeText}</span></td></tr><tr><td style="padding:24px 30px 8px;"><p style="margin:0 0 20px;font-size:15px;color:#333;line-height:1.6;">${summaryText}</p><table cellpadding="0" cellspacing="0" width="100%" style="border:1px solid #e0e0e0;border-radius:4px;border-collapse:collapse;"><tr><td style="padding:10px 16px;font-size:13px;font-weight:700;color:#555;width:130px;border-bottom:1px solid #e0e0e0;">Reference</td><td style="padding:10px 16px;font-size:13px;color:#333;border-bottom:1px solid #e0e0e0;">${ref}</td></tr><tr style="background:#f9f9f9;"><td style="padding:10px 16px;font-size:13px;font-weight:700;color:#555;border-bottom:1px solid #e0e0e0;">Client</td><td style="padding:10px 16px;font-size:13px;color:#333;border-bottom:1px solid #e0e0e0;">${cleanPhone}</td></tr><tr><td style="padding:10px 16px;font-size:13px;font-weight:700;color:#555;border-bottom:1px solid #e0e0e0;">Origin</td><td style="padding:10px 16px;font-size:13px;color:#333;border-bottom:1px solid #e0e0e0;">${origin.toUpperCase()}</td></tr><tr style="background:#f9f9f9;"><td style="padding:10px 16px;font-size:13px;font-weight:700;color:#555;border-bottom:1px solid #e0e0e0;">Destination</td><td style="padding:10px 16px;font-size:13px;color:#333;border-bottom:1px solid #e0e0e0;">${destination.toUpperCase()}</td></tr><tr><td style="padding:10px 16px;font-size:13px;font-weight:700;color:#555;">Urgency</td><td style="padding:10px 16px;font-size:13px;color:#333;">${urgency}</td></tr></table></td></tr><tr><td style="padding:20px 30px 8px;"><p style="margin:0 0 12px;font-size:14px;font-weight:700;color:#333;">Full Conversation</p><table width="100%" cellpadding="0" cellspacing="0">${convRows}</table></td></tr><tr><td style="background:#f4f4f4;padding:16px 30px;border-top:1px solid #e0e0e0;"><span style="font-size:12px;color:#999;">ATW WhatsApp Bot · ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET</span></td></tr></table></td></tr></table></body></html>`;
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
