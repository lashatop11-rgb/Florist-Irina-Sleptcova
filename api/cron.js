// GET /api/cron — vercel.json runs it twice a day: 9:00 and 18:00 МСК (on the free plan — within that hour).
// • Both runs: photos scheduled with «⏰ Опубликовать позже» get their channel post (the site shows them on time anyway).
// • Morning only:
//   – a bouquet that sits on the site for 2+ days → the bot asks Irina: скидка, продано, снять или оставить;
//   – 2–3 weeks before a holiday → the bot offers a banner on the site; after the holiday the banner is removed;
//   – Mondays → weekly summary.
// Safe to call by hand: each bouquet is reminded at most once per 2 days, each holiday offered once, the summary once per week.
import { redis, tg, listItems, saveItem, notifyAdmins } from './_lib.js';
import { DAY, HOLIDAYS, holidayDate, daysUntil, fmtDay, plural, statsText } from './_shop.js';
import { publishDue, setSite, siteFrom } from './telegram.js';

const EVENING = '0 15 * * *'; // must match vercel.json

async function remind(now) {
  let reminded = 0;
  for (const it of await listItems()) {
    if (it.kind === 'flower' || !it.chatId || it.publishAt) continue;
    const age = now - it.createdAt;
    if (age < 2 * DAY || (it.remindedAt && now - it.remindedAt < 2 * DAY - 3600e3)) continue;
    it.remindedAt = now;
    await saveItem(it);
    const days = plural(Math.floor(age / DAY), ['день', 'дня', 'дней']);
    const reserved = it.status === 'reserved';
    const text = reserved
      ? `⏰ Букет №${it.id} «${it.title}» забронирован уже ${days}. Его забрали?`
      : `⏰ Букет №${it.id} «${it.title}» на сайте уже ${days}. Что делаем?`;
    const inline_keyboard = reserved
      ? [[{ text: '✅ Продано', callback_data: `s:${it.id}` }, { text: '↩️ Снять бронь', callback_data: `a:${it.id}` }]]
      : [
        [{ text: '🏷 Скидка 20%', callback_data: `p:${it.id}:20` }, { text: '✅ Продано', callback_data: `s:${it.id}` }],
        [{ text: '🗑 Снять с сайта', callback_data: `d:${it.id}` }, { text: '👌 Оставить', callback_data: `ok:${it.id}` }],
      ];
    await tg('sendMessage', {
      chat_id: it.chatId, text, reply_markup: { inline_keyboard },
      reply_parameters: { message_id: it.cardMsg, allow_sending_without_reply: true },
    }).then(() => reminded++, (e) => console.error('remind', it.id, e.message));
  }
  return reminded;
}

// the holiday banner is gone from the site at midnight (items.js); here it is deleted and Irina is told
async function expireBanner(now) {
  const raw = await redis('GET', 'banner');
  let b = null;
  try { b = raw && JSON.parse(raw); } catch { /* broken — leave it */ }
  if (!b?.until || b.until > now) return false;
  await redis('DEL', 'banner');
  await notifyAdmins('sendMessage', { text: `🎉 Праздник прошёл — объявление «${b.text}» убрано с сайта.` });
  return true;
}

async function offerHolidays(now) {
  const offered = [];
  for (const [key, h] of Object.entries(HOLIDAYS)) {
    const date = holidayDate(key, now);
    const left = daysUntil(date, now);
    if (left < 1 || left > h.lead) continue;
    const year = new Date(date + 3 * 3600e3).getUTCFullYear();
    if ((await redis('SET', `hol:${key}:${year}`, '1', 'NX', 'EX', 60 * 86400)) !== 'OK') continue;
    let cur = '';
    try { cur = JSON.parse((await redis('GET', 'banner')) || '{}').text || ''; } catch { /* none */ }
    const text = [
      `📅 До праздника «${h.name}» — ${plural(left, ['день', 'дня', 'дней'])} (${fmtDay(date)}).`,
      'Включить объявление вверху сайта?',
      `«${h.text}»`,
      `Уберётся само ${fmtDay(date + DAY)}.`,
      cur ? `Сейчас висит «${cur}» — заменится.` : '',
      'Свой текст: /banner текст',
    ].filter(Boolean).join('\n');
    await notifyAdmins('sendMessage', {
      text, reply_markup: { inline_keyboard: [[{ text: '📣 Включить', callback_data: `hb:${key}:on` }, { text: '✖ Не надо', callback_data: `hb:${key}:no` }]] },
    });
    offered.push(key);
  }
  return offered;
}

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) return res.status(401).end();
  setSite(siteFrom(req));
  const now = Date.now();
  const evening = req.headers['x-vercel-cron-schedule'] === EVENING;
  try {
    const published = await publishDue(now);
    if (evening) return res.status(200).json({ ok: true, published });
    const reminded = await remind(now);
    const bannerOff = await expireBanner(now);
    const holidays = await offerHolidays(now);
    let weekly = false;
    const d = new Date(now + 3 * 3600e3); // Moscow time
    if (d.getUTCDay() === 1 && (await redis('SET', `weekly:${d.toISOString().slice(0, 10)}`, '1', 'NX', 'EX', 8 * 86400)) === 'OK') {
      await notifyAdmins('sendMessage', { text: await statsText('📊 Итоги недели'), parse_mode: 'HTML' });
      weekly = true;
    }
    res.status(200).json({ ok: true, published, reminded, bannerOff, holidays, weekly });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false });
  }
}
