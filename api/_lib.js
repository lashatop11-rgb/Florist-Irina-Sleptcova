// Shared helpers for the «Готовые букеты» feature.
// Storage: Upstash Redis over its REST API (Vercel → Storage → Upstash for Redis).
// Photos stay in Telegram: we keep only file_id and proxy the image through /api/photo.

const env = (k) => process.env[k] || '';
const redisUrl = () => env('KV_REST_API_URL') || env('UPSTASH_REDIS_REST_URL');
const redisToken = () => env('KV_REST_API_TOKEN') || env('UPSTASH_REDIS_REST_TOKEN');

export async function redis(...cmd) {
  if (!redisUrl()) throw new Error('Redis не подключён: нет KV_REST_API_URL');
  const r = await fetch(redisUrl(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${redisToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd.map(String)),
  });
  const j = await r.json();
  if (j.error) throw new Error('redis: ' + j.error);
  return j.result;
}

export async function tg(method, params = {}) {
  const r = await fetch(`https://api.telegram.org/bot${env('TELEGRAM_BOT_TOKEN')}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`telegram ${method}: ${j.description}`);
  return j.result;
}

const KEY = 'stock';

export async function listItems() {
  const flat = (await redis('HGETALL', KEY)) || [];
  const items = [];
  for (let i = 1; i < flat.length; i += 2) {
    try { items.push(JSON.parse(flat[i])); } catch { /* skip broken row */ }
  }
  return items.sort((a, b) => b.createdAt - a.createdAt);
}

export async function getItem(id) {
  const v = await redis('HGET', KEY, id);
  return v ? JSON.parse(v) : null;
}

export const saveItem = (item) => redis('HSET', KEY, item.id, JSON.stringify(item));
export const deleteItem = (id) => redis('HDEL', KEY, id);
export const nextId = async () => Number(await redis('INCR', 'stock:seq'));

export async function isAdmin(userId) {
  if (!userId) return false;
  if (env('ADMIN_IDS').split(/[\s,]+/).includes(String(userId))) return true;
  return Number(await redis('SISMEMBER', 'admins', userId)) === 1;
}
