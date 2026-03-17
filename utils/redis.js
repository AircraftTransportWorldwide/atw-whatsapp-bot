// utils/redis.js — All Redis helpers

import { createClient } from 'redis';

const MEMORY_TTL  = 24 * 60 * 60;
const TAKEOVER_TTL = 3 * 60 * 60;
const DEDUP_TTL   = 24 * 60 * 60;
const RATE_TTL    = 10 * 60;
const RATE_MAX    = 15;

export const redis = createClient({ url: process.env.REDIS_URL });
redis.on('error', err => console.error('[Redis] Error:', err));
redis.on('connect', () => console.log('[Redis] Connected'));

export async function getMem(phone) {
  const raw = await redis.get(`mem:${phone}`);
  return raw ? JSON.parse(raw) : null;
}
export async function setMem(phone, data) {
  await redis.set(`mem:${phone}`, JSON.stringify(data), { EX: MEMORY_TTL });
}
export async function getTakeover(convId) {
  const raw = await redis.get(`takeover:${convId}`);
  return raw ? JSON.parse(raw) : null;
}
export async function setTakeover(convId, data) {
  await redis.set(`takeover:${convId}`, JSON.stringify(data), { EX: TAKEOVER_TTL });
}
export async function delTakeover(convId) {
  await redis.del(`takeover:${convId}`);
}
export async function isDuplicate(sid) {
  const exists = await redis.get(`dedup:${sid}`);
  if (exists) return true;
  await redis.set(`dedup:${sid}`, '1', { EX: DEDUP_TTL });
  return false;
}
export async function isRateLimited(phone) {
  const key = `rate:${phone}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, RATE_TTL);
  return count > RATE_MAX;
}
export async function isBotMessage(sid) {
  return !!(await redis.get(`botsent:${sid}`));
}
export async function markBotMessage(sid) {
  await redis.set(`botsent:${sid}`, '1', { EX: DEDUP_TTL });
}
export async function setTwentyCache(phone, data) {
  await redis.set(`twenty:${phone}`, JSON.stringify(data), { EX: 24 * 60 * 60 });
}
export async function isChatwootDuplicate(convId, content, msgId) {
  const key = `cwdedup:${msgId || convId + ':' + content}`;
  const exists = await redis.get(key);
  if (exists) return true;
  await redis.set(key, '1', { EX: 60 });
  return false;
}
