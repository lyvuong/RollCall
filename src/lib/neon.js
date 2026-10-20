import { parseDate, parseTime } from './importer.js';
import { toMinutes } from './time.js';

const lower = (s) => String(s || '').trim().toLowerCase();
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const DEFAULT_START = '09:00';

/**
 * OSG names its events with the format, e.g. "Book Club (Virtual)" or "Dinner Club (In-person)"; Neon has no
 * usable format field. Returns 'virtual' | 'both' | 'in-person' (the default when the name says nothing).
 */
export function inferFormat(name) {
  const t = String(name || '').toLowerCase();
  const virtual = /virtual|online|zoom|webinar/.test(t);
  const person = /in[- ]?person/.test(t);
  if (/hybrid/.test(t) || (virtual && person)) return 'both';
  return virtual ? 'virtual' : 'in-person';
}

/** Registrants not already stored in `current`, as the Firestore map {attendeeId: {name, accountId, status:'pending'}}. */
export function registrantMap(list, current) {
  const out = {};
  for (const r of list || []) {
    const key = String(r.attendeeId || '');
    const name = String(r.name || '').replace(/\s+/g, ' ').trim();
    if (!key || !name || current?.[key]) continue;
    out[key] = { name, accountId: String(r.accountId || ''), status: 'pending' };
  }
  return out;
}

/**
 * Build a write plan from events returned by /api/neon/events.
 * neonEvents = [{neonEventId, name, date, startTime, endTime, location?}]
 * existing   = { events:[{id, name, date, startTime, neonEventId?}], locations:[{id, name}] }
 * newId(collection) -> string (keeps the plan pure and testable).
 *
 * Matching: neonEventId first, then name|date|startTime. A match only gets its
 * neonEventId linked (merge), never its attendees, hours or description.
 * registrants (optional) = { [neonEventId]: [{attendeeId, accountId?, name}] } from /api/neon/events/:id/attendees.
 * They are stored on the event as `registrants` (attendeeId -> {name, accountId, status:'pending'}) so staff can
 * confirm who showed up. Only registrants not already stored are added; confirmed ones are never reset.
 * Returns { rows:[{status,message,label}], ops:[{col,id,data,merge?}], stats }.
 */
export function planNeonEvents(neonEvents, existing, newId, registrants = {}) {
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
  const stats = { created: 0, linked: 0, skipped: 0, errors: 0, newLocations: 0, registrants: 0 };
  const newRegistrants = (id, current) => {
    const out = registrantMap(registrants[id], current);
    stats.registrants += Object.keys(out).length;
    return out;
  };
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
      const regs = newRegistrants(id, byNeon.get(id).registrants);
      const added = Object.keys(regs).length;
      if (added) {
        ops.push({ col: 'events', id: byNeon.get(id).id, data: { registrants: regs }, merge: true });
        row('ok', `already imported · ${added} registered name${added === 1 ? '' : 's'} added`, label);
      } else row('skip', 'Already imported', label);
      continue;
    }
    const match = byKey.get(`${lower(name)}|${date}|${start}`);
    if (match) {
      const regs = newRegistrants(id, match.registrants);
      const added = Object.keys(regs).length;
      ops.push({ col: 'events', id: match.id, data: { neonEventId: id, ...(added ? { registrants: regs } : {}) }, merge: true });
      stats.linked++;
      row('ok', `linked to existing event${added ? ` · ${added} registered name${added === 1 ? '' : 's'}` : ''}`, label);
      continue;
    }
    const regs = newRegistrants(id);
    const added = Object.keys(regs).length;
    const format = inferFormat(name);
    ops.push({
      col: 'events',
      id: newId('events'),
      data: { name, description: '', date, startTime: start, endTime: end, format, locationId: format === 'virtual' ? null : locationFor(n.location), attendees: {}, neonEventId: id, ...(added ? { registrants: regs } : {}) },
    });
    stats.created++;
    row('ok', `new event${added ? ` · ${added} registered name${added === 1 ? '' : 's'}` : ''}`, label);
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
    out.push({ ...n, neonEventId: id, name, format: inferFormat(name), date, startTime: parseTime(n.startTime) || '', endTime: parseTime(n.endTime) || '' });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime) || a.name.localeCompare(b.name));
}

/**
 * Imported OSG events that are over and were never used: past date, no attendees, no recorded volunteer hours.
 * (The caller also checks for photos.) Sorted by date. The OSG Website still has them.
 */
export function emptyPastNeonEvents(events, today) {
  return events
    .filter((e) => e.neonEventId && e.date < today && !Object.keys(e.attendees || {}).length && !(Number(e.volunteerHours) > 0))
    .sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
}
