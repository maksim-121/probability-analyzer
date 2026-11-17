/*
 * Простой режим — для обычного человека, без формул и терминов.
 *
 * Человек отвечает на четыре вопроса:
 *   1) что хотим узнать: «начнётся ли вовремя» (ждём всех -> берётся самое большое опоздание)
 *      или «уложимся ли в срок» (этапы друг за другом -> время складывается);
 *   2) кто или что может задержать — и как: «бывает по-разному» (варианты в процентах),
 *      «минимум / обычно / максимум» или «иногда случается»;
 *   3) есть ли общая причина (например, дождь), из-за которой задерживаются сразу несколько;
 *   4) что считаем успехом.
 * Из ответов собирается обычный сценарий движка (тот же, что в режиме специалиста), а ответ
 * показывается одной фразой: «в 54 случаях из 100», плюс «что поможет больше всего».
 */
const PASimple = (() => {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const { num, pct, esc } = Charts;
  const KEY = 'probability-analyzer.simple.v1';
  const N = 300000, N_IDEA = 100000, SEED = 20261117;

  const KINDS = {
    all: {
      q: 'Начнётся ли вовремя?', how: 'Ждём, пока соберутся все. Решает самое большое опоздание.',
      items: 'Кто или что может задержать?', itemsSub: 'Для каждого — как часто и на сколько он задерживается. Можно примерно: это всё равно лучше, чем гадать.',
      add: '+ Добавить участника', placeholder: 'Например: Иван, едет на автобусе',
      goal: 'Задержка не больше', success: 'начнётся вовремя', yes: 'вовремя', no: 'с опозданием',
      typical: 'задержка', ideas: 'Что поможет больше всего', histo: 'Как часто какая задержка',
    },
    chain: {
      q: 'Уложимся ли в срок?', how: 'Этапы идут друг за другом. Время складывается.',
      items: 'Из каких этапов складывается время?', itemsSub: 'Для каждого этапа — сколько он обычно занимает и как сильно может затянуться.',
      add: '+ Добавить этап', placeholder: 'Например: Разработка',
      goal: 'Всего не больше', success: 'уложится в срок', yes: 'уложились', no: 'не уложились',
      typical: 'всего', ideas: 'Что сильнее всего ускорит', histo: 'Сколько времени уходит всего',
    },
  };
  const MODES = [
    ['options', 'Бывает по-разному'],
    ['range', 'Мин. / обычно / макс.'],
    ['sometimes', 'Иногда случается'],
  ];

  const clone = o => JSON.parse(JSON.stringify(o));
  const tryStore = (fn, fb) => { try { return fn(); } catch (e) { return fb; } };
  const parseNum = s => {
    const t = String(s).trim().replace(/\s/g, '').replace(',', '.');
    return t === '' ? NaN : Number(t);
  };
  const fmtIn = v => (typeof v === 'number' && Number.isFinite(v) ? String(+v.toPrecision(12)).replace('.', ',') : '');
  const getPath = (o, p) => p.split('.').reduce((x, k) => (x == null ? x : x[k]), o);
  const setPath = (o, p, v) => { const k = p.split('.'); let x = o; for (let i = 0; i < k.length - 1; i++) x = x[k[i]]; x[k[k.length - 1]] = v; };

  // ---------------------------------------------------------------- примеры
  const opt = (pairs) => pairs.map(([value, p]) => ({ value, pct: p }));
  const item = (name, mode, d, dc) => ({ name, mode, d: { options: opt([[0, 80], [10, 20]]), min: 0, usual: 5, max: 15, pct: 25, from: 5, to: 15, ...d },
    byCause: !!dc, dc: dc ? { options: opt([[0, 80], [10, 20]]), min: 0, usual: 5, max: 15, pct: 25, from: 5, to: 15, ...dc } : null });

  const EXAMPLES = [
    { id: 'meeting', label: 'Совещание в 14:00', s: {
      kind: 'all', title: 'Совещание в 14:00', unit: 'мин', goal: 5, cause: { on: false, name: 'Дождь', pct: 30 },
      items: [
        item('Иван, едет на автобусе', 'options', { options: opt([[0, 50], [5, 30], [10, 15], [20, 5]]) }),
        item('Мария, задерживается после обеда', 'options', { options: opt([[0, 90], [10, 10]]) }),
        item('Переговорка: прошлое совещание затянулось', 'sometimes', { pct: 25, from: 5, to: 15 }),
      ] } },
    { id: 'rain', label: 'Совещание в дождь', s: {
      kind: 'all', title: 'Совещание в дождь', unit: 'мин', goal: 5, cause: { on: true, name: 'Дождь', pct: 30 },
      items: [
        item('Иван, едет на автобусе', 'options', { options: opt([[0, 60], [5, 30], [10, 8], [20, 2]]) },
          { options: opt([[0, 20], [5, 30], [10, 30], [20, 20]]) }),
        item('Мария, задерживается после обеда', 'options', { options: opt([[0, 95], [10, 5]]) },
          { options: opt([[0, 70], [10, 30]]) }),
        item('Переговорка: прошлое совещание затянулось', 'sometimes', { pct: 25, from: 5, to: 15 }),
      ] } },
    { id: 'delivery', label: 'Доставка за 3 часа', s: {
      kind: 'chain', title: 'Доставка заказа за 3 часа', unit: 'мин', goal: 180, cause: { on: false, name: 'Час пик', pct: 30 },
      items: [
        item('Сборка заказа на складе', 'range', { min: 20, usual: 40, max: 120 }),
        item('Ожидание свободного курьера', 'range', { min: 0, usual: 20, max: 60 }),
        item('Дорога', 'range', { min: 30, usual: 45, max: 70 }),
        item('Пробка', 'sometimes', { pct: 30, from: 5, to: 45 }),
      ] } },
    { id: 'project', label: 'Сроки проекта', s: {
      kind: 'chain', title: 'Сроки проекта', unit: 'дн.', goal: 30, cause: { on: false, name: 'Сырые требования', pct: 30 },
      items: [
        item('Анализ требований', 'range', { min: 3, usual: 5, max: 10 }),
        item('Разработка', 'range', { min: 10, usual: 15, max: 30 }),
        item('Тестирование', 'range', { min: 3, usual: 5, max: 12 }),
        item('Доработка после критических багов', 'sometimes', { pct: 30, from: 2, to: 7 }),
      ] } },
  ];
  const BLANK = () => ({ kind: 'all', title: 'Моя ситуация', unit: 'мин', goal: 5, cause: { on: false, name: 'Дождь', pct: 30 },
    items: [item('', 'options', { options: opt([[0, 70], [10, 30]]) })] });

  let state = null, exampleId = 'meeting', token = 0, timer = null, last = null;

  // ===================================================================================
  // Проверка ответов — человеческим языком
  // ===================================================================================
  function checkDist(mode, d, unit) {
    const bad = x => !Number.isFinite(x);
    if (mode === 'options') {
      if (!d.options.length) return 'добавьте хотя бы один вариант';
      if (d.options.some(o => bad(o.value) || bad(o.pct))) return 'в вариантах есть пустое поле или не число';
      if (d.options.some(o => o.pct < 0)) return 'процент не может быть отрицательным';
      const sum = d.options.reduce((s, o) => s + o.pct, 0);
      if (Math.abs(sum - 100) > 1e-9) return `проценты в сумме ${num(sum)} %, а должно быть 100 %`;
    } else if (mode === 'range') {
      if ([d.min, d.usual, d.max].some(bad)) return 'заполните «меньше всего», «обычно» и «больше всего»';
      if (!(d.min <= d.usual && d.usual <= d.max)) return '«обычно» должно быть между «меньше всего» и «больше всего»';
    } else {
      if ([d.pct, d.from, d.to].some(bad)) return 'заполните, как часто и на сколько';
      if (d.pct < 0 || d.pct > 100) return 'как часто — от 0 до 100 %';
      if (d.from > d.to) return `«от» больше, чем «до»`;
    }
    return '';
  }

  function check(s) {
    const items = {}, global = [];
    if (!s.items.length) global.push('Добавьте хотя бы одного участника или этап.');
    s.items.forEach((it, k) => {
      const nm = it.name || `Пункт ${k + 1}`;
      const m1 = checkDist(it.mode, it.d, s.unit);
      const m2 = s.cause.on && it.byCause && it.dc ? checkDist(it.mode, it.dc, s.unit) : '';
      if (m1) items[k] = `«${nm}»: ${m1}.`;
      else if (m2) items[k] = `«${nm}», когда «${s.cause.name}»: ${m2}.`;
    });
    if (!Number.isFinite(s.goal)) global.push('Укажите, что считаем успехом (число в шаге 4).');
    if (s.cause.on && !(s.cause.pct >= 0 && s.cause.pct <= 100)) global.push('Общая причина: как часто — от 0 до 100 %.');
    return { items, global, ok: !global.length && !Object.keys(items).length };
  }

  // ===================================================================================
  // Ответы -> обычный сценарий движка
  // ===================================================================================
  function distOf(mode, d) {
    if (mode === 'options') return { type: 'table', values: d.options.map(o => o.value), weights: d.options.map(o => o.pct) };
    if (d.min === d.max) return { type: 'uniform', min: d.min, max: d.max };      // всегда одно и то же
    return { type: 'triangular', min: d.min, mode: d.usual, max: d.max };
  }
  const maybeCause = (causeId, it, make) => (causeId && it.byCause
    ? { type: 'conditional', on: causeId, cases: [{ value: 1, dist: make(it.dc) }, { value: 0, dist: make(it.d) }] }
    : make(it.d));

  function toScenario(s) {
    const K = KINDS[s.kind];
    const taken = new Set(['итог', 'успех']);
    const id = (raw, fb) => CSV.safeName(raw || fb, taken);
    const factors = [], derived = [], parts = [];
    let causeId = null;
    if (s.cause.on) {
      causeId = id(s.cause.name, 'Причина');
      factors.push({ name: causeId, label: `${s.cause.name || 'Общая причина'}?`, dist: { type: 'yesno', p: s.cause.pct / 100 } });
    }
    s.items.forEach((it, k) => {
      const label = it.name || `Пункт ${k + 1}`;
      const name = id(it.name, `Пункт_${k + 1}`);
      if (it.mode === 'sometimes') {
        const happened = id(`${name}_случилось`), amount = id(`${name}_сколько`);
        factors.push({ name: happened, label: `${label}: случилось?`, dist: maybeCause(causeId, it, d => ({ type: 'yesno', p: d.pct / 100 })) });
        factors.push({ name: amount, label: `${label}: если случилось, ${s.unit}`, dist: maybeCause(causeId, it, d => ({ type: 'uniform', min: d.from, max: d.to })) });
        derived.push({ name, label: `${label}, ${s.unit}`, formula: `если(${happened}; ${amount}; 0)` });
      } else {
        factors.push({ name, label: `${label}, ${s.unit}`, dist: maybeCause(causeId, it, d => distOf(it.mode, d)) });
      }
      parts.push(name);
    });
    const goal = String(s.goal);
    return {
      name: s.title || 'Моя ситуация',
      description: `Собрано в простом режиме: ${K.q.toLowerCase()} ${K.how}`,
      factors, derived,
      result: { name: 'Итог', label: s.kind === 'all' ? 'Задержка' : 'Сколько всего', unit: s.unit,
        formula: s.kind === 'all' ? `max(${parts.join('; ')})` : parts.join(' + ') },
      event: { name: 'Успех', label: `${s.kind === 'all' ? 'Вовремя' : 'Уложились'} (${s.kind === 'all' ? 'задержка' : 'всего'} ≤ ${num(s.goal)} ${s.unit})`,
        formula: `Итог <= ${goal}` },
    };
  }

  // ===================================================================================
  // Редактор
  // ===================================================================================
  function distEditor(mode, d, P, unit, kind) {
    const u = esc(unit);
    if (mode === 'options') {
      const rows = d.options.map((o, j) => `
        <div class="opt-row">
          <input class="v" inputmode="decimal" data-s="${P}.options.${j}.value" data-num value="${fmtIn(o.value)}" aria-label="Сколько, ${u}">
          <span>${u} — в</span>
          <input class="p" inputmode="decimal" data-s="${P}.options.${j}.pct" data-num value="${fmtIn(o.pct)}" aria-label="Как часто, %">
          <span>%<span class="long"> случаев</span></span>
          <button class="icon" data-s-act="del-opt" data-p="${P}" data-j="${j}" title="Убрать вариант" aria-label="Убрать вариант"${d.options.length < 2 ? ' disabled' : ''}>✕</button>
        </div>`).join('');
      return `<div class="opts">${rows}</div>
        <div class="opt-foot"><button class="link" data-s-act="add-opt" data-p="${P}">+ вариант</button>
        <span class="sum" data-sum="${P}"></span></div>
        <p class="hint">${kind === 'all' ? '0 — значит без задержки. ' : ''}Проценты в сумме должны дать 100.</p>`;
    }
    if (mode === 'range') {
      return `<div class="fields">
        <label class="field">меньше всего, ${u}<input inputmode="decimal" data-s="${P}.min" data-num value="${fmtIn(d.min)}"></label>
        <label class="field">обычно, ${u}<input inputmode="decimal" data-s="${P}.usual" data-num value="${fmtIn(d.usual)}"></label>
        <label class="field">больше всего, ${u}<input inputmode="decimal" data-s="${P}.max" data-num value="${fmtIn(d.max)}"></label>
      </div><p class="hint">Чаще всего выпадает около «обычно», реже — ближе к краям.</p>`;
    }
    return `<div class="sentence">Случается в <input inputmode="decimal" data-s="${P}.pct" data-num value="${fmtIn(d.pct)}" aria-label="Как часто, %"> % случаев,
      и тогда ${kind === 'all' ? 'задерживает' : 'добавляет'} от <input inputmode="decimal" data-s="${P}.from" data-num value="${fmtIn(d.from)}" aria-label="От">
      до <input inputmode="decimal" data-s="${P}.to" data-num value="${fmtIn(d.to)}" aria-label="До"> ${u}</div>`;
  }

  function itemCard(it, k) {
    const s = state, K = KINDS[s.kind];
    return `<div class="item s-item" data-k="${k}">
      <div class="row">
        <input class="s-name" data-s="items.${k}.name" value="${esc(it.name)}" placeholder="${esc(K.placeholder)}" aria-label="Название">
        <button class="icon" data-s-act="del" data-k="${k}" title="Убрать" aria-label="Убрать"${s.items.length < 2 ? ' disabled' : ''}>✕</button>
      </div>
      <div class="seg" role="radiogroup" aria-label="Как описать">
        ${MODES.map(([m, l]) => `<button type="button" role="radio" aria-checked="${it.mode === m}" data-s-act="mode" data-k="${k}" data-mode="${m}">${l}</button>`).join('')}
      </div>
      ${distEditor(it.mode, it.d, `items.${k}.d`, s.unit, s.kind)}
      ${s.cause.on ? `<label class="check"><input type="checkbox" data-s="items.${k}.byCause"${it.byCause ? ' checked' : ''}>
          Когда «${esc(s.cause.name)}» — по-другому</label>
        ${it.byCause ? `<div class="alt"><div class="alt-head">Когда «${esc(s.cause.name)}»:</div>
          ${distEditor(it.mode, it.dc, `items.${k}.dc`, s.unit, s.kind)}</div>` : ''}` : ''}
      <div class="s-err" data-err="${k}"></div>
    </div>`;
  }

  function render() {
    const s = state, K = KINDS[s.kind];
    const units = ['мин', 'ч', 'дн.'];
    if (!units.includes(s.unit)) units.push(s.unit);
    $('#s-editor').innerHTML = `
      <div class="card s-step">
        <h2><span class="step-num">1</span>Что хотите узнать?</h2>
        <div class="choice">
          ${Object.entries(KINDS).map(([k, v]) => `<label class="opt-card${s.kind === k ? ' on' : ''}">
            <input type="radio" name="s-kind" data-s="kind" value="${k}"${s.kind === k ? ' checked' : ''}>
            <span><b>${v.q}</b><small>${v.how}</small></span></label>`).join('')}
        </div>
        <div class="row2">
          <label class="field grow">Как назовём<input data-s="title" value="${esc(s.title)}"></label>
          <label class="field">В чём считаем<select data-s="unit">${units.map(u => `<option${u === s.unit ? ' selected' : ''}>${esc(u)}</option>`).join('')}</select></label>
        </div>
      </div>

      <div class="card s-step">
        <h2><span class="step-num">2</span>${K.items}</h2>
        <p class="sub">${K.itemsSub}</p>
        <div class="items">${s.items.map(itemCard).join('')}</div>
        <button class="btn add" data-s-act="add">${K.add}</button>
      </div>

      <div class="card s-step">
        <h2><span class="step-num">3</span>Есть общая причина? <span>необязательно</span></h2>
        <label class="check"><input type="checkbox" data-s="cause.on"${s.cause.on ? ' checked' : ''}>
          Да — иногда бывает что-то, из-за чего задерживаются сразу несколько (например, дождь)</label>
        ${s.cause.on ? `<div class="row2">
            <label class="field grow">Что это<input data-s="cause.name" value="${esc(s.cause.name)}"></label>
            <label class="field">Как часто, % случаев<input inputmode="decimal" data-s="cause.pct" data-num value="${fmtIn(s.cause.pct)}"></label>
          </div>
          <p class="hint">Теперь в шаге 2 у каждого пункта можно отметить «Когда «${esc(s.cause.name)}» — по-другому».</p>` : ''}
      </div>

      <div class="card s-step">
        <h2><span class="step-num">4</span>Что считаем успехом?</h2>
        <label class="goal">${K.goal} <input inputmode="decimal" data-s="goal" data-num value="${fmtIn(s.goal)}" aria-label="Порог"> ${esc(s.unit)}</label>
      </div>`;
    updateSums();
    showErrors(check(state));
  }

  function updateSums() {
    document.querySelectorAll('[data-sum]').forEach(el => {
      const d = getPath(state, el.dataset.sum);
      const sum = d.options.reduce((a, o) => a + (Number.isFinite(o.pct) ? o.pct : 0), 0);
      const ok = Math.abs(sum - 100) < 1e-9;
      el.textContent = ok ? 'Итого 100 % ✓' : `Итого ${num(sum)} % — нужно 100 %`;
      el.classList.toggle('bad', !ok);
    });
  }

  function showErrors(chk) {
    document.querySelectorAll('[data-err]').forEach(el => { el.textContent = chk.items[el.dataset.err] || ''; });
  }

  // ---------------------------------------------------------------- события
  function bind() {
    const ed = $('#s-editor');
    const onValue = e => {
      const el = e.target, p = el.dataset.s;
      if (!p) return;
      let v;
      if (el.type === 'checkbox') v = el.checked;
      else if (el.hasAttribute('data-num')) v = parseNum(el.value);
      else v = el.value;
      setPath(state, p, v);
      const structural = p === 'kind' || p === 'unit' || p === 'cause.on' || /\.byCause$/.test(p) || (p === 'cause.name' && e.type === 'change');
      if (/\.byCause$/.test(p) && v) {
        const k = +p.split('.')[1];
        if (!state.items[k].dc) state.items[k].dc = clone(state.items[k].d);
      }
      if (structural && (e.type === 'change' || el.type === 'radio' || el.type === 'checkbox')) render();
      else { updateSums(); showErrors(check(state)); }
      changed();
    };
    ed.addEventListener('input', onValue);
    ed.addEventListener('change', e => {
      const el = e.target;
      if (el.type === 'checkbox' || el.type === 'radio' || el.tagName === 'SELECT' || el.dataset.s === 'cause.name') onValue(e);
      else if (el.hasAttribute('data-num')) {        // аккуратный вид числа после ухода с поля
        const v = getPath(state, el.dataset.s);
        if (Number.isFinite(v)) el.value = fmtIn(v);
      }
    });
    ed.addEventListener('click', e => {
      const b = e.target.closest('[data-s-act]');
      if (!b) return;
      const act = b.dataset.sAct, k = +b.dataset.k;
      if (act === 'add') {
        state.items.push(item('', state.kind === 'all' ? 'options' : 'range',
          state.kind === 'all' ? { options: opt([[0, 70], [10, 30]]) } : { min: 1, usual: 2, max: 5 }));
        render();
        const names = document.querySelectorAll('.s-name');
        names[names.length - 1].focus();
      } else if (act === 'del') {
        state.items.splice(k, 1); render();
      } else if (act === 'mode') {
        state.items[k].mode = b.dataset.mode; render();
      } else if (act === 'add-opt') {
        const d = getPath(state, b.dataset.p), lastV = d.options[d.options.length - 1].value;
        d.options.push({ value: Number.isFinite(lastV) ? lastV + 5 : 0, pct: 0 }); render();
      } else if (act === 'del-opt') {
        getPath(state, b.dataset.p).options.splice(+b.dataset.j, 1); render();
      } else return;
      changed();
    });

    $('#s-tpl').innerHTML = EXAMPLES.map(x => `<option value="${x.id}">${esc(x.label)}</option>`).join('') +
      '<option value="">— своя ситуация —</option>';
    $('#s-tpl').addEventListener('change', e => {
      const x = EXAMPLES.find(t => t.id === e.target.value);
      if (!x) { exampleId = ''; return; }
      load(clone(x.s), x.id);
    });
    $('#s-new').addEventListener('click', () => {
      if (!confirm('Начать с чистого листа? Текущие ответы пропадут.')) return;
      load(BLANK(), '');
    });
    $('#s-save').addEventListener('click', () => {
      const text = JSON.stringify({ format: 'probability-analyzer', version: 2, mode: 'simple', saved: new Date().toISOString(), simple: state }, null, 2);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      a.download = `${String(state.title || 'ситуация').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80)}.json`;
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    });
    $('#s-open').addEventListener('click', () => $('#s-open-file').click());
    $('#s-open-file').addEventListener('change', async e => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      try {
        const data = JSON.parse(await f.text());
        if (data && data.simple && Array.isArray(data.simple.items)) load(data.simple, '');
        else if (data && (data.scenario || data.factors)) PA.openExpert(data.scenario || data, data.settings);
        else throw new Error('это не файл анализатора');
      } catch (err) {
        $('#s-results').innerHTML = `<section class="card"><p class="bad">Не удалось открыть «${esc(f.name)}»: ${esc(err.message)}</p></section>`;
      }
    });
  }

  function changed() {
    tryStore(() => localStorage.setItem(KEY, JSON.stringify({ exampleId, state })));
    const x = EXAMPLES.find(t => t.id === exampleId);
    if (x && JSON.stringify(x.s) !== JSON.stringify(state)) { exampleId = ''; $('#s-tpl').value = ''; }
    clearTimeout(timer);
    timer = setTimeout(calc, 450);
  }

  function load(s, id) {
    state = s;
    exampleId = id;
    $('#s-tpl').value = id;
    render();
    tryStore(() => localStorage.setItem(KEY, JSON.stringify({ exampleId, state })));
    calc();
  }

  // ===================================================================================
  // Расчёт и ответ
  // ===================================================================================
  const frame = () => new Promise(r => setTimeout(r, 0));

  async function runP(sc, n) {
    const m = MC.compile(sc);
    const r = MC.createRun(m, { n, seed: SEED });
    while (!r.step(50000)) await frame();
    return { model: m, run: r, summary: MC.summarize(r) };
  }

  /** Варианты «что поможет»: каждый пункт по очереди делаем «идеальным» и пересчитываем. */
  function ideasFor(s) {
    const out = [];
    s.items.forEach((it, k) => {
      const t = clone(s), x = t.items[k], u = s.unit, nm = it.name || `Пункт ${k + 1}`;
      const fix = d => {
        if (it.mode === 'options') {
          const best = Math.min(...d.options.map(o => o.value));
          d.options = [{ value: best, pct: 100 }];
          return best;
        }
        if (it.mode === 'range') { d.min = d.usual; d.max = d.usual; return d.usual; }
        d.pct = 0; return 0;
      };
      const v = fix(x.d);
      if (x.byCause && x.dc) fix(x.dc);
      const what = it.mode === 'options'
        ? (v === 0 && s.kind === 'all' ? 'всегда без задержки' : `всегда ${num(v)} ${u}`)
        : it.mode === 'range' ? `всегда как обычно — ${num(v)} ${u}` : 'такого больше не случается';
      out.push({ name: nm, what, s: t });
    });
    if (s.cause.on) {
      const t = clone(s);
      t.cause.pct = 0;
      out.push({ name: s.cause.name, what: 'этого никогда не бывает', s: t });
    }
    return out;
  }

  /** «План как обычно» для этапов: сумма «обычных» значений. */
  function planOf(s) {
    let sum = 0;
    for (const it of s.items) {
      if (it.mode === 'range') sum += it.d.usual;
      else if (it.mode === 'options') sum += it.d.options.slice().sort((a, b) => b.pct - a.pct)[0].value;
      else if (it.d.pct > 50) sum += (it.d.from + it.d.to) / 2;
    }
    return sum;
  }

  function verdict(p) {
    if (p >= 0.9) return ['good', 'Почти наверняка', '✓'];
    if (p >= 0.7) return ['good', 'Скорее да', '✓'];
    if (p >= 0.4) return ['warn', 'Как повезёт', '!'];
    if (p >= 0.15) return ['bad', 'Скорее нет', '✕'];
    return ['bad', 'Почти точно нет', '✕'];
  }
  const outOf100 = p => (p > 0 && p < 0.005 ? 'меньше 1' : p < 1 && p > 0.995 ? 'больше 99' : String(Math.round(p * 100)));

  async function calc() {
    if (!state) return;
    const my = ++token;
    const box = $('#s-results');
    const chk = check(state);
    showErrors(chk);
    if (!chk.ok) {
      box.innerHTML = `<section class="card s-fix"><h3>Чтобы посчитать, поправьте:</h3><ul class="plain">${
        [...chk.global, ...Object.values(chk.items)].map(m => `<li>${esc(m)}</li>`).join('')}</ul></section>`;
      sticky('<b>Нужно поправить ответы</b> ↓', 'bad');
      return;
    }
    let sc, main;
    try {
      sc = toScenario(state);
      if (!last) box.innerHTML = '<section class="card"><p class="sub">Считаю…</p></section>';
      main = await runP(sc, N);
    } catch (e) {
      if (my === token) box.innerHTML = `<section class="card s-fix"><p class="bad">Не получилось посчитать: ${esc(e.message)}</p></section>`;
      return;
    }
    if (my !== token) return;
    last = { s: clone(state), sc, main, exact: MC.exact(main.model, { maxCombos: 2e5 }), ideas: null, indep: null };
    renderAnswer();
    // что поможет
    const ideas = [];
    for (const idea of ideasFor(state)) {
      const r = await runP(toScenario(idea.s), N_IDEA);
      if (my !== token) return;
      ideas.push({ ...idea, p: r.summary.event.p });
    }
    last.ideas = ideas.sort((a, b) => b.p - a.p);
    // без общей причины
    if (state.cause.on) {
      const r = await runP(MC.independentVersion(sc), N);
      if (my !== token) return;
      last.indep = r.summary.event.p;
    }
    renderAnswer();
  }

  function renderAnswer() {
    const { s, sc, main, exact } = last, K = KINDS[s.kind], S = main.summary, ev = S.event, R = S.result;
    const u = ` ${s.unit}`;
    const [lvl, word, icon] = verdict(ev.p);
    const filled = Math.round(ev.p * 100);
    const grid = Array.from({ length: 100 }, (_, i) => `<i class="${i < filled ? 'y' : 'n'}"></i>`).join('');
    let html = `<section class="card s-answer">
      <div class="badge-${lvl}"><span class="b-icon">${icon}</span>${word}</div>
      <div class="s-q">${esc(s.title)} — ${K.success}?</div>
      <div class="s-big">${outOf100(ev.p)} <span>из 100</span></div>
      <div class="s-sub">Примерно в ${outOf100(ev.p)} случаях из 100 ${K.success} (${K.yes}: ${K.typical === 'задержка' ? 'задержка' : 'всего'} не больше ${num(s.goal)}${u}).</div>
      <div class="dots" role="img" aria-label="${filled} из 100">${grid}</div>
      <div class="legend"><span><i class="sw s1"></i>${K.yes}</span><span><i class="sw nn"></i>${K.no}</span></div>
    </section>`;

    // обычно и в плохой день
    const lines = [];
    if (s.kind === 'all') {
      lines.push(R.pct[50] === 0 ? 'Обычно — без задержки.' : `Обычно задержка около ${num(R.pct[50])}${u}.`);
      lines.push(R.pct[90] === 0 ? 'Даже в плохой день почти всегда без задержки.' : `В плохой день (1 раз из 10) — больше ${num(R.pct[90])}${u}.`);
    } else {
      lines.push(`Обычно всего около ${num(R.pct[50])}${u}.`);
      lines.push(`В 1 случае из 10 — больше ${num(R.pct[90])}${u}.`);
      const plan = planOf(s);
      const sorted = R.sorted;
      let lo = 0, hi = sorted.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] <= plan) lo = mid + 1; else hi = mid; }
      lines.push(`Если считать «как обычно» и просто сложить — выйдет ${num(plan)}${u}. Так быстро получается только в ${outOf100(lo / sorted.length)} случаях из 100.`);
    }
    // «32 дн.» + «.» в конце фразы -> одна точка
    html += `<section class="card"><h3>Чего ждать</h3><ul class="plain">${lines.map(l => `<li>${l.replace(/\.\./g, '.')}</li>`).join('')}</ul></section>`;

    // что поможет
    if (!last.ideas) html += `<section class="card"><h3>${K.ideas}</h3><p class="sub">Считаю…</p></section>`;
    else {
      const good = last.ideas.filter(x => x.p - ev.p > 0.005);
      html += `<section class="card"><h3>${K.ideas}</h3>${good.length
        ? `<p class="sub">Если бы по очереди убрать каждую проблему — сколько раз из 100 ${K.success}:</p>
          <div class="ideas">${good.slice(0, 5).map(x => `<div class="idea">
            <div class="idea-text"><b>${esc(x.name)}</b> — ${esc(x.what)}</div>
            <div class="idea-bar"><span class="now" style="width:${ev.p * 100}%"></span><span class="gain" style="width:${Math.max(0, x.p - ev.p) * 100}%"></span></div>
            <div class="idea-num">${outOf100(x.p)} из 100 <small>+${Math.round((x.p - ev.p) * 100)}</small></div>
          </div>`).join('')}</div>`
        : '<p class="sub">Ни одна отдельная проблема заметно не влияет: всё и так хорошо или все примерно равны.</p>'}</section>`;
    }

    // общая причина
    if (s.cause.on && last.indep !== null) {
      const d = Math.round((last.indep - ev.p) * 100);
      html += `<section class="card"><h3>Почему важна общая причина</h3>
        <p>Если не учитывать, что «${esc(s.cause.name)}» задерживает сразу несколько пунктов, и считать их по отдельности,
        получилось бы <b>${outOf100(last.indep)} из 100</b>${d ? ` — на ${Math.abs(d)} ${d > 0 ? 'больше' : 'меньше'}, чем на самом деле` : ', то есть почти так же'}.</p>
        <p class="note">Плохие случаи приходят вместе: когда «${esc(s.cause.name)}», плохо сразу всем.</p></section>`;
    }

    // гистограмма
    html += `<section class="card"><h3>${K.histo}</h3>
      <div class="legend"><span><i class="sw s1"></i>${K.yes}</span><span><i class="sw s2"></i>${K.no}</span></div>
      <div class="chart" id="s-hist"></div></section>`;

    // подробности
    html += `<details class="card s-details"><summary>Подробности для специалиста</summary>
      <ul class="plain">
        <li>Точно: ${pct(ev.p, 2)} ± ${pct(ev.hi - ev.p, 2)} (95 % интервал), ${S.n.toLocaleString('ru-RU')} прогонов Монте-Карло, сид ${SEED}.</li>
        ${exact ? `<li>Точный ответ полным перебором ${exact.combos.toLocaleString('ru-RU')} вариантов: ${pct(exact.p, 2)}.</li>` : ''}
        <li>Как посчитан итог: <code>${esc(sc.result.formula)}</code> — ${s.kind === 'all' ? 'самое большое опоздание' : 'сумма этапов'}; успех: <code>${esc(sc.event.formula)}</code>.</li>
      </ul>
      <button class="btn" id="s-to-expert">Открыть в режиме специалиста →</button>
      <p class="note">Там видны все распределения и формулы, «торнадо», график сходимости и перцентили.</p>
    </details>`;

    $('#s-results').innerHTML = html;
    drawHist();
    $('#s-to-expert').addEventListener('click', () => PA.openExpert(sc, { n: 1000000, seed: SEED }));
    sticky(`<span class="st-main"><b>${outOf100(ev.p)} из 100</b> · ${word}</span><span class="st-go">ответ ↓</span>`, lvl);
  }

  /** Полоска внизу экрана на телефоне: ответ виден, даже когда листаешь вопросы. */
  function sticky(html, lvl) {
    const el = $('#s-sticky');
    if (!el) return;
    el.innerHTML = html;
    el.className = `s-sticky lvl-${lvl}`;
    el.hidden = false;
  }

  function drawHist() {
    const el = $('#s-hist');
    if (!el || !last || !el.clientWidth) return;
    const { main, s } = last, K = KINDS[s.kind], run = main.run, sorted = main.summary.result.sorted;
    const h = MC.histogram(sorted);
    const bins = h.bins.map(b => ({ ...b, yes: 0 }));
    const K2 = bins.length, lo = bins[0].from, w = bins[0].to - bins[0].from, idx = new Map(bins.map((b, i) => [b.from, i]));
    for (let i = 0; i < run.n; i++) {
      if (!run.event[i]) continue;
      const v = run.result[i];
      const b = h.discrete ? idx.get(v) : (v >= lo && v <= bins[K2 - 1].to ? Math.min(K2 - 1, Math.floor((v - lo) / w)) : undefined);
      if (b !== undefined) bins[b].yes++;
    }
    bins.forEach(b => { b.pYes = b.yes / sorted.length; });
    Charts.histogram(el, { title: K.histo, bins, discrete: h.discrete, hasEvent: true, unit: s.unit,
      resultLabel: s.kind === 'all' ? 'Задержка' : 'Всего', axisLabel: s.unit, yesLabel: K.yes, noLabel: K.no });
  }

  // ===================================================================================
  function init() {
    bind();
    const saved = tryStore(() => JSON.parse(localStorage.getItem(KEY)), null);
    const byHash = EXAMPLES.find(x => location.hash === '#simple=' + x.id);
    if (byHash) { state = clone(byHash.s); exampleId = byHash.id; }
    else if (saved && saved.state && Array.isArray(saved.state.items)) { state = saved.state; exampleId = saved.exampleId || ''; }
    else { state = clone(EXAMPLES[0].s); exampleId = EXAMPLES[0].id; }
    $('#s-tpl').value = exampleId;
    render();
    // считать начинаем, когда простой режим впервые показан (событие pa:mode из app.js)
    document.addEventListener('pa:mode', e => {
      if (e.detail !== 'simple') return;
      if (!last) calc(); else drawHist();
    });
    let rt;
    window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(drawHist, 150); });
    $('#s-sticky').addEventListener('click', () => $('#s-results').scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }

  return { init, load: (s) => load(s, ''), toScenario, check, EXAMPLES, get state() { return state; }, get last() { return last; } };
})();
