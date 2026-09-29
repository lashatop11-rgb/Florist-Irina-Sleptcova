// Shared helpers for the site API and the Telegram bot.
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

// ---------- JSON records in Redis hashes ----------
// stock — букеты и цветы в наличии, works — портфолио, orders — заявки с сайта,
// reviews — отзывы
export async function hList(key) {
  const flat = (await redis('HGETALL', key)) || [];
  const rows = [];
  for (let i = 1; i < flat.length; i += 2) {
    try { rows.push(JSON.parse(flat[i])); } catch { /* skip broken row */ }
  }
  return rows.sort((a, b) => b.createdAt - a.createdAt);
}
export async function hGet(key, id) {
  const v = await redis('HGET', key, id);
  return v ? JSON.parse(v) : null;
}
export const hSave = (key, row, id = row.id) => redis('HSET', key, id, JSON.stringify(row));
export const hDel = (key, id) => redis('HDEL', key, id);
export const seq = async (name) => Number(await redis('INCR', name + ':seq'));

export const listItems = () => hList('stock');
export const getItem = (id) => hGet('stock', id);
export const saveItem = (item) => hSave('stock', item);
export const deleteItem = (id) => hDel('stock', id);
export const nextId = () => seq('stock');

// ---------- admins ----------
export async function isAdmin(userId) {
  if (!userId) return false;
  if (env('ADMIN_IDS').split(/[\s,]+/).includes(String(userId))) return true;
  return Number(await redis('SISMEMBER', 'admins', userId)) === 1;
}

// private chat id == user id, so admins are also the chats to notify
export async function adminChats() {
  const ids = new Set(env('ADMIN_IDS').split(/[\s,]+/).filter(Boolean));
  for (const id of (await redis('SMEMBERS', 'admins')) || []) ids.add(String(id));
  return [...ids].map(Number).filter(Boolean);
}

// sends the same message to every admin; returns [{chat, id}] to edit them later
export async function notifyAdmins(method, params) {
  const sent = [];
  for (const chat of await adminChats()) {
    try {
      const m = await tg(method, { chat_id: chat, ...params });
      sent.push({ chat, id: m.message_id });
    } catch (e) {
      console.error('notify', chat, e.message);
    }
  }
  return sent;
}

// ---------- formatting ----------
export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const fmtPrice = (n) => Number(n).toLocaleString('ru-RU').replace(/\s/g, ' ') + ' ₽';

// «8 926 123-45-67», «+7(926)1234567», «9261234567» → «79261234567»; null if it isn't a phone
export function normPhone(s) {
  let d = String(s || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
  if (d.length === 10 && d[0] === '9') d = '7' + d;
  return d.length >= 10 && d.length <= 15 ? d : null;
}
export const fmtPhone = (d) => (d.length === 11 && d[0] === '7'
  ? `+7 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7, 9)}-${d.slice(9)}`
  : '+' + d);

// ---------- public endpoints ----------
export function clientIp(req) {
  return String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
}

// true while the caller stays under `max` hits per `windowSec`
export async function rateOk(bucket, ip, max, windowSec) {
  const key = `rl:${bucket}:${ip}`;
  const n = Number(await redis('INCR', key));
  if (n === 1) await redis('EXPIRE', key, windowSec);
  return n <= max;
}
