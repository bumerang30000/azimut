// Шлюз только для разрешённых источников (Мосбиржа, Yahoo) — на случай, если браузер не достучится напрямую
import { UA, cors } from './_yahoo.js';
const ALLOW = new Set(['iss.moex.com', 'query1.finance.yahoo.com', 'query2.finance.yahoo.com']);

export default async function handler(req, res) {
  let u;
  try { u = new URL(String(req.query.url)); } catch (e) { cors(res, 0); return res.status(400).json({ error: 'bad url' }); }
  if (u.protocol !== 'https:' || !ALLOW.has(u.hostname)) { cors(res, 0); return res.status(403).json({ error: 'host not allowed' }); }
  cors(res, 30);
  try {
    const r = await fetch(u, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
    const body = await r.text();
    if (!r.ok) cors(res, 0);
    return res.status(r.status).send(body);
  } catch (e) { cors(res, 0); return res.status(502).json({ error: 'upstream' }); }
}
