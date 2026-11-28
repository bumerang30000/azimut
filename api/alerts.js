// Ценовые уведомления: пользователь ставит уровень в мини-приложении, бот пишет ему в Telegram,
// когда цена его достигает.
// POST /api/alerts?a=add   {initData, market, sym, disp, price, now, kind, label, lang, ctx}
// POST /api/alerts?a=list  {initData}
// POST /api/alerts?a=del   {initData, id}
// GET|POST /api/alerts?a=check   — проверка цен; вызывается раз в минуту планировщиком Supabase (pg_cron)
import { parseInitData } from './_tg.js';
import { hasSb, sb, rpc, prof, cors, readBody } from './_store.js';
import { yf, UA } from './_yahoo.js';

const MAX_ACTIVE = 20, TTL_DAYS = 30;
const SITE = (process.env.SITE_URL || 'https://azimut-ten.vercel.app').replace(/\/$/, '');
const TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
const MARKETS = new Set(['crypto', 'stock', 'moex']);
const KINDS = new Set(['entry', 'conf', 'target', 'stop', 'level']);

export default async function handler(req, res) {
  cors(res);
  const a = String(req.query.a || '');
  if (!hasSb) return res.status(503).json({ error: 'storage' });
  if (a === 'check') return check(req, res);
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  const body = await readBody(req);
  const auth = parseInitData(body.initData);
  if (!auth.ok) return res.status(401).json({ error: auth.reason });
  if (!auth.verified) return res.status(403).json({ error: 'unverified' });
  const u = auth.user;
  try {
    if (a === 'list') return res.status(200).json({ alerts: await list(u.id), bot: !!TOKEN });
    if (a === 'del') {
      const id = parseInt(body.id, 10); if (!id) return res.status(400).json({ error: 'id' });
      await sb(`az_alerts?id=eq.${id}&user_id=eq.${encodeURIComponent(u.id)}`, { method: 'DELETE' });
      return res.status(200).json({ ok: true, alerts: await list(u.id) });
    }
    if (a === 'add') {
      const market = String(body.market), sym = String(body.sym || '').toUpperCase().replace(/[^A-Z0-9=^.\-]/g, '').slice(0, 24);
      const price = +body.price, now = +body.now;
      if (!MARKETS.has(market) || !sym || !(price > 0) || !(now > 0)) return res.status(400).json({ error: 'bad' });
      if (Math.abs(price / now - 1) > 0.5) return res.status(400).json({ error: 'far' });
      const act = await sb(`az_alerts?select=id,sym,price&user_id=eq.${encodeURIComponent(u.id)}&fired_at=is.null`);
      const dup = act.find(x => x.sym === sym && Math.abs(x.price / price - 1) < 0.0005);
      if (dup) return res.status(200).json({ ok: true, id: dup.id, repeat: true, alerts: await list(u.id), bot: !!TOKEN });
      if (act.length >= MAX_ACTIVE) return res.status(429).json({ error: 'max', max: MAX_ACTIVE });
      await rpc('az_touch', prof(u)).catch(() => {});
      const ctx = body.ctx && typeof body.ctx === 'object' ? JSON.parse(JSON.stringify(body.ctx).slice(0, 2000)) : null;
      const [row] = await sb('az_alerts', { method: 'POST', prefer: 'return=representation', body: {
        user_id: u.id, chat_id: u.id, market, sym, disp: String(body.disp || sym).slice(0, 24), price, cond: price >= now ? 'above' : 'below',
        start_price: now, kind: KINDS.has(body.kind) ? body.kind : 'level', label: String(body.label || '').slice(0, 80),
        lang: body.lang === 'en' ? 'en' : 'ru', ctx } });
      return res.status(200).json({ ok: true, id: row.id, alerts: await list(u.id), bot: !!TOKEN });
    }
    return res.status(400).json({ error: 'action' });
  } catch (e) {
    return res.status(500).json({ error: 'store', detail: String(e.message).slice(0, 160) });
  }
}

async function list(uid) {
  const since = new Date(Date.now() - 7 * 864e5).toISOString();
  return sb(`az_alerts?select=id,market,sym,disp,price,cond,kind,label,created_at,fired_at,fired_price&user_id=eq.${encodeURIComponent(uid)}&or=(fired_at.is.null,fired_at.gt.${since})&order=fired_at.desc.nullsfirst,created_at.desc&limit=40`);
}

/* ---------- проверка цен ---------- */
async function getJSON(url, ms = 6000) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(url.split('?')[0] + ' ' + r.status);
  return r.json();
}
// минутные свечи с момента from (сек): [{t, h, l, c}]
async function bars(market, sym, from) {
  if (market === 'crypto') {
    for (const h of ['https://data-api.binance.vision', 'https://api.binance.com']) {
      try { const j = await getJSON(`${h}/api/v3/klines?symbol=${sym}&interval=1m&startTime=${from * 1000}&limit=1000`); if (Array.isArray(j) && j.length) return j.map(k => ({ t: k[0] / 1000, h: +k[2], l: +k[3], c: +k[4] })); } catch (e) {}
    }
    const j = await getJSON(`https://api.bybit.com/v5/market/kline?category=spot&symbol=${sym}&interval=1&start=${from * 1000}&limit=1000`);
    return (j?.result?.list || []).map(k => ({ t: k[0] / 1000, h: +k[2], l: +k[3], c: +k[4] })).reverse();
  }
  if (market === 'stock') {
    try {
      const r = await yf.chart(sym, { period1: new Date((from - 120) * 1000), interval: '1m', return: 'array' }, { validateResult: false });
      const q = (r.quotes || []).filter(x => x.high != null && x.low != null);
      if (q.length) return q.map(x => ({ t: new Date(x.date).getTime() / 1000, h: x.high, l: x.low, c: x.close ?? x.high }));
    } catch (e) {}
    const j = await getJSON(`https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1m`);
    const r = j?.chart?.result?.[0], q = r?.indicators?.quote?.[0]; if (!r || !q) return [];
    return r.timestamp.map((t, i) => ({ t, h: q.high[i], l: q.low[i], c: q.close[i] })).filter(b => b.h != null);
  }
  // Мосбиржа: последняя сделка (акции и индексы)
  for (const p of [`engines/stock/markets/shares/boards/TQBR/securities/${sym}`, `engines/stock/markets/shares/boards/TQTF/securities/${sym}`, `engines/stock/markets/index/securities/${sym}`]) {
    try {
      const j = await getJSON(`https://iss.moex.com/iss/${p}.json?iss.meta=off&iss.only=marketdata`);
      const m = j.marketdata, row = m && m.data[0]; if (!row) continue;
      const last = row[m.columns.indexOf('LAST')] ?? row[m.columns.indexOf('CURRENTVALUE')];
      if (last) return [{ t: Date.now() / 1000, h: +last, l: +last, c: +last }];
    } catch (e) {}
  }
  return [];
}

const L = {
  ru: { above: 'выше', below: 'ниже', now: 'Сейчас', since: 'с момента установки', long: 'лонг', short: 'шорт', open: 'Открыть свежий разбор',
    conf: (d, s, side, lvl, c) => `✅ <b>${d}</b>: сигнал на ${s} подтверждён\n15-минутная свеча закрылась ${side} ${lvl} (закрытие ${c})`,
    entry: (d, p, l) => `🎯 <b>${d}</b> у точки входа ${p}${l ? ` · ${l}` : ''}`,
    target: (d, p, l) => `🏁 <b>${d}</b>: ${l || 'цель'} ${p} достигнута\nРазумно зафиксировать часть позиции и перенести стоп в безубыток.`,
    stop: (d, p) => `⛔ <b>${d}</b> у безопасного стопа ${p}\nСценарий под угрозой — проверьте позицию.`,
    level: (d, p, cond) => `🔔 <b>${d}</b> ${cond} ${p}`,
    plan: 'План входа', entryAt: 'Вход сейчас ≈', entryLvl: 'Вход', stopL: 'Стоп', tgt: 'Цель', part: 'частичная фиксация', rr: 'Риск/прибыль', chance: 'шанс',
    size: x => `При риске 1% депозита объём позиции ≈ ${x}% депозита.`,
    vStop: '⚠ Цена уже за стопом — вход отменён.',
    vFar: lvl => `⚠ Цена ушла от уровня: риск/прибыль ниже 1 : 1,5 — вход невыгоден. Дождитесь отката к ${lvl}.`,
    vBad: '⚠ Соотношение риск/прибыль ниже 1 : 1,5 — вход невыгоден, лучше пропустить.',
    vOk: 'Соотношение выгодное. Стоп ставьте сразу при входе.' },
  en: { above: 'above', below: 'below', now: 'Now', since: 'since the alert was set', long: 'long', short: 'short', open: 'Open fresh analysis',
    conf: (d, s, side, lvl, c) => `✅ <b>${d}</b>: ${s} signal confirmed\nA 15-minute candle closed ${side} ${lvl} (close ${c})`,
    entry: (d, p, l) => `🎯 <b>${d}</b> at the entry point ${p}${l ? ` · ${l}` : ''}`,
    target: (d, p, l) => `🏁 <b>${d}</b>: ${l || 'target'} ${p} reached\nConsider taking partial profit and moving the stop to breakeven.`,
    stop: (d, p) => `⛔ <b>${d}</b> at the safe stop ${p}\nThe scenario is at risk — review the position.`,
    level: (d, p, cond) => `🔔 <b>${d}</b> ${cond} ${p}`,
    plan: 'Entry plan', entryAt: 'Entry now ≈', entryLvl: 'Entry', stopL: 'Stop', tgt: 'Target', part: 'partial take', rr: 'Risk/reward', chance: 'chance',
    size: x => `Risking 1% of the account, position size ≈ ${x}% of the account.`,
    vStop: '⚠ Price is already beyond the stop — entry cancelled.',
    vFar: lvl => `⚠ Price has moved away from the level: risk/reward is below 1 : 1.5 — entry is not worth it. Wait for a pullback to ${lvl}.`,
    vBad: '⚠ Risk/reward is below 1 : 1.5 — skip this entry.',
    vOk: 'The ratio is favourable. Place the stop right away.' }
};
function fmt(x, lang) {
  const d = x >= 1000 ? 0 : x >= 100 ? 1 : x >= 1 ? 2 : x >= 0.01 ? 4 : 6;
  return Number(x).toLocaleString(lang === 'en' ? 'en-US' : 'ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d });
}
const pct = (x, lang) => (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x * 100).toLocaleString(lang === 'en' ? 'en-US' : 'ru-RU', { maximumFractionDigits: 2 }) + '%';
const num1 = (x, lang) => Number(x).toFixed(1).replace('.', lang === 'en' ? '.' : ',');
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// план входа от цены e: стоп и цели берутся из разбора на момент установки, риск/прибыль пересчитывается
function planLines(c, e, lg, T, live, lvl) {
  const dir = c.dir, out = [];
  if (!dir || !c.stop || !(c.t2 || c.t1)) return out;
  const tg = c.t2 || c.t1, risk = dir * (e - c.stop), rew = dir * (tg - e), rr = risk > 0 && rew > 0 ? rew / risk : 0;
  out.push('', `<b>${T.plan} (${dir > 0 ? T.long : T.short})</b>`, `${live ? T.entryAt : T.entryLvl} <b>${fmt(e, lg)}</b>`,
    `${T.stopL}: ${fmt(c.stop, lg)} (${pct(c.stop / e - 1, lg)})`,
    `${T.tgt}: ${fmt(tg, lg)} (${pct(tg / e - 1, lg)})${c.t1 && c.t1 !== tg ? ` · ${T.part} ${fmt(c.t1, lg)}` : ''}`,
    `${T.rr}: <b>1 : ${num1(rr, lg)}</b>${c.pw ? ` · ${T.chance} ≈ ${Math.round(c.pw * 100)}%` : ''}`);
  if (risk <= 0) out.push(T.vStop);
  else if (rr < 1.5) out.push(live && lvl ? T.vFar(fmt(lvl, lg)) : T.vBad);
  else { out.push(T.vOk); out.push(T.size(Math.min(100, Math.round(1 / (risk / e))))); }
  return out;
}
function message(al, last, close) {
  const lg = al.lang === 'en' ? 'en' : 'ru', T = L[lg], c = al.ctx || {}, d = esc(al.disp), P = fmt(al.price, lg);
  let lines;
  if (al.kind === 'conf') {
    lines = [T.conf(d, c.dir > 0 ? T.long : c.dir < 0 ? T.short : (al.cond === 'above' ? T.long : T.short), al.cond === 'above' ? T.above : T.below, P, fmt(close ?? last, lg))];
    lines.push(...planLines(c, close ?? last, lg, T, true, al.price));
  } else if (al.kind === 'entry') {
    lines = [T.entry(d, P, esc(al.label || '')), `${T.now}: <b>${fmt(last, lg)}</b>`];
    lines.push(...planLines(c, al.price, lg, T, false));
  } else if (al.kind === 'target') lines = [T.target(d, P, esc(al.label || '')), `${T.now}: <b>${fmt(last, lg)}</b>`];
  else if (al.kind === 'stop') lines = [T.stop(d, P), `${T.now}: <b>${fmt(last, lg)}</b>`];
  else lines = [T.level(d, P, al.cond === 'above' ? T.above : T.below), `${T.now}: <b>${fmt(last, lg)}</b>${al.start_price ? ` (${pct(last / al.start_price - 1, lg)} ${T.since})` : ''}`];
  return lines.join('\n');
}
async function send(al, text) {
  if (!TOKEN) return 'no BOT_TOKEN';
  const q = encodeURIComponent(al.market === 'crypto' ? al.sym.replace(/USDT$/, '') : al.sym);
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(6000),
    body: JSON.stringify({ chat_id: al.chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [[{ text: L[al.lang === 'en' ? 'en' : 'ru'].open, web_app: { url: `${SITE}/#${q}` } }]] } }) });
  if (r.ok) return null;
  return ('tg ' + r.status + ' ' + (await r.text()).slice(0, 150));
}

async function check(req, res) {
  const t0 = Date.now();
  await sb(`az_alerts?fired_at=is.null&created_at=lt.${new Date(Date.now() - TTL_DAYS * 864e5).toISOString()}`, { method: 'DELETE' }).catch(() => {});
  const act = await sb('az_alerts?select=*&fired_at=is.null&order=checked_at.asc&limit=400');
  if (!act.length) return res.status(200).json({ ok: true, active: 0 });
  const groups = new Map();
  for (const al of act) { const k = al.market + ':' + al.sym; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(al); }
  let fired = 0, errors = 0; const okIds = [], nowIso = new Date().toISOString();
  await Promise.all([...groups.values()].map(async list => {
    if (Date.now() - t0 > 9000) return;
    const from = Math.floor(Math.min(...list.map(x => Date.parse(x.checked_at))) / 1000) - 60;
    let bs; try { bs = await bars(list[0].market, list[0].sym, from); } catch (e) { errors++; return; }
    if (!bs.length) return;
    const last = bs[bs.length - 1].c;
    for (const al of list) {
      const since = Math.floor(Date.parse(al.checked_at) / 60000) * 60, seg = bs.filter(b => b.t >= since);
      if (!seg.length) { okIds.push(al.id); continue; }
      let hit, close = null;
      if (al.kind === 'conf' && al.market !== 'moex') {
        // подтверждение — только по закрытию 15-минутной свечи за уровнем (последняя минута каждой четверти часа)
        const nowS = Date.now() / 1000;
        const ends = seg.filter(b => Math.round(b.t) % 900 === 840 && b.t + 60 <= nowS);
        const c = ends.find(b => al.cond === 'above' ? b.c > al.price : b.c < al.price);
        hit = !!c; if (c) close = c.c;
      } else {
        const hi = Math.max(...seg.map(b => b.h)), lo = Math.min(...seg.map(b => b.l));
        hit = al.cond === 'above' ? hi >= al.price : lo <= al.price;
      }
      if (!hit) { okIds.push(al.id); continue; }
      const err = await send(al, message(al, last, close)).catch(e => String(e.message));
      await sb(`az_alerts?id=eq.${al.id}`, { method: 'PATCH', body: { fired_at: nowIso, fired_price: last, checked_at: nowIso, send_error: err } }).catch(() => {});
      fired++; if (err) errors++;
    }
  }));
  for (let i = 0; i < okIds.length; i += 150) await sb(`az_alerts?id=in.(${okIds.slice(i, i + 150).join(',')})`, { method: 'PATCH', body: { checked_at: nowIso } }).catch(() => {});
  return res.status(200).json({ ok: true, active: act.length, groups: groups.size, fired, errors, ms: Date.now() - t0 });
}
