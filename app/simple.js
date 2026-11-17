/*
 * Простой режим — для обычного человека, без формул и терминов.
 *
 * Человек начинает с вопроса своими словами («найду ли работу до Нового года?»). Программа узнаёт тему
 * по словам (TOPICS), сама выбирает схему расчёта и задаёт вопросы на языке темы. Если тему не узнала —
 * человек выбирает из пяти понятных вопросов (схем):
 *   parts — «Успею ли? Хватит ли?»: части складываются (дорога, бюджет, ремонт по этапам);
 *   all   — «Соберутся ли все? Будет ли всё готово?»: решает самое долгое;
 *   goal  — «Когда дойду до цели?»: каждый период понемногу приближаюсь (вес, жим, накопления, учёба);
 *   until — «Получится ли до срока?»: пробую, пока не выйдет (работа, продажа) — попытки во времени;
 *   tries — «Получится ли с нескольких попыток?»: фиксированное число попыток (экзамен, поступление).
 * Про каждое число — «Что вы о нём знаете?»: точно / примерно / может случиться / как было раньше.
 * Из ответов собирается обычный сценарий движка (тот же, что в режиме специалиста).
 *
 * Расчёт («Мои расчёты») = один или два варианта (сравнение «а что если»); сохраняется сам, отправляется ссылкой.
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
    parts: { icon: '🧩', title: 'Успею ли? Хватит ли?', sub: 'Время или деньги складываются из частей',
      ex: 'дорога, бюджет, ремонт по этапам', itemsQ: 'Из каких частей складывается?', add: '+ Добавить часть',
      ph: 'Например: дорога до аэропорта' },
    all: { icon: '👥', title: 'Соберутся ли все? Будет ли всё готово?', sub: 'Всё идёт одновременно, решает самое долгое',
      ex: 'встреча, несколько дел сразу', itemsQ: 'Кого или что ждём?', add: '+ Добавить', ph: 'Например: Иван, едет на автобусе' },
    goal: { icon: '📈', title: 'Когда дойду до цели?', sub: 'Понемногу приближаюсь, иногда откатываюсь',
      ex: 'похудеть, жим 100 кг, накопить, выучить' },
    until: { icon: '🔁', title: 'Получится ли до срока?', sub: 'Пробую, пока не выйдет',
      ex: 'найти работу, продать квартиру, найти клиента' },
    tries: { icon: '🎯', title: 'Получится ли с нескольких попыток?', sub: 'Попыток столько-то, каждая удаётся или нет',
      ex: 'экзамен, поступление, подходы в зале' },
  };
  const KNOW = [['exact', 'Знаю точно'], ['approx', 'Примерно'], ['maybe', 'Может случиться'], ['history', 'Как было раньше']];
  const UNITS = ['мин', 'ч', 'дн.', '₽', 'шт.', 'кг', 'км'];
  const PERIODS = {
    'день': { forms: ['день', 'дня', 'дней'], acc: 'день', many: 'дни', days: 1, perMonth: 30.44, max: 3650 },
    'неделя': { forms: ['неделя', 'недели', 'недель'], accForms: ['неделю', 'недели', 'недель'], acc: 'неделю', many: 'недели', days: 7, perMonth: 4.345, max: 520 },
    'месяц': { forms: ['месяц', 'месяца', 'месяцев'], acc: 'месяц', many: 'месяцы', days: 30.44, perMonth: 1, max: 120 },
  };

  const clone = o => JSON.parse(JSON.stringify(o));
  const tryStore = (fn, fb) => { try { return fn(); } catch (e) { return fb; } };
  const parseNum = s => { const t = String(s).trim().replace(/\s/g, '').replace(',', '.'); return t === '' ? NaN : Number(t); };
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
  const tenText = v => `${num(Math.round((Number.isFinite(v) ? v : 0) / 5) / 2)} из 10`;

  /** Значение для людей: 118 мин -> «1 ч 58 мин», 85000 ₽ -> «85 000 ₽». */
  function fmtVal(x, unit) {
    if (!Number.isFinite(x)) return '—';
    const hm = m => { const h = Math.floor(m / 60), r = m - h * 60; return r ? `${h} ч ${r} мин` : `${h} ч`; };
    if (unit === 'мин') { const m = Math.round(x); return Math.abs(m) >= 60 ? hm(m) : `${m} мин`; }
    if (unit === 'ч') { const m = Math.round(x * 60); return m < 60 ? `${m} мин` : hm(m); }
    if (unitKind(unit) === 'money') return `${Math.round(x).toLocaleString('ru-RU')} ${unit}`;
    if (unit === 'дн.') { const d = Math.round(x); return `${d} ${plural(d, ['день', 'дня', 'дней'])}`; }
    return `${num(x)}${unit ? ' ' + unit : ''}`;
  }
  /** Число периодов для людей: 41 -> «41 неделя (≈ 9,5 мес.)». */
  function fmtPeriods(k, period) {
    const P = PERIODS[period], n = Math.round(k);
    let s = `${n} ${plural(n, P.accForms || P.forms)}`;   // «за 1 неделю», «за 2 недели», «за 5 недель»
    const months = n / P.perMonth;
    if (period !== 'месяц' && months >= 2) s += ` (≈ ${num(Math.round(months * 2) / 2)} мес.)`;
    if (period === 'месяц' && n >= 24) s += ` (≈ ${num(Math.round(n / 6) / 2)} ${plural(Math.round(n / 12), ['года', 'лет', 'лет'])})`;
    return s;
  }

  // ---------------------------------------------------------------- даты и сроки
  const today = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
  const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const fromIso = s => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };
  const fmtDate = s => { const d = fromIso(s); return d ? d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: d.getFullYear() === today().getFullYear() ? undefined : 'numeric' }) : '—'; };
  /** Ближайшая будущая дата «день, месяц». */
  const nextDate = (day, month) => { const t = today(); let d = new Date(t.getFullYear(), month, day); if (d <= t) d = new Date(t.getFullYear() + 1, month, day); return iso(d); };
  const daysLeft = s => { const d = fromIso(s); return d ? Math.round((d - today()) / 864e5) : NaN; };
  /** Срок в периодах: дата -> сколько целых периодов осталось; «через N» — N. */
  function deadlinePeriods(dl, period) {
    if (dl.mode === 'date') return Math.floor(daysLeft(dl.date) / PERIODS[period].days);
    return dl.value;
  }
  function deadlineText(dl, period) {
    if (dl.mode === 'date') {
      const n = deadlinePeriods(dl, period), d = daysLeft(dl.date);
      return `до ${fmtDate(dl.date)}` + (Number.isFinite(n) && d > 0
        ? ` — осталось ${period === 'день' ? `${d} ${plural(d, ['день', 'дня', 'дней'])}` : `${n} ${plural(n, PERIODS[period].forms)} (${d} ${plural(d, ['день', 'дня', 'дней'])})`}` : '');
    }
    return `за ${dl.value} ${plural(dl.value, PERIODS[period].forms)}`;
  }

  // ===================================================================================
  // Заготовки
  // ===================================================================================
  const V = o => ({ exact: 10, usual: 10, min: 5, max: 20, pct: 30, from: 5, to: 15, history: [], ...o });
  const item = (name, know, v) => ({ name, know, v: V(v), byCause: false, vc: null });
  const DL = (o = {}) => ({ on: true, mode: 'date', date: iso(new Date(today().getFullYear(), 11, 31)), value: 12, ...o });
  const WORDS_UNTIL = { one: 'попытка', few: 'попытки', many: 'попыток', succ: 'успех', succFew: 'успеха', succMany: 'успехов',
    succIns: 'успехом', act: 'получится', inf: 'получилось', hint: '' };

  function blank(scheme) {
    const base = { v: 3, scheme, title: '', unit: 'мин', limit: { on: true, value: 60 }, cause: { on: false, name: 'Дождь', pct: 30 } };
    if (scheme === 'parts') return { ...base, title: 'Моя ситуация', items: [item('', 'approx', { usual: 20, min: 10, max: 40 })] };
    if (scheme === 'all') return { ...base, title: 'Встреча', limit: { on: true, value: 5 }, items: [item('', 'approx', { usual: 5, min: 0, max: 15 })] };
    if (scheme === 'goal') return { ...base, title: 'Моя цель', unit: 'кг', goal: { start: 80, target: 100, period: 'неделя',
      step: { know: 'approx', v: V({ exact: 0.5, usual: 0.5, min: 0, max: 1.5 }) },
      setback: { on: false, pct: 20, from: 0, to: 1 }, deadline: DL({ on: false }) } };
    if (scheme === 'until') return { ...base, title: 'Получится ли до срока', until: { period: 'неделя',
      attempts: { know: 'approx', v: V({ exact: 2, usual: 2, min: 1, max: 4 }) }, pct: 20, need: 1, deadline: DL(),
      words: { ...WORDS_UNTIL } } };
    return { ...base, title: 'Мои попытки', tries: { what: 'попытка', n: 5, pct: 30, need: 1, act: 'получится' } };
  }
  const calcOf = sit => ({ id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), variants: [sit], active: 0 });

  // ===================================================================================
  // Темы: узнаём вопрос по словам
  // ===================================================================================
  const WORDNUM = { 'одн': 1, 'дв': 2, 'тр': 3, 'четыр': 4, 'пят': 5, 'шест': 6, 'сем': 7, 'восьм': 8, 'девят': 9, 'десят': 10 };
  const MONTHS = ['январ', 'феврал', 'март', 'апрел', 'ма', 'июн', 'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр'];

  /** Срок из текста: «до нового года», «к лету», «до 1 марта», «к сентябрю», «за 3 месяца», «за год». */
  function parseDeadline(t) {
    const y = today().getFullYear();
    if (/нов(ого|ый|ому)\s*год|новогод|конц\S*\s+года/.test(t)) return DL({ date: iso(new Date(y, 11, 31)) });
    let m = /(?:до|к)\s+(\d{1,2})\s+(январ|феврал|март|апрел|ма[яй]|июн|июл|август|сентябр|октябр|ноябр|декабр)/.exec(t);
    if (m) { const mi = MONTHS.findIndex(x => m[2].startsWith(x)); return DL({ date: nextDate(+m[1], mi) }); }
    m = /(?:до|к)\s+(январ|феврал|март|апрел|ма[яюй]|июн|июл|август|сентябр|октябр|ноябр|декабр)/.exec(t);
    if (m) { const mi = MONTHS.findIndex(x => m[1].startsWith(x)); return DL({ date: nextDate(1, mi) }); }
    if (/(до|к)\s+конц\S*\s+месяц/.test(t)) return DL({ date: iso(new Date(y, today().getMonth() + 1, 0)) });
    const seasons = [[/(до|к)\s+весн/, 2], [/(до|к)\s+лет/, 5], [/(до|к)\s+осен/, 8], [/(до|к)\s+зим/, 11]];
    for (const [re, mo] of seasons) if (re.test(t)) return DL({ date: nextDate(1, mo) });
    m = /(?:за|через)\s+(\d+|полгода|год)\s*(недел|месяц|дн|день|год|лет)?/.exec(t);
    if (m) {
      if (m[1] === 'полгода') return DL({ mode: 'n', value: 6, unit: 'месяц' });
      if (m[1] === 'год') return DL({ mode: 'n', value: 12, unit: 'месяц' });
      if (m[2] === 'год' || m[2] === 'лет') return DL({ mode: 'n', value: +m[1] * 12, unit: 'месяц' });
      const unit = !m[2] || m[2].startsWith('недел') ? 'неделя' : m[2].startsWith('месяц') ? 'месяц' : 'день';
      return DL({ mode: 'n', value: +m[1], unit });
    }
    if (/за\s+год|хочу\s+за\s+год/.test(t)) return DL({ mode: 'n', value: 12, unit: 'месяц' });
    return null;
  }
  /** Число перед словом: «100 кг», «150 000 ₽», «150 тысяч», «150к». */
  function parseAmount(t, after) {
    const m = new RegExp(`(\\d[\\d\\s]*(?:[.,]\\d+)?)\\s*(тыс\\S*|к(?=[\\s.,!?]|$)|млн\\S*)?\\s*${after}`).exec(t);
    if (!m) return NaN;
    let x = parseNum(m[1]);
    if (m[2]) x *= /^млн/.test(m[2]) ? 1e6 : 1e3;
    return x;
  }
  const wordNum = t => { for (const [k, v] of Object.entries(WORDNUM)) if (new RegExp(`(^|\\s)${k}`).test(t)) return v; return NaN; };
  /** Срок из текста в нужных периодах (неделя / месяц / день). */
  function dlFor(t, period, fb) {
    const d = parseDeadline(t);
    if (!d) return fb;
    if (d.mode === 'n' && d.unit && d.unit !== period) d.value = Math.max(1, Math.round(d.value * PERIODS[d.unit].days / PERIODS[period].days));
    delete d.unit;
    d.on = true;
    return d;
  }

  const TOPICS = [
    { id: 'job', re: /(работ|ваканс|оффер|собесед|трудоустро)/, say: 'вы ищете работу. Посчитаю, найдёте ли до срока', build: t => {
      const s = blank('until');
      s.title = 'Найти новую работу';
      s.until.attempts.v = V({ exact: 2, usual: 2, min: 1, max: 4 });
      s.until.pct = 15;
      s.until.deadline = dlFor(t, 'неделя', DL());
      s.until.words = { one: 'собеседование', few: 'собеседования', many: 'собеседований', succ: 'оффер', succFew: 'оффера', succMany: 'офферов',
        succIns: 'оффером', act: 'найдёте работу', inf: 'найти работу', hint: 'Не знаете? Обычно 1–2 из 10 собеседований заканчиваются оффером (очень примерно).' };
      return s;
    } },
    { id: 'sell', re: /(прода[мтжю]|продам|покупател|сдам\s+квартир|сдать\s+квартир|арендатор)/, say: 'вы что-то продаёте. Посчитаю, получится ли до срока', build: t => {
      const s = blank('until');
      s.title = /квартир/.test(t) ? 'Продать квартиру' : /машин|авто/.test(t) ? 'Продать машину' : 'Продать до срока';
      s.until.attempts.v = V({ exact: 2, usual: 2, min: 0, max: 4 });
      s.until.pct = 10;
      s.until.deadline = dlFor(t, 'неделя', DL());
      s.until.words = { one: 'показ', few: 'показа', many: 'показов', succ: 'сделка', succFew: 'сделки', succMany: 'сделок',
        succIns: 'сделкой', act: 'продадите', inf: 'продать', hint: 'Не знаете? Часто сделка случается примерно после 10 показов — это 1 из 10 (очень примерно).' };
      return s;
    } },
    { id: 'admission', re: /(поступ)/, say: 'вы поступаете. Посчитаю шанс поступить хотя бы куда-то', build: t => {
      const s = blank('tries');
      s.title = 'Поступить';
      const n = parseAmount(t, '(вуз|универ|институт|заявлен)');
      const w = wordNum(t);
      s.tries = { what: 'вуз', n: Number.isFinite(n) ? n : Number.isFinite(w) ? w : 5, pct: 30, need: 1, act: 'поступите',
        hint: 'Шанс в один вуз: если ваш балл около проходного прошлого года — примерно 3–5 из 10 (очень примерно).' };
      return s;
    } },
    { id: 'exam', re: /(экзамен|сдам|сдать|сесси|зач[её]т|егэ|огэ|на права|сдачи)/, say: 'вы сдаёте экзамен. Посчитаю шанс сдать', build: t => {
      const s = blank('tries');
      s.title = /прав/.test(t) ? 'Сдать на права' : 'Сдать экзамен';
      const n = parseAmount(t, 'попыт'), w = wordNum(t);
      s.tries = { what: 'попытка сдачи', n: Number.isFinite(n) ? n : Number.isFinite(w) ? w : 3, pct: 60, need: 1, act: 'сдадите',
        hint: 'Не знаете? Подумайте, сколько раз из 10 вы сдали бы его сегодня. Хорошо подготовленные — 8–9 из 10.' };
      return s;
    } },
    { id: 'weight', re: /(похуд|сбросить|скинуть|\sвес[ауе]?\s|лишн)/, say: 'вы худеете. Посчитаю, когда дойдёте до цели', build: t => {
      const s = blank('goal');
      const target = parseAmount(t, 'кг');
      s.title = Number.isFinite(target) ? `Похудеть до ${num(target)} кг` : 'Похудеть';
      s.unit = 'кг';
      s.goal = { start: Number.isFinite(target) ? target + 10 : 90, target: Number.isFinite(target) ? target : 80, period: 'неделя',
        step: { know: 'approx', v: V({ exact: 0.5, usual: 0.6, min: 0.2, max: 1.2 }) },
        setback: { on: true, pct: 20, from: 0.3, to: 1.5 }, deadline: dlFor(t, 'неделя', DL({ on: false })),
        hint: 'Не знаете темп? Безопасно — 0,5–1 кг в неделю. Впишите, сколько весите сейчас.' };
      return s;
    } },
    { id: 'gym', re: /(жим|жать|пожм|присед|станов|подтян|отжим|тяга)/, say: 'вы тренируетесь. Посчитаю, когда дойдёте до цели', build: t => {
      const s = blank('goal');
      const target = parseAmount(t, 'кг');
      s.title = Number.isFinite(target) ? `Пожать ${num(target)} кг` : 'Новый рекорд';
      s.unit = 'кг';
      s.goal = { start: Number.isFinite(target) ? Math.round(target * 0.8) : 80, target: Number.isFinite(target) ? target : 100, period: 'неделя',
        step: { know: 'approx', v: V({ exact: 0.5, usual: 0.5, min: 0, max: 1.5 }) },
        setback: { on: true, pct: 20, from: 0, to: 1 }, deadline: dlFor(t, 'неделя', DL({ on: false })),
        hint: 'Не знаете темп? У любителей обычно +0,5–1 кг в неделю, у опытных медленнее. Впишите свой текущий результат.' };
      return s;
    } },
    { id: 'savings', re: /(накоп|отлож|скоп|сэконом|на машину|на квартиру|первоначальн)/, say: 'вы копите. Посчитаю, когда накопите', build: t => {
      const s = blank('goal');
      const target = parseAmount(t, '(₽|руб|р(?=[\\s.,!?]|$)|\\$|тыс)');
      s.title = Number.isFinite(target) ? `Накопить ${fmtVal(target, '₽')}` : 'Накопить';
      s.unit = '₽';
      s.goal = { start: 0, target: Number.isFinite(target) ? target : 150000, period: 'месяц',
        step: { know: 'approx', v: V({ exact: 15000, usual: 15000, min: 8000, max: 20000 }) },
        setback: { on: true, pct: 15, from: 0, to: 15000 }, deadline: dlFor(t, 'месяц', DL({ on: false })),
        hint: 'Сколько обычно получается отложить за месяц. Плохой месяц — крупные непредвиденные траты.' };
      return s;
    } },
    { id: 'learn', re: /(выуч|слов|прочит|книг|страниц|курс|урок)/, say: 'вы учитесь. Посчитаю, когда дойдёте до цели', build: t => {
      const s = blank('goal');
      const words = /слов/.test(t), target = parseAmount(t, words ? 'слов' : '(страниц|урок|глав)');
      s.title = words ? `Выучить ${Number.isFinite(target) ? num(target) : 1000} слов` : 'Закончить учёбу';
      s.unit = words ? 'слов' : 'стр.';
      s.goal = { start: 0, target: Number.isFinite(target) ? target : (words ? 1000 : 300), period: 'день',
        step: { know: 'approx', v: V({ exact: 20, usual: 20, min: 10, max: 30 }) },
        setback: { on: true, pct: 30, from: 0, to: 0 }, deadline: dlFor(t, 'день', DL({ on: false })),
        hint: 'Плохой день — когда вообще не занимаетесь: прогресс 0.' };
      return s;
    } },
    { id: 'project', re: /(ремонт|проект|диплом|курсов|дедлайн|закончу|сделать|написать|допишу|сдать работу)/, say: 'у вас дело к сроку. Посчитаю, сколько займут этапы', build: t => {
      const s = blank('parts');
      s.title = /ремонт/.test(t) ? 'Ремонт к сроку' : /диплом/.test(t) ? 'Диплом к сроку' : 'Дело к сроку';
      s.unit = 'дн.';
      const dl = parseDeadline(t);
      const left = !dl ? 30 : dl.mode === 'date' ? daysLeft(dl.date) : Math.round(dl.value * PERIODS[dl.unit || 'неделя'].days);
      s.limit = { on: true, value: left > 0 ? left : 30 };
      s.items = /ремонт/.test(t)
        ? [item('Черновые работы', 'approx', { usual: 10, min: 7, max: 20 }), item('Ждать материалы', 'maybe', { pct: 40, from: 3, to: 10 }),
          item('Чистовая отделка', 'approx', { usual: 14, min: 10, max: 25 })]
        : [item('Подготовка', 'approx', { usual: 5, min: 3, max: 10 }), item('Основная работа', 'approx', { usual: 15, min: 10, max: 30 }),
          item('Правки', 'approx', { usual: 5, min: 2, max: 12 })];
      return s;
    } },
    { id: 'meeting', re: /(встреч|соберут|совещан|гост[иья]|все придут|опоздают)/, say: 'вы ждёте нескольких людей. Посчитаю, начнётся ли вовремя',
      build: () => example('meeting') },
    { id: 'money', re: /(хватит|денег|бюджет|потрач|стоит|расход|отпуск|поездк)/, say: 'вопрос про деньги. Посчитаю, хватит ли', build: t => {
      const s = example('trip');
      const lim = parseAmount(t, '(₽|руб|р(?=[\\s.,!?]|$)|\\$|на)');
      if (Number.isFinite(lim)) s.limit.value = lim;
      s.title = /отпуск|поездк|море/.test(t) ? 'Хватит ли на отпуск' : 'Хватит ли денег';
      return s;
    } },
    { id: 'travel', re: /(успе|опозда|доед|добер|самол[её]т|поезд|рейс|аэропорт|вокзал|дорог)/, say: 'вопрос про время в пути. Посчитаю, успеете ли', build: t => {
      const s = example('plane');
      const h = parseAmount(t, 'час'), mm = parseAmount(t, 'мин');
      if (Number.isFinite(h) || Number.isFinite(mm)) s.limit.value = (Number.isFinite(h) ? h * 60 : 0) + (Number.isFinite(mm) ? mm : 0);
      else if (/два часа/.test(t)) s.limit.value = 120;
      if (!/самол|аэропорт|рейс/.test(t)) s.title = 'Успею ли вовремя';
      return s;
    } },
  ];

  function detect(text) {
    const t = ' ' + String(text).toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ') + ' ';
    const topic = TOPICS.find(x => x.re.test(t));
    if (!topic) return null;
    const s = topic.build(t);
    s.question = String(text).trim();
    s.topic = topic.id;
    s.say = topic.say;
    return s;
  }

  const QUESTIONS = ['Найду ли работу до Нового года?', 'Успею ли на самолёт за 2 часа?', 'Хватит ли 70 000 ₽ на отпуск?',
    'Когда пожму 100 кг?', 'Похудею ли до 80 кг к лету?', 'Накоплю ли 150 000 ₽ за год?', 'Сдам ли экзамен с трёх попыток?',
    'Выучу ли 1000 слов к сентябрю?', 'Продам ли квартиру до весны?', 'Успею ли сделать ремонт к 1 марта?'];

  // Готовые ситуации (ссылки #simple=<id>; темы «встреча», «деньги», «дорога» строятся из них)
  const EXAMPLES = [
    { id: 'plane', sit: { v: 3, scheme: 'parts', title: 'Успеть на самолёт', unit: 'мин',
      limit: { on: true, value: 120 }, cause: { on: false, name: 'Дождь', pct: 30 }, items: [
        item('Подача такси', 'approx', { usual: 5, min: 2, max: 15 }), item('Дорога до аэропорта', 'approx', { usual: 40, min: 30, max: 70 }),
        item('Пробка', 'maybe', { pct: 30, from: 10, to: 30 }), item('Регистрация и досмотр', 'approx', { usual: 20, min: 10, max: 50 }),
        item('Дойти до выхода на посадку', 'exact', { exact: 10 })] } },
    { id: 'meeting', sit: { v: 3, scheme: 'all', title: 'Встреча в 14:00', unit: 'мин',
      limit: { on: true, value: 5 }, cause: { on: false, name: 'Дождь', pct: 30 }, items: [
        item('Иван, едет на автобусе', 'history', { history: [0, 0, 5, 0, 10, 0, 5, 20, 0, 5] }),
        item('Мария, задерживается после обеда', 'maybe', { pct: 10, from: 10, to: 10 }),
        item('Переговорка: прошлое совещание затянулось', 'maybe', { pct: 25, from: 5, to: 15 })] } },
    { id: 'trip', sit: { v: 3, scheme: 'parts', title: 'Поездка на море', unit: '₽',
      limit: { on: true, value: 70000 }, cause: { on: false, name: 'Сезон', pct: 30 }, items: [
        item('Билеты', 'exact', { exact: 18000 }), item('Жильё', 'approx', { usual: 20000, min: 16000, max: 26000 }),
        item('Еда', 'approx', { usual: 12000, min: 9000, max: 18000 }), item('Экскурсии и развлечения', 'approx', { usual: 8000, min: 4000, max: 15000 }),
        item('Непредвиденное', 'maybe', { pct: 30, from: 3000, to: 10000 })] } },
    { id: 'offer', sit: { v: 3, scheme: 'tries', title: 'Оффер после собеседований', unit: '', limit: { on: false, value: 0 },
      cause: { on: false, name: '', pct: 0 }, tries: { what: 'собеседование', n: 8, pct: 15, need: 1, act: 'получите оффер' } } },
    { id: 'bench', q: 'Когда пожму 100 кг?', patch: s => { s.goal.start = 80; s.goal.deadline = DL({ mode: 'n', value: 52 }); } },
    { id: 'weight', q: 'Похудею ли до 80 кг?', patch: s => { s.goal.start = 92; s.goal.deadline = DL({ mode: 'n', value: 40 }); } },
    { id: 'savings', q: 'Накоплю ли 150 000 ₽ за год?', patch: s => { s.goal.start = 20000; } },
    { id: 'job', q: 'Найду ли работу до Нового года?' },
  ];
  function example(id) {
    const x = EXAMPLES.find(e => e.id === id);
    if (!x) return null;
    if (x.sit) return clone(x.sit);
    const s = detect(x.q);
    if (x.patch) x.patch(s);
    return s;
  }

  // ===================================================================================
  // Состояние
  // ===================================================================================
  let calc = null;            // { id, variants: [sit, sit?], active }
  let token = 0, timer = null, last = null;
  const open = new Set();
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
  /** Старые сохранения: срок числом -> новый формат. */
  function upgrade(s) {
    if (s && s.goal && s.goal.deadline && !s.goal.deadline.mode) s.goal.deadline = DL({ on: s.goal.deadline.on, mode: 'n', value: s.goal.deadline.value });
    if (s && s.tries && !s.tries.act) s.tries.act = 'получится';
    return s;
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
  function checkDeadline(dl, period, required) {
    if (!dl.on && !required) return '';
    if (dl.mode === 'date') {
      const n = daysLeft(dl.date);
      if (bad(n)) return 'Выберите дату срока.';
      if (n <= 0) return 'Дата срока уже прошла — выберите дату в будущем.';
      if (deadlinePeriods(dl, period) < 1) return `До срока меньше одного периода («${PERIODS[period].acc}») — считайте по дням.`;
      return '';
    }
    return Number.isInteger(dl.value) && dl.value >= 1 ? '' : 'Срок — целое число периодов, хотя бы 1.';
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
      const d = checkDeadline(g.deadline, g.period, false);
      if (d) global.push(d);
    } else if (s.scheme === 'until') {
      const u = s.until;
      const m = checkValue(u.attempts.know, u.attempts.v);
      if (m) items.attempts = `Сколько ${u.words.many} за ${PERIODS[u.period].acc}: ${m}.`;
      if (!(u.pct >= 0 && u.pct <= 100)) global.push('Шанс — от 0 до 100 %.');
      if (!(Number.isInteger(u.need) && u.need >= 1)) global.push('Сколько нужно — целое число, хотя бы 1.');
      const d = checkDeadline(u.deadline, u.period, true);
      if (d) global.push(d);
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
  function distOf(know, v) {
    if (know === 'exact') return { type: 'uniform', min: v.exact, max: v.exact };
    if (know === 'approx') return v.min === v.max ? { type: 'uniform', min: v.min, max: v.max } : { type: 'triangular', min: v.min, mode: v.usual, max: v.max };
    if (know === 'maybe') return { type: 'mixture', parts: [
      { p: 100 - v.pct, dist: { type: 'uniform', min: 0, max: 0 } }, { p: v.pct, dist: { type: 'uniform', min: v.from, max: v.to } }] };
    return { type: 'data', values: v.history.slice() };
  }
  function negate(d) {
    if (d.type === 'uniform') return { type: 'uniform', min: -d.max, max: -d.min };
    if (d.type === 'triangular') return { type: 'triangular', min: -d.max, mode: -d.mode, max: -d.min };
    if (d.type === 'data') return { type: 'data', values: d.values.map(x => -x) };
    if (d.type === 'mixture') return { type: 'mixture', parts: d.parts.map(p => ({ p: p.p, dist: negate(p.dist) })) };
    throw new Error('negate: ' + d.type);
  }
  function meanStep(g) {
    const d = MC.prepareDist(distOf(g.step.know, g.step.v), 'шаг');
    const q = g.setback.on ? g.setback.pct / 100 : 0;
    return (1 - q) * d.mean - q * (g.setback.from + g.setback.to) / 2;
  }
  const meanOf = (know, v) => MC.prepareDist(distOf(know, v), 'x').mean;

  function toScenario(s) {
    const taken = new Set(['итог', 'успех']);
    const id = (raw, fb) => CSV.safeName(raw || fb, taken);
    if (s.scheme === 'goal') {
      const g = s.goal, sign = g.target >= g.start ? 1 : -1, P = PERIODS[g.period];
      const signed = d => (sign === 1 ? d : negate(d));
      const parts = [{ p: g.setback.on ? 100 - g.setback.pct : 100, dist: signed(distOf(g.step.know, g.step.v)) }];
      if (g.setback.on && g.setback.pct > 0) parts.push({ p: g.setback.pct, dist: signed({ type: 'uniform', min: -g.setback.to, max: -g.setback.from }) });
      const W = g.deadline.on ? deadlinePeriods(g.deadline, g.period) : null;
      return { name: s.title || 'Моя цель', description: 'Собрано в простом режиме: когда дойду до цели.',
        factors: [{ name: 'Периоды', label: `Сколько ${P.forms[2]} до цели`, dist: { type: 'walk', start: g.start, goal: g.target,
          maxSteps: P.max, step: { type: 'mixture', parts } } }],
        derived: [], result: { name: 'Итог', label: `Сколько ${P.forms[2]} до цели`, unit: P.forms[2], formula: 'Периоды' },
        event: W ? { name: 'Успех', label: `Дошли ${deadlineText(g.deadline, g.period).replace(/ — .*$/, '')}`, formula: `Итог <= ${W}` } : null };
    }
    if (s.scheme === 'until') {
      const u = s.until, P = PERIODS[u.period], W = deadlinePeriods(u.deadline, u.period);
      return { name: s.title || 'До срока', description: 'Собрано в простом режиме: получится ли до срока.',
        factors: [{ name: 'Периоды', label: `Сколько ${P.forms[2]} уйдёт`,
          dist: { type: 'walk', start: 0, goal: u.need, maxSteps: P.max, step: { type: 'repeat',
            timesDist: distOf(u.attempts.know, u.attempts.v), dist: { type: 'yesno', p: u.pct / 100 } } } }],
        derived: [], result: { name: 'Итог', label: `Сколько ${P.forms[2]} уйдёт`, unit: P.forms[2], formula: 'Периоды' },
        event: { name: 'Успех', label: `Получилось ${deadlineText(u.deadline, u.period).replace(/ — .*$/, '')}`, formula: `Итог <= ${W}` } };
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
    return { name: s.title || 'Моя ситуация', description: `Собрано в простом режиме: ${SCHEMES[s.scheme].title.toLowerCase()}`,
      factors, derived: [],
      result: { name: 'Итог', label: s.scheme === 'all' ? 'Когда готово всё' : 'Сколько всего', unit: s.unit,
        formula: s.scheme === 'all' ? `max(${parts.join('; ')})` : parts.join(' + ') },
      event: s.limit.on ? { name: 'Успех', label: `Не больше ${fmtVal(s.limit.value, s.unit)}`, formula: `Итог <= ${s.limit.value}` } : null };
  }

  // ===================================================================================
  // Редактор
  // ===================================================================================
  function chanceCtl(P, value) {
    const k = Math.round((Number.isFinite(value) ? value : 0) / 10);
    return `<span class="ten" role="group" aria-label="Как часто, из 10">${Array.from({ length: 10 }, (_, i) =>
      `<button type="button" data-s-act="ten" data-p="${P}" data-n="${i + 1}" class="${i < k ? 'on' : ''}" aria-label="${i + 1} из 10"${
        i === 0 ? ' title="Ещё раз — 0 из 10 (никогда)"' : ''}></button>`).join('')}</span>
      <span class="ten-txt"><b>${tenText(value)}</b> · точнее <input class="pct-in" inputmode="decimal" data-s="${P}" data-num value="${fmtIn(value)}" aria-label="Процент"> %</span>`;
  }
  const histHint = n => `${n} знач. Впишите через пробел, как было в прошлые разы.${n && n < 5 ? ' <b>Данных мало — ответ будет примерный.</b>' : ''}`;

  function valueEditor(know, v, P, unit, opt = {}) {
    const u = esc(unit);
    const f = (key, label) => `<label class="field">${label}<input inputmode="decimal" data-s="${P}.${key}" data-num value="${fmtIn(v[key])}"></label>`;
    if (know === 'exact') return `<div class="fields">${f('exact', `ровно${u ? ', ' + u : ''}`)}</div>`;
    if (know === 'approx') return `<div class="fields">${f('usual', `обычно${u ? ', ' + u : ''}`)}${f('min', 'от')}${f('max', 'до')}</div>
      <p class="hint">${opt.approxHint || 'Чаще всего выходит около «обычно», реже — ближе к краям.'}</p>`;
    if (know === 'maybe') return `<div class="maybe"><span>Бывает</span> ${chanceCtl(`${P}.pct`, v.pct)}</div>
      <div class="sentence">и тогда добавляет от <input inputmode="decimal" data-s="${P}.from" data-num value="${fmtIn(v.from)}" aria-label="От">
      до <input inputmode="decimal" data-s="${P}.to" data-num value="${fmtIn(v.to)}" aria-label="До"> ${u}</div>`;
    const n = v.history.filter(Number.isFinite).length;
    return `<textarea rows="2" class="mono" data-s="${P}.history" data-list placeholder="Например: 35 42 38 60 41" aria-label="Прошлые значения">${esc(v.history.map(fmtIn).join(' '))}</textarea>
      <p class="hint" data-hist="${P}">${histHint(n)}</p>`;
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
    return `как раньше: ${v.history.length} знач., обычно ${fmtVal(median(v.history), unit)}`;
  }

  function itemCard(it, k) {
    const s = sit(), key = `${calc.active}.${k}`, P = `items.${k}`;
    const head = `<div class="row">
        <input class="s-name" data-s="${P}.name" value="${esc(it.name)}" placeholder="${esc(SCHEMES[s.scheme].ph)}" aria-label="Название">
        <button class="icon" data-s-act="del" data-k="${k}" title="Убрать" aria-label="Убрать"${s.items.length < 2 ? ' disabled' : ''}>✕</button>
      </div>`;
    if (!open.has(key)) {
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
  function periodSelect(path, period) {
    return `<select data-s="${path}">${Object.entries(PERIODS).map(([k, v]) => `<option value="${k}"${k === period ? ' selected' : ''}>${v.many}</option>`).join('')}</select>`;
  }

  /** Срок: «до даты» (календарь) или «через N периодов». */
  function deadlineCtl(path, dl, period, optional) {
    const P = PERIODS[period];
    return `<div class="deadline">
      ${optional ? `<label class="check"><input type="checkbox" data-s="${path}.on"${dl.on ? ' checked' : ''}> Есть срок</label>` : ''}
      ${!optional || dl.on ? `<div class="row2">
        <select data-s="${path}.mode" aria-label="Как задать срок"><option value="date"${dl.mode === 'date' ? ' selected' : ''}>до даты</option>
          <option value="n"${dl.mode === 'n' ? ' selected' : ''}>через</option></select>
        ${dl.mode === 'date' ? `<input type="date" data-s="${path}.date" value="${esc(dl.date)}" aria-label="Дата">`
          : `<input inputmode="numeric" class="n-in" data-s="${path}.value" data-num value="${fmtIn(dl.value)}" aria-label="Сколько"> <span>${plural(dl.value, P.forms)}</span>`}
      </div><p class="hint" data-dl-hint="${path}">${esc(deadlineText(dl, period))}</p>` : ''}
    </div>`;
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
          <label class="field">считаем по${periodSelect('goal.period', g.period)}</label>
        </div>
      </div>
      <div class="card s-step">
        <h2><span class="step-num">2</span><span>Сколько за ${P.acc} ${up ? 'прибавляете' : 'сбрасываете'}?</span></h2>
        <p class="sub">Сколько обычно — в нормальный период, без пропусков и срывов. Плохие периоды — в следующем шаге.</p>
        ${knowSeg('goal.step', g.step.know, ['exact', 'approx', 'history'])}
        ${valueEditor(g.step.know, g.step.v, 'goal.step.v', s.unit, { approxHint: 'Чаще всего выходит около «обычно».' })}
        ${g.hint ? `<p class="hint s-tip">💡 ${esc(g.hint)}</p>` : ''}
        <div class="s-err" data-err="step"></div>
      </div>
      <div class="card s-step">
        <h2><span class="step-num">3</span><span>Бывают плохие ${P.many}? <small>пропуски, болезнь, срывы</small></span></h2>
        <label class="check"><input type="checkbox" data-s="goal.setback.on"${g.setback.on ? ' checked' : ''}> Да, иногда не получается или откатываюсь назад</label>
        ${g.setback.on ? `<div class="maybe"><span>Бывает</span> ${chanceCtl('goal.setback.pct', g.setback.pct)}</div>
          <div class="sentence">и тогда назад на от <input inputmode="decimal" data-s="goal.setback.from" data-num value="${fmtIn(g.setback.from)}" aria-label="От">
          до <input inputmode="decimal" data-s="goal.setback.to" data-num value="${fmtIn(g.setback.to)}" aria-label="До"> ${u}
          <span class="muted">(0 — просто стою на месте)</span></div>` : ''}
        <div class="s-err" data-err="setback"></div>
      </div>
      <div class="card s-step">
        <h2><span class="step-num">4</span><span>Есть срок? <small>необязательно</small></span></h2>
        ${deadlineCtl('goal.deadline', g.deadline, g.period, true)}
      </div>`;
  }

  function formUntil(s) {
    const u = s.until, P = PERIODS[u.period], w = u.words;
    return `
      <div class="card s-step">
        <h2><span class="step-num">1</span><span>До какого срока?</span></h2>
        <div class="row2"><label class="field grow">Как назовём<input data-s="title" value="${esc(s.title)}"></label>
          <label class="field">считаем по${periodSelect('until.period', u.period)}</label></div>
        ${deadlineCtl('until.deadline', u.deadline, u.period, false)}
      </div>
      <div class="card s-step">
        <h2><span class="step-num">2</span><span>Сколько ${w.many} бывает за ${P.acc}?</span></h2>
        ${knowSeg('until.attempts', u.attempts.know, ['exact', 'approx', 'history'])}
        ${valueEditor(u.attempts.know, u.attempts.v, 'until.attempts.v', '', { approxHint: 'Считаются целыми: бывает 1, 2, 3, 4…' })}
        <div class="s-err" data-err="attempts"></div>
      </div>
      <div class="card s-step">
        <h2><span class="step-num">3</span><span>Как часто ${w.one} заканчивается ${w.succIns || 'успехом'}?</span></h2>
        <div class="maybe"><span>Получается</span> ${chanceCtl('until.pct', u.pct)}</div>
        ${w.hint ? `<p class="hint s-tip">💡 ${esc(w.hint)}</p>` : ''}
      </div>
      <div class="card s-step">
        <h2><span class="step-num">4</span><span>Сколько нужно?</span></h2>
        <label class="goal">Хотя бы <input inputmode="numeric" data-s="until.need" data-num value="${fmtIn(u.need)}" aria-label="Сколько нужно"> ${esc(plural(u.need, [w.succ, w.succFew, w.succMany]))}</label>
      </div>`;
  }

  function formTries(s) {
    const t = s.tries;
    return `
      <div class="card s-step">
        <h2><span class="step-num">1</span><span>Сколько попыток?</span></h2>
        <div class="row2"><label class="field grow">Как назовём<input data-s="title" value="${esc(s.title)}"></label></div>
        <div class="row2">
          <label class="field">сколько попыток<input inputmode="numeric" data-s="tries.n" data-num value="${fmtIn(t.n)}"></label>
          <label class="field grow">попытка — это<input data-s="tries.what" value="${esc(t.what)}" placeholder="собеседование, подход, бросок"></label>
        </div>
      </div>
      <div class="card s-step">
        <h2><span class="step-num">2</span><span>Как часто одна попытка удаётся?</span></h2>
        <div class="maybe"><span>Удаётся</span> ${chanceCtl('tries.pct', t.pct)}</div>
        <p class="hint s-tip">💡 ${esc(t.hint || 'Не знаете? Сколько раз из 10 обычно получается у вас или у похожих людей.')}</p>
      </div>
      <div class="card s-step">
        <h2><span class="step-num">3</span><span>Сколько нужно удачных?</span></h2>
        <label class="goal">Хотя бы <input inputmode="numeric" data-s="tries.need" data-num value="${fmtIn(t.need)}" aria-label="Сколько нужно"> из ${fmtIn(t.n)}</label>
      </div>`;
  }

  function renderStart(msg) {
    $('#s-editor').innerHTML = `
      <div class="card s-step s-ask">
        <h2><span>Что вы хотите узнать?</span></h2>
        <form class="ask" id="s-ask">
          <input id="s-q" placeholder="Например: найду ли работу до Нового года?" aria-label="Ваш вопрос" autocomplete="off">
          <button class="primary" type="submit">Дальше →</button>
        </form>
        ${msg ? `<p class="s-err">${esc(msg)}</p>` : ''}
        <p class="sub">Напишите своими словами — или нажмите на похожий вопрос:</p>
        <div class="chips">${QUESTIONS.map(q => `<button class="chip" data-s-act="ask" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div>
      </div>
      <div class="card s-step">
        <h3>Или выберите, на что похоже</h3>
        <div class="schemes">${Object.entries(SCHEMES).map(([k, v]) => `<button class="scheme" data-s-act="scheme" data-scheme="${k}">
          <span class="sc-icon" aria-hidden="true">${v.icon}</span><b>${v.title}</b><small>${v.sub}</small><em>${v.ex}</em></button>`).join('')}</div>
      </div>`;
    $('#s-results').innerHTML = `<section class="card s-empty"><h3>Здесь будет ответ</h3>
      <p class="sub">Напишите вопрос своими словами — я пойму, как его посчитать, и спрошу то, что нужно. Ответ появится сразу.</p></section>`;
    $('#s-sticky').hidden = true;
    $('#s-ask').addEventListener('submit', e => { e.preventDefault(); ask($('#s-q').value); });
  }

  function ask(text) {
    if (!String(text).trim()) { renderStart('Напишите вопрос — например, «найду ли работу до Нового года?».'); return; }
    const s = detect(text);
    if (!s) { renderStart(`Не понял, как посчитать «${String(text).trim()}». Выберите ниже, на что это похоже, — или переформулируйте.`); return; }
    calc.variants[calc.active] = s;
    open.clear(); last = null;
    if (s.items) open.add(`${calc.active}.0`);
    render(); changed();
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
    if (!s.scheme) { renderStart(); return; }
    const head = `<div class="s-scheme">${s.question
      ? `<span class="s-said">«${esc(s.question)}»</span> <span class="s-say">— похоже, ${esc(s.say || 'это можно посчитать так')}.</span>`
      : `<span>${SCHEMES[s.scheme].icon} ${SCHEMES[s.scheme].title}</span>`}
      <button class="link" data-s-act="change-scheme">${s.question ? 'не то?' : 'сменить'}</button></div>`;
    const form = s.scheme === 'goal' ? formGoal(s) : s.scheme === 'until' ? formUntil(s) : s.scheme === 'tries' ? formTries(s) : formParts(s);
    $('#s-editor').innerHTML = head + form;
    showErrors(check(s));
  }
  function showErrors(chk) { $$('[data-err]').forEach(el => { el.textContent = chk.items[el.dataset.err] || ''; }); }

  // ===================================================================================
  // События
  // ===================================================================================
  function bind() {
    const ed = $('#s-editor');
    const skip = el => el.id === 's-q';
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
      if (el.hasAttribute('data-num') && Number.isFinite(v) && /(tries\.(n|need)|until\.need|deadline\.value)$/.test(p)) v = Math.round(v);
      setPath(sit(), p, v);
      if (/\.byCause$/.test(p) && v) { const it = getPath(sit(), p.replace(/\.byCause$/, '')); if (!it.vc) it.vc = clone(it.v); }
      const structural = el.type === 'checkbox' || el.tagName === 'SELECT' || el.type === 'date' || (final && p === 'cause.name');
      if (structural) render();
      else {
        const h = el.hasAttribute('data-list') && $(`[data-hist="${p.replace(/\.history$/, '')}"]`);
        if (h) h.innerHTML = histHint(v.filter(Number.isFinite).length);
        if (/pct$/.test(p)) syncTen(p, v);
        if (/deadline\.value$/.test(p)) {
          const path = p.replace(/\.value$/, ''), s = sit(), per = s.goal ? s.goal.period : s.until.period;
          const hint = $(`[data-dl-hint="${path}"]`);
          if (hint) hint.textContent = deadlineText(getPath(s, path), per);
        }
        showErrors(check(sit()));
      }
      if (p === 'title') renderVariants();
      changed();
    };
    ed.addEventListener('input', e => {
      const el = e.target;
      if (skip(el) || el.type === 'checkbox' || el.tagName === 'SELECT' || el.type === 'date') return;
      onValue(e, false);
    });
    ed.addEventListener('change', e => {
      const el = e.target;
      if (skip(el)) return;
      if (el.type === 'checkbox' || el.tagName === 'SELECT' || el.type === 'date' || el.dataset.s === 'cause.name') onValue(e, true);
      else if (el.hasAttribute('data-num')) { const v = getPath(sit(), el.dataset.s); if (Number.isFinite(v)) el.value = fmtIn(v); }
    });
    document.addEventListener('click', e => {
      const b = e.target.closest('[data-s-act]');
      if (!b || !b.closest('#simple-view')) return;
      act(b.dataset.sAct, b);
    });
    $('#s-new').addEventListener('click', newCalc);
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
    if (a === 'ask') { ask(b.dataset.q); return; }
    if (a === 'scheme') { calc.variants[calc.active] = blank(b.dataset.scheme); open.clear(); open.add(`${calc.active}.0`); }
    else if (a === 'change-scheme') {
      if (!s.question && !confirm('Сменить тип ситуации? Введённые цифры пропадут.')) return;
      calc.variants[calc.active] = { scheme: null }; last = null;
    } else if (a === 'add') {
      s.items.push(item('', 'approx', unitKind(s.unit) === 'money' ? { usual: 1000, min: 500, max: 2000 } : { usual: 10, min: 5, max: 20 }));
      open.add(`${calc.active}.${s.items.length - 1}`);
      render(); changed();
      const names = $$('.s-name'); names[names.length - 1].focus();
      return;
    } else if (a === 'del') { s.items.splice(k, 1); open.clear(); }
    else if (a === 'open') open.add(`${calc.active}.${k}`);
    else if (a === 'close') { if (check(s).items[k]) return; open.delete(`${calc.active}.${k}`); render(); return; }
    else if (a === 'know') getPath(s, b.dataset.p).know = b.dataset.know;
    else if (a === 'ten') {
      // как звёздочки-оценки: повторный щелчок по единственному закрашенному кружку -> 0 из 10 («никогда»)
      const cur = getPath(s, b.dataset.p), n = +b.dataset.n;
      const val = n === 1 && Math.round((Number.isFinite(cur) ? cur : 0) / 10) === 1 ? 0 : n * 10;
      setPath(s, b.dataset.p, val);
      syncTen(b.dataset.p, val);
      const inp = $(`input[data-s="${b.dataset.p}"]`);
      if (inp) inp.value = fmtIn(val);
      showErrors(check(s)); changed();
      return;
    } else if (a === 'compare') {
      const copy = clone(s);
      copy.title = (s.title ? s.title + ' — ' : '') + 'другой вариант';
      calc.variants.push(copy); calc.active = 1; open.clear();
    } else if (a === 'tab') { calc.active = +b.dataset.i; open.clear(); }
    else if (a === 'drop-b') { calc.variants = [calc.variants[0]]; calc.active = 0; open.clear(); }
    else if (a === 'my-open') { const x = myList().find(m => m.id === b.dataset.id); if (x) { calc = x.calc; calc.variants.forEach(upgrade); open.clear(); last = null; } toggleMy(false); }
    else if (a === 'my-del') { tryStore(() => localStorage.setItem(KEY_MY, JSON.stringify(myList().filter(m => m.id !== b.dataset.id)))); renderMy(); renderMyCount(); return; }
    else return;
    render(); changed();
  }

  function newCalc() {
    calc = calcOf({ scheme: null });
    open.clear(); last = null;
    render();
    tryStore(() => localStorage.setItem(KEY_CUR, JSON.stringify(calc)));
    const q = $('#s-q'); if (q) q.focus();
  }

  // ---------------------------------------------------------------- «Мои расчёты» и ссылка
  function renderMyCount() { const n = myList().length; $('#s-my').textContent = `Мои расчёты${n ? ` (${n})` : ''}`; }
  function toggleMy(force) {
    const box = $('#s-my-list'), show = typeof force === 'boolean' ? force : box.hidden;
    box.hidden = !show;
    if (show) renderMy();
  }
  function renderMy() {
    const list = myList();
    $('#s-my-list').innerHTML = list.length ? `<ul>${list.map(x => {
      const v = x.calc.variants[0];
      return `<li><button class="link" data-s-act="my-open" data-id="${x.id}">${esc(v.title || 'Без названия')}${x.calc.variants.length > 1 ? ' · 2 варианта' : ''}</button>
        <span class="muted">${new Date(x.saved).toLocaleDateString('ru-RU')}</span>
        <button class="icon" data-s-act="my-del" data-id="${x.id}" title="Удалить" aria-label="Удалить">✕</button></li>`;
    }).join('')}</ul>` : '<p class="sub">Пока пусто. Расчёты сохраняются здесь сами, как только вы начнёте вписывать цифры.</p>';
  }
  const b64 = s => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unb64 = s => decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))));
  function shareLink() { return `${location.href.split('#')[0]}#s=${b64(JSON.stringify({ variants: calc.variants, active: calc.active }))}`; }
  async function share() {
    if (!sit().scheme) return;
    const url = shareLink(), btn = $('#s-share');
    let ok = false;
    try { await navigator.clipboard.writeText(url); ok = true; } catch (e) { ok = false; }
    if (ok) { btn.textContent = '✓ Ссылка скопирована'; setTimeout(() => { btn.textContent = '🔗 Поделиться'; }, 2500); }
    else prompt('Скопируйте ссылку:', url);
  }

  function changed() { saveMy(); clearTimeout(timer); timer = setTimeout(run, 400); }

  // ===================================================================================
  // Расчёт
  // ===================================================================================
  const frame = () => new Promise(r => setTimeout(r, 0));
  async function runP(sc, n, my) {
    const m = MC.compile(sc), r = MC.createRun(m, { n, seed: SEED });
    while (!r.step(20000)) { await frame(); if (my !== token) throw new Error('cancel'); }
    return { model: m, run: r, summary: MC.summarize(r) };
  }
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
    for (let n = need; n <= 5000; n++) if (binomAtLeast(n, p, need) >= target) return n;
    return Infinity;
  }
  function metric(s, S) {
    if (S.event) return { kind: 'p', value: S.event.p };
    return { kind: s.scheme === 'goal' ? 'median' : 'p90', value: s.scheme === 'goal' ? S.result.pct[50] : S.result.pct[90] };
  }
  /** Изменить «что вы знаете» (для «+1 собеседование в неделю», «темп на 20 % быстрее»). */
  function bump(st, d) {
    const v = st.v, f = x => (d.mul ? x * d.mul : x + d.add);
    if (st.know === 'exact') v.exact = f(v.exact);
    else if (st.know === 'approx') ['usual', 'min', 'max'].forEach(k => { v[k] = f(v[k]); });
    else v.history = v.history.map(f);
  }

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
      const t = clone(s); bump(t.goal.step, { mul: 1.2 });
      out.push({ name: 'Темп на 20 % быстрее', what: `за ${P.acc} на пятую часть больше`, s: t });
    } else if (s.scheme === 'until') {
      const u = s.until, w = u.words, P = PERIODS[u.period];
      const t1 = clone(s); bump(t1.until.attempts, { add: 1 });
      out.push({ name: `+1 ${w.one} в ${P.acc}`, what: 'чуть больше активности', s: t1 });
      if (u.pct <= 90) { const t2 = clone(s); t2.until.pct = u.pct + 10; out.push({ name: `${w.one[0].toUpperCase() + w.one.slice(1)} удаётся чаще`, what: `на 1 из 10 (${tenText(u.pct + 10)}) — лучше подготовиться`, s: t2 }); }
      const t3 = clone(s), dl = t3.until.deadline;
      if (dl.mode === 'date') { const d = fromIso(dl.date); d.setMonth(d.getMonth() + 1); dl.date = iso(d); } else dl.value += Math.round(P.perMonth);
      out.push({ name: 'Срок на месяц позже', what: deadlineText(dl, u.period).replace(/ — .*$/, ''), s: t3 });
    }
    return out;
  }

  async function run() {
    if (!calc || !sit().scheme) return;
    const my = ++token, box = $('#s-results'), s = sit();
    const chk = check(s);
    showErrors(chk);
    const fail = (title, text) => {
      box.innerHTML = `<section class="card s-fix"><h3>${title}</h3>${text}</section>`;
      sticky(`<span class="st-main"><b>${title}</b></span><span class="st-go">↓</span>`, 'bad');
    };
    if (!chk.ok) { fail('Чтобы посчитать, поправьте:', `<ul class="plain">${[...chk.global, ...Object.values(chk.items)].map(m => `<li>${esc(m)}</li>`).join('')}</ul>`); return; }
    if (s.scheme === 'goal' && s.goal.start !== s.goal.target && meanStep(s.goal) <= 0) {
      fail('С такими цифрами цель не приближается', `<p>В среднем за ${PERIODS[s.goal.period].acc} вы ${meanStep(s.goal) < 0 ? 'откатываетесь назад' : 'стоите на месте'}: плохие периоды съедают весь прогресс. Проверьте темп и откаты.</p>`);
      return;
    }
    if (s.scheme === 'until' && (s.until.pct <= 0 || meanOf(s.until.attempts.know, s.until.attempts.v) <= 0)) {
      fail('Так не получится никогда', `<p>${s.until.pct <= 0 ? `Если ${s.until.words.one} никогда не удаётся, сколько ни пробуй — результата не будет.` : `Если ${s.until.words.many} нет совсем, результата не будет.`} Проверьте цифры.</p>`);
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
      const ideas = [];
      if (s.scheme === 'tries') {
        const t = s.tries, p = t.pct / 100, more = t.n >= 5 ? 3 : 1;
        ideas.push({ name: `Ещё ${more} ${plural(more, ['попытка', 'попытки', 'попыток'])}`, what: `всего ${t.n + more}`, metric: { kind: 'p', value: binomAtLeast(t.n + more, p, t.need) } });
        if (t.pct <= 90) ideas.push({ name: 'Подготовиться лучше', what: `попытка удаётся на 1 из 10 чаще (${tenText(t.pct + 10)})`, metric: { kind: 'p', value: binomAtLeast(t.n, Math.min(1, p + 0.1), t.need) } });
      } else {
        for (const idea of ideasFor(s)) {
          const r = await runP(toScenario(idea.s), N_IDEA, my);
          ideas.push({ ...idea, metric: metric(idea.s, r.summary) });
        }
      }
      last.ideas = ideas;
      if ((s.scheme === 'parts' || s.scheme === 'all') && s.cause.on) last.indep = (await runP(MC.independentVersion(sc), N_IDEA, my)).summary;
      if (calc.variants.length === 2) {
        const o = calc.variants[1 - calc.active];
        if (o.scheme && check(o).ok && !(o.scheme === 'goal' && meanStep(o.goal) <= 0 && o.goal.start !== o.goal.target)
          && !(o.scheme === 'until' && o.until.pct <= 0)) {
          const r = await runP(toScenario(o), N, my);
          last.other = { s: clone(o), summary: r.summary, label: calc.active ? 'А' : 'Б' };
        }
      }
    } catch (e) { if (e.message === 'cancel') return; throw e; }
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
  const dots = p => { const k = Math.round(p * 100); return `<div class="dots" role="img" aria-label="${k} из 100">${Array.from({ length: 100 }, (_, i) => `<i class="${i < k ? 'y' : 'n'}"></i>`).join('')}</div>`; };
  const dot2 = s => s.replace(/\.(<\/b>)?\./g, '.$1');

  function words(s) {
    const dlShort = (dl, per) => deadlineText(dl, per).replace(/ — .*$/, '');
    if (s.scheme === 'goal') return { yes: 'успеете', no: 'не успеете', q: `${s.title || 'Цель'}: успею ${dlShort(s.goal.deadline, s.goal.period)}?` };
    if (s.scheme === 'until') { const u = s.until; return { yes: u.words.act, no: `не ${u.words.act}`, q: `${s.title}: ${dlShort(u.deadline, u.period)}?` }; }
    if (s.scheme === 'tries') return { yes: s.tries.act || 'получится', no: `не ${s.tries.act || 'получится'}`, q: `${s.title || 'Попытки'}: хотя бы ${s.tries.need} из ${s.tries.n}?` };
    const k = unitKind(s.unit);
    if (s.scheme === 'all') return { yes: 'дождётесь', no: 'не дождётесь', inf: 'дождаться всех', q: `${s.title || 'Ситуация'}: всё будет готово за ${fmtVal(s.limit.value, s.unit)}?`, reserve: 'закладывайте' };
    if (k === 'time') return { yes: 'успеете', no: 'не успеете', inf: 'успеть', q: `${s.title || 'Ситуация'}: успею за ${fmtVal(s.limit.value, s.unit)}?`, reserve: 'закладывайте' };
    if (k === 'money') return { yes: 'хватит', no: 'не хватит', inf: 'хватило', q: `${s.title || 'Ситуация'}: хватит ${fmtVal(s.limit.value, s.unit)}?`, reserve: 'берите' };
    return { yes: 'уложитесь', no: 'не уложитесь', inf: 'уложиться', q: `${s.title || 'Ситуация'}: уложусь в ${fmtVal(s.limit.value, s.unit)}?`, reserve: 'закладывайте' };
  }
  function metricText(m, s) {
    if (m.kind === 'p') return `${of100(m.value)} из 100`;
    if (m.kind === 'median') return fmtPeriods(m.value, s.goal.period);
    return fmtVal(m.value, s.unit);
  }
  function countLE(sorted, x) {
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] <= x) lo = mid + 1; else hi = mid; }
    return lo;
  }

  function renderAnswer() {
    const { s, main } = last, S = main.summary, ev = S.event, R = S.result, W = words(s);
    const isGoal = s.scheme === 'goal', isUntil = s.scheme === 'until', isTries = s.scheme === 'tries', timeline = isGoal || isUntil;
    const period = isGoal ? s.goal.period : isUntil ? s.until.period : null, P = period ? PERIODS[period] : null;
    const fv = x => (timeline ? fmtPeriods(x, period) : isTries ? `${Math.round(x)} из ${s.tries.n}` : fmtVal(x, s.unit));
    const notReached = timeline ? 1 - countLE(R.sorted, P.max) / R.sorted.length : 0;
    let html = '';

    if (ev) {
      const [lvl, word, icon] = verdict(ev.p);
      html += `<section class="card s-answer">
        <div class="badge-${lvl}"><span class="b-icon">${icon}</span>${word}</div>
        <div class="s-q">${esc(W.q)}</div>
        <div class="s-big">${of100(ev.p)} <span>из 100</span></div>
        <div class="s-sub">Примерно в ${of100(ev.p)} случаях из 100 ${esc(W.yes)}.</div>
        ${dots(ev.p)}
        <div class="legend"><span><i class="sw s1"></i>${esc(W.yes)}</span><span><i class="sw nn"></i>${esc(W.no)}</span></div>
      </section>`;
      sticky(`<span class="st-main"><b>${of100(ev.p)} из 100</b> · ${word}</span><span class="st-go">ответ ↓</span>`, lvl);
    } else {
      const label = isGoal ? 'Скорее всего дойдёте до цели за' : s.scheme === 'all' ? 'Скорее всего всё будет готово через' : 'Скорее всего выйдет';
      html += `<section class="card s-answer"><div class="s-q">${esc(s.title || '')}</div><div class="s-label">${label}</div>
        <div class="s-big s-big-text">${fv(R.pct[50])}</div><div class="s-sub">В 8 случаях из 10 — от ${fv(R.pct[10])} до ${fv(R.pct[90])}.</div></section>`;
      sticky(`<span class="st-main"><b>≈ ${fv(R.pct[50])}</b></span><span class="st-go">ответ ↓</span>`, 'good');
    }

    const lines = [];
    if (isTries) {
      const t = s.tries, p = t.pct / 100;
      lines.push(`Скорее всего удачных будет ${Math.round(R.pct[50])} из ${t.n}.`);
      const n90 = triesFor(p, t.need, 0.9), n99 = triesFor(p, t.need, 0.99);
      lines.push(Number.isFinite(n90) ? `Чтобы получить хотя бы ${t.need} в 9 случаях из 10, нужно примерно <b>${n90} ${plural(n90, ['попытка', 'попытки', 'попыток'])}</b>; почти наверняка (99 из 100) — ${n99}.`
        : 'С таким шансом одной попытки нужного числа удач почти не набрать.');
    } else if (timeline) {
      lines.push(`Скорее всего ${isUntil ? esc(s.until.words.act) : 'дойдёте до цели'} за <b>${fmtPeriods(R.pct[50], period)}</b>.`);
      if (R.pct[90] <= P.max) lines.push(`Чтобы почти наверняка (9 из 10) — нужно <b>${fmtPeriods(Math.ceil(R.pct[90]), period)}</b>.`);
      if (R.pct[10] < R.pct[50]) lines.push(`Если повезёт (1 из 10) — уже за ${fmtPeriods(Math.max(1, Math.floor(R.pct[10])), period)}.`);
      if (isUntil) {
        const u = s.until, Wp = deadlinePeriods(u.deadline, period), need = triesFor(u.pct / 100, u.need, 0.9);
        if (Number.isFinite(need) && Wp >= 1) {
          const per = Math.ceil(need / Wp);
          lines.push(`Чтобы ${esc(u.words.inf || 'получилось')} ${deadlineText(u.deadline, period).replace(/ — .*$/, '')} в 9 случаях из 10, нужно около ${need} ${plural(need, [u.words.one, u.words.few, u.words.many])} — примерно <b>${per} в ${P.acc}</b>.`);
        }
      }
    } else {
      if (ev) lines.push(`Скорее всего выйдет ${fmtVal(R.pct[50], s.unit)}.`);
      lines.push(`Чтобы ${W.inf} в 9 случаях из 10 — ${W.reserve} <b>${fmtVal(R.pct[90], s.unit)}</b>.`);
      lines.push(`Почти наверняка (99 из 100) — ${fmtVal(R.pct[99], s.unit)}.`);
      if (s.scheme === 'parts') {
        const plan = s.items.reduce((a, it) => a + (it.know === 'exact' ? it.v.exact : it.know === 'approx' ? it.v.usual
          : it.know === 'maybe' ? (it.v.pct > 50 ? (it.v.from + it.v.to) / 2 : 0) : median(it.v.history)), 0);
        lines.push(`Если всё пойдёт «как обычно», выйдет ${fmtVal(plan, s.unit)} — но так или лучше бывает только в ${of100(countLE(R.sorted, plan) / R.sorted.length)} случаях из 100.`);
      }
    }
    html += `<section class="card"><h3>${isTries ? 'Чего ждать' : 'Чего ждать и какой нужен запас'}</h3><ul class="plain">${lines.map(l => `<li>${dot2(l)}</li>`).join('')}</ul></section>`;

    const warn = [];
    if (timeline && notReached > 0.01) warn.push(`В ${of100(notReached)} случаях из 100 это не происходит даже за ${fmtPeriods(P.max, period)}. Похоже, темп слишком медленный.`);
    const few = [];
    const hist = (name, v, know) => { if (know === 'history' && v.history.length < 5) few.push(name); };
    if (s.items) s.items.forEach((it, k) => hist(it.name || `Пункт ${k + 1}`, it.v, it.know));
    if (isGoal) hist('темп', s.goal.step.v, s.goal.step.know);
    if (isUntil) hist(s.until.words.many, s.until.attempts.v, s.until.attempts.know);
    if (few.length) warn.push(`Мало прошлых значений (${few.map(x => `«${esc(x)}»`).join(', ')}): ответ примерный. Чем больше впишете, тем точнее.`);
    if (warn.length) html += `<section class="card s-warn"><h3>Обратите внимание</h3><ul class="plain">${warn.map(w => `<li>${w}</li>`).join('')}</ul></section>`;

    const base = metric(s, S);
    if (!last.ideas) html += `<section class="card"><h3>Что поможет больше всего</h3><p class="sub">Считаю…</p></section>`;
    else {
      const better = m => (m.kind === 'p' ? m.value - base.value : base.value - m.value);
      const good = last.ideas.filter(x => better(x.metric) > (base.kind === 'p' ? 0.005 : 1e-9)).sort((a, b) => better(b.metric) - better(a.metric));
      const was = metricText(base, s);
      html += `<section class="card"><h3>Что поможет больше всего</h3>${good.length
        ? `<p class="sub">${base.kind === 'p' ? `Сейчас ${esc(W.yes)} в ${was}. Если изменить одно:` : base.kind === 'median' ? `Сейчас скорее всего ${was}. Если изменить одно:` : `Сейчас в плохом случае (1 из 10) ${was}. Если изменить одно:`}</p>
          <div class="ideas">${good.slice(0, 5).map(x => {
            const gain = better(x.metric);
            const width = base.kind === 'p' ? [base.value * 100, gain * 100] : [60, Math.min(40, 40 * gain / Math.max(1e-9, base.value))];
            return `<div class="idea"><div class="idea-text"><b>${esc(x.name)}</b> — ${esc(x.what)}</div>
              <div class="idea-bar"><span class="now" style="width:${width[0]}%"></span><span class="gain" style="width:${width[1]}%"></span></div>
              <div class="idea-num">${metricText(x.metric, s)}${base.kind === 'p' ? ` <small>+${Math.round(gain * 100)}</small>` : ''}</div></div>`;
          }).join('')}</div>` : '<p class="sub">Ни одна отдельная вещь заметно не влияет.</p>'}</section>`;
    }

    if (last.indep && ev) {
      const p2 = last.indep.event.p, d = Math.round((p2 - ev.p) * 100);
      html += `<section class="card"><h3>Почему важна общая причина</h3><p>Если считать части по отдельности и забыть, что «${esc(s.cause.name)}» портит сразу несколько, получилось бы
        <b>${of100(p2)} из 100</b>${d ? ` — на ${Math.abs(d)} ${d > 0 ? 'больше' : 'меньше'}, чем на самом деле` : ', почти так же'}. Плохие случаи приходят вместе.</p></section>`;
    }

    if (calc.variants.length === 2) {
      const o = last.other, me = calc.active ? 'Б' : 'А';
      if (!o) html += `<section class="card"><h3>Сравнение вариантов</h3><p class="sub">${calc.variants[1 - calc.active].scheme && check(calc.variants[1 - calc.active]).ok ? 'Считаю…' : 'Во втором варианте нужно заполнить ответы.'}</p></section>`;
      else {
        const mo = metric(o.s, o.summary), mm = base;
        let verdictTxt = '';
        if (mo.kind === mm.kind) {
          const diff = mm.kind === 'p' ? mm.value - mo.value : mo.value - mm.value;
          const big = mm.kind === 'p' ? Math.abs(diff) >= 0.01 : Math.abs(diff) > 1e-9 && Math.abs(diff) / Math.max(1e-9, mo.value) >= 0.02;
          verdictTxt = !big ? 'Варианты почти одинаковые.' : `Лучше вариант <b>${diff > 0 ? me : o.label}</b>.`;
        }
        const p90 = (sx, Sx) => (sx.scheme === 'goal' ? fmtPeriods(Sx.result.pct[90], sx.goal.period) : sx.scheme === 'until' ? fmtPeriods(Sx.result.pct[90], sx.until.period)
          : sx.scheme === 'tries' ? '—' : fmtVal(Sx.result.pct[90], sx.unit));
        html += `<section class="card"><h3>Сравнение вариантов</h3>
          <div class="table-wrap"><table class="cmp"><thead><tr><th></th><th>Вариант ${me} (сейчас)</th><th>Вариант ${o.label}</th></tr></thead><tbody>
          <tr><td>${mm.kind === 'p' ? `Шанс, что ${esc(W.yes)}` : mm.kind === 'median' ? 'Скорее всего' : 'В плохом случае (1 из 10)'}</td><td>${metricText(mm, s)}</td><td>${metricText(mo, o.s)}</td></tr>
          ${!isTries ? `<tr><td>Запас на 9 из 10</td><td>${p90(s, S)}</td><td>${p90(o.s, o.summary)}</td></tr>` : ''}
          </tbody></table></div><p class="verdict">${verdictTxt}</p></section>`;
      }
    }

    if (!isTries) html += `<section class="card"><h3>${timeline ? `Сколько ${P.forms[2]} уходит` : 'Как часто какой итог'}</h3>
      ${ev ? `<div class="legend"><span><i class="sw s1"></i>${esc(W.yes)}</span><span><i class="sw s2"></i>${esc(W.no)}</span></div>` : ''}
      <div class="chart" id="s-hist"></div></section>`;

    const hinted = (s.goal && s.goal.hint) || (s.until && s.until.words.hint) || (s.tries && s.tries.hint);
    html += `<p class="note s-honest">Ответ настолько точен, насколько точны ваши оценки${hinted ? ' (подсказки «не знаете?» — очень примерные)' : ''}. Программа проигрывает ситуацию ${S.n.toLocaleString('ru-RU')} раз.</p>
      <details class="card s-details"><summary>Подробности для специалиста</summary>
      <ul class="plain">
        ${ev ? `<li>Вероятность: ${pct(ev.p, 2)} ± ${pct(ev.hi - ev.p, 2)} (95 % интервал), ${S.n.toLocaleString('ru-RU')} прогонов, сид ${SEED}.</li>` : `<li>${S.n.toLocaleString('ru-RU')} прогонов Монте-Карло, сид ${SEED}. Перцентили: P10 ${num(R.pct[10])}, P50 ${num(R.pct[50])}, P90 ${num(R.pct[90])}, P99 ${num(R.pct[99])}.</li>`}
        ${last.exact && ev ? `<li>Точный ответ полным перебором ${last.exact.combos.toLocaleString('ru-RU')} вариантов: ${pct(last.exact.p, 2)}.</li>` : ''}
        ${isTries && ev ? `<li>Точно по биномиальной формуле: ${pct(binomAtLeast(s.tries.n, s.tries.pct / 100, s.tries.need), 2)}.</li>` : ''}
        <li>Итог: <code>${esc(last.sc.result.formula)}</code>${last.sc.event ? `, успех: <code>${esc(last.sc.event.formula)}</code>` : ''}.</li>
      </ul>
      <button class="btn" id="s-to-expert">Открыть в режиме специалиста →</button></details>`;

    $('#s-results').innerHTML = html;
    drawHist();
    $('#s-to-expert').addEventListener('click', () => PA.openExpert(last.sc, { n: 1000000, seed: SEED }));
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
    const W = words(s), period = s.goal ? s.goal.period : s.until ? s.until.period : null;
    const unit = period ? PERIODS[period].forms[2] : s.unit;
    Charts.histogram(el, { title: 'Разброс', bins, discrete: h.discrete, hasEvent: !!run.event, unit,
      resultLabel: period ? 'Срок' : 'Итог', axisLabel: unit, yesLabel: W.yes, noLabel: W.no });
  }

  function sticky(html, lvl) { const el = $('#s-sticky'); el.innerHTML = html; el.className = `s-sticky lvl-${lvl}`; el.hidden = false; }

  // ===================================================================================
  function init() {
    bind();
    const h = location.hash;
    let fromLink = null;
    if (h.startsWith('#s=')) fromLink = tryStore(() => JSON.parse(unb64(h.slice(3))), null);
    const exId = (/^#simple=(\w+)$/.exec(h) || [])[1];
    const qm = /^#q=(.+)$/.exec(h);
    const saved = tryStore(() => JSON.parse(localStorage.getItem(KEY_CUR)), null);
    if (fromLink && Array.isArray(fromLink.variants)) calc = { ...calcOf(fromLink.variants[0]), variants: fromLink.variants.map(upgrade), active: fromLink.active || 0 };
    else if (exId && exId !== 'new' && example(exId)) calc = calcOf(example(exId));
    else if (qm) { calc = calcOf({ scheme: null }); const s = detect(decodeURIComponent(qm[1])); if (s) calc.variants[0] = s; }
    else if (exId === 'new') calc = calcOf({ scheme: null });
    else if (saved && Array.isArray(saved.variants)) { calc = saved; calc.variants.forEach(upgrade); }
    else calc = calcOf({ scheme: null });
    renderMyCount();
    render();
    document.addEventListener('pa:mode', e => { if (e.detail !== 'simple') return; if (!last) run(); else drawHist(); });
    let rt;
    window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(drawHist, 150); });
  }

  return {
    init, toScenario, check, detect, parseDeadline, EXAMPLES, TOPICS, fmtVal, fmtPeriods, binomAtLeast, triesFor, shareLink,
    load(simple) { calc = calcOf(simple && simple.scheme ? upgrade(simple) : { scheme: null }); open.clear(); render(); changed(); },
    get calc() { return calc; }, get last() { return last; },
  };
})();
