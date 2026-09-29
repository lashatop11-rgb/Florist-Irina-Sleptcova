// POST /api/telegram — webhook of the shop bot.
// Irina sends a photo with a caption, the bot asks where it goes:
//   💐 Готовый букет  — «Пионы с эвкалиптом, 4500» (price required) → block «Готовые букеты»
//   🌷 Свежая поставка — «Пионы Сара Бернар, 350» (price per stem optional) → block «Свежая поставка»
// Buttons under a bouquet: 🔒 Бронь / ✅ Продано / 🗑 Удалить; under a flower: 🥀 Закончились.
// Everything is mirrored to the Telegram channel: the post is created on publish and updated on every status change.
import { tg, redis, listItems, getItem, saveItem, deleteItem, nextId, isAdmin } from './_lib.js';

const ORDER_CONTACT = 'https://t.me/lrinaSlepcova';
const PHONE = '79264678000';
const DEFAULT_CHANNEL = '@FloristIrinaSleptsova';
let SITE = ''; // set per request from the Host header, used for the «на сайте» button in channel posts
const DRAFT_TTL = 2 * 24 * 3600; // seconds a photo waits for the «букет / поставка» answer

const HELP = [
  '🌸 Бот раздела «В наличии» на сайте.',
  '',
  'Отправьте фото с подписью — бот спросит, куда его добавить:',
  '💐 Готовый букет — название и цена: «Пионы с эвкалиптом, 4500»',
  '🌷 Свежая поставка — сорт и, если хотите, цена за штуку: «Пионы Сара Бернар, 350»',
  '',
  'Вторая строка подписи (необязательно) — короткое описание.',
  'Одно фото = один букет или один сорт.',
  'Подпись можно исправить прямо в Telegram — сайт обновится.',
  '',
  'Под букетом: 🔒 Бронь, ✅ Продано, 🗑 Удалить. Под цветком: 🥀 Закончились.',
  'Всё сразу публикуется и в Telegram-канал, а кнопки обновляют пост и там.',
  '',
  '/list — что сейчас на сайте',
  '/channel — какой канал подключён (/channel off — не публиковать в канал)',
].join('\n');

const fmtPrice = (n) => Number(n).toLocaleString('ru-RU').replace(/ /g, ' ') + ' ₽';
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
    for (const m of line.matchAll(/\d[\d  .]*\d|\d/g)) {
      const after = line.slice(m.index + m[0].length);
      if (/^\s*(?:см|cm|мм|шт|стеб)/i.test(after)) continue;
      const n = Number(m[0].replace(/[  .]/g, ''));
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
const parseFor = (kind, text) => (kind === 'flower' ? parseFlower(text) : parseCaption(text));

const pickPhoto = (sizes) => sizes.filter((p) => Math.max(p.width, p.height) <= 1600).pop() || sizes[0];
const draftKey = (chat, msgId) => `draft:${chat}:${msgId}`;

function cardText(it, head) {
  if (isFlower(it)) {
    const price = it.price ? ` — ${fmtPrice(it.price)}/шт` : '';
    return [head, `🌷 Поставка · ${it.title}${price}`, it.note, head ? '' : 'Статус: 🟢 на сайте'].filter(Boolean).join('\n');
  }
  const status = it.status === 'reserved' ? '🔒 забронирован' : '🟢 на сайте';
  return [head, `№${it.id} · ${it.title} — ${fmtPrice(it.price)}`, it.note, `Статус: ${status}`]
    .filter(Boolean).join('\n');
}

function keyboard(it) {
  if (isFlower(it)) return { inline_keyboard: [[{ text: '🥀 Закончились', callback_data: `s:${it.id}` }]] };
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

const KIND_KEYBOARD = (msgId) => ({
  inline_keyboard: [[
    { text: '💐 Готовый букет', callback_data: `tb:${msgId}` },
    { text: '🌷 Свежая поставка', callback_data: `tf:${msgId}` },
  ]],
});

const send = (chat_id, text, extra = {}) => tg('sendMessage', { chat_id, text, disable_web_page_preview: true, ...extra });
const replyTo = (msg) => ({ reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true } });

// ---------- Telegram channel ----------
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function getChannel() {
  const c = await redis('GET', 'channel');
  return c === 'off' ? null : c || DEFAULT_CHANNEL;
}

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
    lines.push(`💐 Готовый букет · №${it.id}`, `<b>${esc(it.title)}</b>`, state === 'sold' ? `<s>${fmtPrice(it.price)}</s>` : fmtPrice(it.price));
    if (it.note) lines.push(esc(it.note));
    if (state === 'available') lines.push('', 'Можно забрать сегодня · доставка по Тучково 0 ₽');
  }
  const text = flower ? `Здравствуйте, Ирина! Хочу букет со свежими цветами: ${it.title}.`
    : state === 'available' ? `Здравствуйте, Ирина! Хочу забронировать букет «${it.title}» (№${it.id}) за ${fmtPrice(it.price)}.`
    : `Здравствуйте, Ирина! Хочу букет, похожий на «${it.title}» (№${it.id}).`;
  const q = encodeURIComponent(text);
  const rows = [];
  if (state !== 'gone') {
    const label = flower ? 'Заказать букет' : state === 'available' ? 'Забронировать' : 'Хочу похожий';
    rows.push([{ text: `💬 ${label}`, url: `https://t.me/lrinaSlepcova?text=${q}` }, { text: 'WhatsApp', url: `https://wa.me/${PHONE}?text=${q}` }]);
  }
  if (SITE) rows.push([{ text: '🌸 Всё в наличии на сайте', url: `${SITE}/#stock` }]);
  return { caption: lines.join('\n'), parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } };
}

const NO_RIGHTS = /not enough rights|chat not found|not a member|administrator|CHAT_ADMIN_REQUIRED|have no rights/i;
const HOW_TO_ADMIN = 'добавьте бота администратором канала (Управление каналом → Администраторы) с правами «Публикация», «Редактирование» и «Удаление сообщений»';

async function postToChannel(item) {
  const channel = await getChannel();
  if (!channel) return '';
  try {
    const m = await tg('sendPhoto', { chat_id: channel, photo: item.fileId, ...channelPost(item) });
    item.channelChat = m.chat.id;
    item.channelMsg = m.message_id;
    return '📣 и в канале';
  } catch (e) {
    return '⚠️ В канал не отправлено: ' + (NO_RIGHTS.test(e.message) ? HOW_TO_ADMIN : e.message);
  }
}

const syncChannel = (item, state) => item.channelMsg
  ? tg('editMessageCaption', { chat_id: item.channelChat, message_id: item.channelMsg, ...channelPost(item, state) }).catch(() => {})
  : null;

async function onChannel(chat, arg) {
  if (!arg) {
    const c = await getChannel();
    return send(chat, c
      ? `Публикую в канал ${c}.\n/channel off — выключить\n/channel @имя — другой канал`
      : 'Публикация в канал выключена.\n/channel @имя_канала — включить');
  }
  if (arg === 'off') {
    await redis('SET', 'channel', 'off');
    return send(chat, 'Готово: в канал больше не публикую, только на сайт.');
  }
  const name = /^(@|-100)/.test(arg) ? arg : '@' + arg.replace(/^(https?:\/\/)?t\.me\//, '');
  try {
    const ch = await tg('getChat', { chat_id: name });
    const me = await tg('getChatMember', { chat_id: ch.id, user_id: Number(String(process.env.TELEGRAM_BOT_TOKEN).split(':')[0]) });
    if (me.status !== 'administrator' || !me.can_post_messages) return send(chat, `Не могу публиковать в ${name}: ${HOW_TO_ADMIN}.`);
    await redis('SET', 'channel', name);
    return send(chat, `Готово: букеты и поставки будут публиковаться в «${ch.title || name}».`);
  } catch (e) {
    return send(chat, `Не нашёл канал ${name}: ${e.message}`);
  }
}

async function onPhoto(msg) {
  if (!String(msg.caption || '').trim()) {
    if (msg.media_group_id) return; // other photos of an album — skip quietly
    return send(msg.chat.id, 'Добавьте к фото подпись, например:\nПионы с эвкалиптом, 4500', replyTo(msg));
  }
  const draft = { fileId: pickPhoto(msg.photo).file_id, caption: msg.caption, chatId: msg.chat.id, srcMsg: msg.message_id };
  await redis('SET', draftKey(msg.chat.id, msg.message_id), JSON.stringify(draft), 'EX', DRAFT_TTL);
  await send(msg.chat.id, 'Куда добавить на сайте?', { ...replyTo(msg), reply_markup: KIND_KEYBOARD(msg.message_id) });
}

async function onEditedPhoto(msg) {
  const fileId = pickPhoto(msg.photo).file_id;
  const key = draftKey(msg.chat.id, msg.message_id);
  const raw = await redis('GET', key);
  if (raw) { // not published yet — just remember the new caption
    const draft = { ...JSON.parse(raw), caption: msg.caption, fileId };
    return redis('SET', key, JSON.stringify(draft), 'EX', DRAFT_TTL);
  }
  const item = (await listItems()).find((it) => it.chatId === msg.chat.id && it.srcMsg === msg.message_id);
  if (!item) return;
  const parsed = parseFor(item.kind, msg.caption);
  if (!parsed) return send(msg.chat.id, 'Не вижу цену в подписи — на сайте осталась прежняя.', replyTo(msg));
  Object.assign(item, parsed, { fileId });
  await saveItem(item);
  await syncChannel(item, item.status);
  if (item.cardMsg) {
    await tg('editMessageText', {
      chat_id: item.chatId, message_id: item.cardMsg, text: cardText(item, '✏️ Обновлено на сайте'), reply_markup: keyboard(item),
    }).catch(() => {});
  }
}

async function onList(chat) {
  const items = await listItems();
  if (!items.length) return send(chat, 'На сайте сейчас пусто.\nОтправьте фото с подписью, чтобы добавить букет или цветы из поставки.');
  const bouquets = items.filter((it) => !isFlower(it)).length;
  await send(chat, `На сайте сейчас:\n💐 готовых букетов — ${bouquets}\n🌷 цветов из поставки — ${items.length - bouquets}`);
  for (const it of items.slice(0, 30)) {
    await tg('sendPhoto', { chat_id: chat, photo: it.fileId, caption: cardText(it), reply_markup: keyboard(it) });
  }
}

async function onCallback(q) {
  const answer = (text, alert = false) => tg('answerCallbackQuery', { callback_query_id: q.id, text, show_alert: alert });
  if (!(await isAdmin(q.from.id))) return answer('Нет доступа');
  const [act, id] = String(q.data || '').split(':');
  const m = q.message;
  const edit = (text, reply_markup = { inline_keyboard: [] }) => {
    const target = { chat_id: m.chat.id, message_id: m.message_id, reply_markup };
    return (m.photo ? tg('editMessageCaption', { ...target, caption: text }) : tg('editMessageText', { ...target, text }))
      .catch(() => {});
  };

  if (act === 'tb' || act === 'tf') {
    const key = draftKey(m.chat.id, id);
    const raw = await redis('GET', key);
    if (!raw) {
      await answer('Фото устарело — отправьте его ещё раз');
      return edit('Фото устарело — отправьте его ещё раз.');
    }
    const draft = JSON.parse(raw);
    const kind = act === 'tf' ? 'flower' : 'bouquet';
    const parsed = parseFor(kind, draft.caption);
    if (!parsed) return answer('Для готового букета нужна цена. Допишите её в подпись к фото (Изменить) и нажмите кнопку ещё раз.', true);
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

  const item = await getItem(id);
  if (!item) {
    await answer('Этого уже нет на сайте');
    return edit((m.caption || m.text || '') + '\n— снято с сайта');
  }
  if (act === 'r' || act === 'a') {
    item.status = act === 'r' ? 'reserved' : 'available';
    await saveItem(item);
    await syncChannel(item, item.status);
    await answer(act === 'r' ? 'На сайте отмечен как забронированный' : 'Снова доступен для заказа');
    return edit(cardText(item), keyboard(item));
  }
  if (act === 's' || act === 'd') {
    await deleteItem(item.id);
    if (act === 's' && !isFlower(item)) await redis('INCR', 'stock:sold');
    if (act === 'd' && item.channelMsg) await tg('deleteMessage', { chat_id: item.channelChat, message_id: item.channelMsg }).catch(() => {});
    else await syncChannel(item, isFlower(item) ? 'gone' : 'sold');
    const head = isFlower(item) ? '🥀 Закончились — сняты с сайта' : act === 's' ? '✅ Продано — снят с сайта' : '🗑 Удалён с сайта';
    await answer('Снято с сайта');
    return edit(cardText(item, head).replace(/\nСтатус:.*$/, ''));
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
    return send(chat, 'Готово — теперь вы можете публиковать на сайте.\n\n' + HELP);
  }
  if (!(await isAdmin(msg.from?.id))) {
    return send(chat, `Здравствуйте! Это служебный бот мастерской «флорист Ирина Слепцова».\nЗаказать букет: ${ORDER_CONTACT}`);
  }
  if (msg.photo) return u.edited_message ? onEditedPhoto(msg) : onPhoto(msg);
  if (/^\/list\b/.test(text)) return onList(chat);
  const channelCmd = text.match(/^\/channel(?:@\w+)?(?:\s+(\S+))?/);
  if (channelCmd) return onChannel(chat, channelCmd[1]);
  return send(chat, HELP);
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
