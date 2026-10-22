import { addPerson, markRegistrant, saveRegistrants, setNeonSeen } from '../data.js';
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
export function makeReconciler({ eventId, getEvent, getPeople, skip = () => false }) {
  let last = '';
  let latest = null;
  function reconcile(list) {
    latest = list || latest;
    const event = getEvent();
    if (!event?.neonEventId || !list) return;
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
      const r = event.registrants?.[o.key] || adds[o.key] || { name: o.name };
      const same = (x) => x.name.toLowerCase() === o.name.toLowerCase();
      const there = Object.entries(event.attendees || {}).find(([, a]) => same(a));
      let person = there ? { id: there[0], name: there[1].name, alreadyThere: true } : people.find(same);
      if (!person) {
        const created = addPerson(o.name, 'community');
        created.done.catch(() => {});
        person = created.person;
      }
      markRegistrant(eventId, { key: o.key, ...r }, 'present', person).catch(() => {});
      setNeonSeen(eventId, { [o.key]: true }).catch(() => {});
    }
    toast(`${pulls.length === 1 ? `${pulls[0].name} was` : `${pulls.length} people were`} checked in on the OSG Website and added to the roll.`);
  }
  reconcile.again = () => latest && reconcile(latest);
  return reconcile;
}
