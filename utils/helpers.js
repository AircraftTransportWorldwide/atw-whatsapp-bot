=// utils/helpers.js — Shared utilities: retry, sanitize, ref number, best name

export async function withRetry(fn, retries = 3, delayMs = 500) {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); }
    catch (err) {
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, delayMs * (i + 1)));
    }
  }
}

export function sanitizeInput(text) {
  return (text || '').trim().slice(0, 1000).replace(/<[^>]*>/g, '');
}

// channel: 'whatsapp' → ATW-WA-YYMMDD-XXXX
// channel: 'web'      → ATW-WEB-YYMMDD-XXXX
export function generateRefNumber(channel = 'whatsapp') {
  const now    = new Date();
  const yy     = String(now.getFullYear()).slice(2);
  const mm     = String(now.getMonth() + 1).padStart(2, '0');
  const dd     = String(now.getDate()).padStart(2, '0');
  const rand   = String(Math.floor(1000 + Math.random() * 9000));
  const prefix = channel === 'web' ? 'WEB' : 'WA';
  return `ATW-${prefix}-${yy}${mm}${dd}-${rand}`;
}

export function bestName(mem, fields, cleanPhone) {
  return fields?.companyName || fields?.contactName || mem.customerName || mem.profileName || cleanPhone;
}
