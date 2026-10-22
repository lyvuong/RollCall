import { parseDate, parseTime } from './importer.js';
import { toMinutes, addDays } from './time.js';
import { matchParticipants, isCancelled } from './neonMerge.js';

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

/**
 * Start and end ('HH:MM') for a Neon event. Neon events may lack times; the rules need end > start, so a missing
 * start becomes 09:00 and a missing or backwards end becomes a one-hour slot.
 */
export function neonSlot(n) {
  let start = parseTime(n.startTime) || DEFAULT_START;
  let end = parseTime(n.endTime);
  if (!end || toMinutes(end) <= toMinutes(start)) end = hhmm(Math.min(toMinutes(start) + 60, 23 * 60 + 59));
  if (toMinutes(end) <= toMinutes(start)) start = hhmm(toMinutes(end) - 1);
  return { start, end };
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
 * What to write to an event's `registrants` after fetching its current Neon list: new people (name, accountId,
 * status 'pending'), `{cancelled:true}` for stored people Neon no longer lists (cancelled, refunded, swapped out),
 * and `{cancelled:false}` for ones that came back. Confirmations (status) are never touched. Empty when `list` is null.
 */
export function registrantUpdates(list, current) {
  if (!list) return {};
  const out = registrantMap(list, current);
  const live = new Set(list.map((r) => String(r.attendeeId || '')));
  for (const [key, r] of Object.entries(current || {})) {
    if (!live.has(key) && !r.cancelled) out[key] = { cancelled: true };
    else if (live.has(key) && r.cancelled) out[key] = { cancelled: false };
  }
  return out;
}

const addedOf = (regs) => Object.values(regs).filter((r) => r.name).length;
const droppedOf = (regs) => Object.values(regs).filter((r) => r.cancelled === true).length;
const summary = (regs) =>
  [addedOf(regs) && `${addedOf(regs)} registered name${addedOf(regs) === 1 ? '' : 's'} added`, droppedOf(regs) && `${droppedOf(regs)} cancelled`]
    .filter(Boolean)
    .join(' · ');

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
    const out = registrantUpdates(registrants[id], current);
    stats.registrants += addedOf(out);
    return out;
  };
  // Remember Neon's counts whenever its attendees were fetched, so staleRegistrantEvents can spot later changes.
  const countOf = (n, id) =>
    registrants[id]
      ? {
          ...(Number.isInteger(n.registered) ? { neonCount: n.registered } : {}),
          ...(Number.isInteger(n.registrations) ? { neonRegs: n.registrations } : {}),
        }
      : {};
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

    const { start, end } = neonSlot(n);

    if (byNeon.has(id)) {
      const cur = byNeon.get(id);
      const regs = newRegistrants(id, cur.registrants);
      const count = countOf(n, id);
      if (Object.keys(regs).length) {
        ops.push({ col: 'events', id: cur.id, data: { registrants: regs, ...count }, merge: true });
        row('ok', `already imported · ${summary(regs)}`, label);
      } else {
        if (Object.entries(count).some(([k, v]) => cur[k] !== v)) ops.push({ col: 'events', id: cur.id, data: count, merge: true });
        row('skip', 'Already imported', label);
      }
      continue;
    }
    const match = byKey.get(`${lower(name)}|${date}|${start}`);
    if (match) {
      const regs = newRegistrants(id, match.registrants);
      const added = addedOf(regs);
      ops.push({ col: 'events', id: match.id, data: { neonEventId: id, ...(Object.keys(regs).length ? { registrants: regs } : {}), ...countOf(n, id) }, merge: true });
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
      data: { name, description: '', date, startTime: start, endTime: end, format, locationId: format === 'virtual' ? null : locationFor(n.location), attendees: {}, neonEventId: id, ...(added ? { registrants: regs } : {}), ...countOf(n, id) },
    });
    stats.created++;
    row('ok', `new event${added ? ` · ${added} registered name${added === 1 ? '' : 's'}` : ''}`, label);
  }
  return { rows, ops, stats };
}

/**
 * Imported events from today on whose registrants should be fetched again:
 *  - today's and tomorrow's events always (a cancel plus a new sign-up leaves Neon's counts unchanged), or
 *  - later events whose Neon attendee or registration count differs from the one stored when the names were last
 *    fetched (or that were never counted but now have registrations).
 * Returns the Neon rows to pass to planNeonEvents. neonEvents = rows with `registered`/`registrations`; events = local.
 */
export function staleRegistrantEvents(neonEvents, events, today) {
  const local = new Map(events.filter((e) => e.neonEventId).map((e) => [String(e.neonEventId), e]));
  const soon = addDays(today, 1);
  return (neonEvents || []).filter((n) => {
    const e = local.get(String(n.neonEventId));
    if (!e || e.date < today) return false;
    if (e.date <= soon) return true;
    if (!Number.isInteger(n.registered)) return false;
    if (e.neonCount === undefined) return n.registered > 0;
    return e.neonCount !== n.registered || (Number.isInteger(n.registrations) && e.neonRegs !== n.registrations);
  });
}

/** Today's or tomorrow's event: its sign-ups can still change faster than Neon's counts show. */
export const isImminent = (date, today) => date >= today && date <= addDays(today, 1);

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

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/**
 * Compare a RollCall event with what the OSG Website (Neon) holds, in the direction RollCall -> Neon.
 *   event       local event ({name, date, startTime, endTime, registrants?})
 *   neonEvent   {name, date, endDate?, startTime, endTime, location} (times 'HH:MM', '' when Neon has none)
 *   attendees   Neon attendees [{attendeeId, registrationId, name, markedAttended}] or null when not loaded
 *   locationName  the local location's name ('' for virtual or unset)
 * Times and locations RollCall merely defaulted are not differences: a field is only compared when both sides
 * have a value. Registrants still 'pending' are never pushed; 'present' -> attended, 'missing' -> not attended.
 * People on the roll who are registered on Neon but not marked attended are checked in too; people on the roll
 * with no Neon registration at all (found by name) are walk-ins to register.
 * Returns { details:[{field,label,local,neon}], checkins:[{attendeeId,registrationId,name,attended}],
 *           walkins:[{personId,name}], count, inSync }.
 */
export function neonSyncPlan(event, neonEvent, attendees, locationName = '') {
  const details = [];
  const add = (field, label, local, neon) => details.push({ field, label, local, neon });
  if (clean(event.name) !== clean(neonEvent.name)) add('name', 'Name', clean(event.name), clean(neonEvent.name));
  if (event.date && event.date !== neonEvent.date) add('date', 'Date', event.date, neonEvent.date);
  if (event.startTime && neonEvent.startTime && event.startTime !== neonEvent.startTime) add('startTime', 'Start', event.startTime, neonEvent.startTime);
  if (event.endTime && neonEvent.endTime && event.endTime !== neonEvent.endTime) add('endTime', 'End', event.endTime, neonEvent.endTime);
  const loc = clean(locationName);
  if (loc && lower(loc) !== lower(clean(neonEvent.location))) add('location', 'Location', loc, clean(neonEvent.location));

  const checkins = [];
  const walkins = [];
  if (attendees) {
    const byId = new Map(attendees.map((a) => [String(a.attendeeId), a]));
    const matches = matchParticipants(event.attendees, attendees);
    const onRoll = new Set(matches.filter((m) => m.attendee).map((m) => String(m.attendee.attendeeId)));
    const rollKnown = event.attendees !== undefined;
    const regs = event.registrants || {};
    for (const [key, r] of Object.entries(regs)) {
      const a = byId.get(String(key));
      if (r.cancelled || !a?.registrationId) continue;
      const status = r.status || 'pending';
      const neon = a.markedAttended === true;
      // Here -> attended (while still on the roll), Missing -> not attended. Unconfirmed sends nothing, except that
      // taking back a Here (Neon attended as of the last sync, still Unconfirmed now) unchecks them.
      let want = null;
      if (status === 'present') want = !rollKnown || onRoll.has(String(key));
      else if (status === 'missing') want = false;
      else if (neon && r.neonSeen === true) want = false;
      if (want !== null && want !== neon) {
        checkins.push({ attendeeId: String(key), registrationId: String(a.registrationId), name: r.name || a.name, attended: want });
      }
    }
    const decided = new Set(checkins.map((c) => c.attendeeId));
    for (const m of matches) {
      if (!m.attendee) walkins.push({ personId: m.personId, name: m.name });
      else if (!regs[m.attendee.attendeeId] && !m.attendee.markedAttended && m.attendee.registrationId && !decided.has(String(m.attendee.attendeeId))) {
        decided.add(String(m.attendee.attendeeId));
        checkins.push({ attendeeId: String(m.attendee.attendeeId), registrationId: String(m.attendee.registrationId), name: m.name, attended: true });
      }
    }
    checkins.sort((x, y) => x.name.localeCompare(y.name));
  }
  const count = details.length + checkins.length + walkins.length;
  return { details, checkins, walkins, count, inSync: count === 0 };
}

/**
 * What RollCall should write down after looking at the OSG Website's attendees, without asking anyone:
 *   {type:'add',  key, entry}   an OSG registration RollCall has no row for yet (already Here when they are on the roll)
 *   {type:'pull', key, name}    checked in on the OSG Website while still Unconfirmed here: becomes Here, joins the roll
 *   {type:'miss', key}          a finished event where the OSG Website reports attendance and this person is not among those
 *                               attended: they are Missing, not merely Unconfirmed
 *   {type:'ack',  key, seen}    both sides already agree: remember Neon's value (`neonSeen`)
 * `neonSeen` is what Neon said at the last sync. It is how an attended flag that was set on the OSG Website (pull) is told
 * from one RollCall is about to change (push): the three RollCall states Unconfirmed / Here / Missing map to Neon's two.
 */
export function neonReconcile(event, attendees, today = '') {
  if (!attendees) return [];
  const regs = event.registrants || {};
  const onRoll = new Set(
    matchParticipants(event.attendees, attendees)
      .filter((m) => m.attendee)
      .map((m) => String(m.attendee.attendeeId)),
  );
  const ops = [];
  // Attendance counts as reported once the day has passed and Neon has anyone marked attended.
  const reported = !!today && event.date < today && attendees.some((a) => a.markedAttended === true && !isCancelled(a.status));
  for (const a of attendees) {
    const key = String(a.attendeeId || '');
    const name = String(a.name || '').replace(/\s+/g, ' ').trim();
    if (!key || !name || isCancelled(a.status)) continue;
    const neon = a.markedAttended === true;
    const r = regs[key];
    if (!r) {
      const here = onRoll.has(key);
      const missing = !here && !neon && reported;
      ops.push({ type: 'add', key, entry: { name, accountId: String(a.accountId || ''), status: here ? 'present' : missing ? 'missing' : 'pending', ...(here ? { neonSeen: neon } : missing ? { neonSeen: false } : {}) } });
      if (!here && neon) ops.push({ type: 'pull', key, name });
      continue;
    }
    if (r.cancelled) continue;
    const status = r.status || 'pending';
    if (status === 'pending' && neon && r.neonSeen !== true) ops.push({ type: 'pull', key, name: r.name || name });
    else if (status === 'pending' && !neon && reported) ops.push({ type: 'miss', key });
    else if (r.neonSeen !== neon && ((status === 'present' && neon) || (status !== 'present' && !neon))) ops.push({ type: 'ack', key, seen: neon });
  }
  return ops;
}

/** The Neon event patch ({name?, date?, endDate?, startTime?, endTime?, location?}) that makes `details` true. */
export function neonEventPatch(details, neonEvent) {
  const patch = {};
  for (const d of details) patch[d.field] = d.local;
  // A one-day Neon event stays one day when its date moves; a multi-day one keeps its end date.
  if (patch.date && (!neonEvent.endDate || neonEvent.endDate === neonEvent.date)) patch.endDate = patch.date;
  return patch;
}

/** Plain-language reason for a failed write, from the Worker's error message. */
export function friendlyNeonReason(message) {
  const m = String(message || '');
  if (/14014|coupon code/i.test(m)) {
    return 'The OSG Website rejects updates to registrations made through the online form (it validates their empty coupon code).';
  }
  if (/403|turned off/i.test(m)) return 'Sending to the OSG Website is turned off on this site.';
  if (/429/.test(m)) return 'The OSG Website is busy. Try again in a minute.';
  const text = m.replace(/^Neon One \d+:\s*/, '');
  return text.length > 140 ? `${text.slice(0, 140)}…` : text || 'Unknown error.';
}
