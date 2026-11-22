// Новости по инструменту: Yahoo Finance + Google News RSS (бесплатно, без ключей)
import { yf, UA, cors } from './_yahoo.js';

const decode = s => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).trim();
const tag = (x, t) => { const m = x.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)); return m ? decode(m[1]) : ''; };

async function google(q, lang) {
  const loc = lang === 'ru' ? 'hl=ru&gl=RU&ceid=RU:ru' : 'hl=en-US&gl=US&ceid=US:en';
  const r = await fetch(`https://news.google.com/rss/search?q=${encodeURIComponent(q + ' when:7d')}&${loc}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(7000) });
  if (!r.ok) return [];
  const xml = await r.text();
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 15).map(([, it]) => {
    const src = tag(it, 'source'); let title = tag(it, 'title');
    if (src && title.endsWith(' - ' + src)) title = title.slice(0, -(src.length + 3));
    const d = Date.parse(tag(it, 'pubDate'));
    return { title, link: tag(it, 'link'), pub: src || 'Google News', t: isFinite(d) ? Math.floor(d / 1000) : 0 };
  });
}
async function yahoo(q) {
  const r = await yf.search(q, { newsCount: 12, quotesCount: 0 }, { validateResult: false });
  return (r.news || []).map(n => ({ title: n.title, link: n.link, pub: n.publisher, t: Math.floor(new Date(n.providerPublishTime).getTime() / 1000) || 0 }));
}

export default async function handler(req, res) {
  const q = String(req.query.q || '').trim().slice(0, 80);
  const g = String(req.query.g || q).trim().slice(0, 80);
  const lang = req.query.lang === 'ru' ? 'ru' : 'en';
  if (!q) { cors(res, 0); return res.status(400).json({ error: 'q' }); }
  cors(res, 600);
  const parts = await Promise.allSettled([yahoo(q), google(g, lang)]);
  const seen = new Set(), news = [];
  for (const p of parts) if (p.status === 'fulfilled') for (const n of p.value) {
    const k = n.title.toLowerCase().slice(0, 60);
    if (n.title && !seen.has(k)) { seen.add(k); news.push(n); }
  }
  news.sort((a, b) => b.t - a.t);
  return res.status(200).json({ news: news.slice(0, 20) });
}
