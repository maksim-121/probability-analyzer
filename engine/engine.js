/*
 * Анализатор вероятностей — движок Монте-Карло.
 *
 * Идея та же, что в Snow Boom: генератор случайных чисел с сидом -> много прогонов -> статистика.
 *   лента барабана с весами  ->  фактор с распределением (таблица «значение — вес» и др.)
 *   один спин                ->  один прогон сценария («один день»)
 *   подсчёт выигрыша         ->  формулы: расчётные величины, итог, событие
 *   RTP / hit rate ± ошибка  ->  средний итог / вероятность события ± ошибка
 *
 * Python-эталон (reference/engine_ref.py) повторяет этот файл бит в бит: тот же генератор,
 * тот же порядок случайных чисел, тот же язык формул. Любое изменение правил — в ОБОИХ файлах.
 *
 * Порядок случайных чисел (важно для сверки с Python): прогон за прогоном; внутри прогона
 * факторы по порядку; таблица / да-нет / равномерное / треугольное / данные / строки берут 1 число,
 * нормальное — 2 (Бокс — Мюллер), смесь — 1 + сколько возьмёт выбранная часть,
 * «зависит от» — сколько возьмёт выбранная ветка, повтор N раз — N раз по внутреннему распределению,
 * «шагов до цели» — по одному шагу, пока не дойдём до цели (или до предела шагов).
 *
 * Работает в браузере (window.MC) и в Node (module.exports).
 */
(function (root) {
  'use strict';

  class MCError extends Error {
    constructor(msg) { super(msg); this.name = 'MCError'; }
  }

  // =====================================================================================
  // Генератор: xoshiro128** (стартовое состояние из сида через splitmix32)
  // =====================================================================================
  function splitmix32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x9e3779b9) >>> 0;
      let t = a ^ (a >>> 16);
      t = Math.imul(t, 0x21f0aaad);
      t = t ^ (t >>> 15);
      t = Math.imul(t, 0x735a2d97);
      return (t ^ (t >>> 15)) >>> 0;
    };
  }

  const rotl = (x, k) => (x << k) | (x >>> (32 - k));

  class Rng {
    constructor(seed) {
      if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)
        throw new MCError('Сид должен быть целым числом от 0 до 4294967295');
      const sm = splitmix32(seed);
      this.s = new Uint32Array([sm(), sm(), sm(), sm()]);
    }
    nextU32() {
      const s = this.s;
      const result = Math.imul(rotl(Math.imul(s[1], 5), 7), 9) >>> 0;
      const t = s[1] << 9;
      s[2] ^= s[0]; s[3] ^= s[1]; s[1] ^= s[2]; s[0] ^= s[3]; s[2] ^= t;
      s[3] = rotl(s[3], 11);
      return result;
    }
    /** Равномерное число в [0, 1) с точностью 53 бита (два 32-битных числа). */
    uniform() {
      const a = this.nextU32() >>> 5, b = this.nextU32() >>> 6;
      return (a * 67108864 + b) / 9007199254740992;
    }
  }

  // =====================================================================================
  // Распределения
  // =====================================================================================
  const DIST_NAMES = {
    table: 'Таблица «значение — вес»',
    yesno: 'Да / нет',
    uniform: 'Равномерное',
    triangular: 'Треугольное',
    normal: 'Нормальное',
    data: 'Из данных',
    rows: 'Строки таблицы (дни целиком)',
  };
  // Составные типы (собираются простым режимом; в режиме специалиста показываются только для чтения)
  const COMPOSITE_NAMES = {
    repeat: 'Повтор N раз (сумма)',
    walk: 'Шагов до цели',
    mixture: 'Смесь распределений',
    conditional: 'Зависит от',
  };
  const MAX_REPEAT = 100000;

  const isNum = x => typeof x === 'number' && Number.isFinite(x);

  function numArray(arr, what, who) {
    if (!Array.isArray(arr) || arr.length === 0) throw new MCError(`${who}: список «${what}» пуст`);
    arr.forEach((x, i) => {
      if (!isNum(x)) throw new MCError(`${who}: в списке «${what}» позиция ${i + 1} — не число`);
    });
    return arr.slice();
  }

  function needNum(d, key, who) {
    if (!isNum(d[key])) throw new MCError(`${who}: параметр «${key}» должен быть числом`);
    return d[key];
  }

  /** Склеивает одинаковые значения: [[значение, вероятность], ...] — нужно для точного перебора. */
  function mergeSupport(values, weights, total) {
    const m = new Map();
    values.forEach((v, i) => { if (weights[i] > 0) m.set(v, (m.get(v) || 0) + weights[i]); });
    return [...m.entries()].map(([v, w]) => [v, w / total]);
  }

  /**
   * Проверяет параметры и готовит распределение:
   *   {type, sample(rng), support: [[v, p], ...] | null (непрерывное), mean, sd}
   */
  function prepareDist(d, who) {
    if (!d || typeof d !== 'object') throw new MCError(`${who}: не задано распределение`);
    switch (d.type) {
      case 'table': {
        const values = numArray(d.values, 'значения', who);
        const weights = numArray(d.weights, 'веса', who);
        if (values.length !== weights.length)
          throw new MCError(`${who}: значений ${values.length}, а весов ${weights.length}`);
        if (weights.some(w => w < 0)) throw new MCError(`${who}: вес не может быть отрицательным`);
        const cum = new Float64Array(weights.length);
        let total = 0;
        weights.forEach((w, i) => { total += w; cum[i] = total; });
        if (!(total > 0)) throw new MCError(`${who}: сумма весов должна быть больше нуля`);
        const last = values.length - 1;
        const sample = rng => {
          const u = rng.uniform() * total;
          let lo = 0, hi = last;
          while (lo < hi) { const mid = (lo + hi) >> 1; if (u < cum[mid]) hi = mid; else lo = mid + 1; }
          return values[lo];
        };
        return withMoments({ type: 'table', sample, support: mergeSupport(values, weights, total) });
      }
      case 'yesno': {
        const p = needNum(d, 'p', who);
        if (p < 0 || p > 1) throw new MCError(`${who}: вероятность должна быть от 0 до 1`);
        return withMoments({ type: 'yesno', sample: rng => (rng.uniform() < p ? 1 : 0),
          support: mergeSupport([1, 0], [p, 1 - p], 1) });
      }
      case 'uniform': {
        const a = needNum(d, 'min', who), b = needNum(d, 'max', who);
        if (a > b) throw new MCError(`${who}: минимум больше максимума`);
        return { type: 'uniform', sample: rng => a + (b - a) * rng.uniform(), support: null,
          mean: (a + b) / 2, sd: (b - a) / Math.sqrt(12) };
      }
      case 'triangular': {
        const a = needNum(d, 'min', who), c = needNum(d, 'mode', who), b = needNum(d, 'max', who);
        if (!(a < b)) throw new MCError(`${who}: минимум должен быть меньше максимума`);
        if (c < a || c > b) throw new MCError(`${who}: «обычно» должно быть между минимумом и максимумом`);
        const fc = (c - a) / (b - a);
        const sample = rng => {
          const u = rng.uniform();
          return u < fc ? a + Math.sqrt(u * (b - a) * (c - a)) : b - Math.sqrt((1 - u) * (b - a) * (b - c));
        };
        const v = (a * a + b * b + c * c - a * b - a * c - b * c) / 18;
        return { type: 'triangular', sample, support: null, mean: (a + b + c) / 3, sd: Math.sqrt(v) };
      }
      case 'normal': {
        const mu = needNum(d, 'mean', who), sd = needNum(d, 'sd', who);
        if (!(sd > 0)) throw new MCError(`${who}: разброс (sd) должен быть больше нуля`);
        const sample = rng => {
          const u1 = rng.uniform(), u2 = rng.uniform();
          return mu + sd * Math.sqrt(-2 * Math.log(1 - u1)) * Math.cos(2 * Math.PI * u2);
        };
        return { type: 'normal', sample, support: null, mean: mu, sd };
      }
      case 'data': {
        const values = numArray(d.values, 'данные', who);
        const n = values.length;
        return withMoments({ type: 'data', sample: rng => values[Math.floor(rng.uniform() * n)],
          support: mergeSupport(values, values.map(() => 1), n) });
      }
      case 'mixture': {   // служебный тип: смесь распределений (нужен для «версии без связей»)
        if (!Array.isArray(d.parts) || !d.parts.length) throw new MCError(`${who}: смесь без частей`);
        const parts = d.parts.map((pt, j) => prepareDist(pt && pt.dist, `${who}, часть ${j + 1}`));
        const w = d.parts.map(pt => pt.p);
        if (w.some(x => !isNum(x) || x < 0)) throw new MCError(`${who}: вес части смеси должен быть числом ≥ 0`);
        const cum = new Float64Array(w.length);
        let total = 0;
        w.forEach((x, j) => { total += x; cum[j] = total; });
        if (!(total > 0)) throw new MCError(`${who}: сумма весов смеси должна быть больше нуля`);
        const last = w.length - 1;
        const sample = rng => {
          const u = rng.uniform() * total;
          let lo = 0, hi = last;
          while (lo < hi) { const mid = (lo + hi) >> 1; if (u < cum[mid]) hi = mid; else lo = mid + 1; }
          return parts[lo].sample(rng);
        };
        if (parts.every(pt => pt.support))
          return withMoments({ type: 'mixture', sample, support: mergeWeighted(parts.map((pt, j) => [w[j] / total, pt.support])) });
        let m = 0, m2 = 0;
        parts.forEach((pt, j) => { const q = w[j] / total; m += q * pt.mean; m2 += q * (pt.sd * pt.sd + pt.mean * pt.mean); });
        return { type: 'mixture', sample, support: null, mean: m, sd: Math.sqrt(Math.max(0, m2 - m * m)) };
      }
      case 'repeat': {
        // Сумма N независимых значений одного распределения. С «да / нет» внутри — число удачных попыток из N.
        // N может быть случайным (timesDist — «собеседований в неделю: 1–4»): сначала разыгрываем N
        // (округляем до целого: floor(x + 0,5), не меньше 0), потом N раз внутреннее значение.
        if (d.timesDist !== undefined) {
          const td = prepareDist(d.timesDist, `${who}, сколько повторов`);
          const inner = prepareDist(d.dist, `${who}, одно повторение`);
          const sample = rng => {
            const n = Math.min(MAX_REPEAT, Math.max(0, Math.floor(td.sample(rng) + 0.5)));
            let s = 0;
            for (let k = 0; k < n; k++) s += inner.sample(rng);
            return s;
          };
          return { type: 'repeat', sample, support: null, mean: td.mean * inner.mean,
            sd: Math.sqrt(Math.max(0, td.mean * inner.sd * inner.sd + td.sd * td.sd * inner.mean * inner.mean)) };
        }
        const n = d.times;
        if (!Number.isInteger(n) || n < 1 || n > MAX_REPEAT)
          throw new MCError(`${who}: число повторов должно быть целым от 1 до ${MAX_REPEAT}`);
        const inner = prepareDist(d.dist, `${who}, одно повторение`);
        const sample = rng => { let s = 0; for (let k = 0; k < n; k++) s += inner.sample(rng); return s; };
        return { type: 'repeat', sample, support: null, mean: n * inner.mean, sd: Math.sqrt(n) * inner.sd };
      }
      case 'walk': {
        // Сколько шагов до цели: от start каждый шаг прибавляет значение step, пока не дойдём до goal.
        // Цель выше старта — ждём «>= goal», ниже — «<= goal». Не дошли за maxSteps -> maxSteps + 1.
        const start = needNum(d, 'start', who), goal = needNum(d, 'goal', who);
        const max = d.maxSteps === undefined ? 1000 : d.maxSteps;
        if (!Number.isInteger(max) || max < 1 || max > MAX_REPEAT)
          throw new MCError(`${who}: предел шагов должен быть целым от 1 до ${MAX_REPEAT}`);
        const step = prepareDist(d.step, `${who}, один шаг`);
        const up = goal >= start;
        const sample = rng => {
          if (up ? start >= goal : start <= goal) return 0;
          let pos = start;
          for (let k = 1; k <= max; k++) {
            pos += step.sample(rng);
            if (up ? pos >= goal : pos <= goal) return k;
          }
          return max + 1;
        };
        return { type: 'walk', sample, support: null, mean: NaN, sd: NaN, maxSteps: max };
      }
      case 'conditional':
      case 'rows':
        throw new MCError(`${who}: «${DIST_NAMES[d.type] || d.type}» нельзя использовать внутри ветки`);
      default:
        throw new MCError(`${who}: неизвестный тип распределения «${d.type}»`);
    }
  }

  function withMoments(dist) {
    let m = 0, m2 = 0;
    for (const [v, p] of dist.support) { m += v * p; m2 += v * v * p; }
    dist.mean = m;
    dist.sd = Math.sqrt(Math.max(0, m2 - m * m));
    return dist;
  }

  // =====================================================================================
  // Язык формул
  //   числа: 5, 0.25, 1e3          имена: Иван, Обед_2 (регистр не важен)
  //   + - * / ^   сравнения < <= > >= = == != <>   логика и / или / не (and / or / not)
  //   функции: max/макс, min/мин, abs/модуль, round/округл, floor/вниз, ceil/вверх,
  //            sqrt/корень, if/если(условие, да, нет)      константы: да/true = 1, нет/false = 0
  //   разделитель аргументов: «,» или «;». Истина = 1, ложь = 0, условие истинно, если не 0.
  // =====================================================================================
  const ID_START = /[A-Za-zА-Яа-яЁё_]/;
  const ID_PART = /[A-Za-zА-Яа-яЁё_0-9]/;
  const NUM_RE = /^\d+(\.\d+)?([eE][+-]?\d+)?/;
  const OPS = ['<=', '>=', '==', '!=', '<>', '&&', '||', '<', '>', '=', '+', '-', '*', '/', '^', '!', '(', ')', ',', ';'];

  const KEYWORDS = { 'и': 'and', 'and': 'and', 'или': 'or', 'or': 'or', 'не': 'not', 'not': 'not' };
  const CONSTS = { 'да': 1, 'true': 1, 'нет': 0, 'false': 0 };
  const FUNC_ALIASES = {
    max: 'max', 'макс': 'max', min: 'min', 'мин': 'min', abs: 'abs', 'модуль': 'abs',
    round: 'round', 'округл': 'round', floor: 'floor', 'вниз': 'floor', ceil: 'ceil', 'вверх': 'ceil',
    sqrt: 'sqrt', 'корень': 'sqrt', if: 'if', 'если': 'if',
  };
  const FUNC_ARITY = { max: [1, Infinity], min: [1, Infinity], abs: [1, 1], round: [1, 1], floor: [1, 1],
    ceil: [1, 1], sqrt: [1, 1], if: [3, 3] };
  const RESERVED = new Set([...Object.keys(KEYWORDS), ...Object.keys(CONSTS), ...Object.keys(FUNC_ALIASES)]);

  const truth = x => x !== 0 && x === x;    // NaN — ложь

  function tokenize(src) {
    const toks = [];
    let i = 0;
    while (i < src.length) {
      const ch = src[i];
      if (/\s/.test(ch)) { i++; continue; }
      if (/\d/.test(ch)) {
        const m = NUM_RE.exec(src.slice(i));
        toks.push({ k: 'num', v: parseFloat(m[0]), pos: i });
        i += m[0].length;
        if (i < src.length && ID_START.test(src[i]))
          throw new MCError(`после числа сразу идут буквы (позиция ${i + 1}); поставьте знак, например «*»`);
        continue;
      }
      if (ID_START.test(ch)) {
        let j = i + 1;
        while (j < src.length && ID_PART.test(src[j])) j++;
        toks.push({ k: 'id', v: src.slice(i, j), pos: i });
        i = j;
        continue;
      }
      const op = OPS.find(o => src.startsWith(o, i));
      if (!op) throw new MCError(`непонятный символ «${ch}» (позиция ${i + 1})`);
      toks.push({ k: 'op', v: op, pos: i });
      i += op.length;
    }
    toks.push({ k: 'end', v: '', pos: src.length });
    return toks;
  }

  /** Разбор формулы в дерево. Ошибки — MCError с понятным текстом. */
  function parse(src) {
    if (typeof src !== 'string' || !src.trim()) throw new MCError('формула пустая');
    const t = tokenize(src);
    let p = 0;
    const peek = () => t[p];
    const kw = tok => (tok.k === 'id' ? KEYWORDS[tok.v.toLowerCase()] : undefined);
    const isOp = (tok, ...ops) => tok.k === 'op' && ops.includes(tok.v);
    const expect = v => {
      if (!isOp(peek(), v)) throw new MCError(`ожидалось «${v}» (позиция ${peek().pos + 1})`);
      p++;
    };

    function orExpr() {
      let a = andExpr();
      while (kw(peek()) === 'or' || isOp(peek(), '||')) { p++; a = { t: 'or', a, b: andExpr() }; }
      return a;
    }
    function andExpr() {
      let a = notExpr();
      while (kw(peek()) === 'and' || isOp(peek(), '&&')) { p++; a = { t: 'and', a, b: notExpr() }; }
      return a;
    }
    function notExpr() {
      if (kw(peek()) === 'not' || isOp(peek(), '!')) { p++; return { t: 'not', a: notExpr() }; }
      return cmpExpr();
    }
    function cmpExpr() {
      const a = addExpr();
      if (isOp(peek(), '<', '<=', '>', '>=', '=', '==', '!=', '<>')) {
        let op = t[p++].v;
        if (op === '=') op = '==';
        if (op === '<>') op = '!=';
        const b = addExpr();
        if (isOp(peek(), '<', '<=', '>', '>=', '=', '==', '!=', '<>'))
          throw new MCError('два сравнения подряд: вместо «a < b < c» пишите «a < b и b < c»');
        return { t: 'cmp', op, a, b };
      }
      return a;
    }
    function addExpr() {
      let a = mulExpr();
      while (isOp(peek(), '+', '-')) { const op = t[p++].v; a = { t: 'bin', op, a, b: mulExpr() }; }
      return a;
    }
    function mulExpr() {
      let a = unary();
      while (isOp(peek(), '*', '/')) { const op = t[p++].v; a = { t: 'bin', op, a, b: unary() }; }
      return a;
    }
    function unary() {
      if (isOp(peek(), '-')) { p++; return { t: 'neg', a: unary() }; }
      if (isOp(peek(), '+')) { p++; return unary(); }
      return power();
    }
    function power() {
      const a = atom();
      if (isOp(peek(), '^')) { p++; return { t: 'bin', op: '^', a, b: unary() }; }
      return a;
    }
    function atom() {
      const tok = peek();
      if (tok.k === 'num') { p++; return { t: 'num', v: tok.v }; }
      if (isOp(tok, '(')) { p++; const e = orExpr(); expect(')'); return e; }
      if (tok.k === 'id') {
        const low = tok.v.toLowerCase();
        if (KEYWORDS[low]) throw new MCError(`лишнее «${tok.v}» (позиция ${tok.pos + 1})`);
        p++;
        if (isOp(peek(), '(')) {
          const fn = FUNC_ALIASES[low];
          if (!fn) throw new MCError(`неизвестная функция «${tok.v}»`);
          p++;
          const args = [];
          if (!isOp(peek(), ')')) {
            args.push(orExpr());
            while (isOp(peek(), ',', ';')) { p++; args.push(orExpr()); }
          }
          expect(')');
          const [lo, hi] = FUNC_ARITY[fn];
          if (args.length < lo || args.length > hi)
            throw new MCError(`функция «${tok.v}»: неверное число аргументов (${args.length})`);
          return { t: 'call', fn, args };
        }
        if (low in CONSTS) return { t: 'num', v: CONSTS[low] };
        if (FUNC_ALIASES[low]) throw new MCError(`после «${tok.v}» нужны скобки: ${tok.v}(…)`);
        return { t: 'var', name: low, raw: tok.v };
      }
      if (tok.k === 'end') throw new MCError('формула оборвалась');
      throw new MCError(`неожиданное «${tok.v}» (позиция ${tok.pos + 1})`);
    }

    const tree = orExpr();
    if (peek().k !== 'end') throw new MCError(`лишнее «${peek().v}» (позиция ${peek().pos + 1})`);
    return tree;
  }

  function collectVars(node, out = new Set()) {
    if (node.t === 'var') out.add(node.name);
    for (const k of ['a', 'b']) if (node[k]) collectVars(node[k], out);
    if (node.args) node.args.forEach(a => collectVars(a, out));
    return out;
  }

  // Функции одного аргумента (max / min / if собираются отдельно — без лишних массивов, ради скорости)
  const FN1 = {
    abs: Math.abs, round: x => Math.floor(x + 0.5), floor: Math.floor, ceil: Math.ceil, sqrt: Math.sqrt,
  };

  /** Дерево -> функция f(row). `index` — имя (в нижнем регистре) -> номер ячейки в row. */
  function compileTree(node, index, rawSrc) {
    const c = n => compileTree(n, index, rawSrc);
    switch (node.t) {
      case 'num': { const v = node.v; return () => v; }
      case 'var': {
        if (!index.has(node.name)) throw new MCError(`неизвестное имя «${node.raw}»`);
        const k = index.get(node.name);
        return row => row[k];
      }
      case 'neg': { const a = c(node.a); return row => -a(row); }
      case 'not': { const a = c(node.a); return row => (truth(a(row)) ? 0 : 1); }
      case 'and': { const a = c(node.a), b = c(node.b); return row => (truth(a(row)) && truth(b(row)) ? 1 : 0); }
      case 'or': { const a = c(node.a), b = c(node.b); return row => (truth(a(row)) || truth(b(row)) ? 1 : 0); }
      case 'cmp': {
        const a = c(node.a), b = c(node.b);
        switch (node.op) {
          case '<': return row => (a(row) < b(row) ? 1 : 0);
          case '<=': return row => (a(row) <= b(row) ? 1 : 0);
          case '>': return row => (a(row) > b(row) ? 1 : 0);
          case '>=': return row => (a(row) >= b(row) ? 1 : 0);
          case '==': return row => (a(row) === b(row) ? 1 : 0);
          case '!=': return row => (a(row) !== b(row) ? 1 : 0);
        }
        break;
      }
      case 'bin': {
        const a = c(node.a), b = c(node.b);
        switch (node.op) {
          case '+': return row => a(row) + b(row);
          case '-': return row => a(row) - b(row);
          case '*': return row => a(row) * b(row);
          case '/': return row => a(row) / b(row);
          case '^': return row => Math.pow(a(row), b(row));
        }
        break;
      }
      case 'call': {
        const args = node.args.map(c);
        if (node.fn === 'if') {
          const [cond, yes, no] = args;
          return row => (truth(cond(row)) ? yes(row) : no(row));
        }
        if (node.fn === 'max' || node.fn === 'min') {
          const m = node.fn === 'max' ? Math.max : Math.min;
          if (args.length === 1) { const a0 = args[0]; return row => m(a0(row)); }
          if (args.length === 2) { const [a0, a1] = args; return row => m(a0(row), a1(row)); }
          if (args.length === 3) { const [a0, a1, a2] = args; return row => m(a0(row), a1(row), a2(row)); }
          return row => { let v = m(args[0](row)); for (let k = 1; k < args.length; k++) v = m(v, args[k](row)); return v; };
        }
        const f = FN1[node.fn], a0 = args[0];
        return row => f(a0(row));
      }
    }
    throw new MCError('внутренняя ошибка разбора');
  }

  /** Удобная функция для тестов и интерфейса: посчитать формулу при заданных значениях. */
  function evalFormula(src, vars = {}) {
    const names = Object.keys(vars);
    const index = new Map(names.map((n, i) => [n.toLowerCase(), i]));
    const f = compileTree(parse(src), index, src);
    return f(Float64Array.from(names.map(n => vars[n])));
  }

  // =====================================================================================
  // Сценарий
  // {
  //   name, factors: [{name, label?, dist: {type, ...}}],
  //   derived: [{name, label?, formula}]   — расчётные величины, по порядку
  //   result:  {name, label?, unit?, formula}   — главное число (например, задержка)
  //   event:   {name, label?, formula} | null   — условие (например, «Задержка <= 5»)
  // }
  // =====================================================================================
  function checkName(name, seen, who) {
    if (typeof name !== 'string' || !name.length) throw new MCError(`${who}: не задано имя`);
    if (!ID_START.test(name[0]) || ![...name].every(ch => ID_PART.test(ch)))
      throw new MCError(`Имя «${name}»: можно только буквы, цифры и «_», без пробелов, первая — буква`);
    const low = name.toLowerCase();
    if (RESERVED.has(low)) throw new MCError(`Имя «${name}» занято (это слово языка формул)`);
    if (seen.has(low)) throw new MCError(`Имя «${name}» встречается дважды`);
    seen.add(low);
    return low;
  }

  function compileFormula(src, index, who) {
    let tree;
    try {
      tree = parse(src);
      return { fn: compileTree(tree, index, src), uses: [...collectVars(tree)] };
    } catch (e) {
      if (e instanceof MCError) throw new MCError(`${who}, формула «${src}»: ${e.message}`);
      throw e;
    }
  }

  // =====================================================================================
  // Факторы. Три вида:
  //   обычный     — одно значение из своего распределения;
  //   «зависит от» — {type: 'conditional', on: 'Дождь', cases: [{value: 1, dist}, {value: 0, dist}]}:
  //                 распределение выбирается по уже выпавшему значению фактора выше (общая причина);
  //   «строки»    — {type: 'rows', columns: ['Автобус', 'Обед'], rows: [[13, 0], [0, 10.5], ...]}:
  //                 берётся одна случайная строка целиком («день целиком»), все столбцы вместе —
  //                 так сохраняются любые связи, которые есть в данных. Сам фактор = номер строки.
  // У каждого фактора: slots (ячейки в row), vars (случайные величины для статистики),
  // sample(rng, row), enumerate(row) -> [[значения по slots, вероятность], ...] | null, maxOptions.
  // =====================================================================================
  const MAX_BRANCHES = 12;

  /** Смесь дискретных распределений: [[вес, [[v, p], ...]], ...] -> [[v, p], ...] (одинаковые v склеиваются). */
  function mergeWeighted(list) {
    const m = new Map();
    for (const [w, sup] of list) for (const [v, p] of sup) m.set(v, (m.get(v) || 0) + w * p);
    return [...m.entries()];
  }

  function buildFactor(f, i, ctx) {
    const who = `Фактор «${f && f.name}»`;
    const d = f && f.dist;
    if (d && d.type === 'rows') return buildRows(f, i, ctx);
    const low = checkName(f && f.name, ctx.seen, `Фактор №${i + 1}`);
    const slot = ctx.index.size;
    const label = f.label || f.name;
    let fac;
    if (d && d.type === 'conditional') {
      const pname = typeof d.on === 'string' ? d.on.toLowerCase() : '';
      if (!ctx.index.has(pname))
        throw new MCError(`${who} зависит от «${d.on}», но такого фактора выше нет (зависеть можно только от факторов, стоящих выше)`);
      const ps = ctx.index.get(pname);
      const pm = ctx.marginal.get(ps);
      if (!pm) throw new MCError(`${who}: «${d.on}» должен принимать отдельные значения (таблица, да/нет, данные), а не любые числа`);
      if (pm.length > MAX_BRANCHES)
        throw new MCError(`${who}: у «${d.on}» слишком много разных значений (${pm.length}, можно до ${MAX_BRANCHES})`);
      if (!Array.isArray(d.cases) || !d.cases.length) throw new MCError(`${who}: нет ни одной ветки`);
      const branches = new Map();
      d.cases.forEach((c, j) => {
        if (!c || !isNum(c.value)) throw new MCError(`${who}: у ветки ${j + 1} не задано значение «${d.on}»`);
        if (branches.has(c.value)) throw new MCError(`${who}: ветка для «${d.on}» = ${c.value} задана дважды`);
        branches.set(c.value, prepareDist(c.dist, `${who}, ветка «${d.on} = ${c.value}»`));
      });
      for (const [v] of pm)
        if (!branches.has(v)) throw new MCError(`${who}: «${d.on}» бывает равен ${v}, а ветки для этого значения нет`);
      const discrete = [...branches.values()].every(b => b.support);
      ctx.marginal.set(slot, discrete ? mergeWeighted(pm.map(([v, p]) => [p, branches.get(v).support])) : null);
      fac = {
        kind: 'conditional', parentSlot: ps, branches,
        sample: (rng, row) => { row[slot] = branches.get(row[ps]).sample(rng); },
        enumerate: discrete ? row => branches.get(row[ps]).support.map(([v, p]) => [[v], p]) : null,
        maxOptions: Math.max(...[...branches.values()].map(b => (b.support ? b.support.length : Infinity))),
      };
    } else {
      const dist = prepareDist(d, who);
      ctx.marginal.set(slot, dist.support);
      fac = {
        kind: 'plain', dist,
        sample: (rng, row) => { row[slot] = dist.sample(rng); },
        enumerate: dist.support ? () => dist.support.map(([v, p]) => [[v], p]) : null,
        maxOptions: dist.support ? dist.support.length : Infinity,
      };
    }
    ctx.index.set(low, slot);
    return { name: f.name, label, spec: d, slots: [slot], vars: [{ name: f.name, label, slot }], ...fac };
  }

  function buildRows(f, i, ctx) {
    const who = `Фактор «${f.name}»`;
    const d = f.dist;
    const low = checkName(f.name, ctx.seen, `Фактор №${i + 1}`);
    if (!Array.isArray(d.columns) || !d.columns.length) throw new MCError(`${who}: нет ни одного столбца`);
    if (!Array.isArray(d.rows) || !d.rows.length) throw new MCError(`${who}: нет ни одной строки`);
    const W = d.columns.length, base = ctx.index.size;
    ctx.index.set(low, base);
    d.columns.forEach((c, k) => ctx.index.set(checkName(c, ctx.seen, `${who}, столбец №${k + 1}`), base + 1 + k));
    d.rows.forEach((r, j) => {
      if (!Array.isArray(r) || r.length !== W)
        throw new MCError(`${who}: в строке ${j + 1} ${Array.isArray(r) ? r.length : 0} знач., а столбцов ${W}`);
      r.forEach((x, k) => { if (!isNum(x)) throw new MCError(`${who}: строка ${j + 1}, столбец «${d.columns[k]}» — не число`); });
    });
    const rows = d.rows, n = rows.length, ones = rows.map(() => 1);
    ctx.marginal.set(base, mergeSupport(rows.map((_, j) => j + 1), ones, n));
    d.columns.forEach((_, k) => ctx.marginal.set(base + 1 + k, mergeSupport(rows.map(r => r[k]), ones, n)));
    const label = f.label || f.name;
    return {
      name: f.name, label, spec: d, kind: 'rows',
      slots: Array.from({ length: W + 1 }, (_, k) => base + k),
      vars: [{ name: f.name, label: `${label}: номер строки`, slot: base, index: true },
        ...d.columns.map((c, k) => ({ name: c, label: c, slot: base + 1 + k }))],
      sample: (rng, row) => {
        const j = Math.floor(rng.uniform() * n), r = rows[j];
        row[base] = j + 1;
        for (let k = 0; k < W; k++) row[base + 1 + k] = r[k];
      },
      enumerate: () => rows.map((r, j) => [[j + 1, ...r], 1 / n]),
      maxOptions: n,
    };
  }

  /** Проверяет сценарий и собирает модель для прогонов. */
  function compile(sc) {
    if (!sc || typeof sc !== 'object') throw new MCError('Сценарий не задан');
    if (!Array.isArray(sc.factors) || sc.factors.length === 0)
      throw new MCError('Нужен хотя бы один случайный фактор');
    if (!sc.result || typeof sc.result.formula !== 'string') throw new MCError('Не задана формула итога');

    const ctx = { seen: new Set(), index: new Map(), marginal: new Map() };
    const factors = sc.factors.map((f, i) => buildFactor(f, i, ctx));
    const vars = factors.flatMap(f => f.vars);
    const nVars = ctx.index.size;
    const index = ctx.index;
    const derived = (sc.derived || []).map(d => {
      const who = `Величина «${d && d.name}»`;
      const low = checkName(d && d.name, ctx.seen, 'Расчётная величина');
      const { fn, uses } = compileFormula(d.formula, index, who);   // видит только то, что выше
      index.set(low, index.size);
      return { name: d.name, label: d.label || d.name, fn, uses };
    });
    const resName = sc.result.name || 'Итог';
    const rlow = checkName(resName, ctx.seen, 'Итог');
    const result = { name: resName, label: sc.result.label || resName, unit: sc.result.unit || '',
      ...compileFormula(sc.result.formula, index, `Итог «${resName}»`) };
    index.set(rlow, index.size);
    let event = null;
    if (sc.event && sc.event.formula && sc.event.formula.trim()) {
      const evName = sc.event.name || 'Событие';
      event = { name: evName, label: sc.event.label || evName,
        ...compileFormula(sc.event.formula, index, `Событие «${evName}»`) };
    }
    // имена, которые реально встречаются в формулах (для «торнадо»: неиспользуемое ни на что не влияет)
    const used = new Set([...derived.flatMap(d => d.uses), ...result.uses, ...(event ? event.uses : [])]);
    return { name: sc.name || 'Сценарий', scenario: sc, factors, vars, nVars, marginal: ctx.marginal, used,
      dependent: factors.some(f => f.kind !== 'plain'), derived, result, event,
      width: index.size, resultSlot: index.size - 1 };
  }

  /**
   * Досчитывает строку после того, как случайные величины уже лежат в row[0..nVars-1].
   * Возвращает итог; событие (1/0) кладёт в model.lastEvent — без временных массивов, ради скорости.
   */
  function finishRow(model, row) {
    const V = model.nVars, der = model.derived;
    for (let j = 0; j < der.length; j++) row[V + j] = der[j].fn(row);
    const r = model.result.fn(row);
    row[model.resultSlot] = r;
    model.lastEvent = model.event && truth(model.event.fn(row)) ? 1 : 0;
    return r;
  }

  /**
   * Тот же сценарий, но БЕЗ связей между факторами — «как посчитал бы тот, кто забыл про зависимость».
   *   «зависит от» -> смесь веток с весами P(значение фактора выше): каждая величина сама по себе та же,
   *                   но связь с причиной пропала;
   *   «строки»     -> каждый столбец становится отдельным фактором «из данных».
   */
  function independentVersion(sc) {
    const model = compile(sc);
    const out = JSON.parse(JSON.stringify(sc));
    out.factors = [];
    model.factors.forEach((f, i) => {
      const spec = sc.factors[i];
      if (f.kind === 'plain') out.factors.push(JSON.parse(JSON.stringify(spec)));
      else if (f.kind === 'conditional') {
        const pm = model.marginal.get(f.parentSlot);
        out.factors.push({ name: spec.name, label: spec.label || spec.name, dist: { type: 'mixture',
          parts: pm.map(([v, p]) => ({ p, dist: JSON.parse(JSON.stringify(spec.dist.cases.find(c => c.value === v).dist)) })) } });
      } else {
        out.factors.push({ name: spec.name, label: spec.label || spec.name,
          dist: { type: 'data', values: spec.dist.rows.map((_, j) => j + 1) } });
        spec.dist.columns.forEach((c, k) =>
          out.factors.push({ name: c, label: c, dist: { type: 'data', values: spec.dist.rows.map(r => r[k]) } }));
      }
    });
    return out;
  }

  /** Факторы, которые (прямо или через цепочку) зависят от ячейки slot, — по порядку. */
  function dependentsOf(model, slot) {
    const s = new Set([slot]), out = [];
    for (const f of model.factors)
      if (f.kind === 'conditional' && s.has(f.parentSlot)) { out.push(f); f.slots.forEach(x => s.add(x)); }
    return out;
  }

  // =====================================================================================
  // Прогон Монте-Карло (можно по кусочкам — чтобы страница не зависала)
  // =====================================================================================
  function checkpoints(n) {
    const out = [];
    for (let k = 100; k < n; k *= 10) for (const m of [1, 2, 5]) if (k * m < n) out.push(k * m);
    out.push(n);
    return out;
  }

  function createRun(model, { n, seed }) {
    if (!Number.isInteger(n) || n < 1) throw new MCError('Число прогонов должно быть целым и больше нуля');
    const rng = new Rng(seed);
    const V = model.nVars, factors = model.factors, F = factors.length;
    const cols = model.vars.map(() => new Float64Array(n));
    const result = new Float64Array(n);
    const event = model.event ? new Uint8Array(n) : null;
    const row = new Float64Array(model.width);
    const cps = checkpoints(n);
    const convergence = [];
    let i = 0, cp = 0, evCount = 0, sum = 0;

    const run = {
      model, n, seed, cols, result, event, convergence,
      get done() { return i >= n; },
      get progress() { return i / n; },
      /** Выполнить следующие k прогонов. Возвращает true, когда всё готово. */
      step(k = n) {
        const end = Math.min(n, i + k);
        for (; i < end; i++) {
          for (let f = 0; f < F; f++) factors[f].sample(rng, row);
          for (let v = 0; v < V; v++) cols[v][i] = row[v];
          const r = finishRow(model, row), ev = model.lastEvent;
          result[i] = r; sum += r;
          if (event) { event[i] = ev; evCount += ev; }
          if (i + 1 === cps[cp]) {
            const m = i + 1, p = evCount / m;
            convergence.push({ n: m, p: event ? p : null,
              half: event ? 1.96 * Math.sqrt(p * (1 - p) / m) : null, mean: sum / m });
            cp++;
          }
        }
        return i >= n;
      },
    };
    return run;
  }

  function run(model, opts) {
    const r = createRun(model, opts);
    r.step();
    return r;
  }

  // =====================================================================================
  // Статистика
  // =====================================================================================
  /** Перцентиль по отсортированному массиву, линейная интерполяция (как numpy по умолчанию). */
  function quantile(sorted, q) {
    const m = sorted.length;
    if (!m) return NaN;
    const pos = (m - 1) * q, lo = Math.floor(pos), frac = pos - lo;
    return lo + 1 < m ? sorted[lo] + (sorted[lo + 1] - sorted[lo]) * frac : sorted[lo];
  }

  const PCTS = [1, 5, 10, 25, 50, 75, 90, 95, 99];

  /** Вероятность с 95% интервалом. При 0 из N — «правило трёх»: верхняя граница ≈ 3/N. */
  function proportion(count, n) {
    const p = count / n, se = Math.sqrt(p * (1 - p) / n);
    let lo = p - 1.96 * se, hi = p + 1.96 * se;
    if (count === 0) hi = 3 / n;
    if (count === n) lo = 1 - 3 / n;
    return { count, n, p, se, lo: Math.max(0, lo), hi: Math.min(1, hi) };
  }

  function summarize(r) {
    const n = r.n;
    const vals = [];
    let nan = 0;
    for (let i = 0; i < n; i++) { const v = r.result[i]; if (v === v) vals.push(v); else nan++; }
    const m = vals.length;
    let sum = 0;
    for (let i = 0; i < m; i++) sum += vals[i];
    const mean = sum / m;
    let ss = 0;
    for (let i = 0; i < m; i++) { const d = vals[i] - mean; ss += d * d; }
    const sd = m > 1 ? Math.sqrt(ss / (m - 1)) : 0;
    const sorted = Float64Array.from(vals).sort();
    const pct = {};
    PCTS.forEach(q => { pct[q] = quantile(sorted, q / 100); });
    let evCount = 0;
    if (r.event) for (let i = 0; i < n; i++) evCount += r.event[i];
    return {
      n, seed: r.seed, nan,
      event: r.event ? proportion(evCount, n) : null,
      result: { mean, sd, se: sd / Math.sqrt(m), min: sorted[0], max: sorted[m - 1], pct, sorted },
      convergence: r.convergence,
    };
  }

  /**
   * Чувствительность («торнадо»): по очереди фиксируем одну случайную величину на «малом» и «большом»
   * уровне (10-й и 90-й перцентиль её собственной выборки), остальные — те же самые прогоны.
   * Факторы, которые ЗАВИСЯТ от зафиксированной величины, перевыбираются заново по её новому значению
   * (своим генератором с сидом seed + 1000003·(номер + 1)) — иначе связь «дождь -> автобус» потерялась бы.
   */
  function sensitivity(r, { maxRows = 200000 } = {}) {
    const model = r.model, V = model.nVars;
    const m = Math.min(r.n, maxRows);
    const row = new Float64Array(model.width);
    const evalWith = (fix, value) => {
      const deps = fix >= 0 ? dependentsOf(model, fix) : [];
      const rng = deps.length ? new Rng((r.seed + 1000003 * (fix + 1)) % 4294967296) : null;
      let ev = 0, sum = 0;
      for (let i = 0; i < m; i++) {
        for (let v = 0; v < V; v++) row[v] = r.cols[v][i];
        if (fix >= 0) row[fix] = value;
        for (let k = 0; k < deps.length; k++) deps[k].sample(rng, row);
        sum += finishRow(model, row); ev += model.lastEvent;
      }
      return { p: model.event ? ev / m : null, mean: sum / m };
    };
    const base = evalWith(-1, 0);
    const matters = v => !v.index && (model.used.has(v.name.toLowerCase()) || dependentsOf(model, v.slot).length > 0);
    const items = model.vars.filter(matters).map(v => {
      const k = v.slot;
      const s = Float64Array.from(r.cols[k].subarray(0, m)).sort();
      const lowV = s[Math.floor(0.1 * (m - 1))], highV = s[Math.ceil(0.9 * (m - 1))];
      const low = { value: lowV, ...evalWith(k, lowV) };
      const high = { value: highV, ...evalWith(k, highV) };
      const swing = model.event ? Math.abs(high.p - low.p) : Math.abs(high.mean - low.mean);
      return { name: v.name, label: v.label, low, high, swing, drives: dependentsOf(model, k).map(f => f.name) };
    });
    items.sort((a, b) => b.swing - a.swing);
    return { rows: m, base, items };
  }

  /**
   * Точный ответ перебором — как точный расчёт базовой игры Snow Boom.
   * Перебор идёт «деревом»: фактор за фактором; у зависимого фактора варианты берутся из ветки,
   * выбранной уже перебранной причиной. Работает, если все факторы дискретные и вариантов не больше maxCombos.
   * Возвращает null, если перебор невозможен.
   */
  function exact(model, { maxCombos = 2e6 } = {}) {
    if (model.factors.some(f => !f.enumerate)) return null;
    let bound = 1;
    for (const f of model.factors) bound *= f.maxOptions;
    if (bound > maxCombos) return null;
    const F = model.factors.length;
    const row = new Float64Array(model.width);
    let pEv = 0, m1 = 0, m2 = 0, combos = 0;
    const rec = (fi, prob) => {
      if (fi === F) {
        const r = finishRow(model, row);
        combos++;
        if (model.lastEvent) pEv += prob;
        m1 += prob * r; m2 += prob * r * r;
        return;
      }
      const f = model.factors[fi];
      for (const [vals, p] of f.enumerate(row)) {
        for (let k = 0; k < vals.length; k++) row[f.slots[k]] = vals[k];
        rec(fi + 1, prob * p);
      }
    };
    rec(0, 1);
    return { combos, p: model.event ? pEv : null, mean: m1, sd: Math.sqrt(Math.max(0, m2 - m1 * m1)) };
  }

  /**
   * Гистограмма итога. Если разных значений немного (<= maxBins) — столбик на каждое значение,
   * иначе равные интервалы между 0.5% и 99.5% перцентилями + счётчики «левее» / «правее».
   */
  function histogram(sorted, { maxBins = 40 } = {}) {
    const m = sorted.length;
    const distinct = [];
    for (let i = 0; i < m && distinct.length <= maxBins; i++)
      if (i === 0 || sorted[i] !== sorted[i - 1]) distinct.push(sorted[i]);
    if (distinct.length <= maxBins) {
      const bins = distinct.map(v => ({ from: v, to: v, count: 0 }));
      let k = 0;
      for (let i = 0; i < m; i++) { while (sorted[i] !== bins[k].from) k++; bins[k].count++; }
      bins.forEach(b => { b.p = b.count / m; });
      return { discrete: true, bins, below: 0, above: 0 };
    }
    // Целые значения (недели, попытки): столбик охватывает целые числа, иначе часть столбиков
    // получала бы по два числа, а часть по одному — и гистограмма выглядела бы «зубчатой».
    let integer = true;
    for (let i = 0; i < m && integer; i++) integer = Number.isInteger(sorted[i]);
    let lo, hi, w, K;
    if (integer) {
      lo = Math.floor(quantile(sorted, 0.005)); hi = Math.ceil(quantile(sorted, 0.995));
      w = Math.max(1, Math.ceil((hi - lo + 1) / maxBins)); K = Math.ceil((hi - lo + 1) / w);
    } else {
      lo = quantile(sorted, 0.005); hi = quantile(sorted, 0.995);
      w = (hi - lo) / maxBins || 1; K = maxBins;
    }
    const bins = Array.from({ length: K }, (_, j) => {
      const from = lo + j * w, to = lo + (j + 1) * w;
      return { from, to, count: 0, label: integer ? (w === 1 ? `${from}` : `${from}–${to - 1}`) : undefined };
    });
    let below = 0, above = 0;
    for (let i = 0; i < m; i++) {
      const v = sorted[i];
      if (v < lo) below++;
      else if (v > hi) above++;
      else bins[Math.min(K - 1, Math.floor((v - lo) / w))].count++;
    }
    bins.forEach(b => { b.p = b.count / m; });
    // lo / hi / width — чтобы страница могла разложить по тем же столбикам свои отметки (событие «да / нет»)
    return { discrete: false, integer, bins, lo, hi, width: w, below: below / m, above: above / m };
  }

  /** Сколько прогонов нужно, чтобы погрешность вероятности p была не больше ±half (95%). */
  function runsNeeded(p, half) {
    return Math.ceil(1.96 * 1.96 * p * (1 - p) / (half * half));
  }

  const MC = {
    MCError, Rng, DIST_NAMES, prepareDist, parse, evalFormula, compile, createRun, run, summarize,
    sensitivity, exact, histogram, quantile, proportion, runsNeeded, PCTS, independentVersion, dependentsOf,
    MAX_BRANCHES, COMPOSITE_NAMES, MAX_REPEAT,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = MC;
  else root.MC = MC;
})(typeof window !== 'undefined' ? window : globalThis);
