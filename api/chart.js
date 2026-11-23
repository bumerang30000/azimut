// Свечи акций, индексов, валют и сырья. Ответ в «родном» формате Yahoo chart — клиенту без разницы, откуда данные
import { yf, UA, cors } from './_yahoo.js';
const DAYS = { '60d': 59, '1y': 365, '2y': 730, '5y': 1826, '10y': 3652, 'max': 365 * 40 };
const OK_INT = new Set(['15m', '60m', '1h', '1d', '1wk', '1mo']);

export default async function handler(req, res) {
  const symbol = String(req.query.symbol || '').trim().slice(0, 32);
  const range = DAYS[req.query.range] ? req.query.range : '5y';
  const interval = OK_INT.has(req.query.interval) ? req.query.interval : '1d';
  if (!symbol) { cors(res, 0); return res.status(400).json({ error: 'symbol' }); }
  cors(res, interval === '15m' ? 30 : interval === '60m' || interval === '1h' ? 60 : 300);

  // 1) библиотека yahoo-finance2
  try {
    const period1 = new Date(Date.now() - DAYS[range] * 864e5);
    const r = await yf.chart(symbol, { period1, interval, return: 'array' }, { validateResult: false });
    const q = (r.quotes || []).filter(x => x.open != null && x.close != null);
    if (q.length) {
      return res.status(200).json({ chart: { result: [{
        meta: r.meta,
        timestamp: q.map(x => Math.floor(new Date(x.date).getTime() / 1000)),
        indicators: { quote: [{ open: q.map(x => x.open), high: q.map(x => x.high), low: q.map(x => x.low), close: q.map(x => x.close), volume: q.map(x => x.volume || 0) }] }
      }] } });
    }
  } catch (e) { /* пробуем прямой запрос */ }

  // 2) прямой запрос к chart API (обычно работает и без crumb)
  for (const host of ['query2.finance.yahoo.com', 'query1.finance.yahoo.com']) {
    try {
      const u = `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`;
      const r = await fetch(u, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      const j = await r.json();
      if (j?.chart?.result?.[0]?.timestamp) return res.status(200).json(j);
      if (j?.chart?.error) { cors(res, 600); return res.status(404).json({ error: 'nosym' }); }
    } catch (e) {}
  }
  cors(res, 0);
  return res.status(502).json({ error: 'upstream' });
}
