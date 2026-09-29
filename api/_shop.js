// Texts and buttons shared by the bot, the site forms and the daily cron:
// заявки с сайта (заказ / бронь), отзывы, статистика.
import { tg, redis, hList, esc, fmtPrice, fmtPhone } from './_lib.js';

export const ORDER_CONTACT = 'https://t.me/lrinaSlepcova';
export const PHONE = '79264678000';
export const DAY = 24 * 3600 * 1000;

// portfolio sections — the same keys as data-cat in the site gallery
export const CATS = {
  bouquet: { name: 'Букеты', one: 'Авторский букет' },
  box: { name: 'В коробках', one: 'Композиция в коробке' },
  basket: { name: 'Корзины', one: 'Цветочная корзина' },
  wedding: { name: 'Свадебные', one: 'Свадебная флористика' },
  mourning: { name: 'Траурные', one: 'Траурная композиция' },
  xmas: { name: 'Новогодние', one: 'Новогодняя композиция' },
};

export const plural = (n, [one, few, many]) => {
  const a = Math.abs(n) % 100, b = a % 10;
  return `${n} ${a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many}`;
};
const fmtTime = (ts) => new Date(ts).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

// ---------- заявки с сайта ----------
// status = the last action: new → acc → rdy → done (заказ), new → ok → sold | free (бронь); can / no — отказ
const STATUS = {
  acc: '👍 принята', rdy: '💐 готова', done: '✅ выдана', can: '✖ отменена',
  ok: '🔒 бронь подтверждена', no: '❌ отказано', sold: '✅ продано', free: '↩️ бронь снята',
};
export const FLOW = {
  order: { new: ['acc', 'can'], acc: ['rdy', 'can'], rdy: ['done'] },
  reserve: { new: ['ok', 'no'], ok: ['sold', 'free'] },
};
const BUTTON = {
  acc: '👍 Принять', rdy: '💐 Готов', done: '✅ Выдан', can: '✖ Отменить',
  ok: '✅ Подтвердить бронь', no: '❌ Отказать', sold: '✅ Продано', free: '↩️ Снять бронь',
};
const statusLabel = (o) => (o.status === 'new' ? (o.type === 'reserve' ? '🆕 ждёт ответа' : '🆕 новая') : STATUS[o.status] || o.status);
export const isOpen = (o) => Boolean(FLOW[o.type]?.[o.status]);

export function orderText(o) {
  const head = {
    order: `🛍 Заявка №${o.id} с сайта`,
    reserve: `🔒 Бронь с сайта · заявка №${o.id}`,
  }[o.type];
  const lines = [`<b>${head}</b> · ${statusLabel(o)}`, ''];
  if (o.name) lines.push(`👤 ${esc(o.name)}`);
  lines.push(`📞 ${fmtPhone(o.phone)}`, '');
  if (o.type === 'reserve') lines.push(`Букет №${o.itemId} «${esc(o.itemTitle)}» — ${fmtPrice(o.itemPrice)}`);
  if (o.text) lines.push(esc(o.text));
  if (o.status === 'new') {
    lines.push('', o.type === 'reserve' ? 'Свяжитесь с клиентом и подтвердите бронь — на сайте букет станет «Забронирован».'
      : 'Свяжитесь с клиентом, чтобы уточнить детали.');
  }
  lines.push('', `🕐 ${fmtTime(o.createdAt)}`);
  return lines.join('\n');
}

export function orderKeyboard(o) {
  const acts = FLOW[o.type]?.[o.status] || [];
  const rows = acts.length ? [acts.map((a) => ({ text: BUTTON[a], callback_data: `o:${o.id}:${a}` }))] : [];
  rows.push([
    { text: '💬 WhatsApp', url: `https://wa.me/${o.phone}` },
    { text: '✈️ Telegram', url: `https://t.me/+${o.phone}` },
  ]);
  return { inline_keyboard: rows };
}

const editAll = (msgs, params) => Promise.all((msgs || []).map((m) => tg('editMessageText', {
  chat_id: m.chat, message_id: m.id, parse_mode: 'HTML', disable_web_page_preview: true, ...params,
}).catch(() => {})));

// every admin got their own copy — keep all of them in sync
export const syncOrder = (o) => editAll(o.msgs, { text: orderText(o), reply_markup: orderKeyboard(o) });

// ---------- отзывы ----------
const stars = (n) => '★'.repeat(n) + '☆'.repeat(5 - n);
const REVIEW_STATUS = { pending: '⏳ ждёт проверки', published: '🟢 на сайте', hidden: '🙈 скрыт', deleted: '🗑 удалён' };

export function reviewText(v) {
  return [`<b>💬 Отзыв №${v.id}</b> · ${REVIEW_STATUS[v.status]}${v.channelMsg ? ' · 📣 в канале' : ''}`, `${stars(v.rating)} · ${esc(v.name)}`, '', `«${esc(v.text)}»`].join('\n');
}
export function reviewKeyboard(v) {
  if (v.status === 'deleted') return { inline_keyboard: [] };
  const main = v.status === 'published'
    ? { text: '🙈 Скрыть', callback_data: `v:${v.id}:hide` }
    : { text: '✅ Опубликовать', callback_data: `v:${v.id}:pub` };
  return { inline_keyboard: [[main, { text: '🗑 Удалить', callback_data: `v:${v.id}:del` }]] };
}
export const syncReview = (v) => editAll(v.msgs, { text: reviewText(v), reply_markup: reviewKeyboard(v) });

// ---------- статистика ----------
export async function statsText(title = '📊 Статистика') {
  const [salesRaw, soldTotal, stock, works, orders, reviews] = await Promise.all([
    redis('LRANGE', 'sales', 0, 999), redis('GET', 'stock:sold'),
    hList('stock'), hList('works'), hList('orders'), hList('reviews'),
  ]);
  const now = Date.now();
  const sales = (salesRaw || []).map((s) => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
  const period = (days) => {
    const list = sales.filter((s) => now - s.at < days * DAY);
    return `${list.length} шт. на ${fmtPrice(list.reduce((sum, s) => sum + (Number(s.price) || 0), 0))}`;
  };
  const recent = orders.filter((o) => now - o.createdAt < 30 * DAY);
  const count = (type) => recent.filter((o) => o.type === type).length;
  const bouquets = stock.filter((it) => it.kind !== 'flower').length;
  return [
    `<b>${title}</b>`,
    '',
    'Продано готовых букетов:',
    `• за 7 дней — ${period(7)}`,
    `• за 30 дней — ${period(30)}`,
    `• всего — ${Number(soldTotal) || 0} шт.`,
    '',
    `Сейчас на сайте: 💐 ${bouquets} · 🌷 ${stock.length - bouquets} · 🖼 ${works.length}`,
    `Заявки с сайта за 30 дней: 🛍 ${count('order')} · 🔒 ${count('reserve')}`,
    `Открытых заявок: ${orders.filter(isOpen).length}`,
    `Отзывы: на сайте ${reviews.filter((v) => v.status === 'published').length}, ждут ${reviews.filter((v) => v.status === 'pending').length}`,
  ].join('\n');
}
