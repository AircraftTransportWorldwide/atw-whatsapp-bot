// services/morning.js — Daily morning briefing email at 8am Miami time

import { Resend } from 'resend';
import { withRetry } from '../utils/helpers.js';

const resend = new Resend(process.env.RESEND_API_KEY);

export async function sendMorningBriefing(inquiries) {
  if (!inquiries || inquiries.length === 0) return;

  const now      = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'full' });
  const total    = inquiries.length;
  const aog      = inquiries.filter(i => i.tier === 1);
  const standard = inquiries.filter(i => i.tier === 2);
  const hasAOG   = aog.length > 0;

  const subject = hasAOG
    ? `🔴 ATW Morning Briefing — ${aog.length} AOG + ${standard.length} inquiries — ${new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York' })}`
    : `ATW Morning Briefing — ${total} inquiries — ${new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York' })}`;

  const buildRow = (inq, index) => {
    const tierColor  = inq.tier === 1 ? '#CC0000' : '#0055A4';
    const tierLabel  = inq.tier === 1 ? 'AOG' : 'TIER 2';
    const tierES     = inq.tier === 1 ? 'EMERGENCIA' : 'ESTÁNDAR';
    const langFlag   = { en: '🇺🇸', es: '🇪🇸', pt: '🇧🇷' }[inq.language] || '🌐';
    const bg         = index % 2 === 0 ? '#ffffff' : '#f9f9f9';
    return `
    <tr style="background:${bg};">
      <td style="padding:10px 14px;font-size:13px;font-weight:700;color:#333;border-bottom:1px solid #e8e8e8;">${inq.refNumber || '---'}</td>
      <td style="padding:10px 14px;font-size:13px;color:#333;border-bottom:1px solid #e8e8e8;">${inq.phone}</td>
      <td style="padding:10px 14px;font-size:13px;color:#333;border-bottom:1px solid #e8e8e8;">${inq.company || inq.contactName || '---'}</td>
      <td style="padding:10px 14px;font-size:13px;color:#333;border-bottom:1px solid #e8e8e8;">${inq.origin || '---'} → ${inq.destination || '---'}</td>
      <td style="padding:10px 14px;font-size:13px;color:#333;border-bottom:1px solid #e8e8e8;">${inq.commodity || '---'}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #e8e8e8;">
        <span style="background:${tierColor};color:#fff;font-size:11px;font-weight:700;padding:2px 8px;border-radius:3px;">${tierLabel}</span>
        <br><span style="font-size:10px;color:#999;">${tierES}</span>
      </td>
      <td style="padding:10px 14px;font-size:13px;color:#333;border-bottom:1px solid #e8e8e8;">${langFlag} ${inq.language?.toUpperCase() || 'EN'}</td>
      <td style="padding:10px 14px;font-size:12px;color:#666;border-bottom:1px solid #e8e8e8;">${inq.timeAgo}</td>
    </tr>`;
  };

  const aogRows      = aog.map((i, idx) => buildRow(i, idx)).join('');
  const standardRows = standard.map((i, idx) => buildRow(i, idx)).join('');

  const aogSection = aog.length > 0 ? `
    <tr><td colspan="8" style="padding:12px 14px;background:#fff0f0;border-top:2px solid #CC0000;border-bottom:1px solid #e8e8e8;">
      <span style="font-size:12px;font-weight:700;color:#CC0000;letter-spacing:1px;">AOG EMERGENCIES / EMERGENCIAS AOG (${aog.length})</span>
    </td></tr>
    ${aogRows}` : '';

  const standardSection = standard.length > 0 ? `
    <tr><td colspan="8" style="padding:12px 14px;background:#f0f4ff;border-top:2px solid #0055A4;border-bottom:1px solid #e8e8e8;">
      <span style="font-size:12px;font-weight:700;color:#0055A4;letter-spacing:1px;">STANDARD INQUIRIES / CONSULTAS ESTÁNDAR (${standard.length})</span>
    </td></tr>
    ${standardRows}` : '';

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:30px 0;">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:900px;background:#fff;border-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,0.08);">

  <!-- Header -->
  <tr><td style="background:#003366;padding:20px 30px;">
    <span style="font-size:22px;font-weight:700;color:#fff;letter-spacing:1px;">ATW CARGO</span>
    <span style="font-size:13px;color:rgba(255,255,255,0.8);margin-left:12px;">Daily Morning Briefing / Resumen Diario</span>
  </td></tr>

  <!-- Date + stats bar -->
  <tr><td style="background:#0055A4;padding:10px 30px;">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td><span style="font-size:13px;color:#fff;">${now}</span></td>
      <td align="right">
        <span style="font-size:13px;color:#fff;margin-left:20px;">
          Total: <strong>${total}</strong>
          &nbsp;|&nbsp; AOG: <strong style="color:${hasAOG ? '#ffaaaa' : '#fff'}">${aog.length}</strong>
          &nbsp;|&nbsp; Standard: <strong>${standard.length}</strong>
        </span>
      </td>
    </tr></table>
  </td></tr>

  ${hasAOG ? `
  <!-- AOG Warning Banner -->
  <tr><td style="background:#fff0f0;padding:12px 30px;border-left:4px solid #CC0000;">
    <span style="font-size:14px;font-weight:700;color:#CC0000;">⚠ ${aog.length} AOG emergency inquiry${aog.length > 1 ? 's' : ''} from the past 24 hours. Please verify these have been handled.</span>
    <br><span style="font-size:12px;color:#CC0000;">${aog.length} consulta${aog.length > 1 ? 's' : ''} de emergencia AOG en las últimas 24 horas. Verifique que hayan sido atendidas.</span>
  </td></tr>` : ''}

  <!-- Inquiries table -->
  <tr><td style="padding:20px 30px 8px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e0e0e0;border-radius:4px;border-collapse:collapse;">
      <tr style="background:#f0f0f0;">
        <th style="padding:10px 14px;font-size:12px;font-weight:700;color:#555;text-align:left;border-bottom:2px solid #ddd;">Ref</th>
        <th style="padding:10px 14px;font-size:12px;font-weight:700;color:#555;text-align:left;border-bottom:2px solid #ddd;">Phone / Tel</th>
        <th style="padding:10px 14px;font-size:12px;font-weight:700;color:#555;text-align:left;border-bottom:2px solid #ddd;">Company / Empresa</th>
        <th style="padding:10px 14px;font-size:12px;font-weight:700;color:#555;text-align:left;border-bottom:2px solid #ddd;">Route / Ruta</th>
        <th style="padding:10px 14px;font-size:12px;font-weight:700;color:#555;text-align:left;border-bottom:2px solid #ddd;">Commodity</th>
        <th style="padding:10px 14px;font-size:12px;font-weight:700;color:#555;text-align:left;border-bottom:2px solid #ddd;">Tier</th>
        <th style="padding:10px 14px;font-size:12px;font-weight:700;color:#555;text-align:left;border-bottom:2px solid #ddd;">Lang</th>
        <th style="padding:10px 14px;font-size:12px;font-weight:700;color:#555;text-align:left;border-bottom:2px solid #ddd;">Received / Recibido</th>
      </tr>
      ${aogSection}
      ${standardSection}
    </table>
  </td></tr>

  <!-- Footer -->
  <tr><td style="background:#f4f4f4;padding:16px 30px;border-top:1px solid #e0e0e0;">
    <span style="font-size:12px;color:#999;">ATW WhatsApp Bot — Daily Briefing · Generated at 8:00 AM ET</span>
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
    console.log(`[Morning] Briefing sent — ${total} inquiries (${aog.length} AOG, ${standard.length} standard)`);
  } catch (err) {
    console.error('[Morning] Briefing failed:', err.message);
  }
}
