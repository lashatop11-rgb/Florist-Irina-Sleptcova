// GET /api/items — everything live on the site: ready bouquets and fresh flowers, portfolio photos added via the bot,
// published reviews, the banner / pause line and the Yandex Metrica counter id.
import { redis, listItems, hList } from './_lib.js';

const photo = (fileId) => `/api/photo?f=${encodeURIComponent(fileId)}`;
const noticeText = (raw) => { try { return raw ? JSON.parse(raw).text || '' : ''; } catch { return ''; } };

export default async function handler(req, res) {
  try {
    const [stock, works, reviews, banner, pause] = await Promise.all([
      listItems(), hList('works'), hList('reviews'), redis('GET', 'banner'), redis('GET', 'pause'),
    ]);
    const items = stock.map((it) => ({
      id: it.id,
      kind: it.kind || 'bouquet',
      title: it.title,
      note: it.note || '',
      price: it.price,
      oldPrice: it.oldPrice || null,
      discount: it.discount || 0,
      status: it.status,
      createdAt: it.createdAt,
      photo: photo(it.fileId),
    }));
    // short CDN cache: new bouquets show up within ~10 seconds
    res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=60');
    res.status(200).json({
      items,
      works: works.slice(0, 60).map((w) => ({ id: w.id, cat: w.cat, title: w.title, createdAt: w.createdAt, photo: photo(w.fileId) })),
      reviews: reviews.filter((v) => v.status === 'published').slice(0, 30)
        .map((v) => ({ id: v.id, name: v.name, text: v.text, rating: v.rating, createdAt: v.createdAt })),
      banner: noticeText(banner),
      pause: noticeText(pause),
      metrika: /^\d{5,12}$/.test(process.env.METRIKA_ID || '') ? process.env.METRIKA_ID : '',
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ items: [], error: 'unavailable' });
  }
}
