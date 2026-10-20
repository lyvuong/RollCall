import { inferFormat, neonSlot } from './neon.js';
import { toMinutes } from './time.js';

/** Registration statuses that mean the person is not coming (kept out of every list). */
export const isCancelled = (status) => /cancel|fail|refund|declin/i.test(status || '');

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** Lower-case, accent-free, punctuation-free, single-spaced: "José  O'Neil " -> "jose o neil". */
export const normName = (s) =>
  String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const STOP = new Set(['the', 'at', 'of', 'and', 'a', 'an', 'in', 'for', 'to', 'with', 'on']);
const FORMAT_WORDS = new Set(['virtual', 'online', 'zoom', 'webinar', 'person', 'hybrid']);
const tokens = (s) => new Set(normName(s).split(' ').filter((t) => t && !STOP.has(t) && !FORMAT_WORDS.has(t)));

/** 0..1 similarity of two event titles, ignoring format words ("(Virtual)") and filler ("at the"). */
export function titleScore(a, b) {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.size || !B.size) return 0;
  const inter = [...A].filter((t) => B.has(t)).length;
  const union = A.size + B.size - inter;
  // "Open Art Studio" vs "Open Art Studio at The Waypoint (Alexandria)": one title contains the other.
  // (Needs two shared words, so "Book Club" and "Dinner Club" do not match on "club" alone.)
  return Math.max(inter / union, inter >= 2 ? (inter / Math.min(A.size, B.size)) * 0.85 : 0);
}

const dayNumber = (d) => Math.round(Date.UTC(...d.split('-').map((x, i) => (i === 1 ? x - 1 : +x))) / 86_400_000);

/**
 * OSG Website events that could be the same event as a RollCall event, best first (at most 5).
 *   event       local event ({name, date, startTime, ...})
 *   neonEvents  [{neonEventId, name, date, startTime, location}] around the event's date
 *   takenIds    neonEventIds already linked to a RollCall event (never offered again)
 * Weights: title 45%, date 25%, start time 15%, location 15%. The title must be at least loosely similar.
 * Returns [{neon, score (0..1), reasons: ['Same title', 'Same date', ...]}].
 */
export function similarNeonEvents(event, neonEvents, { locationName = '', takenIds = new Set() } = {}) {
  const out = [];
  for (const n of neonEvents || []) {
    const id = String(n.neonEventId || '');
    if (!id || takenIds.has(id) || !n.date || !event.date) continue;
    const days = Math.abs(dayNumber(event.date) - dayNumber(n.date));
    if (days > 1) continue;
    const title = titleScore(event.name, n.name);
    if (title < 0.34) continue;

    const dateScore = days === 0 ? 1 : 0.3;
    let timeScore = 0.4; // unknown on one side: neutral
    let gap = null;
    if (event.startTime && n.startTime) {
      gap = Math.abs(toMinutes(event.startTime) - toMinutes(n.startTime));
      timeScore = gap <= 15 ? 1 : gap <= 60 ? 0.6 : gap <= 180 ? 0.25 : 0;
    }
    let locScore = 0.4;
    const a = normName(locationName);
    const b = normName(n.location);
    if (a && b) locScore = a === b ? 1 : a.includes(b) || b.includes(a) ? 0.7 : 0;

    const score = 0.45 * title + 0.25 * dateScore + 0.15 * timeScore + 0.15 * locScore;
    if (score < 0.5) continue;
    const reasons = [title >= 0.8 ? 'Same title' : 'Similar title', days === 0 ? 'Same date' : 'Day before or after'];
    if (gap !== null && gap <= 15) reasons.push('Same start time');
    else if (gap !== null && gap <= 60) reasons.push('Similar start time');
    if (locScore >= 0.7) reasons.push('Same location');
    out.push({ neon: n, score, reasons });
  }
  return out.sort((x, y) => y.score - x.score).slice(0, 5);
}

/**
 * Pair each person on the RollCall roll with their registration on the OSG Website, by name.
 *   attendees       RollCall roll {personId: {name, role?, type?}}
 *   neonAttendees   [{attendeeId, registrationId, name, status, markedAttended}]
 * One registration is used for at most one person. Returns [{personId, name, role, attendee|null}] by name;
 * a null attendee means "not registered yet".
 */
export function matchParticipants(attendees, neonAttendees) {
  const byName = new Map();
  for (const a of neonAttendees || []) {
    if (!a.name || !a.attendeeId || isCancelled(a.status)) continue;
    const key = normName(a.name);
    byName.set(key, [...(byName.get(key) || []), a]);
  }
  const used = new Set();
  return Object.entries(attendees || {})
    .map(([personId, p]) => {
      const hit = (byName.get(normName(p.name)) || []).find((a) => !used.has(a.attendeeId)) || null;
      if (hit) used.add(hit.attendeeId);
      return { personId, name: clean(p.name), role: p.role || 'participant', attendee: hit };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

const FORMAT_HINT = /virtual|online|zoom|webinar|hybrid|in[- ]?person/i;

/**
 * The Firestore write that turns a RollCall event into its OSG Website twin: the OSG details win (name, date,
 * times, place); what only RollCall has (roll, hours, photos, description) is kept. The registrations on the OSG
 * Website become `registrants`, with the ones in `hereAttendeeIds` already confirmed as Here.
 *   event             the RollCall event ({id, format, locationId, ...})
 *   neon              fresh OSG event {neonEventId, name, date, startTime, endTime, location}
 *   attendees         fresh OSG attendees (after any new registrations were made)
 *   hereAttendeeIds   Set of attendeeIds (strings) to mark Here
 *   locations         existing [{id, name}]; a missing OSG location is created
 * Returns { ops:[{col,id,data,merge:true}], data }.
 */
export function planMerge(event, neon, attendees, hereAttendeeIds, locations, newId) {
  const name = clean(neon.name);
  const { start, end } = neonSlot(neon);
  // Neon has no format field: trust the title only when it says something, else keep what staff chose.
  const format = FORMAT_HINT.test(name) ? inferFormat(name) : event.format;
  const ops = [];

  let locationId = event.locationId || null;
  const place = clean(neon.location);
  if (format === 'virtual') locationId = null;
  else if (place) {
    const hit = (locations || []).find((l) => normName(l.name) === normName(place));
    if (hit) locationId = hit.id;
    else {
      locationId = newId('locations');
      ops.push({ col: 'locations', id: locationId, data: { name: place } });
    }
  }

  const registrants = {};
  for (const a of attendees || []) {
    const key = String(a.attendeeId || '');
    const who = clean(a.name);
    if (!key || !who || registrants[key] || isCancelled(a.status)) continue;
    registrants[key] = { name: who, accountId: String(a.accountId || ''), status: hereAttendeeIds.has(key) ? 'present' : 'pending' };
  }

  const data = { name, date: neon.date, startTime: start, endTime: end, format, locationId, neonEventId: String(neon.neonEventId), registrants };
  ops.push({ col: 'events', id: event.id, data, merge: true });
  return { ops, data };
}

/**
 * Move a RollCall-only event's roll onto the RollCall event that is already linked to the OSG Website.
 * The target keeps its own details, roll and confirmations; people from `source` who are not on its roll are
 * added, volunteer hours and description are copied only when the target has none, and everyone in
 * `hereAttendeeIds` is confirmed Here. The caller deletes `source` afterwards.
 * Returns { ops:[{col,id,data,merge:true}], data }.
 */
export function planMove(source, target, attendees, hereAttendeeIds) {
  const roll = {};
  for (const [id, p] of Object.entries(source.attendees || {})) if (!target.attendees?.[id]) roll[id] = p;
  const registrants = {};
  for (const a of attendees || []) {
    const key = String(a.attendeeId || '');
    if (key && hereAttendeeIds.has(key)) registrants[key] = { name: clean(a.name), accountId: String(a.accountId || ''), status: 'present' };
  }
  const data = { attendees: roll, registrants };
  if (!(Number(target.volunteerHours) > 0) && Number(source.volunteerHours) > 0) data.volunteerHours = Number(source.volunteerHours);
  if (!clean(target.description) && clean(source.description)) data.description = clean(source.description);
  return { ops: [{ col: 'events', id: target.id, data, merge: true }], data };
}
