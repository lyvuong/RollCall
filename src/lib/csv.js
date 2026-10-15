/** Parse CSV/TSV text (quotes, escaped quotes, CRLF, BOM, auto delimiter) into rows of strings. */
export function parseCSV(text) {
  text = String(text || '').replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0];
  const count = (ch) => firstLine.split(ch).length - 1;
  const delim = [',', '\t', ';'].sort((a, b) => count(b) - count(a))[0];

  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (field += '"'), i++;
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) (row.push(field), (field = ''));
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) (row.push(field), rows.push(row));

  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Turn rows into objects keyed by canonical field names.
 * `aliases` = { field: ['header', 'alt header', ...] } (compared after normalizing).
 * Each object also has `_line` (1-based line number incl. header).
 */
export function toObjects(rows, aliases) {
  if (!rows.length) return { objects: [], missing: Object.keys(aliases), headers: [] };
  const headers = rows[0].map(norm);
  const index = {};
  for (const [field, names] of Object.entries(aliases)) {
    const i = headers.findIndex((h) => names.map(norm).includes(h));
    if (i >= 0) index[field] = i;
  }
  const objects = rows.slice(1).map((r, n) => {
    const o = { _line: n + 2 };
    for (const [field, i] of Object.entries(index)) o[field] = (r[i] ?? '').trim();
    return o;
  });
  return { objects, missing: Object.keys(aliases).filter((f) => !(f in index)), headers: rows[0] };
}

export function toCSV(rows) {
  const q = (v) => (/[",\r\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return rows.map((r) => r.map((v) => q(v ?? '')).join(',')).join('\r\n') + '\r\n';
}
