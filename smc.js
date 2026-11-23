/* Азимут · Smart Money модуль: ордер-блоки, пулы ликвидности, оценочная карта ликвидаций,
   калибровка вероятностей сценариев методом Монте-Карло. Работает в браузере и в Node. */
(function (root) {
'use strict';
const __t = (typeof root.__t === 'function') ? root.__t : ((k, a) => a ? k.replace(/\{(\d+)\}/g, (_, i) => a[+i]) : k);

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const median = a => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

function atrArr(b, n = 14) {
  const o = new Array(b.length).fill(null); let a = null, s = 0;
  for (let i = 1; i < b.length; i++) {
    const tr = Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c));
    if (i <= n) { s += tr; if (i === n) { a = s / n; o[i] = a; } } else { a = (a * (n - 1) + tr) / n; o[i] = a; }
  }
  for (let i = 0; i < o.length; i++) if (o[i] == null) o[i] = b[i].h - b[i].l;
  return o;
}

/* Фрактальные свинги: экстремум, не перекрытый n барами слева и справа */
function fractals(b, n = 3) {
  const out = [];
  for (let i = n; i < b.length - n; i++) {
    let hi = true, lo = true;
    for (let k = 1; k <= n; k++) {
      if (b[i - k].h >= b[i].h || b[i + k].h > b[i].h) hi = false;
      if (b[i - k].l <= b[i].l || b[i + k].l < b[i].l) lo = false;
    }
    if (hi) out.push({ i, p: b[i].h, t: 'H' });
    if (lo) out.push({ i, p: b[i].l, t: 'L' });
  }
  return out;
}

/* ---------- Ордер-блоки ----------
   Бычий OB — последняя медвежья свеча перед импульсом, который сломал структуру (закрылся выше свинг-хая).
   Медвежий OB — зеркально. Импульс должен быть «смещением»: ≥ 1,2 ATR от зоны и/или с имбалансом (FVG).
   Статус: «нетронут» — цена не возвращалась; «протестирован» — заходила, но не закрылась за зоной;
   «пробит» — закрытие за дальней границей (зона снимается). */
function orderBlocks(b, opt = {}) {
  const N = b.length, A = atrArr(b), fr = fractals(b, opt.n || 3), price = b[N - 1].c;
  const vAvg = []; { let s = 0; for (let i = 0; i < N; i++) { s += b[i].v || 0; if (i >= 20) s -= b[i - 20].v || 0; vAvg.push(s / Math.min(i + 1, 20) || 1); } }
  const raw = [];
  let fi = 0, lastH = null, lastL = null;
  const usedH = new Set(), usedL = new Set();
  for (let i = 1; i < N; i++) {
    // фрактал подтверждается через n баров — учитываем только подтверждённые
    while (fi < fr.length && fr[fi].i + (opt.n || 3) <= i) { const f = fr[fi++]; if (f.t === 'H') lastH = f; else lastL = f; }
    const c = b[i].c;
    if (lastH && !usedH.has(lastH.i) && c > lastH.p) {           // слом структуры вверх
      usedH.add(lastH.i);
      let lo = i, from = Math.max(0, lastH.i - 30);
      for (let j = i; j >= from; j--) if (b[j].l < b[lo].l) lo = j;
      let ob = -1; for (let j = lo; j >= Math.max(0, lo - 4); j--) if (b[j].c < b[j].o) { ob = j; break; }
      if (ob < 0) ob = lo;
      const top = Math.min(b[ob].h, Math.max(b[ob].o, b[ob].c) + A[ob] * 0.25), bot = b[ob].l;
      const disp = (Math.max(...b.slice(ob + 1, i + 1).map(x => x.h)) - top) / A[i];
      let fvg = false; for (let j = ob + 1; j <= Math.min(i, ob + 4) && j + 1 < N; j++) if (b[j + 1].l > b[j - 1].h) fvg = true;
      if (disp >= 1.2 || fvg) raw.push({ side: 'bull', i: ob, bos: i, top, bot, disp, fvg, vol: (b[ob].v || 0) / vAvg[ob] });
    }
    if (lastL && !usedL.has(lastL.i) && c < lastL.p) {           // слом структуры вниз
      usedL.add(lastL.i);
      let hi = i, from = Math.max(0, lastL.i - 30);
      for (let j = i; j >= from; j--) if (b[j].h > b[hi].h) hi = j;
      let ob = -1; for (let j = hi; j >= Math.max(0, hi - 4); j--) if (b[j].c > b[j].o) { ob = j; break; }
      if (ob < 0) ob = hi;
      const bot = Math.max(b[ob].l, Math.min(b[ob].o, b[ob].c) - A[ob] * 0.25), top = b[ob].h;
      const disp = (bot - Math.min(...b.slice(ob + 1, i + 1).map(x => x.l))) / A[i];
      let fvg = false; for (let j = ob + 1; j <= Math.min(i, ob + 4) && j + 1 < N; j++) if (b[j + 1].h < b[j - 1].l) fvg = true;
      if (disp >= 1.2 || fvg) raw.push({ side: 'bear', i: ob, bos: i, top, bot, disp, fvg, vol: (b[ob].v || 0) / vAvg[ob] });
    }
  }
  // статус после формирования
  for (const z of raw) {
    z.touches = 0; z.broken = null; let inside = false;
    for (let k = z.bos + 1; k < N; k++) {
      const x = b[k];
      if (z.side === 'bull') {
        if (x.c < z.bot) { z.broken = k; break; }
        const now = x.l <= z.top; if (now && !inside) z.touches++; inside = now;
      } else {
        if (x.c > z.top) { z.broken = k; break; }
        const now = x.h >= z.bot; if (now && !inside) z.touches++; inside = now;
      }
    }
    z.age = N - 1 - z.i;
    z.strength = clamp((Math.min(z.disp, 6) / 3) * (z.fvg ? 1.25 : 1) * clamp(0.7 + 0.3 * z.vol, 0.7, 1.6) * (z.touches === 0 ? 1 : z.touches === 1 ? 0.75 : 0.5), 0.1, 3);
  }
  const live = raw.filter(z => z.broken == null);
  // дубликаты/наложения: оставляем сильнейшую из перекрывающихся
  const pick = side => {
    const s = live.filter(z => z.side === side && (side === 'bull' ? z.top < price * 1.002 : z.bot > price * 0.998))
      .sort((x, y) => side === 'bull' ? y.top - x.top : x.bot - y.bot);
    const out = [];
    for (const z of s) {
      const ov = out.find(o => z.bot <= o.top && z.top >= o.bot);
      if (ov) { if (z.strength > ov.strength) Object.assign(ov, z); continue; }
      out.push({ ...z }); if (out.length >= 4) break;
    }
    return out;
  };
  return { bull: pick('bull'), bear: pick('bear'), all: raw };
}

/* ---------- Пулы ликвидности ----------
   Над нетронутыми свинг-хаями стоят стопы шортистов и ордера на пробой (buy-side liquidity),
   под свинг-лоу — стопы лонгистов (sell-side). Равные хаи/лоу — самые «жирные» пулы.
   Снятие ликвидности: тень вышла за свинг, а закрытие вернулось обратно. */
function liquidityPools(b, opt = {}) {
  const N = b.length, A = atrArr(b), fr = fractals(b, opt.n || 3), price = b[N - 1].c, atrNow = A[N - 1];
  const pools = [], sweeps = [];
  for (const f of fr) {
    let taken = null;
    for (let k = f.i + 1; k < N; k++) {
      const x = b[k];
      if (f.t === 'H' ? x.h > f.p : x.l < f.p) {
        taken = k;
        const back = f.t === 'H' ? x.c < f.p : x.c > f.p;
        if (back && N - 1 - k <= (opt.sweepLook || 40)) sweeps.push({ i: k, side: f.t === 'H' ? 'buy' : 'sell', p: f.p, ext: f.t === 'H' ? x.h : x.l });
        break;
      }
    }
    if (taken == null) pools.push({ ...f });
  }
  // склейка равных уровней
  const tol = atrNow * 0.35, groups = [];
  for (const p of pools.sort((x, y) => x.p - y.p)) {
    const g = groups.find(g => g.t === p.t && Math.abs(g.p - p.p) <= tol);
    if (g) { g.n++; g.items.push(p); g.p = g.items.reduce((s, x) => s + x.p, 0) / g.items.length; g.last = Math.max(g.last, p.i); }
    else groups.push({ t: p.t, p: p.p, n: 1, items: [p], last: p.i });
  }
  for (const g of groups) {
    const ext = g.t === 'H' ? Math.max(...g.items.map(x => x.p)) : Math.min(...g.items.map(x => x.p));
    g.edge = ext;
    g.strength = g.n * (1 + Math.min(1, (N - 1 - g.last) / 60) * 0.3);
  }
  const above = groups.filter(g => g.t === 'H' && g.edge > price).sort((x, y) => x.edge - y.edge).slice(0, 4);
  const below = groups.filter(g => g.t === 'L' && g.edge < price).sort((x, y) => y.edge - x.edge).slice(0, 4);
  // повторные снятия одного уровня — оставляем последнее
  const sw = []; for (const s of sweeps.sort((x, y) => y.i - x.i)) if (!sw.some(o => o.i === s.i && o.side === s.side)) sw.push(s);
  return { above, below, sweeps: sw.slice(0, 6) };
}

/* ---------- Оценочная карта ликвидаций (крипто) ----------
   Модель в духе публичных «liquidation heatmap»: прирост открытого интереса на каждом 4-часовом баре
   считаем новыми позициями по средней цене бара; доля лонгов — по соотношению агрессивных покупок/продаж.
   Позиции раскладываем по типовым плечам, цену ликвидации считаем с учётом поддерживающей маржи.
   Если цена после открытия дошла до уровня ликвидации — позиция считается ликвидированной (событие на графике),
   остальные формируют кластеры, к которым рынок часто тянется. Это оценка, а не биржевые данные. */
const LEV = [[5, 0.10], [10, 0.25], [25, 0.30], [50, 0.20], [100, 0.15]];
const MM = 0.005;
function liqMap(bars, oi, taker, opt = {}) {
  if (!bars || bars.length < 30 || !oi || oi.length < 12) return null;
  const tIdx = new Map(bars.map((x, i) => [x.t, i]));
  const step = bars[1].t - bars[0].t;
  const tk = new Map((taker || []).map(x => [x.t, x]));
  const price = bars[bars.length - 1].c;
  let pos = [];                       // {side, liq, usd, i}
  const events = new Map();           // i -> {long, short}
  const open = (i, coins, share) => {
    const b = bars[i], tp = (b.h + b.l + b.c) / 3;
    for (const [L, w] of LEV) {
      pos.push({ side: 'long', liq: tp * (1 - 1 / L + MM), usd: coins * share * w * tp, i, L });
      pos.push({ side: 'short', liq: tp * (1 + 1 / L - MM), usd: coins * (1 - share) * w * tp, i, L });
    }
  };
  const first = oi[0], i0 = tIdx.get(first.t - step) ?? tIdx.get(first.t);
  if (i0 == null) return null;
  // стартовый открытый интерес раскладываем по последним 30 барам до окна с весом по объёму
  { const from = Math.max(0, i0 - 30), seg = bars.slice(from, i0 + 1), vs = seg.reduce((s, x) => s + (x.v || 1), 0);
    seg.forEach((x, k) => open(from + k, first.oi * 0.6 * (x.v || 1) / vs, 0.5)); }
  let prevOi = first.oi;
  for (let k = 1; k < oi.length; k++) {
    const o = oi[k], i = tIdx.get(o.t - step); if (i == null) { prevOi = o.oi; continue; }
    const d = o.oi - prevOi; prevOi = o.oi;
    if (d > 0) {
      const t = tk.get(o.t - step) || tk.get(o.t); let share = 0.5;
      if (t && t.buy + t.sell > 0) share = clamp(0.5 + (t.buy / (t.buy + t.sell) - 0.5) * 1.2, 0.3, 0.7);
      open(i, d, share);
    } else if (d < 0) {
      const tot = pos.reduce((s, p) => s + p.usd, 0), cut = clamp(-d * bars[i].c / (tot || 1), 0, 0.9);
      for (const p of pos) p.usd *= 1 - cut;
    }
  }
  // прогон цены: кто ликвидирован
  const iFirst = Math.min(...pos.map(p => p.i));
  const alive = [];
  for (const p of pos) {
    let hit = null;
    for (let j = p.i + 1; j < bars.length; j++) if (p.side === 'long' ? bars[j].l <= p.liq : bars[j].h >= p.liq) { hit = j; break; }
    if (hit == null) alive.push(p);
    else { const e = events.get(hit) || { long: 0, short: 0 }; e[p.side] += p.usd; events.set(hit, e); }
  }
  // кластеры: бины по 0,5% цены в пределах ±30%
  const bin = price * (opt.bin || 0.005), lo = price * 0.7, hi = price * 1.3, map = new Map();
  for (const p of alive) {
    if (p.liq < lo || p.liq > hi || p.usd < 1) continue;
    const k = Math.round(p.liq / bin);
    const m = map.get(k) || { p: k * bin, long: 0, short: 0 }; m[p.side] += p.usd; map.set(k, m);
  }
  const bins = [...map.values()].sort((a, b) => a.p - b.p);
  const vals = bins.map(x => x.long + x.short), mx = Math.max(1, ...vals);
  bins.forEach(x => x.w = (x.long + x.short) / mx);
  // крупнейшие кластеры по сторонам (склейка соседних бинов)
  const clusters = side => {
    const src = bins.filter(x => side === 'long' ? x.p < price : x.p > price).map(x => ({ p: x.p, usd: x[side] })).filter(x => x.usd > 0);
    const out = [];
    for (const x of src) {
      const c = out.find(o => Math.abs(o.p - x.p) <= bin * 2.01);
      if (c) { c.p = (c.p * c.usd + x.p * x.usd) / (c.usd + x.usd); c.usd += x.usd; } else out.push({ ...x });
    }
    return out.sort((a, b) => b.usd - a.usd).slice(0, 4).sort((a, b) => side === 'long' ? b.p - a.p : a.p - b.p);
  };
  const ev = [...events.entries()].map(([i, e]) => ({ i, t: bars[i].t, long: e.long, short: e.short })).filter(e => e.i >= iFirst);
  const evVals = ev.map(e => e.long + e.short).filter(x => x > 0);
  const thr = Math.max(median(evVals) * 3, (Math.max(0, ...evVals)) * 0.25);
  const big = ev.filter(e => e.long + e.short >= thr).sort((a, b) => (b.long + b.short) - (a.long + a.short)).slice(0, 8);
  const totalAlive = alive.reduce((s, p) => s + p.usd, 0);
  return { bins, longs: clusters('long'), shorts: clusters('short'), events: big, total: totalAlive, from: bars[iFirst].t, bin };
}

/* ---------- Вероятности сценариев: Монте-Карло ----------
   Пути цены с текущей волатильностью (умеренно «толстые хвосты») и небольшим дрейфом от суммарного сигнала.
   Считаем, какая цель будет достигнута первой за горизонт: верхняя, нижняя или ни одна (боковик). */
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
function race(price, up, dn, sigma, horizon, drift = 0, paths = 4000) {
  const r = rng(Math.round(price * 1000) % 2147483647 + horizon * 7919);
  let u = 0, d = 0, end = []; const lu = Math.log(up / price), ld = Math.log(dn / price);
  for (let k = 0; k < paths; k++) {
    let x = 0, hit = 0;
    for (let j = 0; j < horizon; j++) {
      // Стьюдент ν≈4 через смесь нормалей — хвосты толще, чем у гауссианы
      const g = Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(6.283185307 * r());
      const s = r() < 0.12 ? 1.9 : 0.86;
      x += drift + sigma * s * g;
      if (x >= lu) { hit = 1; break; } if (x <= ld) { hit = -1; break; }
    }
    if (hit > 0) u++; else if (hit < 0) d++; else end.push(x);
  }
  return { up: u / paths, down: d / paths, side: 1 - (u + d) / paths };
}

/* Сводка по деривативам для текста */
function derivSummary(oi, funding, lsAcc, priceNow, pricePrev7) {
  if (!oi || oi.length < 8) return null;
  const last = oi[oi.length - 1], wk = oi[Math.max(0, oi.length - 43)];
  const oiCh = (last.oi - wk.oi) / wk.oi, prCh = pricePrev7 ? (priceNow - pricePrev7) / pricePrev7 : 0;
  let read;
  if (prCh < -0.03 && oiCh < -0.05) read = __t("Цена падает вместе с открытым интересом — идёт вынос лонгов с плечом; после такой «чистки» давление продавцов часто слабеет.");
  else if (prCh < -0.03 && oiCh > 0.03) read = __t("Цена падает, а открытый интерес растёт — набираются новые шорты; это топливо для резкого шорт-сквиза вверх, если уровень удержат.");
  else if (prCh > 0.03 && oiCh > 0.03) read = __t("Рост сопровождается приростом открытого интереса — движение подкреплено новыми позициями.");
  else if (prCh > 0.03 && oiCh < -0.05) read = __t("Рост идёт на закрытии шортов (OI снижается) — без притока новых покупок он может выдохнуться.");
  else read = __t("Открытый интерес без резких изменений — плечевые позиции не дают явного перекоса.");
  return { oi: last.oi, oiUsd: last.oi * priceNow, oiCh, prCh, funding, lsAcc, read };
}

const api = { fractals, orderBlocks, liquidityPools, liqMap, race, derivSummary, atrArr };
if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.SMC = api;
})(typeof window !== 'undefined' ? window : globalThis);
