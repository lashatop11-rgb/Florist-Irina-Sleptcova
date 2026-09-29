// GET /api/setup?key=<TELEGRAM_SECRET> — one-time: connects the bot to this site and checks storage.
import { tg, redis, adminChats } from './_lib.js';
import { ADMIN_COMMANDS } from './_shop.js';

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  const secret = process.env.TELEGRAM_SECRET;
  if (!secret) return res.status(500).send('Не задана переменная TELEGRAM_SECRET');
  if (req.query.key !== secret) return res.status(401).send('Неверный ключ');
  const steps = [];
  try {
    await redis('PING');
    steps.push('✓ База (Upstash Redis) подключена');
    const me = await tg('getMe');
    steps.push(`✓ Бот @${me.username} найден`);
    const url = `https://${req.headers['x-forwarded-host'] || req.headers.host}/api/telegram`;
    await tg('setWebhook', { url, secret_token: secret, allowed_updates: ['message', 'edited_message', 'callback_query'] });
    steps.push(`✓ Бот подключён к ${url}`);
    // the command menu is only for admins; clients see a clean bot
    await tg('deleteMyCommands', {});
    const admins = await adminChats();
    for (const chat_id of admins) {
      await tg('setMyCommands', { commands: ADMIN_COMMANDS, scope: { type: 'chat', chat_id } }).catch(() => {});
    }
    await redis('SET', 'bot:username', me.username, 'EX', 7 * 86400);
    steps.push(`✓ Меню команд обновлено${admins.length ? ` (админов: ${admins.length})` : ''}`);
    steps.push('', `Готово! Теперь Ирина открывает @${me.username} и отправляет: /admin <тот же код>`);
    res.status(200).send(steps.join('\n'));
  } catch (e) {
    steps.push('✗ ' + e.message);
    res.status(500).send(steps.join('\n'));
  }
}
