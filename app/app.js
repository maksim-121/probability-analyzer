/*
 * Анализатор вероятностей — страница.
 * Слева редактор сценария (факторы -> расчётные величины -> итог -> событие), справа результат.
 * Вся математика — в engine/engine.js (window.MC); здесь только интерфейс.
 */
(() => {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const { num, pct, esc } = Charts;
  const STORE_KEY = 'probability-analyzer.v1';

  const DIST_DEFAULTS = {
    table: { values: [0, 5, 10], weights: [50, 30, 20] },
    yesno: { p: 0.5 },
    uniform: { min: 0, max: 10 },
    triangular: { min: 0, mode: 3, max: 10 },
    normal: { mean: 10, sd: 2 },
    data: { values: [3, 0, 5, 0, 10, 2, 0, 7] },
  };
  const PARAM_FIELDS = {
    uniform: [['min', 'от'], ['max', 'до']],
    triangular: [['min', 'минимум'], ['mode', 'обычно'], ['max', 'максимум']],
    normal: [['mean', 'среднее'], ['sd', 'разброс σ']],
  };
  const DIST_HINTS = {
    table: 'Вес — как число символов на ленте барабана: важны только пропорции (50 / 30 / 20 = 5 / 3 / 2).',
    yesno: '«Да» = 1, «нет» = 0. В формулах: если(Имя; что при «да»; что при «нет»).',
    uniform: 'Любое значение между «от» и «до» одинаково вероятно.',
    triangular: 'Подходит, когда можно сказать «минимум / обычно / максимум». Чаще всего выпадает около «обычно».',
    normal: '«В среднем X, плюс-минус σ»: 68% значений в пределах ±σ, 95% — в пределах ±2σ. Может дать отрицательные числа — при необходимости max(Имя; 0).',
    data: 'Вставьте реальные наблюдения. Каждый прогон берёт случайное из списка (повторы делают значение вероятнее).',
    rows: 'Каждый прогон берёт одну случайную строку целиком: все столбцы — из одного и того же дня, поэтому связи между ними сохраняются. Столбцы — это имена для формул; сам фактор = номер строки.',
  };

  const clone = o => JSON.parse(JSON.stringify(o));
  const tryStore = (fn, fallback) => { try { return fn(); } catch (e) { return fallback; } };

  // ---------------------------------------------------------------- состояние
  let tplId = 'meeting';
  let sc = null;            // редактируемый сценарий
  let model = null;         // скомпилированный (null, если есть ошибка)
  let lastRun = null;       // последний результат
  let runToken = 0;

  // ---------------------------------------------------------------- ввод чисел
  function parseNum(str) {
    const s = String(str).trim().replace(/\s/g, '').replace(',', '.');
    return s === '' ? NaN : Number(s);
  }
  const fmtIn = v => (typeof v === 'number' && Number.isFinite(v) ? String(+v.toPrecision(12)).replace('.', ',') : '');
  function parseList(text) {
    return text.replace(/,(?=\s)/g, ' ').split(/[\s;]+/).filter(Boolean).map(parseNum);
  }
  function setPath(obj, path, val) {
    const ks = path.split('.');
    let o = obj;
    for (let i = 0; i < ks.length - 1; i++) o = o[ks[i]];
    o[ks[ks.length - 1]] = val;
  }
  const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);

  function normalize(s) {
    s = clone(s);
    s.derived = s.derived || [];
    s.result = s.result || { name: 'Итог', formula: '' };
    s.event = s.event || { name: 'Событие', formula: '', label: '' };
    return s;
  }

  // ===================================================================================
  // Редактор сценария
  // Каждое распределение редактируется по своему «пути» P в сценарии: factors.2.dist или
  // factors.1.dist.cases.0.dist (ветка «зависит от»). По пути привязаны доли таблицы,
  // превью формы, счётчики и загрузка CSV.
  // ===================================================================================
  const NAME_RE = /^[A-Za-zА-Яа-яЁё_][A-Za-zА-Яа-яЁё_0-9]*$/;
  const factorIndexOf = P => +P.split('.')[1];
  const distPathOf = path => {
    const m = /^(factors\.\d+\.dist(?:\.cases\.\d+\.dist)?)(?:\.|$)/.exec(path);
    return m ? m[1] : null;
  };

  function typeOptions(current, allowRows) {
    return Object.entries(MC.DIST_NAMES)
      .filter(([k]) => allowRows || k !== 'rows')
      .map(([k, v]) => `<option value="${k}"${current === k ? ' selected' : ''}>${v}</option>`).join('');
  }

  function rowsToText(d) {
    return [(d.columns || []).join(';'), ...(d.rows || []).map(r => r.map(fmtIn).join(';'))].join('\n');
  }

  function csvControls(P, what) {
    return `<div class="csv-row">
        <button class="btn small" data-act="csv" data-p="${P}">📂 Загрузить из CSV…</button>
        <span class="hint" data-csv-status="${P}">${what}</span>
      </div>
      <div class="csv-pick" data-csv-pick="${P}" hidden></div>`;
  }

  function paramsHtml(d, P) {
    switch (d.type) {
      case 'table': {
        const rows = (d.values || []).map((v, j) => `
          <tr>
            <td><input inputmode="decimal" data-path="${P}.values.${j}" data-kind="num" value="${fmtIn(v)}" aria-label="Значение ${j + 1}"></td>
            <td><input inputmode="decimal" data-path="${P}.weights.${j}" data-kind="num" value="${fmtIn(d.weights[j])}" aria-label="Вес ${j + 1}"></td>
            <td class="share" data-share="${P}.${j}"></td>
            <td><button class="icon" data-act="del-row" data-p="${P}" data-j="${j}" title="Убрать строку" aria-label="Убрать строку"${d.values.length < 2 ? ' disabled' : ''}>✕</button></td>
          </tr>`).join('');
        return `<table class="ttable"><thead><tr><th>значение</th><th>вес</th><th>доля</th><th></th></tr></thead>
          <tbody>${rows}</tbody></table>
          <button class="link" data-act="add-row" data-p="${P}">+ строка</button>`;
      }
      case 'yesno':
        return `<label class="field">Вероятность «да», %
          <input inputmode="decimal" data-path="${P}.p" data-kind="pct" value="${fmtIn(d.p * 100)}"></label>`;
      case 'data': {
        const n = (d.values || []).length;
        return `<textarea rows="3" class="mono" data-path="${P}.values" data-kind="list" data-drop="${P}" aria-label="Данные"
          spellcheck="false" placeholder="Числа через пробел или перетащите сюда CSV-файл">${esc((d.values || []).map(fmtIn).join(' '))}</textarea>
          <div class="hint" data-count="${P}">${n} знач. Числа через пробел, перенос строки или «;»; дробные — 2,5 или 2.5.</div>
          ${csvControls(P, 'или перетащите файл на поле с числами')}`;
      }
      case 'rows': {
        const nr = (d.rows || []).length, cols = d.columns || [];
        return `<textarea rows="6" class="mono" data-path="${P}" data-kind="rows" data-drop="${P}" aria-label="Строки таблицы"
          spellcheck="false" placeholder="Первая строка — названия столбцов через «;», дальше — числа">${esc(rowsToText(d))}</textarea>
          <div class="hint" data-count="${P}">${nr} строк × ${cols.length} столб.: ${esc(cols.join(', '))}.</div>
          ${csvControls(P, 'возьмёт все числовые столбцы и «да / нет» (→ 1 / 0)')}`;
      }
      default:
        return `<div class="fields">${(PARAM_FIELDS[d.type] || []).map(([k, lbl]) => `
          <label class="field">${lbl}<input inputmode="decimal" data-path="${P}.${k}" data-kind="num" value="${fmtIn(d[k])}"></label>`).join('')}</div>`;
    }
  }

  function distBody(d, P) {
    return `<div class="params">${paramsHtml(d, P)}</div>
      <div class="hint">${DIST_HINTS[d.type] || ''}</div>
      <div class="shape" data-shape="${P}"></div>`;
  }

  // ---------------------------------------------------------------- «зависит от»
  /** Отдельные значения величины `name`, объявленной выше фактора i (null — если их «бесконечно много»). */
  function discreteValues(name, i) {
    const low = (name || '').toLowerCase();
    const sorted = vs => [...new Set(vs)].sort((a, b) => a - b);
    for (let k = 0; k < i; k++) {
      const f = sc.factors[k], d = f.dist || {};
      try {
        if (d.type === 'rows') {
          const c = (d.columns || []).findIndex(x => x.toLowerCase() === low);
          if (c >= 0) return sorted(d.rows.map(r => r[c]));
          continue;
        }
        if ((f.name || '').toLowerCase() !== low) continue;
        if (d.type === 'conditional') {
          const all = [];
          for (const c of d.cases) {
            const b = MC.prepareDist(c.dist, '');
            if (!b.support) return null;
            all.push(...b.support.map(([v]) => v));
          }
          return sorted(all);
        }
        const dist = MC.prepareDist(d, '');
        return dist.support ? sorted(dist.support.map(([v]) => v)) : null;
      } catch (e) { return null; }
    }
    return null;
  }

  /** Кандидаты в «причину» для фактора i: факторы и столбцы выше, у которых немного отдельных значений. */
  function parentCandidates(i) {
    const out = [];
    for (let k = 0; k < i; k++) {
      const d = sc.factors[k].dist || {};
      const names = d.type === 'rows' ? (d.columns || []) : [sc.factors[k].name];
      for (const n of names) {
        const vs = discreteValues(n, i);
        if (vs && vs.length <= MC.MAX_BRANCHES) out.push(n);
      }
    }
    return out;
  }

  function caseLabel(on, v, i) {
    const vs = discreteValues(on, i);
    if (vs && vs.length <= 2 && vs.every(x => x === 0 || x === 1)) return v === 1 ? 'да' : 'нет';
    return '= ' + num(v);
  }

  function conditionalHtml(f, i) {
    const d = f.dist, P = `factors.${i}.dist`;
    const vs = discreteValues(d.on, i);
    const have = d.cases.map(c => c.value);
    const mismatch = vs && (vs.length !== have.length || vs.some(v => !have.includes(v)));
    return `<div class="cases">${d.cases.map((c, j) => {
      const CP = `${P}.cases.${j}.dist`;
      return `<div class="case">
        <div class="row"><span class="case-head">Если «${esc(d.on)}» ${esc(caseLabel(d.on, c.value, i))}</span>
          <select data-path="${CP}.type" data-kind="type" aria-label="Распределение в этой ветке">${typeOptions(c.dist.type, false)}</select></div>
        ${distBody(c.dist, CP)}
      </div>`;
    }).join('')}</div>
    ${mismatch ? `<div class="warn-box">Значения «${esc(d.on)}» сейчас: ${vs.map(v => num(v)).join(', ')} — ветки не совпадают.
      <button class="btn small" data-act="sync" data-i="${i}">Обновить ветки</button></div>` : ''}`;
  }

  function factorCard(f, i) {
    const d = f.dist || {};
    const cond = d.type === 'conditional';
    const cands = d.type === 'rows' ? [] : parentCandidates(i);
    const depSel = (cands.length || cond) ? `<label class="dep">Зависит от
        <select data-kind="dep" data-i="${i}" aria-label="Зависит от">
          <option value="">— ни от чего —</option>
          ${[...new Set([...cands, ...(cond ? [d.on] : [])])].map(n =>
            `<option value="${esc(n)}"${cond && n.toLowerCase() === d.on.toLowerCase() ? ' selected' : ''}>${esc(n)}</option>`).join('')}
        </select></label>` : '';
    return `<div class="item${cond ? ' dependent' : ''}" data-f="${i}">
      <div class="row">
        <input class="name mono" data-path="factors.${i}.name" data-kind="name" value="${esc(f.name || '')}" aria-label="Имя фактора" spellcheck="false">
        ${cond ? `<span class="dep-note">своё распределение для каждого значения «${esc(d.on)}»</span>`
               : `<select data-path="factors.${i}.dist.type" data-kind="type" aria-label="Распределение">${typeOptions(d.type, true)}</select>`}
        <button class="icon" data-act="del-factor" data-i="${i}" title="Удалить фактор" aria-label="Удалить фактор"${sc.factors.length < 2 ? ' disabled' : ''}>✕</button>
      </div>
      <input class="label" data-path="factors.${i}.label" data-kind="text" value="${esc(f.label || '')}" placeholder="Что это за фактор (необязательно)">
      ${depSel}
      ${cond ? conditionalHtml(f, i) : distBody(d, `factors.${i}.dist`)}
    </div>`;
  }

  function formulaRow(path, obj, opts = {}) {
    return `<div class="item">
      <div class="row">
        <input class="name mono" data-path="${path}.name" data-kind="name" value="${esc(obj.name || '')}" aria-label="Имя" spellcheck="false">
        <span class="eq">=</span>
        <input class="formula mono" data-path="${path}.formula" data-kind="text" value="${esc(obj.formula || '')}"
          aria-label="Формула" spellcheck="false" placeholder="${opts.placeholder || ''}">
        ${opts.del ? `<button class="icon" data-act="del-derived" data-i="${opts.del - 1}" title="Удалить" aria-label="Удалить">✕</button>` : ''}
      </div>
      <div class="row">
        <input class="label" data-path="${path}.label" data-kind="text" value="${esc(obj.label || '')}" placeholder="Описание (необязательно)">
        ${opts.unit ? `<input class="unit" data-path="${path}.unit" data-kind="text" value="${esc(obj.unit || '')}" placeholder="ед." aria-label="Единица">` : ''}
      </div>
    </div>`;
  }

  const distPaths = i => {
    const d = sc.factors[i].dist || {};
    return d.type === 'conditional' ? d.cases.map((_, j) => `factors.${i}.dist.cases.${j}.dist`) : [`factors.${i}.dist`];
  };

  function renderScenario() {
    $('#sc-name').value = sc.name || '';
    $('#sc-desc').value = sc.description || '';
    $('#factors').innerHTML = sc.factors.map(factorCard).join('');
    $('#derived').innerHTML = sc.derived.length
      ? sc.derived.map((d, j) => formulaRow(`derived.${j}`, d, { del: j + 1 })).join('')
      : '<p class="empty">Нет. Здесь можно посчитать промежуточное, например: Мария = max(Обед − 10; 0).</p>';
    $('#result-edit').innerHTML = formulaRow('result', sc.result, { unit: true, placeholder: 'например: max(Иван; Мария)' });
    $('#event-edit').innerHTML = formulaRow('event', sc.event, { placeholder: 'например: Задержка <= 5 (можно пусто)' });
    sc.factors.forEach((_, i) => distPaths(i).forEach(P => { updateShares(P); updateShape(P); }));
    validate();
  }

  function rerenderFactor(i) {
    const el = $(`.item[data-f="${i}"]`);
    el.outerHTML = factorCard(sc.factors[i], i);
    distPaths(i).forEach(P => { updateShares(P); updateShape(P); });
  }

  /** Перерисовать карточки факторов ниже i (у них могли поменяться кандидаты в «причину» и ветки). */
  function rerenderBelow(i) {
    for (let k = i + 1; k < sc.factors.length; k++) {
      const card = $(`.item[data-f="${k}"]`);
      if (!card || card.contains(document.activeElement)) continue;
      const d = sc.factors[k].dist || {};
      if (d.type === 'conditional' || card.querySelector('[data-kind="dep"]') || parentCandidates(k).length) rerenderFactor(k);
    }
  }

  function updateShares(P) {
    const d = getPath(sc, P);
    if (!d || d.type !== 'table') return;
    const total = d.weights.reduce((a, w) => a + (Number.isFinite(w) && w > 0 ? w : 0), 0);
    d.weights.forEach((w, j) => {
      const cell = $(`[data-share="${P}.${j}"]`);
      if (cell) cell.textContent = total > 0 && Number.isFinite(w) ? pct(Math.max(0, w) / total, 1) : '—';
    });
  }

  const shapeTimers = {};
  function updateShape(P) {
    clearTimeout(shapeTimers[P]);
    shapeTimers[P] = setTimeout(() => {
      const box = $(`[data-shape="${P}"]`);
      const d = getPath(sc, P);
      if (!box || !d) return;
      if (d.type === 'rows') {
        const cols = d.columns || [], rows = d.rows || [];
        box.innerHTML = rows.length && cols.length ? `<span>${cols.map((c, k) =>
          `${esc(c)}: в среднем ${num(rows.reduce((s, r) => s + r[k], 0) / rows.length)}`).join(' · ')}</span>` : '';
        return;
      }
      try {
        const dist = MC.prepareDist(d, 'Распределение');
        const cap = dist.type === 'yesno'
          ? `да ${pct(dist.mean)} · нет ${pct(1 - dist.mean)}`
          : `в среднем ${num(dist.mean)}, разброс ±${num(dist.sd)}`;
        box.innerHTML = Charts.shape(dist) + `<span>${cap}</span>`;
      } catch (e) {
        box.innerHTML = `<span class="bad">${esc(e.message)}</span>`;
      }
    }, 120);
  }

  /** Переименование: заменить старое имя во всех формулах и в «зависит от» (целым словом, без учёта регистра). */
  function renameRefs(oldName, newName) {
    const re = /[A-Za-zА-Яа-яЁё_][A-Za-zА-Яа-яЁё_0-9]*/g;
    const low = oldName.toLowerCase();
    const fix = f => (f || '').replace(re, w => (w.toLowerCase() === low ? newName : w));
    sc.derived.forEach(d => { d.formula = fix(d.formula); });
    sc.result.formula = fix(sc.result.formula);
    sc.event.formula = fix(sc.event.formula);
    $$('[data-path$=".formula"]').forEach(el => { el.value = getPath(sc, el.dataset.path) || ''; });
    sc.factors.forEach((f, k) => {
      if (f.dist && f.dist.type === 'conditional' && (f.dist.on || '').toLowerCase() === low) {
        f.dist.on = newName;
        rerenderFactor(k);
      }
    });
  }

  function allNames() {
    const names = [];
    sc.factors.forEach(f => {
      names.push(f.name);
      if (f.dist && f.dist.type === 'rows') names.push(...(f.dist.columns || []));
    });
    names.push(...sc.derived.map(d => d.name), sc.result.name, sc.event.name);
    return new Set(names.map(x => (x || '').toLowerCase()));
  }

  function uniqueName(base) {
    const names = allNames();
    for (let k = 1; ; k++) if (!names.has((base + k).toLowerCase())) return base + k;
  }

  // ---------------------------------------------------------------- проверка и «устаревание»
  function validate() {
    const box = $('#error');
    try {
      model = MC.compile(runnableScenario());
      box.hidden = true;
      $('#run').disabled = false;
    } catch (e) {
      model = null;
      box.textContent = e instanceof MC.MCError ? e.message : 'Ошибка: ' + e.message;
      box.hidden = false;
      $('#run').disabled = true;
    }
    markStale();
  }

  /** Сценарий для движка: пустое событие = «события нет». */
  function runnableScenario() {
    const s = clone(sc);
    if (!s.event.formula || !s.event.formula.trim()) s.event = null;
    return s;
  }

  function markStale() {
    const stale = !!lastRun && JSON.stringify(sc) !== lastRun.scJson;
    $('#results').classList.toggle('stale', stale);
    $('#stale').hidden = !stale;
  }

  let saveTimer;
  function changed() {
    validate();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => tryStore(() => localStorage.setItem(STORE_KEY, JSON.stringify({ tplId, sc }))), 400);
    const tpl = MC_TEMPLATES.find(t => t.id === tplId);
    $('#tpl-mod').hidden = !tpl || JSON.stringify(normalize(tpl)) === JSON.stringify(sc);
  }

  // ---------------------------------------------------------------- смена типа и «зависит от»
  function freshDist(t, old) {
    const fresh = t === 'rows'
      ? { type: 'rows', columns: [uniqueName('Столбец')], rows: [[0], [5], [10]] }
      : { type: t, ...clone(DIST_DEFAULTS[t]) };
    // при смене «таблица <-> данные» сохраняем числа пользователя
    if (t === 'data' && old && old.type === 'table') fresh.values = old.values.slice();
    if (t === 'table' && old && old.type === 'data') {
      const counts = new Map();
      old.values.forEach(v => counts.set(v, (counts.get(v) || 0) + 1));
      fresh.values = [...counts.keys()].sort((a, b) => a - b);
      fresh.weights = fresh.values.map(v => counts.get(v));
    }
    return fresh;
  }

  function setDependency(i, on) {
    const f = sc.factors[i], d = f.dist;
    if (!on) {                                      // больше ни от чего не зависит: берём первую ветку
      if (d.type === 'conditional') f.dist = clone(d.cases[0].dist);
    } else {
      const vs = discreteValues(on, i) || [];
      const base = d.type === 'conditional' ? d.cases[0].dist : d;
      const old = d.type === 'conditional' ? d.cases : [];
      f.dist = { type: 'conditional', on, cases: vs.map(v => {
        const keep = old.find(c => c.value === v);
        return { value: v, dist: clone(keep ? keep.dist : base) };
      }) };
    }
    rerenderFactor(i);
  }

  // ---------------------------------------------------------------- события редактора
  function bindEditor() {
    const pane = $('#scenario');
    pane.addEventListener('focusin', e => {
      if (e.target.dataset.kind === 'name') e.target.dataset.old = e.target.value.trim();
    });
    pane.addEventListener('input', e => {
      const el = e.target, path = el.dataset.path, kind = el.dataset.kind;
      if (!path || kind === 'type' || kind === 'dep') return;
      if (kind === 'rows') {
        const r = CSV.toRows(el.value), d = getPath(sc, path);
        d.columns = r.columns; d.rows = r.rows;
        const cnt = $(`[data-count="${path}"]`);
        if (cnt) cnt.textContent = `${r.rows.length} строк × ${r.columns.length} столб.: ${r.columns.join(', ')}.` +
          (r.skipped ? ` Пропущено неполных строк: ${r.skipped}.` : '') + (r.dropped.length ? ` Без текстовых столбцов: ${r.dropped.join(', ')}.` : '');
        updateShape(path);
        changed();
        return;
      }
      let v;
      if (kind === 'num') v = parseNum(el.value);
      else if (kind === 'pct') v = parseNum(el.value) / 100;
      else if (kind === 'list') v = parseList(el.value);
      else if (kind === 'name') v = el.value.trim();
      else v = el.value;
      setPath(sc, path, v);
      const P = distPathOf(path);
      if (P) {
        updateShares(P); updateShape(P);
        const cnt = $(`[data-count="${P}"]`);
        if (cnt && kind === 'list') cnt.firstChild.textContent = `${v.length} знач. `;
      }
      changed();
    });
    pane.addEventListener('change', e => {
      const el = e.target, kind = el.dataset.kind;
      if (kind === 'type') {
        const P = el.dataset.path.slice(0, -'.type'.length), i = factorIndexOf(P);
        setPath(sc, P, freshDist(el.value, getPath(sc, P)));
        rerenderFactor(i);
        rerenderBelow(i);
        changed();
      } else if (kind === 'dep') {
        const i = +el.dataset.i;
        setDependency(i, el.value);
        changed();
      } else if (kind === 'name') {
        const oldName = el.dataset.old, newName = el.value.trim();
        if (oldName && newName && oldName.toLowerCase() !== newName.toLowerCase() && NAME_RE.test(newName)) {
          renameRefs(oldName, newName);
          changed();
        }
        el.dataset.old = newName;
        const P = distPathOf(el.dataset.path || '');
        if (/^factors\.\d+\.name$/.test(el.dataset.path)) rerenderBelow(+el.dataset.path.split('.')[1]);
        else if (P) rerenderBelow(factorIndexOf(P));
      } else if (kind === 'num' || kind === 'pct') {
        // после ухода с поля показываем число в аккуратном виде
        const v = getPath(sc, el.dataset.path);
        if (Number.isFinite(v)) el.value = fmtIn(kind === 'pct' ? v * 100 : v);
        // значения причины могли измениться — у зависимых факторов ниже обновим подсказку о ветках
        const P = distPathOf(el.dataset.path);
        if (P) rerenderBelow(factorIndexOf(P));
      } else if (kind === 'rows' || kind === 'list') {
        rerenderBelow(factorIndexOf(el.dataset.path));
      }
    });
    pane.addEventListener('click', e => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const i = +b.dataset.i, P = b.dataset.p, act = b.dataset.act;
      if (act === 'add-factor') {
        sc.factors.push({ name: uniqueName('Фактор'), label: '', dist: { type: 'table', ...clone(DIST_DEFAULTS.table) } });
        renderScenario();
        $(`.item[data-f="${sc.factors.length - 1}"] .name`).focus();
      } else if (act === 'del-factor') {
        sc.factors.splice(i, 1); renderScenario();
      } else if (act === 'add-row') {
        const d = getPath(sc, P);
        const last = d.values[d.values.length - 1];
        d.values.push(Number.isFinite(last) ? last + 5 : 0); d.weights.push(10);
        rerenderFactor(factorIndexOf(P));
        rerenderBelow(factorIndexOf(P));
      } else if (act === 'del-row') {
        const d = getPath(sc, P), j = +b.dataset.j;
        d.values.splice(j, 1); d.weights.splice(j, 1);
        rerenderFactor(factorIndexOf(P));
        rerenderBelow(factorIndexOf(P));
      } else if (act === 'sync') {
        setDependency(i, sc.factors[i].dist.on);
      } else if (act === 'add-derived') {
        sc.derived.push({ name: uniqueName('Величина'), label: '', formula: sc.factors[0].name });
        renderScenario();
        $$('#derived .formula').pop().focus();
      } else if (act === 'del-derived') {
        sc.derived.splice(i, 1); renderScenario();
      } else if (act === 'csv') {
        const input = $('#csv-file');
        input.dataset.p = P;
        input.click();
        return;
      } else if (act === 'csv-col') {
        const p = pendingCsv[P];
        if (p) applyCsvColumn(P, p.fileName, p.cols[+b.dataset.k]);
        return;
      } else return;
      changed();
    });
    // CSV: выбор файла кнопкой или перетаскивание на поле
    $('#csv-file').addEventListener('change', e => {
      const f = e.target.files[0];
      if (f) loadCsvFile(e.target.dataset.p, f);
      e.target.value = '';
    });
    pane.addEventListener('dragover', e => {
      const t = e.target.closest && e.target.closest('[data-drop]');
      if (!t) return;
      e.preventDefault();
      t.classList.add('dragging');
    });
    pane.addEventListener('dragleave', e => {
      const t = e.target.closest && e.target.closest('[data-drop]');
      if (t) t.classList.remove('dragging');
    });
    pane.addEventListener('drop', e => {
      const t = e.target.closest && e.target.closest('[data-drop]');
      if (!t) return;
      e.preventDefault();
      t.classList.remove('dragging');
      const f = e.dataTransfer && e.dataTransfer.files[0];
      if (f) loadCsvFile(t.dataset.drop, f);
    });
  }

  // ===================================================================================
  // CSV: в фактор «Из данных» (один столбец) или «Строки таблицы» (все столбцы вместе)
  // ===================================================================================
  const pendingCsv = {};
  const mean = a => a.reduce((s, x) => s + x, 0) / a.length;

  /** Текст файла: сначала пробуем UTF-8, если не вышло — Windows-1251 (так часто сохраняет русский Excel). */
  async function fileText(file) {
    const buf = await file.arrayBuffer();
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
    catch (e) { return new TextDecoder('windows-1251').decode(buf); }
  }

  function csvStatus(P, text, bad) {
    const el = $(`[data-csv-status="${P}"]`);
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('bad', !!bad);
  }

  async function loadCsvFile(P, file) {
    try {
      const text = await fileText(file);
      const d = getPath(sc, P);
      if (d.type === 'rows') {
        const r = CSV.toRows(text);
        if (!r.rows.length || !r.columns.length) { csvStatus(P, `В файле «${file.name}» не нашлось строк с числами.`, true); return; }
        d.columns = r.columns; d.rows = r.rows;
        const i = factorIndexOf(P);
        rerenderFactor(i); rerenderBelow(i);
        csvStatus(P, `Загружено ${r.rows.length} строк из «${file.name}», столбцы: ${r.columns.join(', ')}` +
          (r.dropped.length ? `; текстовые столбцы не взяты: ${r.dropped.join(', ')}` : '') +
          (r.skipped ? `; неполных строк пропущено: ${r.skipped}` : '') +
          (r.renamed.length ? `; переименованы: ${r.renamed.map(([a, b]) => `«${a}» → ${b}`).join(', ')}` : '') + '.');
        changed();
        return;
      }
      const numeric = CSV.parse(text).columns.filter(c => c.values.length > 0);
      if (!numeric.length) { csvStatus(P, `В файле «${file.name}» не нашлось чисел.`, true); return; }
      if (numeric.length === 1) applyCsvColumn(P, file.name, numeric[0]);
      else {
        pendingCsv[P] = { fileName: file.name, cols: numeric };
        const box = $(`[data-csv-pick="${P}"]`);
        box.innerHTML = `<div class="hint">В файле «${esc(file.name)}» ${numeric.length} столбца с числами. Какой взять?
          (Чтобы взять все столбцы вместе, «днями целиком», выберите тип «${MC.DIST_NAMES.rows}».)</div>` +
          numeric.map((c, k) => `<button class="btn small" data-act="csv-col" data-p="${P}" data-k="${k}">${esc(c.name)}
            <span class="muted">${c.values.length} знач., в среднем ${num(mean(c.values))}</span></button>`).join('');
        box.hidden = false;
      }
    } catch (e) {
      csvStatus(P, 'Не удалось прочитать файл: ' + e.message, true);
    }
  }

  function applyCsvColumn(P, fileName, col) {
    const i = factorIndexOf(P), f = sc.factors[i];
    getPath(sc, P).values = col.values.slice();
    if (!f.label) f.label = col.name;
    delete pendingCsv[P];
    rerenderFactor(i);
    rerenderBelow(i);
    csvStatus(P, `Загружено ${col.values.length} знач. из столбца «${col.name}» (${fileName})` +
      (col.skipped ? `; пропущено нечисловых ячеек: ${col.skipped}` : '') + '.');
    changed();
  }

  // ===================================================================================
  // Файлы: сохранить / открыть сценарий, скачать сводку
  // ===================================================================================
  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  const safeName = s => String(s || 'сценарий').replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 80) || 'сценарий';

  function scenarioFile() {
    return JSON.stringify({
      format: 'probability-analyzer', version: 1, saved: new Date().toISOString(),
      settings: { n: +$('#n').value, seed: parseInt($('#seed').value, 10) },
      scenario: sc,
    }, null, 2);
  }

  async function openScenario(file) {
    try {
      const data = JSON.parse(await fileText(file));
      const s = data && data.format === 'probability-analyzer' ? data.scenario : data;
      if (!s || !Array.isArray(s.factors) || !s.result) throw new Error('это не файл сценария');
      loadScenario(s, '');
      const st = data.settings || {};
      if ([...$('#n').options].some(o => +o.value === st.n)) $('#n').value = String(st.n);
      if (Number.isInteger(st.seed)) $('#seed').value = st.seed;
      runSim();
    } catch (e) {
      $('#error').textContent = `Не удалось открыть «${file.name}»: ${e.message}`;
      $('#error').hidden = false;
    }
  }

  /** Сводка для Excel: «;» и дробная часть через запятую, BOM — чтобы русские буквы открылись правильно. */
  function summaryCsv() {
    const { model: M, summary: S, sens, exact } = lastRun;
    const R = S.result, u = M.result.unit ? `, ${M.result.unit}` : '';
    const f = v => (typeof v === 'number' ? String(+v.toPrecision(10)).replace('.', ',') : v);
    const rows = [['Показатель', 'Значение'], ['Сценарий', M.name], ['Прогонов', S.n], ['Сид', S.seed]];
    if (S.event) {
      rows.push([`Вероятность: ${M.event.label}`, f(S.event.p)], ['Погрешность ± (95%)', f(S.event.hi - S.event.p)],
        ['95% интервал: от', f(S.event.lo)], ['95% интервал: до', f(S.event.hi)]);
      if (exact) rows.push(['Точный ответ (перебор)', f(exact.p)]);
    }
    rows.push([`${M.result.label}: среднее${u}`, f(R.mean)], [`${M.result.label}: стандартное отклонение${u}`, f(R.sd)],
      [`${M.result.label}: минимум${u}`, f(R.min)], [`${M.result.label}: максимум${u}`, f(R.max)]);
    MC.PCTS.forEach(q => rows.push([`${M.result.label}: P${q}${u}`, f(R.pct[q])]));
    rows.push([], ['Влияние факторов', 'Малое значение (P10)', S.event ? 'Вероятность' : 'Среднее',
      'Большое значение (P90)', S.event ? 'Вероятность' : 'Среднее']);
    sens.items.forEach(it => rows.push([it.label, f(it.low.value), f(S.event ? it.low.p : it.low.mean),
      f(it.high.value), f(S.event ? it.high.p : it.high.mean)]));
    if (lastRun.indep) {
      const I = lastRun.indep.summary;
      rows.push([], ['Без связей между факторами', 'Значение']);
      if (I.event) rows.push([`Вероятность: ${M.event.label}`, f(I.event.p)]);
      if (lastRun.indep.exact && I.event) rows.push(['Точный ответ (перебор)', f(lastRun.indep.exact.p)]);
      rows.push([`${M.result.label}: среднее${u}`, f(I.result.mean)], [`${M.result.label}: P90${u}`, f(I.result.pct[90])],
        [`${M.result.label}: P99${u}`, f(I.result.pct[99])]);
    }
    const cell = c => (/[;"\r\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : String(c));
    return '﻿' + rows.map(r => r.map(cell).join(';')).join('\r\n') + '\r\n';
  }

  // ===================================================================================
  // Прогон
  // ===================================================================================
  const nextFrame = () => new Promise(r => setTimeout(r, 0));

  async function runSim() {
    if (!model) return;
    const n = +$('#n').value;
    const seed = parseInt($('#seed').value, 10);
    if (!(seed >= 0 && seed <= 4294967295)) {
      $('#error').textContent = 'Сид — целое число от 0 до 4 294 967 295';
      $('#error').hidden = false;
      return;
    }
    const token = ++runToken;
    const btn = $('#run'), bar = $('#progress');
    btn.disabled = true; btn.textContent = 'Считаю…';
    bar.hidden = false; bar.value = 0;
    const t0 = performance.now();
    const run = MC.createRun(model, { n, seed });
    const chunk = Math.max(20000, Math.floor(n / 40));
    while (!run.step(chunk)) {
      bar.value = run.progress;
      await nextFrame();
      if (token !== runToken) return;
    }
    bar.value = 1;
    await nextFrame();
    const summary = MC.summarize(run);
    const sens = MC.sensitivity(run, { maxRows: 100000 });
    const exact = MC.exact(model, { maxCombos: 1e6 });
    if (token !== runToken) return;
    lastRun = { model, run, summary, sens, exact, ms: performance.now() - t0, scJson: JSON.stringify(sc) };
    btn.disabled = false; btn.textContent = '▶ Рассчитать';
    bar.hidden = true;
    renderResults();
    if (model.dependent) await runIndependent(token, n, seed);
  }

  /**
   * Этап 4: тот же сценарий без связей между факторами («как посчитал бы тот, кто забыл про зависимость»).
   * Считается после основного результата, тем же сидом; не больше 1 млн прогонов.
   */
  async function runIndependent(token, n, seed) {
    const box = $('#indep');
    try {
      const s = JSON.parse(lastRun.scJson);
      if (!s.event.formula || !s.event.formula.trim()) s.event = null;
      const m2 = MC.compile(MC.independentVersion(s));
      const n2 = Math.min(n, 1000000);
      const r2 = MC.createRun(m2, { n: n2, seed });
      while (!r2.step(100000)) {
        await nextFrame();
        if (token !== runToken) return;
      }
      if (token !== runToken) return;
      lastRun.indep = { summary: MC.summarize(r2), exact: MC.exact(m2, { maxCombos: 1e6 }) };
      renderIndep();
    } catch (e) {
      if (box) box.innerHTML = `<h3>Что будет, если забыть про связи</h3><p class="bad">Не удалось посчитать: ${esc(e.message)}</p>`;
    }
  }

  function renderIndep() {
    const box = $('#indep');
    if (!box || !lastRun.indep) return;
    const { model: M, summary: S, exact } = lastRun, I = lastRun.indep;
    const u = M.result.unit ? ' ' + M.result.unit : '';
    const links = M.factors.filter(f => f.kind !== 'plain').map(f => f.kind === 'conditional'
      ? `«${esc(f.name)}» зависит от «${esc(f.spec.on)}»`
      : `столбцы ${f.spec.columns.map(c => `«${esc(c)}»`).join(', ')} берутся из одной строки «${esc(f.name)}»`);
    const pp = d => `${d > 0 ? '+' : d < 0 ? '−' : ''}${num(Math.abs(d) * 100, 2)} п.п.`;
    const diffNum = (a, b) => `${a - b > 0 ? '+' : a - b < 0 ? '−' : ''}${num(Math.abs(a - b))}${u}`;
    const rows = [];
    let verdict = '';
    if (S.event) {
      const a = S.event, b = I.summary.event;
      rows.push([`P(${esc(M.event.name)}), Монте-Карло`, `${pct(a.p, 2)} ± ${pct(a.hi - a.p, 2)}`,
        `${pct(b.p, 2)} ± ${pct(b.hi - b.p, 2)}`, pp(b.p - a.p)]);
      const both = exact && I.exact;
      if (both) rows.push([`P(${esc(M.event.name)}), точно`, pct(exact.p, 2), pct(I.exact.p, 2), pp(I.exact.p - exact.p)]);
      const noise = 2 * Math.sqrt(a.se * a.se + b.se * b.se);
      const d = both ? I.exact.p - exact.p : b.p - a.p;
      verdict = !both && Math.abs(d) <= noise
        ? 'Разница в пределах погрешности: в этом сценарии связь почти не меняет вероятность события.'
        : d > 0
          ? `Наивный расчёт <b>переоценивает</b> вероятность «${esc(M.event.label)}» на ${num(d * 100, 2)} п.п.: обещает больше, чем есть на самом деле.`
          : `Наивный расчёт <b>недооценивает</b> вероятность «${esc(M.event.label)}» на ${num(-d * 100, 2)} п.п.`;
    }
    const R = S.result, R2 = I.summary.result;
    rows.push([`${esc(M.result.name)}: среднее`, num(R.mean) + u, num(R2.mean) + u, diffNum(R2.mean, R.mean)]);
    rows.push([`${esc(M.result.name)}: P90`, num(R.pct[90]) + u, num(R2.pct[90]) + u, diffNum(R2.pct[90], R.pct[90])]);
    rows.push([`${esc(M.result.name)}: P99`, num(R.pct[99]) + u, num(R2.pct[99]) + u, diffNum(R2.pct[99], R.pct[99])]);
    const tail = Math.abs(R2.pct[90] - R.pct[90]) > 0.02 * Math.max(1, Math.abs(R.pct[90]))
      ? ` Хвост тоже другой: в 10% худших случаев ${esc(M.result.name.toLowerCase())} со связью больше ${num(R.pct[90])}${u}, а наивный расчёт говорит ${num(R2.pct[90])}${u}.`
      : '';
    box.innerHTML = `<h3>Что будет, если забыть про связи</h3>
      <p class="sub">В сценарии есть связи: ${links.join('; ')}. Ниже тот же сценарий, где факторы считаются независимыми:
      каждый сам по себе распределён так же, но про общую причину «забыли». Так получается, если просто перемножать вероятности.</p>
      <div class="table-wrap"><table class="cmp"><thead><tr><th></th><th>Со связями</th><th>Без связей</th><th>Разница</th></tr></thead>
      <tbody>${rows.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td><td>${r[3]}</td></tr>`).join('')}</tbody></table></div>
      <p class="verdict">${(verdict + tail).replace(/\.\./g, '.')}</p>
      <p class="note">Если итог — сумма факторов, средние совпадают: среднее суммы от связей не зависит.
      Связи меняют прежде всего разброс и хвосты — плохие случаи приходят вместе.</p>`;
  }

  // ===================================================================================
  // Результаты
  // ===================================================================================
  function histWithEvent(run, sorted) {
    const h = MC.histogram(sorted);
    const bins = h.bins.map(b => ({ ...b, yes: 0 }));
    const m = sorted.length, K = bins.length;
    if (run.event) {
      if (h.discrete) {
        const idx = new Map(bins.map((b, k) => [b.from, k]));
        for (let i = 0; i < run.n; i++) if (run.event[i]) { const k = idx.get(run.result[i]); if (k !== undefined) bins[k].yes++; }
      } else {
        const lo = bins[0].from, hi = bins[K - 1].to, w = bins[0].to - bins[0].from;
        for (let i = 0; i < run.n; i++) {
          const v = run.result[i];
          if (!run.event[i] || !(v >= lo && v <= hi)) continue;
          bins[Math.min(K - 1, Math.floor((v - lo) / w))].yes++;
        }
      }
    }
    bins.forEach(b => { b.pYes = b.yes / m; });
    return { ...h, bins };
  }

  function countLE(sorted, x) {
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] <= x) lo = mid + 1; else hi = mid; }
    return lo;
  }

  function renderResults() {
    const { model: M, run, summary: S, sens, exact, ms } = lastRun;
    const ev = S.event, R = S.result, unit = M.result.unit, u = unit ? ' ' + unit : '';
    const rl = M.result.label;
    let html = '';

    // --- главный ответ
    if (ev) {
      let exactHtml;
      if (exact) {
        const inside = exact.p >= ev.lo - 1e-12 && exact.p <= ev.hi + 1e-12;
        exactHtml = `<div class="exact ${inside ? 'good' : 'warn'}"><b>${inside ? '✓' : '!'}</b>
          Точный ответ перебором всех ${exact.combos.toLocaleString('ru-RU')} комбинаций: <b>${pct(exact.p, 2)}</b>.
          ${inside ? 'Монте-Карло попал в свой 95% интервал.'
                   : 'Монте-Карло вне 95% интервала — такое бывает в 1 случае из 20. Если повторяется на других сидах — ищите ошибку.'}</div>`;
      } else {
        const cont = M.factors.filter(f => !f.enumerate).map(f => `«${f.name}»`).join(', ');
        exactHtml = `<div class="exact">Точный перебор невозможен: ${cont ? `непрерывные факторы ${cont} принимают бесконечно много значений` : 'слишком много комбинаций'}. Ответ — только через Монте-Карло.</div>`;
      }
      const times = ev.count === 0
        ? `ни разу за ${S.n.toLocaleString('ru-RU')} прогонов — скорее всего реже, чем ${pct(3 / S.n, 3)} (правило трёх)`
        : `примерно ${num(ev.p * 100, ev.p < 0.1 ? 1 : 0)} раз из 100`;
      html += `<section class="card hero">
        <div class="hero-label">${esc(M.event.label)}</div>
        <div class="hero-value">${pct(ev.p, 2)}</div>
        <div class="hero-sub">± ${pct(ev.hi - ev.p, 2)} (95% интервал: ${pct(ev.lo, 2)} … ${pct(ev.hi, 2)}) · ${times}</div>
        ${exactHtml}
      </section>`;
    }

    // --- плитки итога
    const tile = (label, value, sub) => `<div class="tile"><div class="tile-label">${label}</div>
      <div class="tile-value">${value}</div>${sub ? `<div class="tile-sub">${sub}</div>` : ''}</div>`;
    html += `<section class="card"><h3>${esc(rl)}</h3><div class="tiles">
      ${tile('Среднее', num(R.mean) + u, `± ${num(1.96 * R.se)}`)}
      ${tile('Медиана', num(R.pct[50]) + u, 'в половине случаев меньше')}
      ${tile('P90', num(R.pct[90]) + u, 'в 9 из 10 случаев меньше')}
      ${tile('Максимум', num(R.max) + u, `минимум ${num(R.min)}${u}`)}
    </div></section>`;

    // --- вывод словами
    const lines = [];
    if (ev) lines.push(`«${esc(M.event.label)}» — ${ev.count ? `примерно в ${num(ev.p * 100, ev.p < 0.1 ? 1 : 0)} случаях из 100` : 'не случилось ни разу'}.`);
    lines.push(`${esc(rl)}: в среднем ${num(R.mean)}${u}; в половине случаев не больше ${num(R.pct[50])}${u}; в 10% случаев больше ${num(R.pct[90])}${u}.`);
    const top = sens.items[0];
    if (top && top.swing > 0) {
      const v = r => (ev ? pct(r.p) : num(r.mean) + u);
      lines.push(`Сильнее всего влияет «${esc(top.label)}»: если всегда ${num(top.low.value)} — ${v(top.low)}, если всегда ${num(top.high.value)} — ${v(top.high)}.`);
    }
    // «44 дн.» + «.» в конце фразы -> одна точка
    html += `<section class="card"><h3>Вывод</h3><ul class="plain">${lines.map(l => `<li>${l.replace(/\.\./g, '.')}</li>`).join('')}</ul></section>`;
    if (M.dependent) html += `<section class="card" id="indep"><h3>Что будет, если забыть про связи</h3>
      <p class="sub">Считаю тот же сценарий без связей между факторами…</p></section>`;

    // --- гистограмма
    const legend = ev ? `<div class="legend"><span><i class="sw s1"></i>${esc(M.event.name)}</span><span><i class="sw s2"></i>не ${esc(M.event.name.toLowerCase())}</span></div>` : '';
    html += `<section class="card"><h3>Распределение: ${esc(rl)}</h3>
      <p class="sub">Доля прогонов с каждым значением${ev ? '; нижняя часть столбика — где событие произошло' : ''}.</p>
      ${legend}<div class="chart" id="ch-hist"></div><p class="note" id="hist-note"></p></section>`;

    // --- калькулятор
    html += `<section class="card"><h3>Калькулятор</h3>
      <div class="calc">
        <label>Вероятность, что ${esc(M.result.name)} ≤ <input id="calc-x" inputmode="decimal" value="${fmtIn(Math.round(R.pct[75]))}">${u}</label>
        <output id="calc-x-out"></output>
      </div>
      <div class="calc">
        <label>В <input id="calc-q" inputmode="decimal" value="95"> % случаев ${esc(M.result.name)} не больше</label>
        <output id="calc-q-out"></output>
      </div></section>`;

    // --- торнадо
    html += `<section class="card"><h3>Что влияет сильнее всего</h3>
      <p class="sub">Берём те же прогоны и фиксируем один фактор: на малом значении (10-й перцентиль) и на большом (90-й).
      ${ev ? 'Чем шире отрезок, тем сильнее фактор двигает вероятность.' : 'Чем шире отрезок, тем сильнее фактор двигает средний итог.'}
      Посчитано на ${sens.rows.toLocaleString('ru-RU')} прогонах.</p>
      <div class="legend"><span><i class="dotk s1"></i>фактор мал</span><span><i class="dotk s2"></i>фактор велик</span></div>
      <div class="chart" id="ch-tornado"></div></section>`;

    // --- сходимость
    html += `<section class="card"><h3>Сходимость</h3>
      <p class="sub">${ev ? 'Как менялась оценка вероятности' : 'Как менялось среднее'} по мере прогонов.
      ${ev ? 'Коридор — 95% интервал: он сужается как 1/√N — в 100 раз больше прогонов дают в 10 раз точнее.' : ''}</p>
      <div class="chart" id="ch-conv"></div></section>`;

    // --- таблица перцентилей (табличный вид для графиков)
    html += `<section class="card"><h3>Перцентили: ${esc(rl)}</h3>
      <div class="table-wrap"><table class="pct-table"><thead><tr>${MC.PCTS.map(q => `<th>P${q}</th>`).join('')}</tr></thead>
      <tbody><tr>${MC.PCTS.map(q => `<td>${num(R.pct[q])}</td>`).join('')}</tr></tbody></table></div>
      <p class="note">P90 = ${num(R.pct[90])}${u}: в 90% прогонов итог не больше этого числа.</p></section>`;

    html += `<p class="runinfo">${S.n.toLocaleString('ru-RU')} прогонов · сид ${S.seed} · ${(ms / 1000).toFixed(2)} с.
      Тот же сид даёт те же самые числа.${S.nan ? ` Пропущено ${S.nan} прогонов, где итог не число (например, деление на 0).` : ''}
      <button class="link" id="btn-summary">⬇ Скачать сводку для Excel (CSV)</button></p>`;

    $('#results-body').innerHTML = html;
    $('#btn-summary').addEventListener('click', () =>
      download(`${safeName(M.name)} — результаты.csv`, summaryCsv(), 'text/csv'));
    drawCharts();
    bindCalc();
    markStale();
  }

  function drawCharts() {
    if (!lastRun) return;
    const { model: M, run, summary: S, sens, exact } = lastRun;
    const ev = S.event;
    const h = histWithEvent(run, S.result.sorted);
    Charts.histogram($('#ch-hist'), {
      title: 'Распределение итога', bins: h.bins, discrete: h.discrete, hasEvent: !!ev,
      unit: M.result.unit, resultLabel: M.result.name, axisLabel: M.result.unit || '',
      yesLabel: ev ? M.event.name : '', noLabel: ev ? 'не ' + M.event.name.toLowerCase() : '',
    });
    $('#hist-note').textContent = h.discrete ? ''
      : `Крайние 0,5% с каждой стороны не показаны: от ${num(S.result.min)} до ${num(S.result.max)} — см. перцентили.`;
    Charts.tornado($('#ch-tornado'), {
      title: 'Влияние факторов', items: sens.items, base: sens.base, hasEvent: !!ev, unit: M.result.unit,
    });
    Charts.convergence($('#ch-conv'), {
      title: 'Сходимость', points: run.convergence, hasEvent: !!ev,
      exact: exact ? (ev ? exact.p : exact.mean) : null,
    });
  }

  function bindCalc() {
    const sorted = lastRun.summary.result.sorted, unit = lastRun.model.result.unit;
    const upd = () => {
      const x = parseNum($('#calc-x').value);
      $('#calc-x-out').textContent = Number.isFinite(x)
        ? `${pct(countLE(sorted, x) / sorted.length, 2)}  (больше — ${pct(1 - countLE(sorted, x) / sorted.length, 2)})` : '—';
      const q = parseNum($('#calc-q').value);
      $('#calc-q-out').textContent = q >= 0 && q <= 100 ? `${num(MC.quantile(sorted, q / 100))}${unit ? ' ' + unit : ''}` : '—';
    };
    $('#calc-x').addEventListener('input', upd);
    $('#calc-q').addEventListener('input', upd);
    upd();
  }

  // ===================================================================================
  // Подсказки на графиках
  // ===================================================================================
  function bindTips() {
    const tip = $('#tip');
    const show = (el, x, y) => {
      tip.textContent = el.dataset.tip;
      tip.hidden = false;
      const r = tip.getBoundingClientRect();
      tip.style.left = Math.min(window.innerWidth - r.width - 8, x + 14) + 'px';
      tip.style.top = (y + 14 + r.height > window.innerHeight ? y - r.height - 10 : y + 14) + 'px';
    };
    document.addEventListener('pointermove', e => {
      const el = e.target.closest && e.target.closest('[data-tip]');
      if (el) show(el, e.clientX, e.clientY); else tip.hidden = true;
    });
    document.addEventListener('pointerleave', () => { tip.hidden = true; });
  }

  // ===================================================================================
  // Шаблоны и запуск
  // ===================================================================================
  function loadScenario(s, id) {
    tplId = id;
    sc = normalize(s);
    $('#tpl').value = id || '';
    renderScenario();
    changed();
  }

  function init() {
    $('#tpl').innerHTML = MC_TEMPLATES.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('') +
      '<option value="">— свой сценарий —</option>';
    const saved = tryStore(() => JSON.parse(localStorage.getItem(STORE_KEY)), null);
    const byHash = MC_TEMPLATES.find(t => location.hash === '#tpl=' + t.id);    // ссылка вида index.html#tpl=project
    if (byHash) loadScenario(byHash, byHash.id);
    else if (saved && saved.sc && Array.isArray(saved.sc.factors)) loadScenario(saved.sc, saved.tplId);
    else loadScenario(MC_TEMPLATES[0], MC_TEMPLATES[0].id);

    bindEditor();
    bindTips();
    $('#tpl').addEventListener('change', e => {
      const t = MC_TEMPLATES.find(x => x.id === e.target.value);
      if (!t) { tplId = ''; changed(); return; }
      if (!$('#tpl-mod').hidden && !confirm('Изменения в текущем сценарии пропадут. Загрузить шаблон?')) {
        e.target.value = tplId; return;
      }
      loadScenario(t, t.id);
      runSim();
    });
    $('#btn-reset').addEventListener('click', () => {
      const t = MC_TEMPLATES.find(x => x.id === tplId);
      if (t && confirm('Вернуть шаблон к исходному виду?')) { loadScenario(t, t.id); runSim(); }
    });
    $('#btn-new').addEventListener('click', () => {
      if (!confirm('Начать пустой сценарий? Текущий пропадёт.')) return;
      loadScenario({
        name: 'Новый сценарий', description: '',
        factors: [{ name: 'А', label: '', dist: { type: 'table', ...clone(DIST_DEFAULTS.table) } }],
        derived: [], result: { name: 'Итог', label: 'Итог', unit: '', formula: 'А' },
        event: { name: 'Событие', label: 'Итог не больше 5', formula: 'Итог <= 5' },
      }, '');
    });
    $('#run').addEventListener('click', runSim);
    $('#btn-save').addEventListener('click', () => download(`${safeName(sc.name)}.json`, scenarioFile(), 'application/json'));
    $('#btn-open').addEventListener('click', () => $('#open-file').click());
    $('#open-file').addEventListener('change', e => {
      const f = e.target.files[0];
      if (f) {
        // без вопроса — только если открыт нетронутый шаблон; свой сценарий может пропасть, поэтому спрашиваем
        if ((tplId && $('#tpl-mod').hidden) || confirm('Текущий сценарий будет заменён. Открыть файл?')) openScenario(f);
      }
      e.target.value = '';
    });
    $('#seed-rand').addEventListener('click', () => {
      $('#seed').value = tryStore(() => crypto.getRandomValues(new Uint32Array(1))[0], Math.floor(Math.random() * 4294967295));
    });
    document.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) runSim(); });
    let rt;
    window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(drawCharts, 150); });
    runSim();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
