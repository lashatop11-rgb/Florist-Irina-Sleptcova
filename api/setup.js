// GET /api/setup?key=<TELEGRAM_SECRET> — one-time: connects the bot to this site and checks storage.
import { tg, redis } from './_lib.js';

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
    await tg('setMyCommands', {
      commands: [
        { command: 'list', description: 'Что сейчас в наличии' },
        { command: 'orders', description: 'Открытые заявки с сайта' },
        { command: 'works', description: 'Портфолио' },
        { command: 'reviews', description: 'Отзывы' },
        { command: 'stats', description: 'Статистика' },
        { command: 'banner', description: 'Объявление на сайте' },
        { command: 'pause', description: 'Мастерская на паузе' },
        { command: 'channel', description: 'Публикация в Telegram-канал' },
        { command: 'help', description: 'Как пользоваться ботом' },
      ],
    });
    steps.push('', `Готово! Теперь Ирина открывает @${me.username} и отправляет: /admin <тот же код>`);
    res.status(200).send(steps.join('\n'));
  } catch (e) {
    steps.push('✗ ' + e.message);
    res.status(500).send(steps.join('\n'));
  }
}
