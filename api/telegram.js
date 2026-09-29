// POST /api/telegram — webhook of the shop bot.
// Irina sends a photo, the bot asks where it goes:
//   💐 Готовый букет  — «Пионы с эвкалиптом, 4500» (price required) → block «Готовые букеты»
//   🌷 Свежая поставка — «Пионы Сара Бернар, 350» (price per stem optional) → block «Свежая поставка»
//   🖼 В портфолио     — caption = title (optional), then a section → gallery «Примеры композиций»
// Buttons under a bouquet: 🔒 Бронь / ✅ Продано / 🏷 Скидка / 🗑 Удалить; under a flower: 🥀 Закончились.
// Orders, reservations and reviews from the site arrive here too, with buttons (texts in _shop.js).
// Everything is mirrored to the Telegram channel: the post is created on publish and updated on every status change.
import {
  tg, redis, hList, hGet, hSave, hDel, seq, listItems, getItem, saveItem, deleteItem, nextId, isAdmin, esc, fmtPrice,
} from './_lib.js';
import {
  ORDER_CONTACT, PHONE, CATS, FLOW, plural, isOpen, orderText, orderKeyboard, syncOrder,
  reviewText, reviewKeyboard, syncReview, statsText,
} from './_shop.js';

const DEFAULT_CHANNEL = '@FloristIrinaSleptsova';
let SITE = ''; // set per request from the Host header, used for links to the site
const DRAFT_TTL = 2 * 24 * 3600; // seconds a photo waits for the «куда добавить» answer

const HELP = [
  '🌸 Бот сайта мастерской.',
  '',
  '📸 Отправьте фото — бот спросит, куда его добавить:',
  '💐 Готовый букет — подпись с названием и ценой: «Пионы с эвкалиптом, 4500»',
  '🌷 Свежая поставка — сорт и, если хотите, цена за штуку: «Пионы Сара Бернар, 350»',
  '🖼 В портфолио — подпись = название работы (можно без неё), потом раздел. Альбом из нескольких фото тоже можно.',
  '',
  'Вторая строка подписи (необязательно) — короткое описание. Подпись можно исправить в Telegram — сайт обновится.',
  'Под букетом: 🔒 Бронь, ✅ Продано, 🏷 Скидка, 🗑 Удалить. Под цветком: 🥀 Закончились.',
  'Всё сразу публикуется и в Telegram-канал.',
  '',
  'Заявки, брони и отзывы с сайта приходят сюда — с кнопками.',
  '',
  '/list — что сейчас в наличии',
  '/orders — открытые заявки',
  '/works — портфолио',
  '/reviews — отзывы · /review Анна: спасибо за букет! — добавить отзыв самой',
  '/banner текст — объявление вверху сайта · /banner off — убрать',
  '/pause до 5 октября — «мастерская на паузе» · /pause off — снять',
  '/stats — статистика',
  '/channel — Telegram-канал (/channel off — не публиковать в канал)',
  '/reviewchannel — отдельный канал для отзывов (/reviewchannel off — выключить)',
].join('\n');

const clean = (s) => s.replace(/^[\s,.;:—–-]+|[\s,.;:—–-]+$/g, '').replace(/\s{2,}/g, ' ');
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isFlower = (it) => it.kind === 'flower';

// Caption → { title, price, note }. The price is the biggest number that isn't a size or a count,
// so «букет из 15 роз, 4500» gives 4500 and «Роза 60 см, 250» gives 250.
function parseText(text, { requirePrice, minPrice, fallback }) {
  const lines = String(text || '').split('\n').map((s) => s.trim()).filter(Boolean);
  if (!lines.length) return null;
  let best = null;
  lines.forEach((line, li) => {
    for (const m of line.matchAll(/\d[\d  .]*\d|\d/g)) {
      const after = line.slice(m.index + m[0].length);
      if (/^\s*(?:см|cm|мм|шт|стеб)/i.test(after)) continue;
      const n = Number(m[0].replace(/[  .]/g, ''));
      if (!best || n > best.n) best = { n, s: m[0], li, at: m.index };
    }
  });
  if (best && (best.n < minPrice || best.n > 10_000_000)) best = null;
  if (!best && requirePrice) return null;
  let rest = lines;
  if (best) {
    const priceRe = new RegExp(
      `(?:цена|стоимость|за)?\\s*[:—–-]?\\s*${escapeRe(best.s)}\\s*(?:₽|рубл\\p{L}*|руб\\.?|р\\.?)?(?:\\s*(?:\\/|за)\\s*(?:шт\\.?|штук\\p{L}*|стебель|стебл\\p{L}*))?(?!\\p{L})`, 'iu');
    rest = lines.map((l, i) => (i === best.li ? clean(l.replace(priceRe, ' ')) : l)).filter(Boolean);
  }
  const title = cap(clean(rest[0] || fallback)).slice(0, 80);
  const note = clean(rest.slice(1).join(' ')).slice(0, 220);
  return { title, price: best ? best.n : null, note };
}

// «Пионы с эвкалиптом, 4500» → { title: 'Пионы с эвкалиптом', price: 4500, note: '' }
export const parseCaption = (text) => parseText(text, { requirePrice: true, minPrice: 50, fallback: 'Букет' });
// «Пионы Сара Бернар, 350» → { title: 'Пионы Сара Бернар', price: 350, note: '' }; price may be null
export const parseFlower = (text) => parseText(text, { requirePrice: false, minPrice: 10, fallback: 'Цветы' });
// portfolio shows no prices: «Пионы и эвкалипт, 4500» → 'Пионы и эвкалипт', but «Свадьба 2025» stays as is;
// no caption → name of the section
export const parseWork = (text, cat) => {
  const line = String(text || '').split('\n').map((s) => s.trim()).find(Boolean) || '';
  const title = clean(line
    .replace(/\s*(?:цена|стоимость)?\s*:?\s*\d[\d  ]*\s*(?:₽|руб\p{L}*\.?|р\.?)\s*$/iu, '')
    .replace(/\s*[,;—–-]\s*(?:цена|стоимость)?\s*:?\s*\d[\d  ]{2,}\s*$/u, ''));
  return title ? cap(title).slice(0, 80) : CATS[cat]?.one || 'Композиция';
};
const parseFor = (kind, text) => (kind === 'flower' ? parseFlower(text) : parseCaption(text));

const pickPhoto = (sizes) => sizes.filter((p) => Math.max(p.width, p.height) <= 1600).pop() || sizes[0];
const draftKey = (chat, msgId) => `draft:${chat}:${msgId}`;
const NO_BUTTONS = { inline_keyboard: [] };

const priceText = (it) => (it.oldPrice
  ? `${fmtPrice(it.price)} (−${it.discount}%, было ${fmtPrice(it.oldPrice)})`
  : fmtPrice(it.price));

function cardText(it, head) {
  if (isFlower(it)) {
    const price = it.price ? ` — ${fmtPrice(it.price)}/шт` : '';
    return [head, `🌷 Поставка · ${it.title}${price}`, it.note, head ? '' : 'Статус: 🟢 на сайте'].filter(Boolean).join('\n');
  }
  const status = it.status === 'reserved' ? '🔒 забронирован' : '🟢 на сайте';
  return [head, `№${it.id} · ${it.title} — ${priceText(it)}`, it.note, `Статус: ${status}`]
    .filter(Boolean).join('\n');
}
const goneText = (it, head) => cardText(it, head).replace(/\nСтатус:.*$/, '');

function keyboard(it) {
  if (isFlower(it)) return { inline_keyboard: [[{ text: '🥀 Закончились', callback_data: `s:${it.id}` }]] };
  const toggle = it.status === 'reserved'
    ? { text: '↩️ Снять бронь', callback_data: `a:${it.id}` }
    : { text: '🔒 Бронь', callback_data: `r:${it.id}` };
  return {
    inline_keyboard: [
      [toggle, { text: '✅ Продано', callback_data: `s:${it.id}` }],
      [{ text: '🏷 Скидка', callback_data: `ds:${it.id}` }, { text: '🗑 Удалить', callback_data: `d:${it.id}` }],
    ],
  };
}

function discountKeyboard(it) {
  const rows = [[10, 15, 20, 30].map((p) => ({ text: (it.discount === p ? '✓ ' : '') + `−${p}%`, callback_data: `p:${it.id}:${p}` }))];
  if (it.oldPrice) rows.push([{ text: `↩️ Без скидки (${fmtPrice(it.oldPrice)})`, callback_data: `p:${it.id}:0` }]);
  rows.push([{ text: '← Назад', callback_data: `k:${it.id}` }]);
  return { inline_keyboard: rows };
}

const KIND_KEYBOARD = (msgId) => ({
  inline_keyboard: [
    [{ text: '💐 Готовый букет', callback_data: `tb:${msgId}` }, { text: '🌷 Свежая поставка', callback_data: `tf:${msgId}` }],
    [{ text: '🖼 В портфолио', callback_data: `tw:${msgId}` }],
  ],
});

function catKeyboard(prefix, back) {
  const btns = Object.entries(CATS).map(([k, c]) => ({ text: c.name, callback_data: `${prefix}:${k}` }));
  const rows = [btns.slice(0, 3), btns.slice(3)];
  if (back) rows.push([{ text: '← Назад', callback_data: back }]);
  return { inline_keyboard: rows };
}

const workText = (w, head) => [head, `🖼 Портфолио · ${CATS[w.cat]?.name || w.cat}`, w.title].filter(Boolean).join('\n');
const workKeyboard = (w) => ({ inline_keyboard: [[{ text: '🗑 Убрать из портфолио', callback_data: `w:${w.id}:del` }]] });

const send = (chat_id, text, extra = {}) => tg('sendMessage', { chat_id, text, disable_web_page_preview: true, ...extra });
const sendHtml = (chat_id, text, extra = {}) => send(chat_id, text, { parse_mode: 'HTML', ...extra });
const replyTo = (msg) => ({ reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true } });

// ---------- Telegram channel ----------
async function getChannel() {
  const c = await redis('GET', 'channel');
  return c === 'off' ? null : c || DEFAULT_CHANNEL;
}

const orderButtons = (text, label) => {
  const q = encodeURIComponent(text);
  return [{ text: `💬 ${label}`, url: `${ORDER_CONTACT}?text=${q}` }, { text: 'WhatsApp', url: `https://wa.me/${PHONE}?text=${q}` }];
};

// caption + buttons of a channel post; state: available | reserved | sold | gone
function channelPost(it, state = it.status) {
  const flower = isFlower(it);
  const mark = { reserved: '🔒 <b>Забронирован</b>', sold: '✅ <b>Продано</b>', gone: '🥀 <b>Закончились</b> — ждём новую поставку' }[state];
  const lines = mark ? [mark, ''] : [];
  if (flower) {
    lines.push('🌷 Свежая поставка', `<b>${esc(it.title)}</b>` + (it.price ? ` — ${fmtPrice(it.price)}/шт` : ''));
    if (it.note) lines.push(esc(it.note));
    if (state === 'available') lines.push('', 'Соберём букет из свежих цветов — пишите!');
  } else {
    const price = state === 'sold' ? `<s>${fmtPrice(it.price)}</s>`
      : it.oldPrice ? `<s>${fmtPrice(it.oldPrice)}</s> <b>${fmtPrice(it.price)}</b> · скидка ${it.discount}%`
      : fmtPrice(it.price);
    lines.push(`💐 Готовый букет · №${it.id}`, `<b>${esc(it.title)}</b>`, price);
    if (it.note) lines.push(esc(it.note));
    if (state === 'available') lines.push('', 'Можно забрать сегодня · доставка по Тучково 0 ₽');
  }
  const text = flower ? `Здравствуйте, Ирина! Хочу букет со свежими цветами: ${it.title}.`
    : state === 'available' ? `Здравствуйте, Ирина! Хочу забронировать букет «${it.title}» (№${it.id}) за ${fmtPrice(it.price)}.`
    : `Здравствуйте, Ирина! Хочу букет, похожий на «${it.title}» (№${it.id}).`;
  const rows = [];
  if (state !== 'gone') rows.push(orderButtons(text, flower ? 'Заказать букет' : state === 'available' ? 'Забронировать' : 'Хочу похожий'));
  if (SITE) rows.push([{ text: '🌸 Всё в наличии на сайте', url: `${SITE}/#stock` }]);
  return { caption: lines.join('\n'), parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } };
}

// portfolio post; album photos can't carry buttons, so they get a link in the caption instead
function workPost(w, albumSize = 0) {
  const lines = [`🖼 Новая работа · ${CATS[w.cat]?.name || ''}`, `<b>${esc(w.title)}</b>`];
  if (albumSize > 1) lines[0] += ` · ${albumSize} фото`;
  lines.push('', 'Соберём похожую под ваш повод — пишите!');
  if (albumSize > 1 || w.album) {
    lines.push(`💬 ${ORDER_CONTACT.replace('https://', '')} · WhatsApp +7 (926) 467-80-00`);
    if (SITE) lines.push(`<a href="${SITE}/#gallery">Все работы на сайте</a>`);
    return { caption: lines.join('\n'), parse_mode: 'HTML' };
  }
  const rows = [orderButtons(`Здравствуйте, Ирина! Хочу похожую работу: «${w.title}».`, 'Хочу похожий')];
  if (SITE) rows.push([{ text: '🌸 Все работы на сайте', url: `${SITE}/#gallery` }]);
  return { caption: lines.join('\n'), parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } };
}

const NO_RIGHTS = /not enough rights|chat not found|not a member|administrator|CHAT_ADMIN_REQUIRED|have no rights/i;
const HOW_TO_ADMIN = 'добавьте бота администратором канала (Управление каналом → Администраторы) с правами «Публикация», «Редактирование» и «Удаление сообщений»';
const channelError = (e) => '⚠️ В канал не отправлено: ' + (NO_RIGHTS.test(e.message) ? HOW_TO_ADMIN : e.message);

async function postToChannel(item) {
  const channel = await getChannel();
  if (!channel) return '';
  try {
    const m = await tg('sendPhoto', { chat_id: channel, photo: item.fileId, ...channelPost(item) });
    item.channelChat = m.chat.id;
    item.channelMsg = m.message_id;
    return '📣 и в канале';
  } catch (e) {
    return channelError(e);
  }
}

async function postWorks(works) {
  const channel = await getChannel();
  if (!channel) return '';
  try {
    if (works.length === 1) {
      const m = await tg('sendPhoto', { chat_id: channel, photo: works[0].fileId, ...workPost(works[0]) });
      Object.assign(works[0], { channelChat: m.chat.id, channelMsg: m.message_id });
    } else {
      const { caption, parse_mode } = workPost(works[0], works.length);
      const media = works.map((w, i) => ({ type: 'photo', media: w.fileId, ...(i === 0 ? { caption, parse_mode } : {}) }));
      const sent = await tg('sendMediaGroup', { chat_id: channel, media });
      sent.forEach((m, i) => works[i] && Object.assign(works[i], { channelChat: m.chat.id, channelMsg: m.message_id, album: true }));
    }
    return '📣 и в канале';
  } catch (e) {
    return channelError(e);
  }
}

const syncChannel = (item, state) => item.channelMsg
  ? tg('editMessageCaption', { chat_id: item.channelChat, message_id: item.channelMsg, ...channelPost(item, state) }).catch(() => {})
  : null;
const dropChannelPost = (row) => row.channelMsg
  ? tg('deleteMessage', { chat_id: row.channelChat, message_id: row.channelMsg }).catch(() => {})
  : null;

// two channels: the main one (bouquets, flowers, works) and an optional one only for reviews
const CHANNELS = {
  main: { key: 'channel', cmd: '/channel', what: 'букеты, поставки и работы' },
  reviews: { key: 'reviewChannel', cmd: '/reviewchannel', what: 'опубликованные отзывы' },
};
const botId = () => Number(String(process.env.TELEGRAM_BOT_TOKEN).split(':')[0]);
const getReviewChannel = async () => (await redis('GET', 'reviewChannel')) || null;

async function onChannel(chat, arg, kind = 'main') {
  const c = CHANNELS[kind];
  if (!arg) {
    const cur = kind === 'main' ? await getChannel() : await getReviewChannel();
    // the next post forwarded from a channel within 10 minutes connects it — works for private channels too
    await redis('SET', `await:${chat}`, kind, 'EX', 600);
    const how = `пришлите ${c.cmd} @имя_канала или перешлите сюда любой пост из канала.`;
    if (kind === 'main') {
      return send(chat, cur ? `Публикую в канал ${cur}.\n${c.cmd} off — выключить\nДругой канал — ${how}` : `Публикация в канал выключена.\nВключить — ${how}`);
    }
    return send(chat, cur
      ? `Отзывы публикую в канал ${cur}.\n${c.cmd} off — выключить\nДругой канал — ${how}`
      : `Канал для отзывов не подключён.\n1. Создайте канал в Telegram и добавьте бота администратором с правами «Публикация», «Редактирование» и «Удаление сообщений».\n2. Затем ${how}`);
  }
  if (arg === 'off') {
    if (kind === 'main') await redis('SET', 'channel', 'off');
    else await redis('DEL', 'reviewChannel');
    return send(chat, kind === 'main' ? 'Готово: в канал больше не публикую, только на сайт.' : 'Готово: отзывы больше не публикую в канал, только на сайт.');
  }
  const name = /^(@|-100)/.test(arg) ? arg : '@' + arg.replace(/^(https?:\/\/)?t\.me\//, '');
  return connectChannel(chat, kind, name);
}

async function connectChannel(chat, kind, ref) {
  const c = CHANNELS[kind];
  const byName = String(ref).startsWith('@');
  try {
    const ch = await tg('getChat', { chat_id: ref });
    const me = await tg('getChatMember', { chat_id: ch.id, user_id: botId() });
    if (me.status !== 'administrator' || !me.can_post_messages) {
      return send(chat, `Не могу публиковать в ${byName ? ref : `«${ch.title || ref}»`}: ${HOW_TO_ADMIN}.`);
    }
    await redis('SET', c.key, byName ? ref : ch.username ? '@' + ch.username : String(ch.id));
    await redis('DEL', `await:${chat}`);
    const done = `Готово: ${c.what} будут публиковаться в «${ch.title || ref}».`;
    if (kind === 'main') return send(chat, done);
    const waiting = (await hList('reviews')).filter((v) => v.status === 'published' && !v.channelMsg).length;
    return send(chat, done, waiting
      ? { reply_markup: { inline_keyboard: [[{ text: `📣 Выложить уже одобренные (${waiting})`, callback_data: 'rc:all' }]] } }
      : {});
  } catch (e) {
    return send(chat, `Не нашёл канал ${ref}: ${e.message}`);
  }
}

// ---------- reviews channel ----------
function reviewPost(v) {
  const lines = ['★'.repeat(v.rating) + '☆'.repeat(5 - v.rating), '', `«${esc(v.text)}»`, '', `— <b>${esc(v.name)}</b>`];
  const row = [{ text: '💐 Заказать букет', url: ORDER_CONTACT }];
  if (SITE) row.push({ text: '✍️ Оставить отзыв', url: `${SITE}/#reviews` });
  return { text: lines.join('\n'), parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: { inline_keyboard: [row] } };
}

// returns a line for Irina: '' when the reviews channel is off
async function postReview(v) {
  const channel = await getReviewChannel();
  if (!channel || v.channelMsg) return '';
  try {
    const m = await tg('sendMessage', { chat_id: channel, ...reviewPost(v) });
    Object.assign(v, { channelChat: m.chat.id, channelMsg: m.message_id });
    return '📣 и в канале отзывов';
  } catch (e) {
    return channelError(e).replace('В канал', 'В канал отзывов');
  }
}

async function unpostReview(v) {
  await dropChannelPost(v);
  delete v.channelChat;
  delete v.channelMsg;
}

// ---------- items: shared steps ----------
// the card is the bot message that became «Опубликовано на сайте»; keep it current when the change comes from elsewhere
const touchCard = (item, text, reply_markup = NO_BUTTONS) => (item.cardMsg
  ? tg('editMessageText', { chat_id: item.chatId, message_id: item.cardMsg, text, reply_markup }).catch(() => {})
  : null);

// a site reservation (заявка) linked to the bouquet follows the bouquet's fate
async function closeReservation(item, status) {
  if (!item.reservedBy) return;
  const o = await hGet('orders', item.reservedBy);
  delete item.reservedBy;
  if (o && o.status === 'ok') {
    o.status = status;
    await hSave('orders', o);
    await syncOrder(o);
  }
}

// how: sold | gone | deleted
async function removeItem(item, how, { linkedOrder = true } = {}) {
  await deleteItem(item.id);
  if (how === 'sold') {
    await redis('INCR', 'stock:sold');
    await redis('LPUSH', 'sales', JSON.stringify({ id: item.id, title: item.title, price: item.price, at: Date.now() }));
    await redis('LTRIM', 'sales', 0, 999);
  }
  if (linkedOrder) await closeReservation(item, how === 'sold' ? 'sold' : 'free');
  if (how === 'deleted') await dropChannelPost(item);
  else await syncChannel(item, how);
  return goneText(item, { sold: '✅ Продано — снят с сайта', gone: '🥀 Закончились — сняты с сайта', deleted: '🗑 Удалён с сайта' }[how]);
}

function applyDiscount(item, pct) {
  const base = item.oldPrice || item.price;
  if (pct > 0) Object.assign(item, { oldPrice: base, discount: pct, price: Math.max(10, Math.round((base * (100 - pct)) / 1000) * 10) });
  else { item.price = base; delete item.oldPrice; delete item.discount; }
}

// ---------- photos ----------
async function onPhoto(msg) {
  const fileId = pickPhoto(msg.photo).file_id;
  if (msg.media_group_id) return onAlbumPhoto(msg, fileId);
  const draft = { fileId, caption: msg.caption || '', chatId: msg.chat.id, srcMsg: msg.message_id };
  await redis('SET', draftKey(msg.chat.id, msg.message_id), JSON.stringify(draft), 'EX', DRAFT_TTL);
  const hint = String(msg.caption || '').trim() ? ''
    : '\n\nДля букета и поставки нужна подпись — нажмите у фото «Изменить» и допишите, например: Пионы с эвкалиптом, 4500';
  await send(msg.chat.id, 'Куда добавить на сайте?' + hint, { ...replyTo(msg), reply_markup: KIND_KEYBOARD(msg.message_id) });
}

// albums go to the portfolio: every photo of the group is collected, the question is asked once
async function onAlbumPhoto(msg, fileId) {
  const key = `album:${msg.chat.id}:${msg.media_group_id}`;
  await redis('RPUSH', key, JSON.stringify({ fileId, caption: msg.caption || '', srcMsg: msg.message_id }));
  await redis('EXPIRE', key, DRAFT_TTL);
  if ((await redis('SET', key + ':q', '1', 'NX', 'EX', DRAFT_TTL)) !== 'OK') return;
  await send(msg.chat.id, 'Альбом добавлю в портфолио — выберите раздел.\n(Готовые букеты и поставку отправляйте по одному фото.)',
    { ...replyTo(msg), reply_markup: catKeyboard(`ga:${msg.media_group_id}`) });
}

async function onEditedPhoto(msg) {
  const fileId = pickPhoto(msg.photo).file_id;
  const key = draftKey(msg.chat.id, msg.message_id);
  const raw = await redis('GET', key);
  if (raw) { // not published yet — just remember the new caption
    const draft = { ...JSON.parse(raw), caption: msg.caption || '', fileId };
    return redis('SET', key, JSON.stringify(draft), 'EX', DRAFT_TTL);
  }
  const mine = (row) => row.chatId === msg.chat.id && row.srcMsg === msg.message_id;
  const item = (await listItems()).find(mine);
  if (item) {
    const parsed = parseFor(item.kind, msg.caption);
    if (!parsed) return send(msg.chat.id, 'Не вижу цену в подписи — на сайте осталась прежняя.', replyTo(msg));
    const { price, ...rest } = parsed;
    Object.assign(item, rest, { fileId });
    // the same base price keeps the discount, a new price replaces it
    if (!(item.oldPrice && price === item.oldPrice)) { item.price = price; delete item.oldPrice; delete item.discount; }
    await saveItem(item);
    await syncChannel(item, item.status);
    return touchCard(item, cardText(item, '✏️ Обновлено на сайте'), keyboard(item));
  }
  const work = (await hList('works')).find(mine);
  if (!work) return;
  Object.assign(work, { title: parseWork(msg.caption, work.cat), fileId });
  await hSave('works', work);
  if (work.channelMsg) {
    await tg('editMessageCaption', { chat_id: work.channelChat, message_id: work.channelMsg, ...workPost(work) }).catch(() => {});
  }
  if (!work.album) await touchCard(work, workText(work, '✏️ Обновлено на сайте'), workKeyboard(work));
}

// ---------- commands ----------
async function onList(chat) {
  const items = await listItems();
  if (!items.length) return send(chat, 'На сайте сейчас пусто.\nОтправьте фото с подписью, чтобы добавить букет или цветы из поставки.');
  const bouquets = items.filter((it) => !isFlower(it)).length;
  await send(chat, `На сайте сейчас:\n💐 готовых букетов — ${bouquets}\n🌷 цветов из поставки — ${items.length - bouquets}`);
  for (const it of items.slice(0, 30)) {
    await tg('sendPhoto', { chat_id: chat, photo: it.fileId, caption: cardText(it), reply_markup: keyboard(it) });
  }
}

async function onOrders(chat) {
  const open = (await hList('orders')).filter(isOpen).slice(0, 20);
  if (!open.length) return send(chat, 'Открытых заявок нет 🌿\nНовые заявки с сайта приходят сюда сами.');
  await send(chat, `Открытых заявок: ${open.length}`);
  for (const o of open.reverse()) {
    const m = await sendHtml(chat, orderText(o), { reply_markup: orderKeyboard(o) });
    o.msgs = [...(o.msgs || []), { chat, id: m.message_id }].slice(-10);
    await hSave('orders', o);
  }
}

async function onWorks(chat) {
  const works = await hList('works');
  if (!works.length) return send(chat, 'В портфолио на сайте пока только постоянные фото.\nОтправьте фото и выберите «🖼 В портфолио».');
  const counts = Object.entries(CATS).map(([k, c]) => [c.name, works.filter((w) => w.cat === k).length]).filter(([, n]) => n);
  await send(chat, `Добавлено через бота: ${works.length}\n` + counts.map(([n, c]) => `• ${n} — ${c}`).join('\n')
    + (works.length > 20 ? '\n\nНиже — последние 20.' : ''));
  for (const w of works.slice(0, 20)) {
    await tg('sendPhoto', { chat_id: chat, photo: w.fileId, caption: workText(w), reply_markup: workKeyboard(w) });
  }
}

async function sendReview(chat, v) {
  const m = await sendHtml(chat, reviewText(v), { reply_markup: reviewKeyboard(v) });
  v.msgs = [...(v.msgs || []), { chat, id: m.message_id }].slice(-10);
  await hSave('reviews', v);
}

async function onReviews(chat) {
  const all = await hList('reviews');
  if (!all.length) return send(chat, 'Отзывов пока нет.\nОтзывы с сайта придут сюда на проверку.\nДобавить самой: /review Анна: спасибо за чудесный букет!');
  const pub = all.filter((v) => v.status === 'published').length;
  await send(chat, `Отзывов на сайте: ${pub}, ждут проверки: ${all.filter((v) => v.status === 'pending').length}` + (all.length > 20 ? '\nНиже — последние 20.' : ''));
  for (const v of all.slice(0, 20).reverse()) await sendReview(chat, v);
}

// «/review Анна: спасибо!» — for reviews that came by phone or WhatsApp; 1–5 stars at the end are optional
async function onReviewAdd(chat, arg) {
  const m = String(arg || '').match(/^([^:\n]{1,40}):\s*([\s\S]{3,})$/);
  if (!m) return send(chat, 'Напишите так:\n/review Анна: Спасибо за чудесный букет!\nМожно добавить оценку в конце: ★★★★ или 4/5 (по умолчанию 5).');
  let text = m[2].trim(), rating = 5;
  const r = text.match(/\s*(?:(★{1,5})|\b([1-5])\s*\/\s*5)\s*$/);
  if (r) { rating = r[1] ? r[1].length : Number(r[2]); text = text.slice(0, r.index).trim(); }
  const v = { id: await seq('reviews'), name: m[1].trim(), text: text.slice(0, 800), rating, status: 'published', createdAt: Date.now(), source: 'bot' };
  const note = await postReview(v);
  await hSave('reviews', v);
  await send(chat, '✨ Отзыв добавлен на сайт.' + (note ? '\n' + note : ''));
  return sendReview(chat, v);
}

// /banner and /pause: one line of text shown at the top of the site
async function onNotice(chat, key, arg) {
  if (!arg) {
    const cur = await redis('GET', key);
    const text = cur ? JSON.parse(cur).text : '';
    return send(chat, key === 'pause'
      ? (text ? `Сейчас на сайте: «Мастерская на паузе — ${text}».\n/pause off — снять` : 'Паузы нет.\n/pause до 5 октября — показать на сайте, что мастерская временно не работает.')
      : (text ? `Сейчас на сайте: «${text}».\n/banner off — убрать` : 'Объявления нет.\n/banner Принимаем предзаказы на 14 февраля — показать вверху сайта.'));
  }
  if (/^(off|выкл|нет|-)$/i.test(arg)) {
    await redis('DEL', key);
    return send(chat, key === 'pause' ? 'Готово: пауза снята, на сайте её больше нет.' : 'Готово: объявление убрано с сайта.');
  }
  const text = arg.replace(/\s+/g, ' ').trim().slice(0, 160);
  await redis('SET', key, JSON.stringify({ text, at: Date.now() }));
  return send(chat, key === 'pause'
    ? `Готово: на сайте «Мастерская на паузе — ${text}». Заявки принимаются, вы ответите позже.\n/pause off — снять`
    : `Готово: вверху сайта «${text}».\n/banner off — убрать`);
}

// ---------- buttons ----------
async function onCallback(q) {
  const answer = (text, alert = false) => tg('answerCallbackQuery', { callback_query_id: q.id, text, show_alert: alert });
  if (!(await isAdmin(q.from.id))) return answer('Нет доступа');
  const [act, id, arg] = String(q.data || '').split(':');
  const m = q.message;
  const edit = (text, reply_markup = NO_BUTTONS, extra = {}) => {
    const target = { chat_id: m.chat.id, message_id: m.message_id, reply_markup, ...extra };
    return (m.photo ? tg('editMessageCaption', { ...target, caption: text }) : tg('editMessageText', { ...target, text, disable_web_page_preview: true }))
      .catch(() => {});
  };
  const editButtons = (reply_markup) => tg('editMessageReplyMarkup', { chat_id: m.chat.id, message_id: m.message_id, reply_markup }).catch(() => {});

  // --- a photo waiting for «куда добавить» ---
  if (['tb', 'tf', 'tw', 'tk', 'wc'].includes(act)) {
    const key = draftKey(m.chat.id, id);
    const raw = await redis('GET', key);
    if (!raw) {
      await answer('Фото устарело — отправьте его ещё раз');
      return edit('Фото устарело — отправьте его ещё раз.');
    }
    const draft = JSON.parse(raw);
    if (act === 'tw') { await answer(''); return edit('В какой раздел портфолио?', catKeyboard(`wc:${id}`, `tk:${id}`)); }
    if (act === 'tk') { await answer(''); return edit('Куда добавить на сайте?', KIND_KEYBOARD(id)); }
    if (act === 'wc') {
      if (!CATS[arg]) return answer('');
      await redis('DEL', key);
      const w = {
        id: await seq('works'), cat: arg, title: parseWork(draft.caption, arg), fileId: draft.fileId,
        createdAt: Date.now(), chatId: draft.chatId, srcMsg: draft.srcMsg, cardMsg: m.message_id,
      };
      const channelNote = await postWorks([w]);
      await hSave('works', w);
      await answer('Добавлено в портфолио');
      return edit(workText(w, ['✨ Добавлено в портфолио на сайте', channelNote].filter(Boolean).join('\n')), workKeyboard(w));
    }
    const kind = act === 'tf' ? 'flower' : 'bouquet';
    const parsed = parseFor(kind, draft.caption);
    if (!parsed) {
      return answer(kind === 'flower'
        ? 'Для поставки нужна подпись — сорт цветов. Допишите её к фото (Изменить) и нажмите кнопку ещё раз.'
        : 'Для готового букета нужна цена. Допишите её в подпись к фото (Изменить) и нажмите кнопку ещё раз.', true);
    }
    await redis('DEL', key);
    const item = {
      id: await nextId(), kind, ...parsed, status: 'available', fileId: draft.fileId,
      createdAt: Date.now(), chatId: draft.chatId, srcMsg: draft.srcMsg, cardMsg: m.message_id,
    };
    await saveItem(item);
    const channelNote = await postToChannel(item);
    if (item.channelMsg) await saveItem(item);
    await answer('Опубликовано');
    return edit(cardText(item, ['✨ Опубликовано на сайте', channelNote].filter(Boolean).join('\n')), keyboard(item));
  }

  // --- an album → portfolio ---
  if (act === 'ga') {
    const key = `album:${m.chat.id}:${id}`;
    const photos = ((await redis('LRANGE', key, 0, -1)) || []).map((s) => JSON.parse(s)).sort((a, b) => a.srcMsg - b.srcMsg);
    if (!photos.length || !CATS[arg]) {
      await answer('Альбом устарел — отправьте его ещё раз');
      return edit('Альбом устарел — отправьте его ещё раз.');
    }
    await redis('DEL', key);
    const caption = (photos.find((p) => p.caption.trim()) || { caption: '' }).caption;
    const now = Date.now();
    const works = [];
    for (const [i, p] of photos.slice(0, 10).entries()) {
      works.push({
        id: await seq('works'), cat: arg, title: parseWork(caption, arg), fileId: p.fileId,
        createdAt: now - i, chatId: m.chat.id, srcMsg: p.srcMsg, cardMsg: m.message_id, album: true,
      });
    }
    const channelNote = await postWorks(works);
    for (const w of works) await hSave('works', w);
    await answer('Добавлено в портфолио');
    return edit([`✨ В портфолио добавлено: ${plural(works.length, ['фото', 'фото', 'фото'])}`, channelNote,
      `🖼 ${CATS[arg].name} · ${works[0].title}`, 'Убрать отдельные фото — /works'].filter(Boolean).join('\n'));
  }

  // --- заявки с сайта ---
  if (act === 'o') {
    const o = await hGet('orders', id);
    if (!o) return answer('Заявка не найдена');
    if (!FLOW[o.type]?.[o.status]?.includes(arg)) {
      await answer('Эта заявка уже обработана');
      return syncOrder(o);
    }
    if (o.type === 'reserve') {
      const item = await getItem(o.itemId);
      if (arg === 'ok') {
        if (!item) return answer('Этого букета уже нет на сайте — нажмите «Отказать».', true);
        if (item.status === 'reserved' && item.reservedBy !== o.id) return answer('Букет уже забронирован другой заявкой.', true);
        Object.assign(item, { status: 'reserved', reservedBy: o.id });
        await saveItem(item);
        await syncChannel(item, 'reserved');
        await touchCard(item, cardText(item), keyboard(item));
      }
      if (arg === 'sold' && item) await touchCard(item, await removeItem(item, 'sold', { linkedOrder: false }));
      if (arg === 'free' && item && item.status === 'reserved') {
        item.status = 'available';
        delete item.reservedBy;
        await saveItem(item);
        await syncChannel(item, 'available');
        await touchCard(item, cardText(item), keyboard(item));
      }
    }
    Object.assign(o, { status: arg, updatedAt: Date.now() });
    if (!(o.msgs || []).some((x) => x.chat === m.chat.id && x.id === m.message_id)) o.msgs = [...(o.msgs || []), { chat: m.chat.id, id: m.message_id }];
    await hSave('orders', o);
    await syncOrder(o);
    return answer('Готово');
  }

  // --- отзывы ---
  if (act === 'v') {
    const v = await hGet('reviews', id);
    if (!v) { await answer('Отзыв уже удалён'); return edit('🗑 Отзыв удалён'); }
    const wasPosted = Boolean(v.channelMsg);
    let note = '';
    if (arg === 'del') {
      await hDel('reviews', v.id);
      await unpostReview(v);
      v.status = 'deleted';
    } else {
      v.status = arg === 'pub' ? 'published' : 'hidden';
      if (v.status === 'published') note = await postReview(v);
      else await unpostReview(v);
      await hSave('reviews', v);
    }
    await syncReview(v);
    if (note.startsWith('⚠️')) await send(m.chat.id, note);
    const posted = note.startsWith('📣');
    return answer({
      pub: posted ? 'Опубликован на сайте и в канале отзывов' : 'Опубликован на сайте',
      hide: wasPosted ? 'Скрыт с сайта и из канала' : 'Скрыт с сайта',
      del: 'Удалён',
    }[arg] || '');
  }

  // --- выложить в канал отзывы, одобренные до его подключения ---
  if (act === 'rc') {
    if (!(await getReviewChannel())) return answer('Канал для отзывов не подключён', true);
    const list = (await hList('reviews')).filter((v) => v.status === 'published' && !v.channelMsg).reverse().slice(0, 30);
    await answer('Выкладываю…');
    let posted = 0, note = '';
    for (const v of list) {
      note = await postReview(v);
      if (!v.channelMsg) break;
      await hSave('reviews', v);
      posted++;
    }
    return edit(`Готово: в канал выложено ${plural(posted, ['отзыв', 'отзыва', 'отзывов'])}.` + (note.startsWith('⚠️') ? '\n' + note : ''));
  }

  // --- портфолио ---
  if (act === 'w') {
    const w = await hGet('works', id);
    if (!w) { await answer('Уже убрано'); return edit((m.caption || m.text || '') + '\n— убрано с сайта'); }
    await hDel('works', w.id);
    await dropChannelPost(w);
    await answer('Убрано из портфолио');
    return edit(workText(w, '🗑 Убрано из портфолио (и из канала)'));
  }

  // --- букеты и цветы ---
  const item = await getItem(id);
  if (!item) {
    await answer('Этого уже нет на сайте');
    return edit((m.caption || m.text || '') + '\n— снято с сайта');
  }
  // the pressed message and the main card show the same text
  const show = async (text, kb = keyboard(item)) => {
    await edit(text, kb);
    if (m.chat.id !== item.chatId || m.message_id !== item.cardMsg) await touchCard(item, text, kb);
  };
  if (act === 'r' || act === 'a') {
    item.status = act === 'r' ? 'reserved' : 'available';
    if (act === 'a') await closeReservation(item, 'free');
    await saveItem(item);
    await syncChannel(item, item.status);
    await answer(act === 'r' ? 'На сайте отмечен как забронированный' : 'Снова доступен для заказа');
    return show(cardText(item));
  }
  if (act === 's' || act === 'd') {
    const text = await removeItem(item, act === 'd' ? 'deleted' : isFlower(item) ? 'gone' : 'sold');
    await answer('Снято с сайта');
    return show(text, NO_BUTTONS);
  }
  if (act === 'ds') {
    if (isFlower(item) || !item.price) return answer('');
    await answer('Выберите скидку');
    return editButtons(discountKeyboard(item));
  }
  if (act === 'k') { await answer(''); return editButtons(keyboard(item)); }
  if (act === 'p') {
    applyDiscount(item, Number(arg) || 0);
    await saveItem(item);
    await syncChannel(item, item.status);
    await answer(item.discount ? `Скидка ${item.discount}%: ${fmtPrice(item.price)}` : 'Скидка снята');
    return show(cardText(item, item.discount ? `🏷 Скидка ${item.discount}% — на сайте и в канале` : '🏷 Скидка снята'));
  }
  if (act === 'ok') { // «оставить» from the daily reminder
    await answer('Оставили на сайте');
    return edit((m.text || '') + '\n\n👌 Оставили на сайте');
  }
  return answer('');
}

export async function onUpdate(u) {
  if (u.callback_query) return onCallback(u.callback_query);
  const msg = u.message || u.edited_message;
  if (!msg || msg.chat.type !== 'private') return;
  if (u.edited_message && !msg.photo) return;
  const chat = msg.chat.id;
  const text = (msg.text || '').trim();

  const admin = text.match(/^\/admin(?:@\w+)?\s+(\S+)/);
  if (admin) {
    if (admin[1] !== process.env.TELEGRAM_SECRET) return send(chat, 'Неверный код.');
    await redis('SADD', 'admins', msg.from.id);
    return send(chat, 'Готово — теперь вы можете публиковать на сайте, а заявки с сайта будут приходить сюда.\n\n' + HELP);
  }
  if (!(await isAdmin(msg.from?.id))) {
    return send(chat, `Здравствуйте! Это служебный бот мастерской «флорист Ирина Слепцова».\nЗаказать букет: ${ORDER_CONTACT}`);
  }
  const fwd = msg.forward_origin?.type === 'channel' ? msg.forward_origin.chat : msg.forward_from_chat;
  if (fwd && !u.edited_message) {
    const kind = await redis('GET', `await:${chat}`);
    if (kind && CHANNELS[kind]) return connectChannel(chat, kind, fwd.username ? '@' + fwd.username : fwd.id);
  }
  if (msg.photo) return u.edited_message ? onEditedPhoto(msg) : onPhoto(msg);

  const cmd = text.match(/^\/(\w+)(?:@\w+)?(?:\s+([\s\S]+))?$/);
  const arg = cmd?.[2]?.trim() || '';
  switch (cmd?.[1]) {
    case 'list': return onList(chat);
    case 'orders': return onOrders(chat);
    case 'works': return onWorks(chat);
    case 'reviews': return onReviews(chat);
    case 'review': return onReviewAdd(chat, arg);
    case 'banner': return onNotice(chat, 'banner', arg);
    case 'pause': return onNotice(chat, 'pause', arg);
    case 'stats': return sendHtml(chat, await statsText());
    case 'channel': return onChannel(chat, arg.split(/\s+/)[0], 'main');
    case 'reviewchannel': return onChannel(chat, arg.split(/\s+/)[0], 'reviews');
    default: return send(chat, HELP);
  }
}

export default async function handler(req, res) {
  const secret = process.env.TELEGRAM_SECRET;
  if (req.method !== 'POST') return res.status(200).send('ok');
  if (!secret || req.headers['x-telegram-bot-api-secret-token'] !== secret) return res.status(401).end();
  SITE = process.env.SITE_URL || `https://${req.headers['x-forwarded-host'] || req.headers.host}`;
  try {
    await onUpdate(req.body || {});
  } catch (e) {
    console.error(e);
  }
  res.status(200).json({ ok: true }); // always 200, otherwise Telegram keeps re-sending the update
}
