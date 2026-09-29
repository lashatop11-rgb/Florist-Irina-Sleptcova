// GET /api/cron — runs once a day (vercel.json → crons, 10:00 МСК).
// • A bouquet that sits on the site for 2+ days → the bot asks Irina: скидка, продано, снять или оставить.
// • Mondays → weekly summary.
// Safe to call by hand: each bouquet is reminded at most once per 2 days, the summary once per week.
import { redis, tg, listItems, saveItem, notifyAdmins } from './_lib.js';
import { DAY, plural, statsText } from './_shop.js';

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) return res.status(401).end();
  const now = Date.now();
  let reminded = 0;
  try {
    for (const it of await listItems()) {
      if (it.kind === 'flower' || !it.chatId) continue;
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
    let weekly = false;
    const d = new Date(now + 3 * 3600e3); // Moscow time
    if (d.getUTCDay() === 1 && (await redis('SET', `weekly:${d.toISOString().slice(0, 10)}`, '1', 'NX', 'EX', 8 * 86400)) === 'OK') {
      await notifyAdmins('sendMessage', { text: await statsText('📊 Итоги недели'), parse_mode: 'HTML' });
      weekly = true;
    }
    res.status(200).json({ ok: true, reminded, weekly });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false });
  }
}
