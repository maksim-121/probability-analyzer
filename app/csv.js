/*
 * Разбор CSV для фактора «Из данных».
 * Понимает файлы русского Excel: разделитель «;», дробная часть через запятую (2,5), BOM в начале.
 * Также: разделитель «,» или табуляция, кавычки "…" (внутри "" = кавычка), строка заголовков (если есть).
 *
 * CSV.parse(text) -> { delimiter, hasHeader, rows, columns: [{ name, values: [числа], skipped, empty }] }
 *   values  — только числа (пустые ячейки и текст пропускаются)
 *   skipped — сколько ячеек с текстом пропущено (например, «да» / «нет»)
 */
const CSV = (() => {
  'use strict';

  function splitLine(line, d) {
    const out = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') q = false;
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === d) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  }

  /** «2,5» -> 2.5; «1 200» -> 1200; пусто -> null; текст -> NaN */
  function cellNumber(s) {
    const t = s.trim().replace(/[\s ]/g, '').replace(',', '.');
    if (t === '') return null;
    return /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t) ? Number(t) : NaN;
  }

  function detectDelimiter(line) {
    const count = ch => splitLine(line, ch).length - 1;
    if (count(';') > 0) return ';';
    if (count('\t') > 0) return '\t';
    if (count(',') > 0) return ',';
    return null;                       // один столбец
  }

  function parse(text) {
    const lines = String(text).replace(/^﻿/, '').split(/\r\n|\n|\r/).filter(l => l.trim() !== '');
    if (!lines.length) return { delimiter: null, hasHeader: false, rows: 0, columns: [] };
    const d = detectDelimiter(lines[0]);
    const table = lines.map(l => (d ? splitLine(l, d) : [l]));
    const width = Math.max(...table.map(r => r.length));
    // первая строка — заголовок, если в ней есть непустой нечисловой текст
    const hasHeader = table[0].some(c => Number.isNaN(cellNumber(c)));
    const body = hasHeader ? table.slice(1) : table;
    const columns = [];
    for (let k = 0; k < width; k++) {
      const name = (hasHeader && (table[0][k] || '').trim()) || `Столбец ${k + 1}`;
      const values = [];
      let skipped = 0, empty = 0;
      for (const r of body) {
        const v = cellNumber(r[k] === undefined ? '' : r[k]);
        if (v === null) empty++;
        else if (Number.isNaN(v)) skipped++;
        else values.push(v);
      }
      columns.push({ name, values, skipped, empty });
    }
    return { delimiter: d, hasHeader, rows: body.length, columns };
  }

  // ---------------------------------------------------------------- «строки целиком»
  const YES = new Set(['да', 'yes', 'true', 'истина', 'д', 'y']);
  const NO = new Set(['нет', 'no', 'false', 'ложь', 'н', 'n']);
  const NAME_START = /[A-Za-zА-Яа-яЁё_]/;
  const RESERVED = new Set(['и', 'или', 'не', 'and', 'or', 'not', 'да', 'нет', 'true', 'false', 'max', 'min', 'макс',
    'мин', 'abs', 'модуль', 'round', 'округл', 'floor', 'вниз', 'ceil', 'вверх', 'sqrt', 'корень', 'if', 'если']);

  /** Название столбца -> имя для формул: «Обед, мин» -> «Обед_мин». */
  function safeName(raw, taken) {
    let s = String(raw).trim().replace(/[^A-Za-zА-Яа-яЁё_0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (!s || !NAME_START.test(s[0])) s = 'С_' + s;
    if (RESERVED.has(s.toLowerCase())) s += '_';
    let out = s;
    for (let k = 2; taken.has(out.toLowerCase()); k++) out = `${s}_${k}`;
    taken.add(out.toLowerCase());
    return out;
  }

  /**
   * Таблица целиком, для фактора «Строки таблицы».
   * Берём столбцы, где все непустые ячейки — числа или «да / нет» (-> 1 / 0); остальные (дата, текст) отбрасываем.
   * Строки, где в нужном столбце пусто, пропускаем (иначе строка «развалится»).
   * -> { columns: [имена для формул], rows: [[числа]], dropped: [исходные имена], skipped, renamed: [[было, стало]] }
   */
  function toRows(text) {
    const lines = String(text).replace(/^﻿/, '').split(/\r\n|\n|\r/).filter(l => l.trim() !== '');
    const empty = { columns: [], rows: [], dropped: [], skipped: 0, renamed: [] };
    if (!lines.length) return empty;
    const d = detectDelimiter(lines[0]);
    const table = lines.map(l => (d ? splitLine(l, d) : [l]));
    const width = Math.max(...table.map(r => r.length));
    const hasHeader = table[0].some(c => {
      const t = c.trim().toLowerCase();
      return t !== '' && Number.isNaN(cellNumber(c)) && !YES.has(t) && !NO.has(t);
    });
    const body = hasHeader ? table.slice(1) : table;
    const conv = [];   // для каждого столбца: функция ячейка -> число | null (пусто) | NaN (не подходит)
    const keep = [], names = [], dropped = [], renamed = [], taken = new Set();
    for (let k = 0; k < width; k++) {
      const raw = (hasHeader && (table[0][k] || '').trim()) || `Столбец ${k + 1}`;
      const cells = body.map(r => (r[k] === undefined ? '' : r[k]));
      const filled = cells.filter(c => c.trim() !== '');
      const isNum = filled.length && filled.every(c => !Number.isNaN(cellNumber(c)));
      const isBool = filled.length && filled.every(c => YES.has(c.trim().toLowerCase()) || NO.has(c.trim().toLowerCase()));
      if (!isNum && !isBool) { dropped.push(raw); continue; }
      const name = safeName(raw, taken);
      if (name !== raw) renamed.push([raw, name]);
      keep.push(k);
      names.push(name);
      conv[k] = isNum ? c => cellNumber(c) : c => {
        const t = c.trim().toLowerCase();
        return t === '' ? null : YES.has(t) ? 1 : 0;
      };
    }
    const rows = [];
    let skipped = 0;
    for (const r of body) {
      const vals = keep.map(k => conv[k](r[k] === undefined ? '' : r[k]));
      if (vals.some(v => v === null)) skipped++;
      else rows.push(vals);
    }
    return { columns: names, rows, dropped, skipped, renamed };
  }

  return { parse, cellNumber, toRows, safeName };
})();
