// GET /api/items — bouquets that are in stock right now (read by the site).
import { listItems } from './_lib.js';

export default async function handler(req, res) {
  try {
    const items = (await listItems()).map((it) => ({
      id: it.id,
      title: it.title,
      note: it.note || '',
      price: it.price,
      status: it.status,
      createdAt: it.createdAt,
      photo: `/api/photo?f=${encodeURIComponent(it.fileId)}`,
    }));
    // short CDN cache: new bouquets show up within ~10 seconds
    res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=60');
    res.status(200).json({ items });
  } catch (e) {
    console.error(e);
    res.status(500).json({ items: [], error: 'unavailable' });
  }
}
