/*
 * Простой режим — для обычного человека, без формул и терминов.
 *
 * Человек выбирает одну из четырёх схем ситуации:
 *   parts — «Из нескольких частей»: части идут друг за другом и складываются (дорога, бюджет, ремонт);
 *   all   — «Ждём, пока будет готово всё»: решает самое долгое (встреча, несколько дел сразу);
 *   goal  — «Иду к цели шаг за шагом»: каждый период понемногу приближаюсь (жим, похудение, накопления);
 *   tries — «Несколько попыток»: каждая удаётся или нет (собеседования, подходы, экзамены).
 * Про каждое неизвестное число спрашиваем «Что вы о нём знаете?»: точно / примерно / может случиться /
 * как было раньше. Из ответов собирается обычный сценарий движка (тот же, что в режиме специалиста).
 *
 * Расчёт («Мои расчёты») = один или два варианта ситуации (для сравнения «а что если»).
 * Расчёты сами сохраняются в браузере; любой можно отправить ссылкой.
 */
const PASimple = (() => {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const { num, pct, esc } = Charts;
  const KEY_CUR = 'probability-analyzer.simple.v2';
  const KEY_MY = 'probability-analyzer.my.v2';
  const N = 200000, N_IDEA = 50000, SEED = 20261117;

  // ===================================================================================
  // Словарь
  // ===================================================================================
  const SCHEMES = {
    parts: { icon: '🧩', title: 'Из нескольких частей', sub: 'Части идут друг за другом, время или деньги складываются',
      ex: 'дорога до аэропорта, ремонт, бюджет поездки', itemsQ: 'Из каких частей складывается?', add: '+ Добавить часть',
      ph: 'Например: дорога до аэропорта' },
    all: { icon: '👥', title: 'Ждём, пока будет готово всё', sub: 'Всё идёт одновременно, решает самое долгое',
      ex: 'встреча, несколько дел сразу, посылки', itemsQ: 'Кого или что ждём?', add: '+ Добавить',
      ph: 'Например: Иван, едет на автобусе' },
    goal: { icon: '📈', title: 'Иду к цели шаг за шагом', sub: 'Каждую неделю понемногу приближаюсь, иногда откатываюсь',
      ex: 'жим 100 кг, похудение, накопления, учёба' },
    tries: { icon: '🎯', title: 'Несколько попыток', sub: 'Каждая попытка удаётся или нет',
      ex: 'собеседования, подходы в зале, экзамены, броски' },
  };
  const KNOW = [
    ['exact', 'Знаю точно'],
    ['approx', 'Примерно'],
    ['maybe', 'Может случиться'],
    ['history', 'Как было раньше'],
  ];
  const UNITS = ['мин', 'ч', 'дн.', '₽', 'шт.', 'кг', 'км'];
  const PERIODS = {
    'день': { forms: ['день', 'дня', 'дней'], acc: 'день', many: 'дни', perMonth: 30.44, max: 3650 },
    'неделя': { forms: ['неделя', 'недели', 'недель'], acc: 'неделю', many: 'недели', perMonth: 4.345, max: 520 },
    'месяц': { forms: ['месяц', 'месяца', 'месяцев'], acc: 'месяц', many: 'месяцы', perMonth: 1, max: 120 },
  };

  const clone = o => JSON.parse(JSON.stringify(o));
  const tryStore = (fn, fb) => { try { return fn(); } catch (e) { return fb; } };
  const parseNum = s => {
    const t = String(s).trim().replace(/\s/g, '').replace(',', '.');
    return t === '' ? NaN : Number(t);
  };
  const parseList = t => String(t).replace(/,(?=\s)/g, ' ').split(/[\s;]+/).filter(Boolean).map(parseNum);
  const fmtIn = v => (typeof v === 'number' && Number.isFinite(v) ? String(+v.toPrecision(12)).replace('.', ',') : '');
  const getPath = (o, p) => p.split('.').reduce((x, k) => (x == null ? x : x[k]), o);
  const setPath = (o, p, v) => { const k = p.split('.'); let x = o; for (let i = 0; i < k.length - 1; i++) x = x[k[i]]; x[k[k.length - 1]] = v; };
  const median = a => { const s = a.slice().sort((x, y) => x - y); const m = s.length; return m % 2 ? s[(m - 1) / 2] : (s[m / 2 - 1] + s[m / 2]) / 2; };
  const plural = (n, f) => {
    if (!Number.isInteger(n)) return f[1];
    const a = Math.abs(n) % 100, b = a % 10;
    return a > 10 && a < 20 ? f[2] : b === 1 ? f[0] : b >= 2 && b <= 4 ? f[1] : f[2];
  };
  const unitKind = u => (u === 'мин' || u === 'ч' || u === 'дн.' ? 'time' : u === '₽' || u === '$' || u === '€' ? 'money' : 'other');

  /** Значение для людей: 118 мин -> «1 ч 58 мин», 85000 ₽ -> «85 000 ₽». */
  function fmtVal(x, unit) {
    if (!Number.isFinite(x)) return '—';
    const hm = m => { const h = Math.floor(m / 60), r = m - h * 60; return r ? `${h} ч ${r} мин` : `${h} ч`; };
    if (unit === 'мин') { const m = Math.round(x); return Math.abs(m) >= 60 ? hm(m) : `${m} мин`; }
    if (unit === 'ч') { const m = Math.round(x * 60); return m < 60 ? `${m} мин` : hm(m); }
    if (unitKind(unit) === 'money') return `${Math.round(x).toLocaleString('ru-RU')} ${unit}`;
    return `${num(x)}${unit ? ' ' + unit : ''}`;
  }
  /** Число периодов для людей: 41 -> «41 неделя (≈ 9,5 мес.)». */
  function fmtPeriods(k, period) {
    const P = PERIODS[period];
    const n = Math.round(k);
    let s = `${n} ${plural(n, P.forms)}`;
    const months = n / P.perMonth;
    if (period !== 'месяц' && months >= 2) s += ` (≈ ${num(Math.round(months * 2) / 2)} мес.)`;
    if (period === 'месяц' && n >= 24) s += ` (≈ ${num(Math.round(n / 6) / 2)} ${plural(Math.round(n / 12), ['года', 'лет', 'лет'])})`;
    return s;
  }

  // ===================================================================================
  // Пустые заготовки и примеры
  // ===================================================================================
  const V = o => ({ exact: 10, usual: 10, min: 5, max: 20, pct: 30, from: 5, to: 15, history: [], ...o });
  const item = (name, know, v) => ({ name, know, v: V(v), byCause: false, vc: null });
  const blank = scheme => {
    const base = { v: 2, scheme, title: '', unit: 'мин', limit: { on: true, value: 60 }, cause: { on: false, name: 'Дождь', pct: 30 } };
    if (scheme === 'parts') return { ...base, title: 'Моя ситуация', items: [item('', 'approx', { usual: 20, min: 10, max: 40 })] };
    if (scheme === 'all') return { ...base, title: 'Встреча', limit: { on: true, value: 5 }, items: [item('', 'approx', { usual: 5, min: 0, max: 15 })] };
    if (scheme === 'goal') return { ...base, title: 'Моя цель', unit: 'кг', goal: { start: 80, target: 100, period: 'неделя',
      step: { know: 'approx', v: V({ exact: 0.5, usual: 0.5, min: 0, max: 1.5 }) },
      setback: { on: false, pct: 20, from: 0, to: 1 }, deadline: { on: false, value: 26 } } };
    return { ...base, title: 'Мои попытки', tries: { what: 'попытка', n: 5, pct: 30, need: 1 } };
  };
  const calcOf = sit => ({ id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), variants: [sit], active: 0 });

  const EXAMPLES = [
    { id: 'plane', label: '✈️ Успеть на самолёт', sit: { v: 2, scheme: 'parts', title: 'Успеть на самолёт', unit: 'мин',
      limit: { on: true, value: 120 }, cause: { on: false, name: 'Дождь', pct: 30 }, items: [
        item('Подача такси', 'approx', { usual: 5, min: 2, max: 15 }),
        item('Дорога до аэропорта', 'approx', { usual: 40, min: 30, max: 70 }),
        item('Пробка', 'maybe', { pct: 30, from: 10, to: 30 }),
        item('Регистрация и досмотр', 'approx', { usual: 20, min: 10, max: 50 }),
        item('Дойти до выхода на посадку', 'exact', { exact: 10 })] } },
    { id: 'meeting', label: '👥 Начнётся ли встреча вовремя', sit: { v: 2, scheme: 'all', title: 'Встреча в 14:00', unit: 'мин',
      limit: { on: true, value: 5 }, cause: { on: false, name: 'Дождь', pct: 30 }, items: [
        item('Иван, едет на автобусе', 'history', { history: [0, 0, 5, 0, 10, 0, 5, 20, 0, 5] }),
        item('Мария, задерживается после обеда', 'maybe', { pct: 10, from: 10, to: 10 }),
        item('Переговорка: прошлое совещание затянулось', 'maybe', { pct: 25, from: 5, to: 15 })] } },
    { id: 'trip', label: '🧳 Хватит ли денег на поездку', sit: { v: 2, scheme: 'parts', title: 'Поездка на море', unit: '₽',
      limit: { on: true, value: 70000 }, cause: { on: false, name: 'Сезон', pct: 30 }, items: [
        item('Билеты', 'exact', { exact: 18000 }),
        item('Жильё', 'approx', { usual: 20000, min: 16000, max: 26000 }),
        item('Еда', 'approx', { usual: 12000, min: 9000, max: 18000 }),
        item('Экскурсии и развлечения', 'approx', { usual: 8000, min: 4000, max: 15000 }),
        item('Непредвиденное', 'maybe', { pct: 30, from: 3000, to: 10000 })] } },
    { id: 'bench', label: '🏋️ Пожму ли 100 кг', sit: { v: 2, scheme: 'goal', title: 'Жим лёжа 100 кг', unit: 'кг',
      limit: { on: false, value: 0 }, cause: { on: false, name: '', pct: 0 }, goal: { start: 80, target: 100, period: 'неделя',
        step: { know: 'approx', v: V({ usual: 0.5, min: 0, max: 1.5 }) },
        setback: { on: true, pct: 20, from: 0, to: 1 }, deadline: { on: true, value: 52 } } } },
    { id: 'weight', label: '⚖️ Похудеть до 80 кг', sit: { v: 2, scheme: 'goal', title: 'Похудеть до 80 кг', unit: 'кг',
      limit: { on: false, value: 0 }, cause: { on: false, name: '', pct: 0 }, goal: { start: 92, target: 80, period: 'неделя',
        step: { know: 'approx', v: V({ usual: 0.6, min: 0.2, max: 1.2 }) },
        setback: { on: true, pct: 20, from: 0.3, to: 1.5 }, deadline: { on: true, value: 40 } } } },
    { id: 'savings', label: '💰 Накопить на отпуск', sit: { v: 2, scheme: 'goal', title: 'Накопить 150 000 ₽', unit: '₽',
      limit: { on: false, value: 0 }, cause: { on: false, name: '', pct: 0 }, goal: { start: 20000, target: 150000, period: 'месяц',
        step: { know: 'approx', v: V({ usual: 15000, min: 8000, max: 20000 }) },
        setback: { on: true, pct: 15, from: 0, to: 15000 }, deadline: { on: true, value: 12 } } } },
    { id: 'offer', label: '💼 Оффер после собеседований', sit: { v: 2, scheme: 'tries', title: 'Оффер после собеседований', unit: '',
      limit: { on: false, value: 0 }, cause: { on: false, name: '', pct: 0 }, tries: { what: 'собеседование', n: 8, pct: 15, need: 1 } } },
  ];

  // ===================================================================================
  // Состояние: текущий расчёт и «Мои расчёты»
  // ===================================================================================
  let calc = null;            // { id, variants: [sit, sit?], active }
  let token = 0, timer = null, last = null;
  const open = new Set();     // какие карточки развёрнуты (ключ — «вариант.номер»)
  const sit = () => calc.variants[calc.active];

  const myList = () => tryStore(() => JSON.parse(localStorage.getItem(KEY_MY)) || [], []);
  function saveMy() {
    if (!calc || !sit().scheme) return;
    const list = myList().filter(x => x.id !== calc.id);
    list.unshift({ id: calc.id, saved: new Date().toISOString(), calc });
    tryStore(() => localStorage.setItem(KEY_MY, JSON.stringify(list.slice(0, 30))));
    tryStore(() => localStorage.setItem(KEY_CUR, JSON.stringify(calc)));
    renderMyCount();
  }

  // ===================================================================================
  // Проверка ответов — человеческим языком
  // ===================================================================================
  const bad = x => !Number.isFinite(x);
  function checkValue(know, v) {
    if (know === 'exact') return bad(v.exact) ? 'впишите число' : '';
    if (know === 'approx') {
      if ([v.usual, v.min, v.max].some(bad)) return 'заполните «обычно», «от» и «до»';
      if (!(v.min <= v.usual && v.usual <= v.max)) return '«обычно» должно быть между «от» и «до»';
      return '';
    }
    if (know === 'maybe') {
      if ([v.pct, v.from, v.to].some(bad)) return 'заполните, как часто и на сколько';
      if (v.pct < 0 || v.pct > 100) return 'как часто — от 0 до 100 %';
      if (v.from > v.to) return '«от» больше, чем «до»';
      return '';
    }
    if (!v.history.length) return 'впишите хотя бы одно прошлое значение';
    if (v.history.some(bad)) return 'в прошлых значениях есть не число';
    return '';
  }

  function check(s) {
    const items = {}, global = [];
    if (s.scheme === 'parts' || s.scheme === 'all') {
      if (!s.items.length) global.push('Добавьте хотя бы одну часть.');
      s.items.forEach((it, k) => {
        const nm = it.name || `Пункт ${k + 1}`;
        const m1 = checkValue(it.know, it.v);
        const m2 = s.cause.on && it.byCause && it.vc ? checkValue(it.know, it.vc) : '';
        if (m1) items[k] = `«${nm}»: ${m1}.`;
        else if (m2) items[k] = `«${nm}», когда «${s.cause.name}»: ${m2}.`;
      });
      if (s.limit.on && bad(s.limit.value)) global.push('Впишите число в вопросе внизу (или снимите галочку).');
      if (s.cause.on && !(s.cause.pct >= 0 && s.cause.pct <= 100)) global.push('Общая причина: как часто — от 0 до 100 %.');
    } else if (s.scheme === 'goal') {
      const g = s.goal;
      if (bad(g.start) || bad(g.target)) global.push('Впишите, где вы сейчас и какая цель.');
      const m = checkValue(g.step.know, g.step.v);
      if (m) items.step = `Темп: ${m}.`;
      if (g.setback.on) {
        if ([g.setback.pct, g.setback.from, g.setback.to].some(bad)) items.setback = 'Плохие периоды: заполните, как часто и насколько.';
        else if (g.setback.from > g.setback.to) items.setback = 'Плохие периоды: «от» больше, чем «до».';
      }
      if (g.deadline.on && !(g.deadline.value >= 1)) global.push('Срок — целое число периодов, хотя бы 1.');
    } else if (s.scheme === 'tries') {
      const t = s.tries;
      if (!(Number.isInteger(t.n) && t.n >= 1 && t.n <= 1000)) global.push('Число попыток — целое, от 1 до 1000.');
      if (!(t.pct >= 0 && t.pct <= 100)) global.push('Шанс одной попытки — от 0 до 100 %.');
      if (!(Number.isInteger(t.need) && t.need >= 1)) global.push('Сколько нужно удачных — целое число, хотя бы 1.');
      else if (Number.isInteger(t.n) && t.need > t.n) global.push(`Нужно ${t.need} удачных, а попыток всего ${t.n} — так не бывает.`);
    }
    return { items, global, ok: !global.length && !Object.keys(items).length };
  }

  // ===================================================================================
  // Ответы -> сценарий движка
  // ===================================================================================
  /** «Что вы знаете» -> распределение движка. */
  function distOf(know, v) {
    if (know === 'exact') return { type: 'uniform', min: v.exact, max: v.exact };
    if (know === 'approx') return v.min === v.max ? { type: 'uniform', min: v.min, max: v.max } : { type: 'triangular', min: v.min, mode: v.usual, max: v.max };
    if (know === 'maybe') return { type: 'mixture', parts: [
      { p: 100 - v.pct, dist: { type: 'uniform', min: 0, max: 0 } },
      { p: v.pct, dist: { type: 'uniform', min: v.from, max: v.to } }] };
    return { type: 'data', values: v.history.slice() };
  }

  /** Средний шаг к цели (для проверки здравого смысла). */
  function meanStep(g) {
    const d = MC.prepareDist(distOf(g.step.know, g.step.v), 'шаг');
    const q = g.setback.on ? g.setback.pct / 100 : 0;
    return (1 - q) * d.mean - q * (g.setback.from + g.setback.to) / 2;
  }

  function toScenario(s) {
    const taken = new Set(['итог', 'успех']);
    const id = (raw, fb) => CSV.safeName(raw || fb, taken);
    if (s.scheme === 'goal') {
      const g = s.goal, up = g.target >= g.start, sign = up ? 1 : -1;
      const toward = distOf(g.step.know, g.step.v);
      const signed = d => (sign === 1 ? d : negate(d));
      const parts = [{ p: g.setback.on ? 100 - g.setback.pct : 100, dist: signed(toward) }];
      if (g.setback.on && g.setback.pct > 0) parts.push({ p: g.setback.pct, dist: signed({ type: 'uniform', min: -g.setback.to, max: -g.setback.from }) });
      const P = PERIODS[g.period];
      return { name: s.title || 'Моя цель', description: `Собрано в простом режиме: ${SCHEMES.goal.title.toLowerCase()}.`,
        factors: [{ name: 'Периоды', label: `Сколько ${P.forms[2]} до цели`, dist: { type: 'walk', start: g.start, goal: g.target,
          maxSteps: P.max, step: { type: 'mixture', parts } } }],
        derived: [], result: { name: 'Итог', label: `Сколько ${P.forms[2]} до цели`, unit: P.forms[2], formula: 'Периоды' },
        event: g.deadline.on ? { name: 'Успех', label: `Дошли за ${g.deadline.value} ${plural(g.deadline.value, P.forms)}`,
          formula: `Итог <= ${g.deadline.value}` } : null };
    }
    if (s.scheme === 'tries') {
      const t = s.tries;
      return { name: s.title || 'Попытки', description: 'Собрано в простом режиме: несколько попыток.',
        factors: [{ name: 'Удачные', label: `Сколько удачных из ${t.n}`, dist: { type: 'repeat', times: t.n, dist: { type: 'yesno', p: t.pct / 100 } } }],
        derived: [], result: { name: 'Итог', label: 'Сколько удачных', unit: 'шт.', formula: 'Удачные' },
        event: { name: 'Успех', label: `Хотя бы ${t.need} удачных`, formula: `Итог >= ${t.need}` } };
    }
    const factors = [], parts = [];
    let causeId = null;
    if (s.cause.on) {
      causeId = id(s.cause.name, 'Причина');
      factors.push({ name: causeId, label: `${s.cause.name || 'Общая причина'}?`, dist: { type: 'yesno', p: s.cause.pct / 100 } });
    }
    s.items.forEach((it, k) => {
      const name = id(it.name, `Пункт_${k + 1}`);
      const dist = causeId && it.byCause && it.vc
        ? { type: 'conditional', on: causeId, cases: [{ value: 1, dist: distOf(it.know, it.vc) }, { value: 0, dist: distOf(it.know, it.v) }] }
        : distOf(it.know, it.v);
      factors.push({ name, label: `${it.name || `Пункт ${k + 1}`}, ${s.unit}`, dist });
      parts.push(name);
    });
    return { name: s.title || 'Моя ситуация', description: `Собрано в простом режиме: ${SCHEMES[s.scheme].title.toLowerCase()}.`,
      factors, derived: [],
      result: { name: 'Итог', label: s.scheme === 'all' ? 'Когда готово всё' : 'Сколько всего', unit: s.unit,
        formula: s.scheme === 'all' ? `max(${parts.join('; ')})` : parts.join(' + ') },
      event: s.limit.on ? { name: 'Успех', label: `Не больше ${fmtVal(s.limit.value, s.unit)}`, formula: `Итог <= ${s.limit.value}` } : null };
  }

  /** Распределение с противоположным знаком (для «иду к цели вниз»: похудение). */
  function negate(d) {
    if (d.type === 'uniform') return { type: 'uniform', min: -d.max, max: -d.min };
    if (d.type === 'triangular') return { type: 'triangular', min: -d.max, mode: -d.mode, max: -d.min };
    if (d.type === 'data') return { type: 'data', values: d.values.map(x => -x) };
    if (d.type === 'mixture') return { type: 'mixture', parts: d.parts.map(p => ({ p: p.p, dist: negate(p.dist) })) };
    throw new Error('negate: ' + d.type);
  }

  // ===================================================================================
  // Редактор
  // ===================================================================================
  const UK = () => sit().unit;

  const tenText = v => `${num(Math.round((Number.isFinite(v) ? v : 0) / 5) / 2)} из 10`;
  /** Кружочки «N из 10» + точное поле в процентах. */
  function chanceCtl(P, value) {
    const k = Math.round((Number.isFinite(value) ? value : 0) / 10);
    return `<span class="ten" role="group" aria-label="Как часто, из 10">${Array.from({ length: 10 }, (_, i) =>
      `<button type="button" data-s-act="ten" data-p="${P}" data-n="${i + 1}" class="${i < k ? 'on' : ''}" aria-label="${i + 1} из 10"></button>`).join('')}</span>
      <span class="ten-txt"><b>${tenText(value)}</b> · точнее <input class="pct-in" inputmode="decimal" data-s="${P}" data-num value="${fmtIn(value)}" aria-label="Процент"> %</span>`;
  }

  function valueEditor(know, v, P, unit, opt = {}) {
    const u = esc(unit);
    const f = (key, label) => `<label class="field">${label}<input inputmode="decimal" data-s="${P}.${key}" data-num value="${fmtIn(v[key])}"></label>`;
    if (know === 'exact') return `<div class="fields">${f('exact', `ровно, ${u}`)}</div>`;
    if (know === 'approx') return `<div class="fields">${f('usual', `обычно, ${u}`)}${f('min', 'от')}${f('max', 'до')}</div>
      <p class="hint">${opt.approxHint || 'Чаще всего выходит около «обычно», реже — ближе к краям.'}</p>`;
    if (know === 'maybe') return `<div class="maybe"><span>Бывает</span> ${chanceCtl(`${P}.pct`, v.pct)}</div>
      <div class="sentence">и тогда ${opt.maybeVerb || 'добавляет'} от <input inputmode="decimal" data-s="${P}.from" data-num value="${fmtIn(v.from)}" aria-label="От">
      до <input inputmode="decimal" data-s="${P}.to" data-num value="${fmtIn(v.to)}" aria-label="До"> ${u}</div>`;
    const n = v.history.filter(Number.isFinite).length;
    return `<textarea rows="2" class="mono" data-s="${P}.history" data-list placeholder="Например: 35 42 38 60 41" aria-label="Прошлые значения">${esc(v.history.map(fmtIn).join(' '))}</textarea>
      <p class="hint" data-hist="${P}">${n} знач. Впишите через пробел, как было в прошлые разы.${n && n < 5 ? ' <b>Данных мало — ответ будет примерный.</b>' : ''}</p>`;
  }

  function knowSeg(P, know, allowed = KNOW.map(x => x[0])) {
    return `<div class="seg" role="radiogroup" aria-label="Что вы о нём знаете?">${KNOW.filter(([k]) => allowed.includes(k)).map(([k, l]) =>
      `<button type="button" role="radio" aria-checked="${know === k}" data-s-act="know" data-p="${P}" data-know="${k}">${l}</button>`).join('')}</div>`;
  }

  function summaryOf(know, v, unit) {
    if (checkValue(know, v)) return '<span class="bad">нужно заполнить</span>';
    if (know === 'exact') return `ровно ${fmtVal(v.exact, unit)}`;
    if (know === 'approx') return `обычно ${fmtVal(v.usual, unit)} (от ${fmtVal(v.min, unit)} до ${fmtVal(v.max, unit)})`;
    if (know === 'maybe') return `бывает ${tenText(v.pct)}, тогда ${v.from === v.to ? fmtVal(v.from, unit) : `${fmtVal(v.from, unit)}–${fmtVal(v.to, unit)}`}`;
    const h = v.history;
    return `как раньше: ${h.length} знач., обычно ${fmtVal(median(h), unit)}`;
  }

  function itemCard(it, k) {
    const s = sit(), key = `${calc.active}.${k}`, isOpen = open.has(key), P = `items.${k}`;
    const head = `<div class="row">
        <input class="s-name" data-s="${P}.name" value="${esc(it.name)}" placeholder="${esc(SCHEMES[s.scheme].ph)}" aria-label="Название">
        <button class="icon" data-s-act="del" data-k="${k}" title="Убрать" aria-label="Убрать"${s.items.length < 2 ? ' disabled' : ''}>✕</button>
      </div>`;
    if (!isOpen) {
      return `<div class="item s-item closed" data-k="${k}">${head}
        <button type="button" class="s-sum" data-s-act="open" data-k="${k}"><span>${summaryOf(it.know, it.v, s.unit)}${
          s.cause.on && it.byCause ? ` · когда «${esc(s.cause.name)}» — по-другому` : ''}</span><span class="edit">изменить</span></button>
        <div class="s-err" data-err="${k}"></div></div>`;
    }
    return `<div class="item s-item" data-k="${k}">${head}
      <div class="know-q">Что вы об этом знаете?</div>
      ${knowSeg(P, it.know)}
      ${valueEditor(it.know, it.v, `${P}.v`, s.unit)}
      ${s.cause.on ? `<label class="check"><input type="checkbox" data-s="${P}.byCause"${it.byCause ? ' checked' : ''}>
          Когда «${esc(s.cause.name)}» — по-другому</label>
        ${it.byCause && it.vc ? `<div class="alt"><div class="alt-head">Когда «${esc(s.cause.name)}»:</div>
          ${valueEditor(it.know, it.vc, `${P}.vc`, s.unit)}</div>` : ''}` : ''}
      <div class="s-err" data-err="${k}"></div>
      <button class="btn small done" data-s-act="close" data-k="${k}">Готово</button>
    </div>`;
  }

  function unitSelect(path, unit) {
    const list = UNITS.includes(unit) || !unit ? UNITS : [...UNITS, unit];
    return `<select data-s="${path}" aria-label="Единица">${list.map(u => `<option${u === unit ? ' selected' : ''}>${esc(u)}</option>`).join('')}
      <option value="__other">другое…</option></select>`;
  }

  function limitText(s) {
    const k = unitKind(s.unit);
    if (s.scheme === 'all') return 'Всё должно быть готово не позже чем через';
    return k === 'time' ? 'Успею ли за' : k === 'money' ? 'Хватит ли' : 'Уложусь ли в';
  }

  function formParts(s) {
    const S = SCHEMES[s.scheme];
    return `
      <div class="card s-step">
        <h2><span class="step-num">1</span><span>${S.itemsQ}</span></h2>
        <div class="row2">
          <label class="field grow">Как назовём<input data-s="title" value="${esc(s.title)}"></label>
          <label class="field">В чём считаем${unitSelect('unit', s.unit)}</label>
        </div>
        <div class="items">${s.items.map(itemCard).join('')}</div>
        <button class="btn add" data-s-act="add">${S.add}</button>
      </div>
      <div class="card s-step">
        <h2><span class="step-num">2</span><span>Что вы хотите узнать?</span></h2>
        <label class="goal"><input type="checkbox" data-s="limit.on"${s.limit.on ? ' checked' : ''}> ${limitText(s)}
          <input inputmode="decimal" data-s="limit.value" data-num value="${fmtIn(s.limit.value)}" aria-label="Порог"${s.limit.on ? '' : ' disabled'}> ${esc(s.unit)}?</label>
        <p class="hint">${s.limit.on ? 'Посчитаю шанс и сколько нужно заложить с запасом.' : 'Без галочки просто посчитаю, сколько скорее всего выйдет и какой нужен запас.'}</p>
      </div>
      <div class="card s-step">
        <h2><span class="step-num">3</span><span>Есть общая причина? <small>необязательно</small></span></h2>
        <label class="check"><input type="checkbox" data-s="cause.on"${s.cause.on ? ' checked' : ''}>
          Иногда бывает что-то, из-за чего хуже становится сразу нескольким частям (например, дождь)</label>
        ${s.cause.on ? `<div class="row2"><label class="field grow">Что это<input data-s="cause.name" value="${esc(s.cause.name)}"></label></div>
          <div class="maybe"><span>Бывает</span> ${chanceCtl('cause.pct', s.cause.pct)}</div>
          <p class="hint">Теперь у каждой части можно отметить «Когда «${esc(s.cause.name)}» — по-другому».</p>` : ''}
      </div>`;
  }

  function formGoal(s) {
    const g = s.goal, P = PERIODS[g.period], up = g.target >= g.start, u = esc(s.unit);
    return `
      <div class="card s-step">
        <h2><span class="step-num">1</span><span>Где вы сейчас и какая цель?</span></h2>
        <div class="row2"><label class="field grow">Как назовём<input data-s="title" value="${esc(s.title)}"></label>
          <label class="field">В чём меряем${unitSelect('unit', s.unit)}</label></div>
        <div class="fields">
          <label class="field">сейчас, ${u}<input inputmode="decimal" data-s="goal.start" data-num value="${fmtIn(g.start)}"></label>
          <label class="field">цель, ${u}<input inputmode="decimal" data-s="goal.target" data-num value="${fmtIn(g.target)}"></label>
          <label class="field">считаем по<select data-s="goal.period">${Object.entries(PERIODS).map(([k, v]) =>
            `<option value="${k}"${k === g.period ? ' selected' : ''}>${v.many}</option>`).join('')}</select></label>
        </div>
      </div>
      <div class="card s-step">
        <h2><span class="step-num">2</span><span>Сколько за ${P.acc} ${up ? 'прибавляете' : 'сбрасываете'}?</span></h2>
        <p class="sub">Сколько обычно — в нормальный период, без пропусков и срывов. Плохие периоды — в следующем шаге.</p>
        ${knowSeg('goal.step', g.step.know, ['exact', 'approx', 'history'])}
        ${valueEditor(g.step.know, g.step.v, 'goal.step.v', s.unit, { approxHint: 'Чаще всего выходит около «обычно».' })}
        <div class="s-err" data-err="step"></div>
      </div>
      <div class="card s-step">
        <h2><span class="step-num">3</span><span>Бывают плохие ${P.many}? <small>пропуски, болезнь, срывы</small></span></h2>
        <label class="check"><input type="checkbox" data-s="goal.setback.on"${g.setback.on ? ' checked' : ''}> Да, иногда откатываюсь назад</label>
        ${g.setback.on ? `<div class="maybe"><span>Бывает</span> ${chanceCtl('goal.setback.pct', g.setback.pct)}</div>
          <div class="sentence">и тогда назад на от <input inputmode="decimal" data-s="goal.setback.from" data-num value="${fmtIn(g.setback.from)}" aria-label="От">
          до <input inputmode="decimal" data-s="goal.setback.to" data-num value="${fmtIn(g.setback.to)}" aria-label="До"> ${u}</div>` : ''}
        <div class="s-err" data-err="setback"></div>
      </div>
      <div class="card s-step">
        <h2><span class="step-num">4</span><span>Есть срок? <small>необязательно</small></span></h2>
        <label class="goal"><input type="checkbox" data-s="goal.deadline.on"${g.deadline.on ? ' checked' : ''}> Хочу успеть за
          <input inputmode="numeric" data-s="goal.deadline.value" data-num value="${fmtIn(g.deadline.value)}" aria-label="Срок"${g.deadline.on ? '' : ' disabled'}>
          ${plural(g.deadline.value, P.forms)}</label>
      </div>`;
  }

  function formTries(s) {
    const t = s.tries;
    return `
      <div class="card s-step">
        <h2><span class="step-num">1</span><span>Что за попытки?</span></h2>
        <div class="row2"><label class="field grow">Как назовём<input data-s="title" value="${esc(s.title)}"></label></div>
        <div class="row2">
          <label class="field">сколько попыток<input inputmode="numeric" data-s="tries.n" data-num value="${fmtIn(t.n)}"></label>
          <label class="field grow">попытка — это<input data-s="tries.what" value="${esc(t.what)}" placeholder="собеседование, подход, бросок"></label>
        </div>
      </div>
      <div class="card s-step">
        <h2><span class="step-num">2</span><span>Как часто одна попытка удаётся?</span></h2>
        <div class="maybe"><span>Удаётся</span> ${chanceCtl('tries.pct', t.pct)}</div>
        <p class="hint">Если не знаете: сколько раз из 10 обычно получается у вас или у похожих людей.</p>
      </div>
      <div class="card s-step">
        <h2><span class="step-num">3</span><span>Сколько нужно удачных?</span></h2>
        <label class="goal">Хотя бы <input inputmode="numeric" data-s="tries.need" data-num value="${fmtIn(t.need)}" aria-label="Сколько нужно"> из ${fmtIn(t.n)}</label>
      </div>`;
  }

  function renderPicker() {
    $('#s-editor').innerHTML = `
      <div class="card s-step">
        <h2><span>Какая у вас ситуация?</span></h2>
        <p class="sub">Выберите, на что она похожа, — дальше впишете свои цифры.</p>
        <div class="schemes">${Object.entries(SCHEMES).map(([k, v]) => `<button class="scheme" data-s-act="scheme" data-scheme="${k}">
          <span class="sc-icon" aria-hidden="true">${v.icon}</span><b>${v.title}</b><small>${v.sub}</small><em>${v.ex}</em></button>`).join('')}</div>
      </div>
      <div class="card"><h3>Или посмотрите пример</h3>
        <div class="chips">${EXAMPLES.map(x => `<button class="chip" data-s-act="example" data-id="${x.id}">${esc(x.label)}</button>`).join('')}</div>
      </div>`;
    $('#s-results').innerHTML = `<section class="card s-empty"><h3>Здесь будет ответ</h3>
      <p class="sub">Выберите слева, на что похожа ваша ситуация. Ответ появится сразу и будет обновляться, пока вы меняете цифры.</p></section>`;
    $('#s-sticky').hidden = true;
  }

  function renderVariants() {
    const v = calc.variants;
    if (!sit().scheme && v.length === 1) { $('#s-variants').innerHTML = ''; return; }
    $('#s-variants').innerHTML = v.length === 1
      ? `<button class="btn small" data-s-act="compare" title="Скопировать ситуацию и поменять что-нибудь">⇄ Сравнить с другим вариантом</button>`
      : `<div class="tabs" role="tablist">${v.map((x, i) => `<button role="tab" aria-selected="${i === calc.active}" data-s-act="tab" data-i="${i}">
          Вариант ${i ? 'Б' : 'А'}${x.title ? `: ${esc(x.title)}` : ''}</button>`).join('')}
          <button class="icon" data-s-act="drop-b" title="Убрать вариант Б" aria-label="Убрать вариант Б">✕</button></div>`;
  }

  function render() {
    const s = sit();
    renderVariants();
    if (!s.scheme) { renderPicker(); return; }
    const head = `<div class="s-scheme"><span>${SCHEMES[s.scheme].icon} ${SCHEMES[s.scheme].title}</span>
      <button class="link" data-s-act="change-scheme">сменить</button></div>`;
    $('#s-editor').innerHTML = head + (s.scheme === 'goal' ? formGoal(s) : s.scheme === 'tries' ? formTries(s) : formParts(s));
    showErrors(check(s));
  }

  function showErrors(chk) {
    $$('[data-err]').forEach(el => { el.textContent = chk.items[el.dataset.err] || ''; });
  }

  // ===================================================================================
  // События
  // ===================================================================================
  function bind() {
    const ed = $('#s-editor');
    const onValue = (e, final) => {
      const el = e.target, p = el.dataset.s;
      if (!p) return;
      let v;
      if (el.type === 'checkbox') v = el.checked;
      else if (el.hasAttribute('data-num')) v = parseNum(el.value);
      else if (el.hasAttribute('data-list')) v = parseList(el.value);
      else v = el.value;
      if (el.tagName === 'SELECT' && v === '__other') {
        const u = prompt('Как подписать единицу? Например: стр., раз, л');
        v = u && u.trim() ? u.trim().slice(0, 12) : getPath(sit(), p);
      }
      if (/\.(n|need|value)$/.test(p) && el.hasAttribute('data-num') && Number.isFinite(v) && /tries|deadline/.test(p)) v = Math.round(v);
      setPath(sit(), p, v);
      if (/\.byCause$/.test(p) && v) {
        const it = getPath(sit(), p.replace(/\.byCause$/, ''));
        if (!it.vc) it.vc = clone(it.v);
      }
      const structural = el.type === 'checkbox' || el.tagName === 'SELECT' || (final && p === 'cause.name');
      if (structural) render();
      else {
        const h = el.hasAttribute('data-list') && $(`[data-hist="${p.replace(/\.history$/, '')}"]`);
        if (h) { const n = v.filter(Number.isFinite).length; h.innerHTML = `${n} знач. Впишите через пробел, как было в прошлые разы.${n && n < 5 ? ' <b>Данных мало — ответ будет примерный.</b>' : ''}`; }
        if (/pct$/.test(p)) syncTen(p, v);
        showErrors(check(sit()));
      }
      if (p === 'title') renderVariants();
      changed();
    };
    ed.addEventListener('input', e => { if (e.target.type !== 'checkbox' && e.target.tagName !== 'SELECT') onValue(e, false); });
    ed.addEventListener('change', e => {
      const el = e.target;
      if (el.type === 'checkbox' || el.tagName === 'SELECT' || el.dataset.s === 'cause.name') onValue(e, true);
      else if (el.hasAttribute('data-num')) { const v = getPath(sit(), el.dataset.s); if (Number.isFinite(v)) el.value = fmtIn(v); }
    });
    document.addEventListener('click', e => {
      const b = e.target.closest('[data-s-act]');
      if (!b || !b.closest('#simple-view')) return;
      act(b.dataset.sAct, b);
    });
    $('#s-new').addEventListener('click', () => { newCalc(); });
    $('#s-my').addEventListener('click', toggleMy);
    $('#s-share').addEventListener('click', share);
    $('#s-sticky').addEventListener('click', () => $('#s-results').scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }

  function syncTen(p, v) {
    const k = Math.round((Number.isFinite(v) ? v : 0) / 10);
    $$(`[data-s-act="ten"][data-p="${p}"]`).forEach(b => b.classList.toggle('on', +b.dataset.n <= k));
    const box = $(`[data-s-act="ten"][data-p="${p}"]`);
    if (box) box.closest('.maybe').querySelector('.ten-txt b').textContent = tenText(v);
  }

  function act(a, b) {
    const s = sit(), k = +b.dataset.k;
    if (a === 'scheme') { calc.variants[calc.active] = blank(b.dataset.scheme); open.clear(); open.add(`${calc.active}.0`); }
    else if (a === 'example') {
      // пример не попадает в «Мои расчёты», пока человек его не поменяет
      const x = EXAMPLES.find(e => e.id === b.dataset.id);
      calc = calcOf(clone(x.sit)); open.clear(); last = null;
      render();
      tryStore(() => localStorage.setItem(KEY_CUR, JSON.stringify(calc)));
      run();
      return;
    }
    else if (a === 'change-scheme') { if (!confirm('Сменить тип ситуации? Введённые цифры пропадут.')) return; calc.variants[calc.active] = { scheme: null }; }
    else if (a === 'add') {
      const unit = s.unit;
      s.items.push(item('', 'approx', unitKind(unit) === 'money' ? { usual: 1000, min: 500, max: 2000 } : { usual: 10, min: 5, max: 20 }));
      open.add(`${calc.active}.${s.items.length - 1}`);
      render(); changed();
      const names = $$('.s-name'); names[names.length - 1].focus();
      return;
    } else if (a === 'del') { s.items.splice(k, 1); open.clear(); }
    else if (a === 'open') open.add(`${calc.active}.${k}`);
    else if (a === 'close') { if (check(s).items[k]) return; open.delete(`${calc.active}.${k}`); render(); return; }
    else if (a === 'know') {
      const obj = getPath(s, b.dataset.p);
      obj.know = b.dataset.know;
    } else if (a === 'ten') {
      setPath(s, b.dataset.p, +b.dataset.n * 10);
      syncTen(b.dataset.p, +b.dataset.n * 10);
      const inp = $(`input[data-s="${b.dataset.p}"]`);
      if (inp) inp.value = fmtIn(+b.dataset.n * 10);
      showErrors(check(s));
      changed();
      return;
    } else if (a === 'compare') {
      const copy = clone(s);
      copy.title = (s.title ? s.title + ' — ' : '') + 'другой вариант';
      calc.variants.push(copy); calc.active = 1; open.clear();
    } else if (a === 'tab') { calc.active = +b.dataset.i; open.clear(); }
    else if (a === 'drop-b') { calc.variants = [calc.variants[0]]; calc.active = 0; open.clear(); }
    else if (a === 'my-open') { const x = myList().find(m => m.id === b.dataset.id); if (x) { calc = x.calc; open.clear(); } toggleMy(false); }
    else if (a === 'my-del') { tryStore(() => localStorage.setItem(KEY_MY, JSON.stringify(myList().filter(m => m.id !== b.dataset.id)))); renderMy(); renderMyCount(); return; }
    else return;
    render();
    changed();
  }

  function newCalc() {
    calc = calcOf({ scheme: null });
    open.clear();
    last = null;
    render();
    tryStore(() => localStorage.setItem(KEY_CUR, JSON.stringify(calc)));
  }

  // ---------------------------------------------------------------- «Мои расчёты» и ссылка
  function renderMyCount() { const n = myList().length; $('#s-my').textContent = `Мои расчёты${n ? ` (${n})` : ''}`; }
  function toggleMy(force) {
    const box = $('#s-my-list');
    const show = typeof force === 'boolean' ? force : box.hidden;
    box.hidden = !show;
    if (show) renderMy();
  }
  function renderMy() {
    const list = myList();
    $('#s-my-list').innerHTML = list.length ? `<ul>${list.map(x => {
      const v = x.calc.variants[0];
      return `<li><button class="link" data-s-act="my-open" data-id="${x.id}">${esc(v.title || 'Без названия')}${x.calc.variants.length > 1 ? ' · 2 варианта' : ''}</button>
        <span class="muted">${SCHEMES[v.scheme] ? SCHEMES[v.scheme].title.toLowerCase() : ''} · ${new Date(x.saved).toLocaleDateString('ru-RU')}</span>
        <button class="icon" data-s-act="my-del" data-id="${x.id}" title="Удалить" aria-label="Удалить">✕</button></li>`;
    }).join('')}</ul>` : '<p class="sub">Пока пусто. Расчёты сохраняются здесь сами, как только вы начнёте вписывать цифры.</p>';
  }
  const b64 = s => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unb64 = s => decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))));
  function shareLink() { return `${location.href.split('#')[0]}#s=${b64(JSON.stringify({ variants: calc.variants, active: calc.active }))}`; }
  async function share() {
    if (!sit().scheme) return;
    const url = shareLink(), btn = $('#s-share');
    const ok = await tryStore(async () => { await navigator.clipboard.writeText(url); return true; }, false).catch(() => false);
    if (ok) { btn.textContent = '✓ Ссылка скопирована'; setTimeout(() => { btn.textContent = '🔗 Поделиться'; }, 2500); }
    else prompt('Скопируйте ссылку:', url);
  }

  function changed() {
    saveMy();
    clearTimeout(timer);
    timer = setTimeout(run, 400);
  }

  // ===================================================================================
  // Расчёт
  // ===================================================================================
  const frame = () => new Promise(r => setTimeout(r, 0));
  async function runP(sc, n, my) {
    const m = MC.compile(sc);
    const r = MC.createRun(m, { n, seed: SEED });
    while (!r.step(20000)) { await frame(); if (my !== token) throw new Error('cancel'); }
    return { model: m, run: r, summary: MC.summarize(r) };
  }

  /** Биномиальное: P(хотя бы need удач из n при шансе p) — точно, без Монте-Карло. */
  function binomAtLeast(n, p, need) {
    let total = 0, c = 1;
    for (let k = 0; k <= n; k++) {
      if (k > 0) c = c * (n - k + 1) / k;
      if (k >= need) total += c * Math.pow(p, k) * Math.pow(1 - p, n - k);
    }
    return Math.min(1, total);
  }
  function triesFor(p, need, target) {
    if (p <= 0) return Infinity;
    for (let n = need; n <= 2000; n++) if (binomAtLeast(n, p, need) >= target) return n;
    return Infinity;
  }

  /** Главный показатель ситуации — для «что поможет» и сравнения вариантов. */
  function metric(s, S) {
    if (S.event) return { kind: 'p', value: S.event.p };
    return { kind: s.scheme === 'goal' ? 'median' : 'p90', value: s.scheme === 'goal' ? S.result.pct[50] : S.result.pct[90] };
  }

  /** «Что поможет»: по очереди улучшаем одну вещь и пересчитываем. */
  function ideasFor(s) {
    const out = [];
    if (s.scheme === 'parts' || s.scheme === 'all') {
      s.items.forEach((it, k) => {
        if (it.know === 'exact') return;
        const t = clone(s), x = t.items[k], nm = it.name || `Пункт ${k + 1}`;
        const fix = v => {
          if (it.know === 'approx') { v.min = v.max = v.usual; return `всегда как обычно — ${fmtVal(v.usual, s.unit)}`; }
          if (it.know === 'maybe') { v.pct = 0; return 'такого не случается'; }
          const m = median(v.history); v.history = [m]; return `всегда как обычно — ${fmtVal(m, s.unit)}`;
        };
        const what = fix(x.v);
        if (x.byCause && x.vc) fix(x.vc);
        out.push({ name: nm, what, s: t });
      });
      if (s.cause.on) { const t = clone(s); t.cause.pct = 0; out.push({ name: s.cause.name, what: 'этого не бывает', s: t }); }
    } else if (s.scheme === 'goal') {
      const g = s.goal, P = PERIODS[g.period];
      if (g.setback.on && g.setback.pct > 0) { const t = clone(s); t.goal.setback.pct = 0; out.push({ name: `Без плохих ${P.forms[2]}`, what: 'ни пропусков, ни откатов', s: t }); }
      const t = clone(s), v = t.goal.step.v;
      if (g.step.know === 'exact') v.exact *= 1.2;
      else if (g.step.know === 'approx') { v.usual *= 1.2; v.min *= 1.2; v.max *= 1.2; }
      else v.history = v.history.map(x => x * 1.2);
      out.push({ name: 'Темп на 20 % быстрее', what: `за ${P.acc} на пятую часть больше`, s: t });
    }
    return out;
  }

  async function run() {
    if (!calc || !sit().scheme) return;
    const my = ++token, box = $('#s-results'), s = sit();
    const chk = check(s);
    showErrors(chk);
    if (!chk.ok) {
      box.innerHTML = `<section class="card s-fix"><h3>Чтобы посчитать, поправьте:</h3><ul class="plain">${
        [...chk.global, ...Object.values(chk.items)].map(m => `<li>${esc(m)}</li>`).join('')}</ul></section>`;
      sticky('<span class="st-main"><b>Нужно поправить ответы</b></span><span class="st-go">↓</span>', 'bad');
      return;
    }
    // здравый смысл до расчёта: к цели вообще движемся?
    if (s.scheme === 'goal' && s.goal.start !== s.goal.target && meanStep(s.goal) <= 0) {
      box.innerHTML = `<section class="card s-fix"><h3>С такими цифрами цель не приближается</h3>
        <p>В среднем за ${PERIODS[s.goal.period].acc} вы ${meanStep(s.goal) < 0 ? 'откатываетесь назад' : 'стоите на месте'}: плохие периоды съедают весь прогресс.
        Проверьте темп и откаты — или посмотрите, что будет, если откатов станет меньше.</p></section>`;
      sticky('<span class="st-main"><b>Цель не приближается</b></span><span class="st-go">↓</span>', 'bad');
      return;
    }
    let main, sc;
    try {
      sc = toScenario(s);
      if (!last) box.innerHTML = '<section class="card"><p class="sub">Считаю…</p></section>';
      main = await runP(sc, N, my);
    } catch (e) {
      if (e.message !== 'cancel' && my === token) box.innerHTML = `<section class="card s-fix"><p class="bad">Не получилось посчитать: ${esc(e.message)}</p></section>`;
      return;
    }
    last = { s: clone(s), sc, main, exact: MC.exact(main.model, { maxCombos: 2e5 }), ideas: null, other: null, indep: null };
    renderAnswer();
    try {
      // что поможет
      const ideas = [];
      if (s.scheme === 'tries') {
        const t = s.tries, p = t.pct / 100;
        ideas.push({ name: `Ещё ${t.n >= 5 ? 3 : 1} ${plural(t.n >= 5 ? 3 : 1, ['попытка', 'попытки', 'попыток'])}`, what: `всего ${t.n + (t.n >= 5 ? 3 : 1)}`,
          p: binomAtLeast(t.n + (t.n >= 5 ? 3 : 1), p, t.need) });
        if (t.pct <= 90) ideas.push({ name: 'Попытка удаётся чаще', what: `на 1 из 10 чаще (${Math.round(t.pct / 10) + 1} из 10)`, p: binomAtLeast(t.n, Math.min(1, p + 0.1), t.need) });
        ideas.forEach(x => { x.metric = { kind: 'p', value: x.p }; });
      } else {
        for (const idea of ideasFor(s)) {
          const r = await runP(toScenario(idea.s), N_IDEA, my);
          ideas.push({ ...idea, metric: metric(idea.s, r.summary) });
        }
      }
      last.ideas = ideas;
      // общая причина: сколько было бы без неё
      if ((s.scheme === 'parts' || s.scheme === 'all') && s.cause.on) last.indep = (await runP(MC.independentVersion(sc), N_IDEA, my)).summary;
      // второй вариант
      if (calc.variants.length === 2) {
        const o = calc.variants[1 - calc.active];
        if (o.scheme && check(o).ok && !(o.scheme === 'goal' && meanStep(o.goal) <= 0 && o.goal.start !== o.goal.target)) {
          const r = await runP(toScenario(o), N, my);
          last.other = { s: clone(o), summary: r.summary, label: calc.active ? 'А' : 'Б' };
        }
      }
    } catch (e) {
      if (e.message === 'cancel') return;
      throw e;
    }
    if (my === token) renderAnswer();
  }

  // ===================================================================================
  // Ответ
  // ===================================================================================
  function verdict(p) {
    if (p >= 0.9) return ['good', 'Почти наверняка', '✓'];
    if (p >= 0.7) return ['good', 'Скорее да', '✓'];
    if (p >= 0.4) return ['warn', 'Как повезёт', '!'];
    if (p >= 0.15) return ['bad', 'Скорее нет', '✕'];
    return ['bad', 'Почти точно нет', '✕'];
  }
  const of100 = p => (p > 0 && p < 0.005 ? 'меньше 1' : p < 1 && p > 0.995 ? 'больше 99' : String(Math.round(p * 100)));
  const dots = p => {
    const k = Math.round(p * 100);
    return `<div class="dots" role="img" aria-label="${k} из 100">${Array.from({ length: 100 }, (_, i) => `<i class="${i < k ? 'y' : 'n'}"></i>`).join('')}</div>`;
  };
  const dot2 = s => s.replace(/\.\./g, '.');

  /** Слова под ситуацию. */
  function words(s) {
    if (s.scheme === 'goal') return { yes: 'успеете', no: 'не успеете', q: `${s.title || 'Цель'}: успею за ${s.goal.deadline.value} ${plural(s.goal.deadline.value, PERIODS[s.goal.period].forms)}?` };
    if (s.scheme === 'tries') return { yes: 'получится', no: 'не получится', q: `${s.title || 'Попытки'}: будет хотя бы ${s.tries.need} из ${s.tries.n}?` };
    const k = unitKind(s.unit);
    if (s.scheme === 'all') return { yes: 'дождётесь', no: 'не дождётесь', q: `${s.title || 'Ситуация'}: всё будет готово за ${fmtVal(s.limit.value, s.unit)}?`, reserve: 'ждать' };
    if (k === 'time') return { yes: 'успеете', no: 'не успеете', q: `${s.title || 'Ситуация'}: успею за ${fmtVal(s.limit.value, s.unit)}?`, reserve: 'закладывайте' };
    if (k === 'money') return { yes: 'хватит', no: 'не хватит', q: `${s.title || 'Ситуация'}: хватит ${fmtVal(s.limit.value, s.unit)}?`, reserve: 'берите' };
    return { yes: 'уложитесь', no: 'не уложитесь', q: `${s.title || 'Ситуация'}: уложусь в ${fmtVal(s.limit.value, s.unit)}?`, reserve: 'закладывайте' };
  }

  function metricText(m, s) {
    if (m.kind === 'p') return `${of100(m.value)} из 100`;
    if (m.kind === 'median') return fmtPeriods(m.value, s.goal.period);
    return fmtVal(m.value, s.unit);
  }

  function renderAnswer() {
    const { s, main } = last, S = main.summary, ev = S.event, R = S.result, W = words(s);
    let html = '';
    const isGoal = s.scheme === 'goal', isTries = s.scheme === 'tries';
    const P = isGoal ? PERIODS[s.goal.period] : null;
    const fv = x => (isGoal ? fmtPeriods(x, s.goal.period) : isTries ? `${Math.round(x)} из ${s.tries.n}` : fmtVal(x, s.unit));
    const notReached = isGoal ? 1 - countLE(R.sorted, P.max) / R.sorted.length : 0;

    // --- главная карточка
    if (ev) {
      const [lvl, word, icon] = verdict(ev.p);
      html += `<section class="card s-answer">
        <div class="badge-${lvl}"><span class="b-icon">${icon}</span>${word}</div>
        <div class="s-q">${esc(W.q)}</div>
        <div class="s-big">${of100(ev.p)} <span>из 100</span></div>
        <div class="s-sub">Примерно в ${of100(ev.p)} случаях из 100 ${W.yes}.</div>
        ${dots(ev.p)}
        <div class="legend"><span><i class="sw s1"></i>${W.yes}</span><span><i class="sw nn"></i>${W.no}</span></div>
      </section>`;
      sticky(`<span class="st-main"><b>${of100(ev.p)} из 100</b> · ${word}</span><span class="st-go">ответ ↓</span>`, lvl);
    } else {
      const label = isGoal ? `Скорее всего дойдёте до цели за` : s.scheme === 'all' ? 'Скорее всего всё будет готово через' : 'Скорее всего выйдет';
      html += `<section class="card s-answer">
        <div class="s-q">${esc(s.title || '')}</div>
        <div class="s-label">${label}</div>
        <div class="s-big s-big-text">${fv(R.pct[50])}</div>
        <div class="s-sub">В 8 случаях из 10 — от ${fv(R.pct[10])} до ${fv(R.pct[90])}.</div>
      </section>`;
      sticky(`<span class="st-main"><b>≈ ${fv(R.pct[50])}</b></span><span class="st-go">ответ ↓</span>`, 'good');
    }

    // --- чего ждать и какой нужен запас
    const lines = [];
    if (isTries) {
      const t = s.tries, p = t.pct / 100;
      lines.push(`Скорее всего удачных будет ${Math.round(R.pct[50])} из ${t.n}.`);
      const n90 = triesFor(p, t.need, 0.9), n99 = triesFor(p, t.need, 0.99);
      if (Number.isFinite(n90)) lines.push(`Чтобы получить хотя бы ${t.need} в 9 случаях из 10, нужно примерно <b>${n90} ${plural(n90, ['попытка', 'попытки', 'попыток'])}</b>; почти наверняка (99 из 100) — ${n99}.`);
      else lines.push('С таким шансом одной попытки нужного числа удач почти не набрать.');
    } else if (isGoal) {
      lines.push(`Скорее всего дойдёте за <b>${fmtPeriods(R.pct[50], s.goal.period)}</b>.`);
      if (R.pct[90] <= P.max) lines.push(`Чтобы почти наверняка (9 из 10) — закладывайте <b>${fmtPeriods(Math.ceil(R.pct[90]), s.goal.period)}</b>.`);
      if (R.pct[10] < R.pct[50]) lines.push(`Если повезёт (1 из 10) — быстрее ${fmtPeriods(Math.floor(R.pct[10]), s.goal.period)}.`);
    } else {
      if (ev) lines.push(`Скорее всего выйдет ${fmtVal(R.pct[50], s.unit)}.`);
      lines.push(`Чтобы ${W.yes} в 9 случаях из 10 — ${W.reserve} <b>${fmtVal(R.pct[90], s.unit)}</b>.`);
      lines.push(`Почти наверняка (99 из 100) — ${fmtVal(R.pct[99], s.unit)}.`);
      if (s.scheme === 'parts') {
        const plan = s.items.reduce((a, it) => a + (it.know === 'exact' ? it.v.exact : it.know === 'approx' ? it.v.usual
          : it.know === 'maybe' ? (it.v.pct > 50 ? (it.v.from + it.v.to) / 2 : 0) : median(it.v.history)), 0);
        lines.push(`Если всё пойдёт «как обычно», выйдет ${fmtVal(plan, s.unit)} — но так или лучше бывает только в ${of100(countLE(R.sorted, plan) / R.sorted.length)} случаях из 100.`);
      }
    }
    html += `<section class="card"><h3>${isTries ? 'Чего ждать' : 'Чего ждать и какой нужен запас'}</h3><ul class="plain">${lines.map(l => `<li>${dot2(l)}</li>`).join('')}</ul></section>`;

    // --- здравый смысл
    const warn = [];
    if (isGoal && notReached > 0.01) warn.push(`В ${of100(notReached)} случаях из 100 вы не доходите до цели даже за ${fmtPeriods(P.max, s.goal.period)}. Похоже, темп слишком медленный или откаты слишком частые.`);
    const few = [];
    const hist = (name, v, know) => { if (know === 'history' && v.history.length < 5) few.push(name); };
    if (s.items) s.items.forEach((it, k) => hist(it.name || `Пункт ${k + 1}`, it.v, it.know));
    if (isGoal) hist('темп', s.goal.step.v, s.goal.step.know);
    if (few.length) warn.push(`Мало прошлых значений (${few.map(x => `«${esc(x)}»`).join(', ')}): ответ примерный. Чем больше впишете, тем точнее.`);
    if (warn.length) html += `<section class="card s-warn"><h3>Обратите внимание</h3><ul class="plain">${warn.map(w => `<li>${w}</li>`).join('')}</ul></section>`;

    // --- что поможет
    const base = metric(s, S);
    if (!last.ideas) html += `<section class="card"><h3>Что поможет больше всего</h3><p class="sub">Считаю…</p></section>`;
    else {
      const better = (m) => (m.kind === 'p' ? m.value - base.value : base.value - m.value);
      const good = last.ideas.filter(x => better(x.metric) > (base.kind === 'p' ? 0.005 : 1e-9)).sort((a, b) => better(b.metric) - better(a.metric));
      const was = metricText(base, s);
      html += `<section class="card"><h3>Что поможет больше всего</h3>${good.length
        ? `<p class="sub">${base.kind === 'p' ? `Сейчас ${W.yes} в ${was}. Если улучшить одно:` : base.kind === 'median' ? `Сейчас скорее всего ${was}. Если улучшить одно:` : `Сейчас в плохом случае (1 из 10) ${was}. Если улучшить одно:`}</p>
          <div class="ideas">${good.slice(0, 5).map(x => {
            const gain = better(x.metric);
            const width = base.kind === 'p' ? [base.value * 100, gain * 100] : [60, Math.min(40, 40 * gain / Math.max(1e-9, base.value))];
            return `<div class="idea"><div class="idea-text"><b>${esc(x.name)}</b> — ${esc(x.what)}</div>
              <div class="idea-bar"><span class="now" style="width:${width[0]}%"></span><span class="gain" style="width:${width[1]}%"></span></div>
              <div class="idea-num">${metricText(x.metric, s)}${base.kind === 'p' ? ` <small>+${Math.round(gain * 100)}</small>` : ''}</div></div>`;
          }).join('')}</div>`
        : '<p class="sub">Ни одна отдельная вещь заметно не влияет.</p>'}</section>`;
    }

    // --- общая причина
    if (last.indep && ev) {
      const p2 = last.indep.event.p, d = Math.round((p2 - ev.p) * 100);
      html += `<section class="card"><h3>Почему важна общая причина</h3>
        <p>Если считать части по отдельности и забыть, что «${esc(s.cause.name)}» портит сразу несколько, получилось бы
        <b>${of100(p2)} из 100</b>${d ? ` — на ${Math.abs(d)} ${d > 0 ? 'больше' : 'меньше'}, чем на самом деле` : ', почти так же'}.
        Плохие случаи приходят вместе.</p></section>`;
    }

    // --- сравнение вариантов
    if (calc.variants.length === 2) {
      const o = last.other, me = calc.active ? 'Б' : 'А';
      if (!o) html += `<section class="card"><h3>Сравнение вариантов</h3><p class="sub">${calc.variants[1 - calc.active].scheme && check(calc.variants[1 - calc.active]).ok ? 'Считаю…' : 'Во втором варианте нужно заполнить ответы.'}</p></section>`;
      else {
        const mo = metric(o.s, o.summary), mm = base;
        const same = mo.kind === mm.kind;
        let verdictTxt = '';
        if (same) {
          const diff = mm.kind === 'p' ? mm.value - mo.value : mo.value - mm.value;
          const big = mm.kind === 'p' ? Math.abs(diff) >= 0.01 : Math.abs(diff) > 1e-9 && Math.abs(diff) / Math.max(1e-9, mo.value) >= 0.02;
          verdictTxt = !big ? 'Варианты почти одинаковые.' : `Лучше вариант <b>${diff > 0 ? me : o.label}</b>.`;
        }
        const cell = (sx, Sx) => `${metricText(metric(sx, Sx), sx)}`;
        html += `<section class="card"><h3>Сравнение вариантов</h3>
          <div class="table-wrap"><table class="cmp"><thead><tr><th></th><th>Вариант ${me} (сейчас)</th><th>Вариант ${o.label}</th></tr></thead><tbody>
          <tr><td>${mm.kind === 'p' ? `Шанс, что ${W.yes}` : mm.kind === 'median' ? 'Скорее всего' : 'В плохом случае (1 из 10)'}</td><td>${cell(s, S)}</td><td>${cell(o.s, o.summary)}</td></tr>
          ${!isTries ? `<tr><td>Запас на 9 из 10</td><td>${isGoal ? fmtPeriods(S.result.pct[90], s.goal.period) : fmtVal(S.result.pct[90], s.unit)}</td>
            <td>${o.s.scheme === 'goal' ? fmtPeriods(o.summary.result.pct[90], o.s.goal.period) : o.s.scheme === 'tries' ? '—' : fmtVal(o.summary.result.pct[90], o.s.unit)}</td></tr>` : ''}
          </tbody></table></div><p class="verdict">${verdictTxt}</p></section>`;
      }
    }

    // --- картинка разброса
    if (!isTries) html += `<section class="card"><h3>${isGoal ? `Сколько ${P.forms[2]} уходит` : 'Как часто какой итог'}</h3>
      ${ev ? `<div class="legend"><span><i class="sw s1"></i>${W.yes}</span><span><i class="sw s2"></i>${W.no}</span></div>` : ''}
      <div class="chart" id="s-hist"></div></section>`;

    // --- честность и подробности
    html += `<p class="note s-honest">Ответ настолько точен, насколько точны ваши оценки. Программа проигрывает ситуацию ${S.n.toLocaleString('ru-RU')} раз.</p>
      <details class="card s-details"><summary>Подробности для специалиста</summary>
      <ul class="plain">
        ${ev ? `<li>Вероятность: ${pct(ev.p, 2)} ± ${pct(ev.hi - ev.p, 2)} (95 % интервал), ${S.n.toLocaleString('ru-RU')} прогонов, сид ${SEED}.</li>` : `<li>${S.n.toLocaleString('ru-RU')} прогонов Монте-Карло, сид ${SEED}. Перцентили: P10 ${num(R.pct[10])}, P50 ${num(R.pct[50])}, P90 ${num(R.pct[90])}, P99 ${num(R.pct[99])}.</li>`}
        ${last.exact && ev ? `<li>Точный ответ полным перебором ${last.exact.combos.toLocaleString('ru-RU')} вариантов: ${pct(last.exact.p, 2)}.</li>` : ''}
        ${isTries && ev ? `<li>Точно по биномиальной формуле: ${pct(binomAtLeast(s.tries.n, s.tries.pct / 100, s.tries.need), 2)}.</li>` : ''}
        <li>Итог: <code>${esc(last.sc.result.formula)}</code>${last.sc.event ? `, успех: <code>${esc(last.sc.event.formula)}</code>` : ''}.</li>
      </ul>
      <button class="btn" id="s-to-expert">Открыть в режиме специалиста →</button>
    </details>`;

    $('#s-results').innerHTML = html;
    drawHist();
    $('#s-to-expert').addEventListener('click', () => PA.openExpert(last.sc, { n: 1000000, seed: SEED }));
  }

  function countLE(sorted, x) {
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] <= x) lo = mid + 1; else hi = mid; }
    return lo;
  }

  function drawHist() {
    const el = $('#s-hist');
    if (!el || !last || !el.clientWidth) return;
    const { main, s } = last, run = main.run, sorted = main.summary.result.sorted;
    const h = MC.histogram(sorted);
    const bins = h.bins.map(b => ({ ...b, yes: 0 }));
    const K = bins.length, lo = h.discrete ? 0 : h.lo, hi = h.discrete ? 0 : h.hi, w = h.discrete ? 1 : h.width;
    const idx = new Map(bins.map((b, i) => [b.from, i]));
    if (run.event) for (let i = 0; i < run.n; i++) {
      if (!run.event[i]) continue;
      const v = run.result[i];
      const b = h.discrete ? idx.get(v) : (v >= lo && v <= hi ? Math.min(K - 1, Math.floor((v - lo) / w)) : undefined);
      if (b !== undefined) bins[b].yes++;
    }
    bins.forEach(b => { b.pYes = b.yes / sorted.length; });
    const W = words(s);
    const unit = s.scheme === 'goal' ? PERIODS[s.goal.period].forms[2] : s.unit;
    Charts.histogram(el, { title: 'Разброс', bins, discrete: h.discrete, hasEvent: !!run.event, unit,
      resultLabel: s.scheme === 'goal' ? 'Срок' : 'Итог', axisLabel: unit, yesLabel: W.yes, noLabel: W.no });
  }

  /** Полоска внизу экрана на телефоне: ответ виден, даже когда листаешь вопросы. */
  function sticky(html, lvl) {
    const el = $('#s-sticky');
    el.innerHTML = html;
    el.className = `s-sticky lvl-${lvl}`;
    el.hidden = false;
  }

  // ===================================================================================
  function init() {
    bind();
    const h = location.hash;
    let fromLink = null;
    if (h.startsWith('#s=')) fromLink = tryStore(() => JSON.parse(unb64(h.slice(3))), null);
    const ex = EXAMPLES.find(x => h === '#simple=' + x.id);
    const saved = tryStore(() => JSON.parse(localStorage.getItem(KEY_CUR)), null);
    if (fromLink && Array.isArray(fromLink.variants)) calc = { ...calcOf(fromLink.variants[0]), variants: fromLink.variants, active: fromLink.active || 0 };
    else if (ex) calc = calcOf(clone(ex.sit));
    else if (h === '#simple=new') calc = calcOf({ scheme: null });
    else if (saved && Array.isArray(saved.variants)) calc = saved;
    else calc = calcOf({ scheme: null });
    renderMyCount();
    render();
    document.addEventListener('pa:mode', e => {
      if (e.detail !== 'simple') return;
      if (!last) run(); else drawHist();
    });
    let rt;
    window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(drawHist, 150); });
  }

  return {
    init, toScenario, check, EXAMPLES, fmtVal, fmtPeriods, binomAtLeast, triesFor, shareLink,
    load(simple) { calc = calcOf(simple && simple.scheme ? simple : { scheme: null }); open.clear(); render(); changed(); },
    get calc() { return calc; }, get last() { return last; },
  };
})();
