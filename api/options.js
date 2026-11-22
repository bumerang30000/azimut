// Опционы и шорт-интерес по акциям США — аналог «карты ликвидаций» для фондового рынка:
// стены открытого интереса по коллам и путам и max pain притягивают цену к экспирации,
// высокий шорт-интерес — топливо для шорт-сквиза.
import { yf, cors } from './_yahoo.js';

function maxPain(calls, puts) {
  const strikes = [...new Set([...calls, ...puts].map(o => o.strike))].sort((a, b) => a - b);
  let best = null;
  for (const k of strikes) {
    let pay = 0;
    for (const c of calls) if (k > c.strike) pay += (k - c.strike) * (c.openInterest || 0);
    for (const p of puts) if (k < p.strike) pay += (p.strike - k) * (p.openInterest || 0);
    if (!best || pay < best.pay) best = { k, pay };
  }
  return best ? best.k : null;
}

export default async function handler(req, res) {
  const symbol = String(req.query.symbol || '').trim().slice(0, 16);
  if (!symbol) { cors(res, 0); return res.status(400).json({ error: 'symbol' }); }
  cors(res, 900);
  const out = { symbol };
  try {
    const first = await yf.options(symbol, {}, { validateResult: false });
    const price = first?.quote?.regularMarketPrice;
    const toD = d => d instanceof Date ? d : new Date(typeof d === 'number' && d < 1e11 ? d * 1000 : d);
    const now = Date.now(), dates = (first.expirationDates || []).map(toD).filter(d => d - now < 50 * 864e5).slice(0, 4);
    const chains = [first.options?.[0]].filter(Boolean);
    for (const d of dates.slice(1)) {
      try { const r = await yf.options(symbol, { date: d }, { validateResult: false }); if (r.options?.[0]) chains.push(r.options[0]); } catch (e) {}
    }
    const calls = chains.flatMap(c => c.calls || []), puts = chains.flatMap(c => c.puts || []);
    const agg = arr => { const m = new Map(); for (const o of arr) m.set(o.strike, (m.get(o.strike) || 0) + (o.openInterest || 0)); return m; };
    const cm = agg(calls), pm = agg(puts);
    const top = (m, f) => [...m.entries()].filter(([k]) => f(k)).sort((a, b) => b[1] - a[1]);
    const near = k => Math.abs(k - price) / price <= 0.2;   // дальние страйки — не рабочие уровни
    const cw = top(cm, k => k > price && near(k)), pw = top(pm, k => k < price && near(k));
    const cOI = calls.reduce((s, o) => s + (o.openInterest || 0), 0), pOI = puts.reduce((s, o) => s + (o.openInterest || 0), 0);
    Object.assign(out, {
      price, expiries: chains.map(c => toD(c.expirationDate)), callWall: cw[0]?.[0] ?? null, callWallOI: cw[0]?.[1] ?? 0,
      putWall: pw[0]?.[0] ?? null, putWallOI: pw[0]?.[1] ?? 0, callWalls: cw.slice(0, 3), putWalls: pw.slice(0, 3),
      maxPain: maxPain(calls.filter(o => near(o.strike)), puts.filter(o => near(o.strike))), pcr: cOI ? pOI / cOI : null, callOI: cOI, putOI: pOI
    });
  } catch (e) { out.optErr = true; }
  try {
    const q = await yf.quoteSummary(symbol, { modules: ['defaultKeyStatistics'] }, { validateResult: false });
    const k = q.defaultKeyStatistics || {};
    out.short = { pctFloat: k.shortPercentOfFloat ?? null, ratio: k.shortRatio ?? null, shares: k.sharesShort ?? null, prior: k.sharesShortPriorMonth ?? null, date: k.dateShortInterest ?? null };
  } catch (e) {}
  if (out.optErr && !out.short) { cors(res, 0); return res.status(502).json({ error: 'upstream' }); }
  return res.status(200).json(out);
}
