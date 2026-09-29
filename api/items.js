// GET /api/items — everything live on the site: ready bouquets and fresh flowers, portfolio photos added via the bot,
// published reviews, the banner / pause line and the Yandex Metrica counter id.
// Scheduled photos appear exactly at their time; the first request after it also posts them to the channel.
import { redis, listItems, hList } from './_lib.js';
import { publishDue, setSite, siteFrom } from './telegram.js';

const photo = (fileId) => `/api/photo?f=${encodeURIComponent(fileId)}`;
// a holiday banner switches itself off after the holiday
const noticeText = (raw, now) => {
  try {
    const n = raw ? JSON.parse(raw) : {};
    return n.until && n.until <= now ? '' : n.text || '';
  } catch { return ''; }
};

export default async function handler(req, res) {
  try {
    const [stock, works, reviews, banner, pause, reviewChannel] = await Promise.all([
      listItems(), hList('works'), hList('reviews'), redis('GET', 'banner'), redis('GET', 'pause'), redis('GET', 'reviewChannel'),
    ]);
    const now = Date.now();
    const live = (r) => !r.publishAt || r.publishAt <= now;
    if ([...stock, ...works].some((r) => r.publishAt && r.publishAt <= now)) {
      setSite(siteFrom(req));
      await publishDue(now).catch((e) => console.error('publishDue', e));
    }
    const items = stock.filter(live).map((it) => ({
      id: it.id,
      kind: it.kind || 'bouquet',
      title: it.title,
      note: it.note || '',
      price: it.price,
      oldPrice: it.oldPrice || null,
      discount: it.discount || 0,
      status: it.status === 'scheduled' ? 'available' : it.status,
      createdAt: it.createdAt,
      photo: photo(it.fileId),
    }));
    // short CDN cache: new bouquets show up within ~10 seconds
    res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=60');
    res.status(200).json({
      items,
      works: works.filter(live).slice(0, 60).map((w) => ({ id: w.id, cat: w.cat, title: w.title, createdAt: w.createdAt, photo: photo(w.fileId) })),
      reviews: reviews.filter((v) => v.status === 'published').slice(0, 30)
        .map((v) => ({ id: v.id, name: v.name, text: v.text, rating: v.rating, createdAt: v.createdAt })),
      banner: noticeText(banner, now),
      pause: noticeText(pause, now),
      // public reviews channel → «Все отзывы в Telegram» on the site (private channels have no link)
      reviewsChannel: /^@\w{4,}$/.test(reviewChannel || '') ? `https://t.me/${reviewChannel.slice(1)}` : '',
      metrika: /^\d{5,12}$/.test(process.env.METRIKA_ID || '') ? process.env.METRIKA_ID : '',
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ items: [], error: 'unavailable' });
  }
}
