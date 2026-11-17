/*
 * Графики анализатора — чистый SVG, без библиотек (страница работает без интернета).
 * Цвета берутся из CSS-переменных (--s1, --s2, ...), поэтому светлая и тёмная тема переключаются сами.
 * Подсказки: у любого элемента с атрибутом data-tip при наведении показывается текст (см. app.js).
 */
const Charts = (() => {
  'use strict';

  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const RU = 'ru-RU';

  /** Число для людей: 2 знака у маленьких, 1 у средних, 0 у больших; лишние нули убираем. */
  function num(v, maxDigits) {
    if (!Number.isFinite(v)) return v > 0 ? '∞' : v < 0 ? '−∞' : '—';
    const a = Math.abs(v);
    const d = maxDigits !== undefined ? maxDigits : a >= 100 ? 0 : a >= 10 ? 1 : 2;
    return v.toLocaleString(RU, { maximumFractionDigits: d }).replace('-', '−');
  }
  function pct(p, d = 1) {
    if (p === null || !Number.isFinite(p)) return '—';
    return (p * 100).toLocaleString(RU, { minimumFractionDigits: d, maximumFractionDigits: d }) + ' %';
  }
  function compact(v) {
    if (v >= 1e6) return num(v / 1e6) + ' млн';
    if (v >= 1e3) return num(v / 1e3) + ' тыс';
    return num(v);
  }

  /** «Круглые» деления оси. */
  function ticks(min, max, count = 5) {
    if (!(max > min)) return [min];
    const raw = (max - min) / count, mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) || 10 * mag;
    const out = [];
    for (let v = Math.ceil(min / step - 1e-9) * step; v <= max + step * 1e-9; v += step) out.push(+v.toFixed(10));
    return out;
  }

  /** Столбик с закруглённым верхом (4px) и прямым низом. */
  function colPath(x, y, w, h, r = 4) {
    if (h <= 0) return '';
    r = Math.min(r, w / 2, h);
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }

  const svgOpen = (w, h, label) =>
    `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}">`;

  // ===================================================================================
  // Гистограмма итога: столбик = доля прогонов, нижняя часть — событие «да», верхняя — «нет»
  // ===================================================================================
  function histogram(el, o) {
    const W = Math.max(280, el.clientWidth), H = 240;
    const m = { l: 44, r: 8, t: 10, b: 34 };
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const bins = o.bins, k = bins.length;
    const maxP = Math.max(...bins.map(b => b.p), 1e-9);
    const yt = ticks(0, maxP, 4), yMax = Math.max(yt[yt.length - 1], maxP);
    const y = p => m.t + ih - (p / yMax) * ih;
    const slot = iw / k, bw = Math.min(24, Math.max(2, slot - 2));
    let s = svgOpen(W, H, o.title);
    yt.forEach(t => {
      s += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}"/>` +
           `<text class="tick" x="${m.l - 6}" y="${y(t) + 4}" text-anchor="end">${pct(t, t < 0.1 && yMax < 0.1 ? 1 : 0)}</text>`;
    });
    // подписи оси X: у дискретного — значения, у непрерывного — круглые числа по шкале
    if (o.discrete) {
      const every = Math.ceil(k / Math.max(1, Math.floor(iw / 44)));
      bins.forEach((b, i) => {
        if (i % every) return;
        s += `<text class="tick" x="${m.l + slot * (i + 0.5)}" y="${H - m.b + 16}" text-anchor="middle">${num(b.from)}</text>`;
      });
    } else {
      const lo = bins[0].from, hi = bins[k - 1].to;
      ticks(lo, hi, Math.max(2, Math.floor(iw / 70))).forEach(t => {
        const x = m.l + ((t - lo) / (hi - lo)) * iw;
        s += `<text class="tick" x="${x}" y="${H - m.b + 16}" text-anchor="middle">${num(t)}</text>`;
      });
    }
    if (o.axisLabel) s += `<text class="tick" x="${W - m.r}" y="${H - 2}" text-anchor="end">${esc(o.axisLabel)}</text>`;
    bins.forEach((b, i) => {
      const x = m.l + slot * i + (slot - bw) / 2;
      const yesH = o.hasEvent ? (b.pYes / yMax) * ih : 0;
      const allH = (b.p / yMax) * ih;
      const noH = allH - yesH;
      const range = b.label || (o.discrete ? `${num(b.from)}` : `${num(b.from)} … ${num(b.to)}`);
      let tip = `${o.resultLabel}: ${range}${o.unit ? ' ' + o.unit : ''}\n${pct(b.p, 2)} прогонов`;
      if (o.hasEvent) tip += `\n${o.yesLabel}: ${pct(b.pYes, 2)} · ${o.noLabel}: ${pct(b.p - b.pYes, 2)}`;
      // нижний сегмент («да»), над ним через 2px зазор — «нет»; закругляется только верхний
      if (o.hasEvent) {
        if (yesH > 0) s += `<path class="s1" d="${noH > 2 ? `M${x},${m.t + ih}V${m.t + ih - yesH}H${x + bw}V${m.t + ih}Z`
                                                             : colPath(x, m.t + ih - yesH, bw, yesH)}"/>`;
        if (noH > 2) s += `<path class="s2" d="${colPath(x, m.t + ih - allH, bw, yesH > 0 ? noH - 2 : noH)}"/>`;
      } else if (allH > 0) {
        s += `<path class="s1" d="${colPath(x, m.t + ih - allH, bw, allH)}"/>`;
      }
      s += `<rect class="hit" x="${m.l + slot * i}" y="${m.t}" width="${slot}" height="${ih}" data-tip="${esc(tip)}"/>`;
    });
    s += `<line class="axis" x1="${m.l}" x2="${W - m.r}" y1="${m.t + ih}" y2="${m.t + ih}"/></svg>`;
    el.innerHTML = s;
  }

  // ===================================================================================
  // «Торнадо»: для каждого фактора — вероятность при «малом» и «большом» его значении
  // ===================================================================================
  function tornado(el, o) {
    const W = Math.max(280, el.clientWidth);
    const rowH = 56;
    const longest = Math.max(...o.items.map(it => it.name.length));
    const labelW = Math.min(W * 0.4, Math.max(70, longest * 8.5 + 18));
    const m = { l: labelW, r: 16, t: 24, b: 26 };
    const H = m.t + m.b + rowH * o.items.length;
    const iw = W - m.l - m.r;
    let lo = 0, hi = 1;
    if (!o.hasEvent) {
      const vals = o.items.flatMap(it => [it.low.mean, it.high.mean]).concat(o.base.mean);
      lo = Math.min(...vals); hi = Math.max(...vals);
      const pad = (hi - lo) * 0.08 || 1; lo -= pad; hi += pad;
    }
    const val = r => (o.hasEvent ? r.p : r.mean);
    const fmt = v => (o.hasEvent ? pct(v) : num(v) + (o.unit ? ' ' + o.unit : ''));
    const x = v => m.l + ((v - lo) / (hi - lo)) * iw;
    let s = svgOpen(W, H, o.title);
    const xt = o.hasEvent ? [0, 0.25, 0.5, 0.75, 1] : ticks(lo, hi, 4);
    xt.forEach(t => {
      s += `<line class="grid" x1="${x(t)}" x2="${x(t)}" y1="${m.t}" y2="${H - m.b}"/>` +
           `<text class="tick" x="${x(t)}" y="${H - m.b + 16}" text-anchor="middle">${o.hasEvent ? pct(t, 0) : num(t)}</text>`;
    });
    const bx = x(val(o.base));
    s += `<line class="base" x1="${bx}" x2="${bx}" y1="${m.t - 6}" y2="${H - m.b}"/>` +
         `<text class="tick strong" x="${bx}" y="${m.t - 10}" text-anchor="middle">сейчас ${fmt(val(o.base))}</text>`;
    o.items.forEach((it, i) => {
      let cy = m.t + rowH * i + rowH / 2;
      const a = x(val(it.low)), b = x(val(it.high));
      // имя слева, под отрезком — цифры: «значение фактора → результат»
      s += `<text class="lbl" x="${m.l - 12}" y="${cy}" text-anchor="end">${esc(it.name)}</text>` +
           `<text class="tick halo" x="${m.l}" y="${cy + 19}">${num(it.low.value)} → ${fmt(val(it.low))} · ${num(it.high.value)} → ${fmt(val(it.high))}</text>`;
      cy -= 4;
      s += `<line class="range" x1="${Math.min(a, b)}" x2="${Math.max(a, b)}" y1="${cy}" y2="${cy}"/>`;
      s += `<circle class="dot s1" cx="${a}" cy="${cy}" r="5"/><circle class="dot s2" cx="${b}" cy="${cy}" r="5"/>`;
      const tip = `${it.label}\nЕсли всегда ${num(it.low.value)} (10-й перцентиль): ${fmt(val(it.low))}\n` +
                  `Если всегда ${num(it.high.value)} (90-й перцентиль): ${fmt(val(it.high))}\nСейчас: ${fmt(val(o.base))}` +
                  (it.drives && it.drives.length ? `\nВместе с ним заново разыгрываются: ${it.drives.join(', ')}` : '');
      s += `<rect class="hit" x="0" y="${cy - rowH / 2}" width="${W}" height="${rowH}" data-tip="${esc(tip)}"/>`;
    });
    el.innerHTML = s + '</svg>';
  }

  // ===================================================================================
  // Сходимость: оценка после 100, 200, 500, ... прогонов и её 95% коридор
  // ===================================================================================
  function convergence(el, o) {
    const W = Math.max(280, el.clientWidth), H = 220;
    const m = { l: 56, r: 12, t: 12, b: 30 };
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const pts = o.points;
    const v = p => (o.hasEvent ? p.p : p.mean);
    let lo = Math.min(...pts.map(p => v(p) - (p.half || 0)));
    let hi = Math.max(...pts.map(p => v(p) + (p.half || 0)));
    if (o.exact !== null && o.exact !== undefined) { lo = Math.min(lo, o.exact); hi = Math.max(hi, o.exact); }
    if (o.hasEvent) { lo = Math.max(0, lo); hi = Math.min(1, hi); }
    if (!(hi > lo)) { hi = lo + 1e-6; }
    const yt = ticks(lo, hi, 4);
    lo = Math.min(lo, yt[0]); hi = Math.max(hi, yt[yt.length - 1]);
    const n0 = Math.log10(pts[0].n), n1 = Math.log10(Math.max(pts[pts.length - 1].n, pts[0].n * 10));
    const x = n => m.l + ((Math.log10(n) - n0) / (n1 - n0)) * iw;
    const y = val => m.t + ih - ((val - lo) / (hi - lo)) * ih;
    const fmt = val => (o.hasEvent ? pct(val, 2) : num(val));
    let s = svgOpen(W, H, o.title);
    yt.forEach(t => {
      s += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}"/>` +
           `<text class="tick" x="${m.l - 6}" y="${y(t) + 4}" text-anchor="end">${o.hasEvent ? pct(t, hi - lo < 0.02 ? 1 : 0) : num(t)}</text>`;
    });
    for (let p = Math.ceil(n0); p <= Math.floor(n1); p++)
      s += `<text class="tick" x="${x(10 ** p)}" y="${H - m.b + 16}" text-anchor="middle">${compact(10 ** p)}</text>`;
    if (o.hasEvent) {
      const up = pts.map(p => `${x(p.n)},${y(Math.min(1, v(p) + p.half))}`);
      const dn = pts.slice().reverse().map(p => `${x(p.n)},${y(Math.max(0, v(p) - p.half))}`);
      s += `<path class="band" d="M${up.join('L')}L${dn.join('L')}Z"/>`;
    }
    if (o.exact !== null && o.exact !== undefined) {
      s += `<line class="ref" x1="${m.l}" x2="${W - m.r}" y1="${y(o.exact)}" y2="${y(o.exact)}"/>` +
           `<text class="tick strong" x="${W - m.r}" y="${y(o.exact) - 6}" text-anchor="end">точно ${fmt(o.exact)}</text>`;
    }
    s += `<polyline class="line" points="${pts.map(p => `${x(p.n)},${y(v(p))}`).join(' ')}"/>`;
    pts.forEach(p => {
      const tip = `После ${p.n.toLocaleString(RU)} прогонов:\n${fmt(v(p))}` + (o.hasEvent ? ` ± ${pct(p.half, 2)}` : '');
      s += `<circle class="dot s1" cx="${x(p.n)}" cy="${y(v(p))}" r="4"/>` +
           `<circle class="hit" cx="${x(p.n)}" cy="${y(v(p))}" r="12" data-tip="${esc(tip)}"/>`;
    });
    s += `<line class="axis" x1="${m.l}" x2="${W - m.r}" y1="${m.t + ih}" y2="${m.t + ih}"/>` +
         `<text class="tick" x="${W - m.r}" y="${H - 2}" text-anchor="end">число прогонов</text></svg>`;
    el.innerHTML = s;
  }

  // ===================================================================================
  // Маленькое превью формы распределения фактора
  // ===================================================================================
  function shape(dist) {
    const W = 150, H = 36;
    let bars;
    if (dist.support && dist.support.length <= 40) {
      bars = dist.support.slice().sort((a, b) => a[0] - b[0]).map(([v, p]) => ({ p, tip: `${num(v)}: ${pct(p)}` }));
    } else {
      const rng = new MC.Rng(1), N = 3000, xs = new Float64Array(N);
      for (let i = 0; i < N; i++) xs[i] = dist.sample(rng);
      xs.sort();
      const lo = xs[Math.floor(N * 0.005)], hi = xs[Math.ceil(N * 0.995) - 1], k = 24, w = (hi - lo) / k || 1;
      bars = Array.from({ length: k }, (_, j) => ({ p: 0, tip: `${num(lo + j * w)} … ${num(lo + (j + 1) * w)}` }));
      for (const v of xs) if (v >= lo && v <= hi) bars[Math.min(k - 1, Math.floor((v - lo) / w))].p += 1 / N;
    }
    const maxP = Math.max(...bars.map(b => b.p), 1e-9), slot = W / bars.length, bw = Math.max(1, Math.min(14, slot - 2));
    let s = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true">`;
    bars.forEach((b, i) => {
      const h = (b.p / maxP) * (H - 2);
      if (h > 0) s += `<path class="s1" d="${colPath(slot * i + (slot - bw) / 2, H - h, bw, h, Math.min(2, bw / 2))}"><title>${esc(b.tip)}</title></path>`;
    });
    return s + `<line class="axis" x1="0" x2="${W}" y1="${H - 0.5}" y2="${H - 0.5}"/></svg>`;
  }

  // ===================================================================================
  // «Шанс к каждой дате»: доля прогонов, где всё случилось не позже периода k (растёт от 0 до 100 %)
  // points: [{ k, p, label }] — label: дата для подписи; deadline: { k, label } | null
  // ===================================================================================
  function cumulative(el, o) {
    const W = Math.max(280, el.clientWidth), H = 220;
    const m = { l: 44, r: 14, t: 16, b: 34 };
    const iw = W - m.l - m.r, ih = H - m.t - m.b, pts = o.points;
    const k0 = pts[0].k, k1 = Math.max(pts[pts.length - 1].k, k0 + 1);
    const x = k => m.l + ((k - k0) / (k1 - k0)) * iw;
    const y = p => m.t + ih - p * ih;
    let s = svgOpen(W, H, o.title);
    [0, 0.25, 0.5, 0.75, 1].forEach(t => {
      s += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}"/>` +
           `<text class="tick" x="${m.l - 6}" y="${y(t) + 4}" text-anchor="end">${Math.round(t * 100)} %</text>`;
    });
    // подписи дат: не больше одной на ~90 px
    const every = Math.max(1, Math.ceil(pts.length / Math.max(2, Math.floor(iw / 90))));
    pts.forEach((p, i) => {
      if (i % every) return;
      s += `<text class="tick" x="${x(p.k)}" y="${H - m.b + 16}" text-anchor="middle">${esc(p.short || p.label)}</text>`;
    });
    // ступенчатая линия и заливка под ней
    let d = `M${x(pts[0].k)},${y(pts[0].p)}`;
    for (let i = 1; i < pts.length; i++) d += `H${x(pts[i].k)}V${y(pts[i].p)}`;
    s += `<path class="band" d="${d}V${y(0)}H${x(pts[0].k)}Z"/><path class="line" d="${d}"/>`;
    if (o.deadline && o.deadline.k >= k0 && o.deadline.k <= k1) {
      const dx = x(o.deadline.k), dp = o.deadline.p;
      s += `<line class="ref" x1="${dx}" x2="${dx}" y1="${m.t}" y2="${y(0)}"/>` +
           `<circle class="dot s1" cx="${dx}" cy="${y(dp)}" r="5"/>` +
           `<text class="tick strong halo" x="${dx + (dx > W * 0.7 ? -6 : 6)}" y="${y(dp) - 8}" text-anchor="${dx > W * 0.7 ? 'end' : 'start'}">${esc(o.deadline.label)}: ${Math.round(dp * 100)} из 100</text>`;
    }
    const slot = iw / Math.max(1, pts.length - 1);
    pts.forEach(p => {
      s += `<rect class="hit" x="${x(p.k) - slot / 2}" y="${m.t}" width="${slot}" height="${ih}" data-tip="${esc(`${p.label}: ${Math.round(p.p * 100)} из 100`)}"/>`;
    });
    s += `<line class="axis" x1="${m.l}" x2="${W - m.r}" y1="${y(0)}" y2="${y(0)}"/></svg>`;
    el.innerHTML = s;
  }

  return { histogram, tornado, convergence, cumulative, shape, num, pct, compact, esc };
})();
