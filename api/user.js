// Профиль пользователя Telegram и дневной лимит анализов.
// POST /api/user?a=me   {initData}          -> профиль и остаток лимита
// POST /api/user?a=use  {initData, ticker}  -> списать анализ (повтор тикера в тот же день бесплатный)
import { parseInitData } from './_tg.js';
import { hasStore, backend, LIMIT, isAdmin, me, use, resetAt, cleanTicker, cors, readBody } from './_store.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  const body = await readBody(req);
  const auth = parseInitData(body.initData);
  if (!auth.ok) return res.status(401).json({ error: auth.reason });
  const u = auth.user, admin = isAdmin(u.id);
  const base = { user: u, verified: auth.verified, method: auth.method, storage: hasStore, backend, limit: admin ? null : LIMIT, admin, resetAt: resetAt() };
  if (!hasStore) return res.status(200).json({ ...base, used: null, left: null, tickers: [] });
  try {
    if (String(req.query.a) === 'use') {
      const t = cleanTicker(body.ticker);
      if (!t) return res.status(400).json({ error: 'ticker' });
      const r = await use(u, t, admin);
      const left = admin ? null : Math.max(0, LIMIT - r.used);
      if (!r.ok) return res.status(429).json({ ...base, used: r.used, left: 0, tickers: r.tickers, error: 'limit' });
      return res.status(200).json({ ...base, ok: true, repeat: r.repeat, used: r.used, left, tickers: r.tickers });
    }
    const m = await me(u);
    return res.status(200).json({ ...base, ...m, left: admin ? null : Math.max(0, LIMIT - m.used) });
  } catch (e) {
    // хранилище недоступно — не блокируем пользователя, клиент перейдёт на облачное хранилище Telegram
    return res.status(200).json({ ...base, storage: false, used: null, left: null, tickers: [], storeError: String(e.message).slice(0, 120) });
  }
}
