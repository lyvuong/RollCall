/** Reaction poll: anonymous thumbs up / sideways / down per event. Pure logic; storage is in data.js. */

export const REACTIONS = [
  { key: 'up', label: 'Thumbs up', emoji: '👍' },
  { key: 'mid', label: 'Thumbs sideways', emoji: '👌' },
  { key: 'down', label: 'Thumbs down', emoji: '👎' },
];

export const MAX_COUNT = 500;

/** A whole number between 0 and MAX_COUNT; anything else becomes 0. */
export function clampCount(n) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v < 0) return 0;
  return Math.min(v, MAX_COUNT);
}

/** { up, mid, down } with every count clamped. */
export const cleanCounts = (c = {}) => ({ up: clampCount(c.up), mid: clampCount(c.mid), down: clampCount(c.down) });

/** Sum reaction docs: { up, mid, down, total, entries }. */
export function tally(docs = []) {
  const t = { up: 0, mid: 0, down: 0 };
  for (const d of docs) for (const { key } of REACTIONS) t[key] += clampCount(d[key]);
  return { ...t, total: t.up + t.mid + t.down, entries: docs.length };
}

/** Whole-number percentage of the total, 0 when there are no reactions. */
export const percent = (n, total) => (total > 0 ? Math.round((n / total) * 100) : 0);

/** One line for the event page, e.g. "👍 5 · 👌 2 · 👎 1"; empty string when nothing was recorded. */
export function summaryLine(t) {
  if (!t.total) return '';
  return REACTIONS.map((r) => `${r.emoji} ${t[r.key]}`).join(' · ');
}

/** CSV rows (header first) for the Report: one row per event that has reactions. */
export function pollRows(events, reactionsByEvent) {
  const rows = [['Event', 'Date', 'Thumbs up', 'Thumbs sideways', 'Thumbs down', 'Total', 'Entries']];
  for (const e of events) {
    const t = tally(reactionsByEvent[e.id] || []);
    if (!t.total) continue;
    rows.push([e.name, e.date, t.up, t.mid, t.down, t.total, t.entries]);
  }
  return rows;
}
