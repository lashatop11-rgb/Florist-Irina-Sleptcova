// POST /api/telegram — webhook of the shop bot.
// Irina sends a photo with a caption «Пионы с эвкалиптом, 4500» → the bouquet appears on the site.
// Buttons under each bouquet: 🔒 Бронь / ✅ Продано / 🗑 Удалить.
import { tg, redis, listItems, getItem, saveItem, deleteItem, nextId, isAdmin } from './_lib.js';

const ORDER_CONTACT = 'https://t.me/lrinaSlepcova';

const HELP = [
  '🌸 Бот раздела «Готовые букеты» на сайте.',
  '',
  'Чтобы добавить букет, отправьте фото с подписью: название и цена. Например:',
  'Пионы с эвкалиптом, 4500',
  '',
  'Вторая строка подписи (необязательно) — короткое описание.',
  'Одно фото = один букет. Если отправить альбом, на сайт попадёт фото с подписью.',
  '',
  'Под каждым букетом будут кнопки: 🔒 Бронь, ✅ Продано, 🗑 Удалить.',
  'Подпись можно исправить прямо в Telegram — сайт обновится.',
  '',
  '/list — что сейчас на сайте',
].join('\n');

const fmtPrice = (n) => Number(n).toLocaleString('ru-RU').replace(/ /g, ' ') + ' ₽';
const clean = (s) => s.replace(/^[\s,.;:—–-]+|[\s,.;:—–-]+$/g, '').replace(/\s{2,}/g, ' ');
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// «Пионы с эвкалиптом, 4500» → { title: 'Пионы с эвкалиптом', price: 4500, note: '' }
export function parseCaption(text) {
  const lines = String(text || '').split('\n').map((s) => s.trim()).filter(Boolean);
  if (!lines.length) return null;
  // the price is the biggest number, so «букет из 15 роз, 4500» gives 4500
  let best = null;
  lines.forEach((line, li) => {
    for (const m of line.matchAll(/\d[\d  .]*\d|\d/g)) {
      const n = Number(m[0].replace(/[  .]/g, ''));
      if (!best || n > best.n) best = { n, s: m[0], li };
    }
  });
  if (!best || best.n < 50 || best.n > 10_000_000) return null;
  const priceRe = new RegExp(
    `(?:цена|стоимость|за)?\\s*[:—–-]?\\s*${escapeRe(best.s)}\\s*(?:₽|рубл\\p{L}*|руб\\.?|р\\.?)?(?!\\p{L})`, 'iu');
  const rest = lines.map((l, i) => (i === best.li ? clean(l.replace(priceRe, ' ')) : l)).filter(Boolean);
  const title = cap(clean(rest[0] || 'Букет')).slice(0, 80);
  const note = clean(rest.slice(1).join(' ')).slice(0, 220);
  return { title, price: best.n, note };
}

const pickPhoto = (sizes) => sizes.filter((p) => Math.max(p.width, p.height) <= 1600).pop() || sizes[0];

function cardText(it, head) {
  const status = it.status === 'reserved' ? '🔒 забронирован' : '🟢 на сайте';
  return [head, `№${it.id} · ${it.title} — ${fmtPrice(it.price)}`, it.note, `Статус: ${status}`]
    .filter(Boolean).join('\n');
}

function keyboard(it) {
  const toggle = it.status === 'reserved'
    ? { text: '↩️ Снять бронь', callback_data: `a:${it.id}` }
    : { text: '🔒 Бронь', callback_data: `r:${it.id}` };
  return {
    inline_keyboard: [
      [toggle, { text: '✅ Продано', callback_data: `s:${it.id}` }],
      [{ text: '🗑 Удалить', callback_data: `d:${it.id}` }],
    ],
  };
}

const send = (chat_id, text, extra = {}) => tg('sendMessage', { chat_id, text, disable_web_page_preview: true, ...extra });
const replyTo = (msg) => ({ reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true } });

async function onPhoto(msg) {
  const parsed = parseCaption(msg.caption);
  if (!parsed) {
    if (msg.media_group_id && !msg.caption) return; // other photos of an album — skip quietly
    return send(msg.chat.id, 'Добавьте к фото подпись с названием и ценой, например:\nПионы с эвкалиптом, 4500', replyTo(msg));
  }
  const ph = pickPhoto(msg.photo);
  const item = {
    id: await nextId(), ...parsed, status: 'available',
    fileId: ph.file_id, createdAt: Date.now(), chatId: msg.chat.id, srcMsg: msg.message_id,
  };
  await saveItem(item);
  const card = await send(msg.chat.id, cardText(item, '✨ Опубликовано на сайте'), { ...replyTo(msg), reply_markup: keyboard(item) });
  item.cardMsg = card.message_id;
  await saveItem(item);
}

async function onEditedPhoto(msg) {
  const item = (await listItems()).find((it) => it.chatId === msg.chat.id && it.srcMsg === msg.message_id);
  if (!item) return;
  const parsed = parseCaption(msg.caption);
  if (!parsed) return send(msg.chat.id, 'Не вижу цену в подписи — на сайте осталась прежняя.', replyTo(msg));
  Object.assign(item, parsed, { fileId: pickPhoto(msg.photo).file_id });
  await saveItem(item);
  if (item.cardMsg) {
    await tg('editMessageText', {
      chat_id: item.chatId, message_id: item.cardMsg, text: cardText(item, '✏️ Обновлено на сайте'), reply_markup: keyboard(item),
    }).catch(() => {});
  }
}

async function onList(chat) {
  const items = await listItems();
  if (!items.length) return send(chat, 'На сайте сейчас нет готовых букетов.\nОтправьте фото с подписью, чтобы добавить.');
  await send(chat, `На сайте сейчас: ${items.length}`);
  for (const it of items.slice(0, 20)) {
    await tg('sendPhoto', { chat_id: chat, photo: it.fileId, caption: cardText(it), reply_markup: keyboard(it) });
  }
}

async function onCallback(q) {
  const answer = (text) => tg('answerCallbackQuery', { callback_query_id: q.id, text });
  if (!(await isAdmin(q.from.id))) return answer('Нет доступа');
  const [act, id] = String(q.data || '').split(':');
  const m = q.message;
  const edit = (text, reply_markup = { inline_keyboard: [] }) => {
    const target = { chat_id: m.chat.id, message_id: m.message_id, reply_markup };
    return (m.photo ? tg('editMessageCaption', { ...target, caption: text }) : tg('editMessageText', { ...target, text }))
      .catch(() => {});
  };
  const item = await getItem(id);
  if (!item) {
    await answer('Этого букета уже нет на сайте');
    return edit((m.caption || m.text || '') + '\n— снят с сайта');
  }
  if (act === 'r' || act === 'a') {
    item.status = act === 'r' ? 'reserved' : 'available';
    await saveItem(item);
    await answer(act === 'r' ? 'На сайте отмечен как забронированный' : 'Снова доступен для заказа');
    return edit(cardText(item), keyboard(item));
  }
  if (act === 's' || act === 'd') {
    await deleteItem(item.id);
    if (act === 's') await redis('INCR', 'stock:sold');
    await answer('Снят с сайта');
    return edit(cardText(item, act === 's' ? '✅ Продано — снят с сайта' : '🗑 Удалён с сайта').replace(/\nСтатус:.*$/, ''));
  }
  return answer('');
}

export async function onUpdate(u) {
  if (u.callback_query) return onCallback(u.callback_query);
  const msg = u.message || u.edited_message;
  if (!msg || msg.chat.type !== 'private') return;
  if (u.edited_message && !msg.photo) return;
  const chat = msg.chat.id;
  const text = msg.text || '';

  const admin = text.match(/^\/admin(?:@\w+)?\s+(\S+)/);
  if (admin) {
    if (admin[1] !== process.env.TELEGRAM_SECRET) return send(chat, 'Неверный код.');
    await redis('SADD', 'admins', msg.from.id);
    return send(chat, 'Готово — теперь вы можете публиковать букеты.\n\n' + HELP);
  }
  if (!(await isAdmin(msg.from?.id))) {
    return send(chat, `Здравствуйте! Это служебный бот мастерской «флорист Ирина Слепцова».\nЗаказать букет: ${ORDER_CONTACT}`);
  }
  if (msg.photo) return u.edited_message ? onEditedPhoto(msg) : onPhoto(msg);
  if (/^\/list\b/.test(text)) return onList(chat);
  return send(chat, HELP);
}

export default async function handler(req, res) {
  const secret = process.env.TELEGRAM_SECRET;
  if (req.method !== 'POST') return res.status(200).send('ok');
  if (!secret || req.headers['x-telegram-bot-api-secret-token'] !== secret) return res.status(401).end();
  try {
    await onUpdate(req.body || {});
  } catch (e) {
    console.error(e);
  }
  res.status(200).json({ ok: true }); // always 200, otherwise Telegram keeps re-sending the update
}
