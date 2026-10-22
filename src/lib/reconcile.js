import { addPerson, markRegistrant, saveRegistrants, setNeonSeen, setAttendance } from '../data.js';
import { neonReconcile } from './neon.js';
import { toast } from './dom.js';
import { ymd } from './time.js';

/**
 * Bring an event's registered list in line with what the OSG Website just said (see neonReconcile): rows for new
 * registrations, check-ins made there become Here and join the roll, finished events with reported attendance mark
 * the rest Missing, and agreed values are remembered. Written straight to Firestore, not staged.
 *
 *   getEvent()      the current local event
 *   getPeople()     { people, loaded } the saved people (adding someone to the roll waits until they are known)
 *   skip(key)       true for a row with an unsaved tap on it, which that tap settles
 * Returns reconcile(attendeesFromNeon); calling it again with the same outcome does nothing. reconcile.again() repeats it
 * on the latest list: call it when the saved people arrive after the check did.
 */
const nameKey = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

export function makeReconciler({ eventId, getEvent, getPeople, skip = () => false }) {
  let last = '';
  let latest = null;
  // Writes are applied locally at once but the page only hears about them a moment later, so a second check can still see
  // the old data. These remember what this page already did so it is never done twice (that made duplicate roll entries).
  const pulled = new Set(); // registrant keys already brought onto the roll
  const created = new Map(); // lower-case name -> person made here
  const droppedDupes = new Set(); // roll entries already removed as duplicates
  /** The same name twice on one roll is never right (and the OSG match goes by name): keep one, drop the rest. */
  function dropDuplicateRoll(event) {
    const byName = new Map();
    for (const [id, a] of Object.entries(event.attendees || {})) {
      const k = nameKey(a.name);
      const keep = Object.values(event.registrants || {}).some((r) => r.personId === id);
      const list = byName.get(k) || [];
      list.push({ id, a, keep });
      byName.set(k, list);
    }
    for (const list of byName.values()) {
      if (list.length < 2) continue;
      const first = list.find((x) => x.keep) || list[0];
      for (const x of list) {
        if (x === first || droppedDupes.has(x.id)) continue;
        droppedDupes.add(x.id);
        setAttendance(eventId, { id: x.id, ...x.a }, false).catch(() => {});
      }
    }
  }

  function reconcile(list) {
    latest = list || latest;
    const event = getEvent();
    if (!event?.neonEventId || !list) return;
    dropDuplicateRoll(event);
    const ops = neonReconcile(event, list, ymd()).filter((o) => !skip(o.key));
    const sig = JSON.stringify(ops);
    if (!ops.length || sig === last) return;
    last = sig;
    const adds = {};
    const seen = {};
    for (const o of ops) {
      if (o.type === 'add') adds[o.key] = o.entry;
      else if (o.type === 'ack') seen[o.key] = o.seen;
      else if (o.type === 'miss') {
        seen[o.key] = false;
        markRegistrant(eventId, { key: o.key, ...(event.registrants?.[o.key] || {}) }, 'missing', null).catch(() => {});
      }
    }
    if (Object.keys(adds).length) saveRegistrants(eventId, adds).catch(() => {});
    if (Object.keys(seen).length) setNeonSeen(eventId, seen).catch(() => {});
    const pulls = ops.filter((o) => o.type === 'pull');
    if (!pulls.length) return;
    const { people, loaded } = getPeople();
    if (!loaded) {
      last = ''; // try again on the next check, once the saved people are known
      return;
    }
    for (const o of pulls) {
      if (pulled.has(o.key)) continue;
      pulled.add(o.key);
      const r = event.registrants?.[o.key] || adds[o.key] || { name: o.name };
      const same = (x) => x.name.toLowerCase() === o.name.toLowerCase();
      const there = Object.entries(event.attendees || {}).find(([, a]) => same(a));
      let person = there ? { id: there[0], name: there[1].name, alreadyThere: true } : people.find(same) || created.get(nameKey(o.name));
      if (!person) {
        const made = addPerson(o.name, 'community');
        made.done.catch(() => {});
        person = made.person;
        created.set(nameKey(o.name), person);
      }
      markRegistrant(eventId, { key: o.key, ...r }, 'present', person).catch(() => {});
      setNeonSeen(eventId, { [o.key]: true }).catch(() => {});
    }
    toast(`${pulls.length === 1 ? `${pulls[0].name} was` : `${pulls.length} people were`} checked in on the OSG Website and added to the roll.`);
  }
  reconcile.again = () => latest && reconcile(latest);
  return reconcile;
}
