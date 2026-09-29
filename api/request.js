// POST /api/request — forms on the site: заказ из конструктора, бронь готового букета, отзыв.
// Everything lands in the bot as a message with buttons (see _shop.js); nothing is published without Irina.
// An order or a reservation answers with a t.me link: the client opens the bot and gets its statuses there.
import { redis, hGet, hList, hSave, seq, getItem, notifyAdmins, normPhone, clientIp, rateOk, botName, randomCode } from './_lib.js';
import { orderText, orderKeyboard, reviewText, reviewKeyboard } from './_shop.js';

const line = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const block = (v, max) => String(v ?? '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
const CALL_US = 'Позвоните или напишите в WhatsApp: +7 (926) 467-80-00';

// client base by phone: how many times they came before (the card shows «постоянный клиент»)
async function rememberClient(o) {
  let c = await hGet('clients', o.phone);
  if (!c) { // first time since the base exists — pick up their earlier requests
    const refs = (await hList('orders')).filter((x) => x.phone === o.phone && x.id !== o.id).reverse()
      .map((x) => ({ t: x.type, id: x.id, at: x.createdAt }));
    c = { id: o.phone, phone: o.phone, refs, createdAt: refs[0]?.at || o.createdAt };
  }
  o.visits = c.refs.length;
  o.lastVisit = c.refs.length ? c.refs[c.refs.length - 1].at : null;
  c.refs = [...c.refs, { t: o.type, id: o.id, at: o.createdAt }].slice(-50);
  c.lastAt = o.createdAt;
  if (o.name) c.name = o.name;
  await hSave('clients', c);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  let b = req.body || {};
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
  const fail = (code, error) => res.status(code).json({ ok: false, error });
  if (b.website) return res.status(200).json({ ok: true }); // honeypot: only bots fill the hidden field

  try {
    if (!(await rateOk('req', clientIp(req), 8, 3600))) return fail(429, 'Слишком много заявок подряд. ' + CALL_US);
    const name = line(b.name, 60);

    if (b.type === 'review') {
      const text = block(b.text, 800);
      if (text.length < 5) return fail(400, 'Напишите хотя бы пару слов 🙂');
      const rating = Math.min(5, Math.max(1, Math.round(Number(b.rating)) || 5));
      const v = { id: await seq('reviews'), name: name || 'Гость', text, rating, status: 'pending', createdAt: Date.now(), source: 'site' };
      await hSave('reviews', v);
      v.msgs = await notifyAdmins('sendMessage', { text: reviewText(v), parse_mode: 'HTML', reply_markup: reviewKeyboard(v) });
      await hSave('reviews', v);
      return res.status(200).json({ ok: true });
    }

    const phone = normPhone(b.phone);
    if (!phone) return fail(400, 'Проверьте номер телефона — Ирина перезвонит по нему');
    const o = { type: b.type, status: 'new', name, phone, createdAt: Date.now() };

    if (b.type === 'order') {
      o.text = block(b.text, 1500);
      if (!o.text) return fail(400, 'Заявка пустая');
    } else if (b.type === 'reserve') {
      const item = await getItem(Number(b.itemId));
      if (!item || item.kind === 'flower') return fail(410, 'Этого букета уже нет в наличии');
      if (item.status !== 'available') return fail(409, 'Букет уже забронирован — посмотрите другие или закажите похожий');
      // the same person tapping twice gets one request
      if ((await redis('SET', `rq:${item.id}:${phone}`, '1', 'NX', 'EX', 3600)) !== 'OK') return res.status(200).json({ ok: true, repeat: true });
      Object.assign(o, { itemId: item.id, itemTitle: item.title, itemPrice: item.price });
    } else {
      return fail(400, 'unknown form');
    }

    o.id = await seq('orders');
    o.token = randomCode();
    await rememberClient(o);
    await hSave('orders', o);
    o.msgs = await notifyAdmins('sendMessage', {
      text: orderText(o), parse_mode: 'HTML', reply_markup: orderKeyboard(o), disable_web_page_preview: true,
    });
    await hSave('orders', o);
    const bot = await botName().catch(() => '');
    const track = bot ? `https://t.me/${bot}?start=${o.type === 'reserve' ? 'r' : 'o'}${o.id}_${o.token}` : '';
    return res.status(200).json({ ok: true, id: o.id, track });
  } catch (e) {
    console.error(e);
    return fail(500, 'Не получилось отправить. ' + CALL_US);
  }
}
