// utils/helpers.js — Shared utilities: retry, sanitize, ref number, best name

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

export function generateRefNumber() {
  const now  = new Date();
  const yy   = String(now.getFullYear()).slice(2);
  const mm   = String(now.getMonth() + 1).padStart(2, '0');
  const dd   = String(now.getDate()).padStart(2, '0');
  const rand = String(Math.floor(1000 + Math.random() * 9000));
  return `ATW-${yy}${mm}${dd}-${rand}`;
}

export function bestName(mem, fields, cleanPhone) {
  return fields?.companyName || fields?.contactName || mem.customerName || mem.profileName || cleanPhone;
}
