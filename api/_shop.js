// Texts and buttons shared by the bot, the site forms and the daily cron:
// заявки с сайта (заказ / бронь) и сообщения клиенту о них, отзывы, праздники, статистика.
import { tg, redis, hList, esc, fmtPrice, fmtPhone } from './_lib.js';

export const ORDER_CONTACT = 'https://t.me/lrinaSlepcova';
export const PHONE = '79264678000';
export const DAY = 24 * 3600 * 1000;
export const WORKSHOP = 'пгт. Тучково, Восточный мкр., д. 1А — дверь под козырьком';

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
export const fmtDay = (ts) => new Date(ts).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long' });

// ---------- Moscow time ----------
const MSK = 3 * 3600e3; // UTC+3 all year
// timestamp of hour:00 Moscow time, `days` days after today (Moscow)
export function mskAt(hour, days = 0, now = Date.now()) {
  const d = new Date(now + MSK);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + days, hour) - MSK;
}
// «сегодня в 18:00», «завтра в 9:00», «2 октября в 9:00»
export function fmtWhen(ts, now = Date.now()) {
  const days = Math.round((mskAt(0, 0, ts) - mskAt(0, 0, now)) / DAY);
  const d = new Date(ts + MSK);
  const time = `${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  return `${days === 0 ? 'сегодня' : days === 1 ? 'завтра' : fmtDay(ts)} в ${time}`;
}

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

// one line of a client's history: «🛍 №12 · День рождения — ✅ выдана»
export function orderLine(o) {
  const occasion = String(o.text || '').match(/Повод:\s*([^\n•]+)/)?.[1]?.trim();
  const what = o.type === 'reserve' ? `🔒 №${o.id} бронь «${esc(o.itemTitle)}», ${fmtPrice(o.itemPrice)}`
    : `🛍 №${o.id}` + (occasion ? ` · ${esc(occasion)}` : '');
  return `${what} — ${statusLabel(o)}`;
}

export function orderText(o) {
  const head = {
    order: `🛍 Заявка №${o.id} с сайта`,
    reserve: `🔒 Бронь с сайта · заявка №${o.id}`,
  }[o.type];
  const lines = [`<b>${head}</b> · ${statusLabel(o)}`, ''];
  if (o.name) lines.push(`👤 ${esc(o.name)}`);
  lines.push(`📞 ${fmtPhone(o.phone)}`);
  if (o.visits > 0) lines.push(`⭐ Постоянный клиент: раньше ${plural(o.visits, ['обращение', 'обращения', 'обращений'])}, последнее ${fmtDay(o.lastVisit)}`);
  else if (o.visits === 0) lines.push('🆕 Новый клиент');
  if (o.clientChat) lines.push('📲 Следит за заявкой в Telegram — статусы приходят клиенту');
  lines.push('');
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
  const extra = [];
  if (o.clientChat) extra.push({ text: '✉️ Написать клиенту', callback_data: `cm:${o.id}` });
  if (o.visits > 0) extra.push({ text: `👤 История (${o.visits + 1})`, callback_data: `cl:${o.phone}` });
  if (extra.length) rows.push(extra);
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

// what the client sees in the bot after following «Следить в Telegram» from the site; '' = nothing to send
export function clientText(o) {
  const n = `№${o.id}`, bq = `«${esc(o.itemTitle)}»`;
  return ({
    order: {
      new: `🌸 Заявка ${n} у Ирины. Она скоро позвонит или напишет, чтобы уточнить детали.\nСюда придёт, когда заявку примут и когда букет будет готов.`,
      acc: `👍 Ирина приняла заявку ${n} и уже собирает для вас букет.`,
      rdy: `💐 Букет по заявке ${n} готов!\nИрина свяжется, чтобы договориться о доставке или самовывозе.\nМастерская: ${WORKSHOP}.`,
      done: `✅ Заявка ${n} выполнена. Спасибо, что выбрали нас! Будем рады вашему отзыву 🌿`,
      can: `Заявка ${n} отменена. Если это ошибка — напишите сюда, Ирина ответит.`,
    },
    reserve: {
      new: `🌸 Бронь букета ${bq} у Ирины. Она позвонит и подтвердит.\nОтвет придёт сюда.`,
      ok: `🔒 Бронь подтверждена: букет ${bq} ждёт вас.\nМастерская: ${WORKSHOP}.`,
      no: `К сожалению, букет ${bq} забронировать не получилось. Посмотрите другие букеты в наличии или закажите похожий — Ирина соберёт.`,
      sold: `✅ Спасибо за покупку! Будем рады вашему отзыву о букете ${bq} 🌿`,
      free: `↩️ Бронь букета ${bq} снята. Если планы изменились — напишите сюда.`,
    },
  })[o.type]?.[o.status] || '';
}
export function clientKeyboard(o, site) {
  if (!site) return undefined;
  if (['done', 'sold'].includes(o.status)) return { inline_keyboard: [[{ text: '✍️ Оставить отзыв', url: `${site}/#reviews` }]] };
  if (['no', 'can'].includes(o.status)) return { inline_keyboard: [[{ text: '🌸 Букеты в наличии', url: `${site}/#stock` }]] };
  return undefined;
}

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

// ---------- праздники ----------
// за `lead` дней бот предлагает объявление вверху сайта; после праздника оно снимается само
const lastSunday = (y, m) => { const d = new Date(Date.UTC(y, m + 1, 0)); return d.getUTCDate() - d.getUTCDay(); };
export const HOLIDAYS = {
  feb14: { name: '14 февраля', date: () => [1, 14], lead: 14, text: 'Принимаем предзаказы букетов на 14 февраля' },
  mar8: { name: '8 Марта', date: () => [2, 8], lead: 21, text: 'Принимаем предзаказы к 8 Марта — успейте забронировать' },
  bell: { name: 'Последний звонок', date: () => [4, 25], lead: 14, text: 'Букеты на последний звонок и выпускной — принимаем заказы' },
  sep1: { name: '1 сентября', date: () => [8, 1], lead: 14, text: 'Принимаем предзаказы букетов к 1 сентября' },
  teacher: { name: 'День учителя', date: () => [9, 5], lead: 10, text: 'Букеты ко Дню учителя — принимаем предзаказы' },
  mother: { name: 'День матери', date: (y) => [10, lastSunday(y, 10)], lead: 14, text: 'Букеты ко Дню матери — принимаем предзаказы' },
  newyear: { name: 'Новый год', date: () => [11, 31], lead: 21, text: 'Новогодние композиции и декор — принимаем заказы' },
};
// the coming (or today's) date of a holiday: midnight Moscow time
export function holidayDate(key, now = Date.now()) {
  const at = (y) => { const [m, d] = HOLIDAYS[key].date(y); return Date.UTC(y, m, d) - MSK; };
  const y = new Date(now + MSK).getUTCFullYear();
  return at(y) + DAY > now ? at(y) : at(y + 1);
}
export const daysUntil = (ts, now = Date.now()) => Math.round((ts - mskAt(0, 0, now)) / DAY);

// ---------- меню команд (видно только админам) ----------
export const ADMIN_COMMANDS = [
  { command: 'list', description: 'Что сейчас в наличии' },
  { command: 'orders', description: 'Открытые заявки с сайта' },
  { command: 'client', description: 'Клиенты и история заказов' },
  { command: 'works', description: 'Портфолио' },
  { command: 'reviews', description: 'Отзывы' },
  { command: 'stats', description: 'Статистика' },
  { command: 'banner', description: 'Объявление на сайте' },
  { command: 'pause', description: 'Мастерская на паузе' },
  { command: 'channel', description: 'Публикация в Telegram-канал' },
  { command: 'reviewchannel', description: 'Канал для отзывов' },
  { command: 'help', description: 'Как пользоваться ботом' },
];

// ---------- статистика ----------
export async function statsText(title = '📊 Статистика') {
  const [salesRaw, soldTotal, allStock, works, orders, reviews, clients] = await Promise.all([
    redis('LRANGE', 'sales', 0, 999), redis('GET', 'stock:sold'),
    hList('stock'), hList('works'), hList('orders'), hList('reviews'), hList('clients'),
  ]);
  const stock = allStock.filter((it) => it.status !== 'scheduled');
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
    `Клиентов: ${clients.length}, из них постоянных: ${clients.filter((c) => (c.refs || []).length > 1).length}`,
    `Отзывы: на сайте ${reviews.filter((v) => v.status === 'published').length}, ждут ${reviews.filter((v) => v.status === 'pending').length}`,
  ].join('\n');
}
