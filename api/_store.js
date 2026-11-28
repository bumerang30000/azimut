// Хранилище профилей и дневных лимитов.
// 1) Supabase (Postgres): функции az_me / az_use из supabase.sql, вызов по REST с серверным ключом.
// 2) Запасной вариант — Upstash Redis по REST.
const SB_URL = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || '';
const R_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const R_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
export const backend = SB_URL && SB_KEY ? 'supabase' : R_URL && R_TOKEN ? 'redis' : null;
export const hasStore = !!backend;
export const LIMIT = Math.max(1, +process.env.DAILY_LIMIT || 10);
const ADMINS = new Set(String(process.env.ADMIN_IDS || '').split(/[\s,;]+/).filter(Boolean));
export const isAdmin = id => ADMINS.has(String(id));
export function resetAt(now = new Date()) { return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1); }
export const cleanTicker = t => String(t || '').toUpperCase().replace(/[^A-Z0-9=^.\-/]/g, '').slice(0, 24);
export function cors(res) { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); }
export async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (e) { return {}; } }
  return {};
}

/* ---------- Supabase ---------- */
export async function rpc(fn, args) {
  const h = { apikey: SB_KEY, 'Content-Type': 'application/json' };
  if (!SB_KEY.startsWith('sb_')) h.Authorization = `Bearer ${SB_KEY}`;   // старые JWT-ключи; новые sb_secret_ — только в apikey
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: h, body: JSON.stringify(args), signal: AbortSignal.timeout(7000) });
  if (!r.ok) throw new Error('supabase ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return r.json();
}
export const prof = u => ({ p_user: u.id, p_name: [u.first, u.last].filter(Boolean).join(' ').slice(0, 128), p_username: u.username || '', p_photo: u.photo || '', p_premium: !!u.premium, p_lang: u.lang || '' });

export const hasSb = !!(SB_URL && SB_KEY);
// запрос к таблицам Supabase (PostgREST) с серверным ключом
export async function sb(path, { method = 'GET', body, prefer } = {}) {
  const h = { apikey: SB_KEY, 'Content-Type': 'application/json' };
  if (!SB_KEY.startsWith('sb_')) h.Authorization = `Bearer ${SB_KEY}`;
  if (prefer) h.Prefer = prefer;
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { method, headers: h, body: body == null ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(7000) });
  if (!r.ok) throw new Error('supabase ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const t = await r.text(); return t ? JSON.parse(t) : null;
}

/* ---------- Upstash Redis ---------- */
async function pipe(cmds) {
  const r = await fetch(R_URL.replace(/\/$/, '') + '/pipeline', { method: 'POST', headers: { Authorization: `Bearer ${R_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cmds), signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw new Error('redis ' + r.status);
  return (await r.json()).map(x => x.result);
}
const day = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');
const touch = (u, kUser) => [['HSET', kUser, 'name', [u.first, u.last].filter(Boolean).join(' '), 'username', u.username, 'photo', u.photo, 'last', String(Date.now())], ['HSETNX', kUser, 'first', String(Date.now())]];

/* ---------- общий интерфейс ---------- */
export async function me(u) {
  if (backend === 'supabase') { const j = await rpc('az_me', prof(u)); return { used: +j.used || 0, tickers: j.tickers || [], total: +j.total || 0, since: Math.round(+j.since) || Date.now() }; }
  const kDay = `az:d:${day()}:${u.id}`, kUser = `az:u:${u.id}`;
  const [used, tickers, total, first] = await pipe([['SCARD', kDay], ['SMEMBERS', kDay], ['HGET', kUser, 'total'], ['HGET', kUser, 'first'], ...touch(u, kUser)]);
  return { used: used || 0, tickers: tickers || [], total: +total || 0, since: +first || Date.now() };
}
export async function use(u, ticker, admin) {
  if (backend === 'supabase') { const j = await rpc('az_use', { ...prof(u), p_ticker: ticker, p_limit: LIMIT, p_admin: !!admin }); return { ok: !!j.ok, repeat: !!j.repeat, used: +j.used || 0, tickers: j.tickers || [] }; }
  const kDay = `az:d:${day()}:${u.id}`, kUser = `az:u:${u.id}`;
  const [had, cnt] = await pipe([['SISMEMBER', kDay, ticker], ['SCARD', kDay]]);
  if (!had && !admin && cnt >= LIMIT) { const [t] = await pipe([['SMEMBERS', kDay]]); return { ok: false, used: cnt, tickers: t || [] }; }
  const out = await pipe([['SADD', kDay, ticker], ['EXPIRE', kDay, 172800], ['SCARD', kDay], ['SMEMBERS', kDay], ...(had ? [] : [['HINCRBY', kUser, 'total', 1]]), ...touch(u, kUser)]);
  return { ok: true, repeat: !!had, used: out[2], tickers: out[3] || [] };
}
