import { parseDate, parseTime } from './importer.js';
import { toMinutes } from './time.js';

const lower = (s) => String(s || '').trim().toLowerCase();
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const DEFAULT_START = '09:00';

/**
 * Build a write plan from events returned by /api/neon/events.
 * neonEvents = [{neonEventId, name, date, startTime, endTime, location?}]
 * existing   = { events:[{id, name, date, startTime, neonEventId?}], locations:[{id, name}] }
 * newId(collection) -> string (keeps the plan pure and testable).
 *
 * Matching: neonEventId first, then name|date|startTime. A match only gets its
 * neonEventId linked (merge), never its attendees, hours or description.
 * Returns { rows:[{status,message,label}], ops:[{col,id,data,merge?}], stats }.
 */
export function planNeonEvents(neonEvents, existing, newId) {
  const byNeon = new Map(existing.events.filter((e) => e.neonEventId).map((e) => [String(e.neonEventId), e]));
  const byKey = new Map(existing.events.map((e) => [`${lower(e.name)}|${e.date}|${e.startTime}`, e]));
  const locByName = new Map((existing.locations || []).map((l) => [lower(l.name), l]));
  const locationFor = (raw) => {
    const name = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!name) return null;
    let loc = locByName.get(lower(name));
    if (!loc) {
      loc = { id: newId('locations'), name };
      locByName.set(lower(name), loc);
      ops.push({ col: 'locations', id: loc.id, data: { name } });
      stats.newLocations++;
    }
    return loc.id;
  };
  const seen = new Set();
  const rows = [];
  const ops = [];
  const stats = { created: 0, linked: 0, skipped: 0, errors: 0, newLocations: 0 };
  const row = (status, message, label) => {
    rows.push({ status, message, label });
    if (status === 'ok') return;
    stats[status === 'skip' ? 'skipped' : 'errors']++;
  };

  for (const n of neonEvents) {
    const name = String(n.name || '').replace(/\s+/g, ' ').trim();
    const date = parseDate(n.date);
    const label = `${name || '(unnamed)'} · ${n.date || '?'}`;
    const id = String(n.neonEventId || '');
    if (!id) { row('error', 'Missing Neon event ID', label); continue; }
    if (!name) { row('error', 'Name is empty', label); continue; }
    if (!date) { row('error', `Invalid date "${n.date}"`, label); continue; }
    if (seen.has(id)) { row('skip', 'Duplicate in Neon results', label); continue; }
    seen.add(id);

    let start = parseTime(n.startTime) || DEFAULT_START;
    let end = parseTime(n.endTime);
    // Neon events may lack times; the rules need end > start, so default to a one-hour slot.
    if (!end || toMinutes(end) <= toMinutes(start)) end = hhmm(Math.min(toMinutes(start) + 60, 23 * 60 + 59));
    if (toMinutes(end) <= toMinutes(start)) start = hhmm(toMinutes(end) - 1);

    if (byNeon.has(id)) {
      row('skip', 'Already imported', label);
      continue;
    }
    const match = byKey.get(`${lower(name)}|${date}|${start}`);
    if (match) {
      ops.push({ col: 'events', id: match.id, data: { neonEventId: id }, merge: true });
      stats.linked++;
      row('ok', 'linked to existing event', label);
      continue;
    }
    ops.push({
      col: 'events',
      id: newId('events'),
      data: { name, description: '', date, startTime: start, endTime: end, format: 'in-person', locationId: locationFor(n.location), attendees: {}, neonEventId: id },
    });
    stats.created++;
    row('ok', 'new event', label);
  }
  return { rows, ops, stats };
}

/**
 * Neon events that have no RollCall counterpart yet, sorted for display.
 * An event counts as present when a local event carries its neonEventId, or
 * matches on name|date|start time (the same rule planNeonEvents links on).
 * neonEvents = [{neonEventId, name, date, startTime?, endTime?, location?}]; events = local events.
 */
export function neonOnlyEvents(neonEvents, events) {
  const ids = new Set(events.filter((e) => e.neonEventId).map((e) => String(e.neonEventId)));
  const keys = new Set(events.map((e) => `${lower(e.name)}|${e.date}|${e.startTime}`));
  const seen = new Set();
  const out = [];
  for (const n of neonEvents || []) {
    const id = String(n.neonEventId || '');
    const date = parseDate(n.date);
    const name = String(n.name || '').replace(/\s+/g, ' ').trim();
    if (!id || !name || !date || seen.has(id) || ids.has(id)) continue;
    seen.add(id);
    const start = parseTime(n.startTime) || DEFAULT_START;
    if (keys.has(`${lower(name)}|${date}|${start}`)) continue;
    out.push({ ...n, neonEventId: id, name, date, startTime: parseTime(n.startTime) || '', endTime: parseTime(n.endTime) || '' });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime) || a.name.localeCompare(b.name));
}
