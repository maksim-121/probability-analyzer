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

  return { histogram, cumulative, num, pct, esc };
})();
