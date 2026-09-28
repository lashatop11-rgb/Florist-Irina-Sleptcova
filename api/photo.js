// GET /api/photo?f=<file_id> — streams a bouquet photo from Telegram without exposing the bot token.
import { tg } from './_lib.js';

export default async function handler(req, res) {
  const f = String(req.query.f || '');
  if (!/^[\w-]{20,300}$/.test(f)) return res.status(400).end();
  try {
    const file = await tg('getFile', { file_id: f });
    const r = await fetch(`https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`);
    if (!r.ok) throw new Error('download failed: ' + r.status);
    res.setHeader('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    // file_id never changes for the same photo, so the CDN can keep it for good
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=31536000, immutable');
    res.status(200).send(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    console.error(e);
    res.status(404).end();
  }
}
