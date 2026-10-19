import {
  collection,
  collectionGroup,
  doc,
  addDoc,
  getDoc,
  getDocs,
  writeBatch,
  limit,
  setDoc,
  updateDoc,
  deleteDoc,
  deleteField,
  onSnapshot,
  query,
  where,
  orderBy,
  serverTimestamp,
  Timestamp,
} from 'firebase/firestore';
import { personKind } from './lib/time.js';
import { db } from './firebase.js';

const withId = (d) => ({ id: d.id, ...d.data() });

function watchCollection(q, cb, sort) {
  return onSnapshot(
    q,
    (snap) => {
      const rows = snap.docs.map(withId);
      cb(sort ? rows.sort(sort) : rows);
    },
    (err) => console.error('snapshot error', err),
  );
}

/* ---------- auth / membership ---------- */

export async function getMembership(uid) {
  try {
    const snap = await getDoc(doc(db, 'members', uid));
    return snap.exists();
  } catch {
    return false;
  }
}

/** The signed-in staff member's membership doc data, or null when not a member. */
export async function getMember(uid) {
  try {
    const snap = await getDoc(doc(db, 'members', uid));
    return snap.exists() ? snap.data() : null;
  } catch {
    return null;
  }
}

export const setMyName = (uid, name) => updateDoc(doc(db, 'members', uid), { name: name.trim().replace(/\s+/g, ' ') });

export async function getIsAdmin(uid) {
  try {
    return (await getDoc(doc(db, 'admins', uid))).exists();
  } catch {
    return false;
  }
}

/** Redeem an invitation code. Rules reject invalid or expired codes. */
export async function redeemInvite(user, code, name) {
  await setDoc(doc(db, 'members', user.uid), {
    code: code.trim().toUpperCase(),
    email: user.email || '',
    name: name.trim().replace(/\s+/g, ' '),
    redeemedAt: serverTimestamp(),
  });
}

/* ---------- events ---------- */

export function watchEvents(from, to, cb) {
  const q = query(collection(db, 'events'), where('date', '>=', from), where('date', '<=', to), orderBy('date'));
  return watchCollection(q, cb, (a, b) =>
    a.date === b.date ? a.startTime.localeCompare(b.startTime) : a.date.localeCompare(b.date),
  );
}

/** One-shot read of events in an inclusive date range, sorted by date then start. */
export async function fetchEventsInRange(from, to) {
  const snap = await getDocs(
    query(collection(db, 'events'), where('date', '>=', from), where('date', '<=', to), orderBy('date')),
  );
  return snap.docs
    .map(withId)
    .sort((a, b) => a.date.localeCompare(b.date) || (a.startTime || '').localeCompare(b.startTime || ''));
}

/* ---------- event photos (metadata only; files are in R2 via /api/photos) ---------- */

export function watchPhotos(eventId, cb) {
  const q = query(collection(db, 'events', eventId, 'photos'), orderBy('uploadedAt'));
  return watchCollection(q, cb);
}

/** Every photo's metadata across all events, each with its `eventId`. Bounded: photos expire after 30 days. */
export function watchAllPhotos(cb) {
  return onSnapshot(
    collectionGroup(db, 'photos'),
    (snap) => {
      const rows = snap.docs.map((d) => ({ id: d.id, eventId: d.ref.parent.parent.id, ...d.data() }));
      const t = (r) => r.uploadedAt?.toMillis?.() ?? Number.MAX_SAFE_INTEGER; // pending writes sort last
      cb(rows.sort((a, b) => t(a) - t(b)));
    },
    (err) => console.error('photos snapshot error', err),
  );
}

/** Photos are removed automatically this long after upload (R2 lifecycle rule + Firestore TTL on `expireAt`). */
export const PHOTO_RETENTION_DAYS = 30;

export function addPhotoDoc(eventId, photoId, { uploadedBy, uploadedByName, width, height }) {
  return setDoc(doc(db, 'events', eventId, 'photos', photoId), {
    expireAt: Timestamp.fromMillis(Date.now() + PHOTO_RETENTION_DAYS * 86_400_000),
    uploadedBy,
    uploadedByName,
    width,
    height,
    uploadedAt: serverTimestamp(),
  });
}

export const deletePhotoDoc = (eventId, photoId) => deleteDoc(doc(db, 'events', eventId, 'photos', photoId));

export async function fetchLocations() {
  const snap = await getDocs(collection(db, 'locations'));
  return Object.fromEntries(snap.docs.map((d) => [d.id, d.data().name]));
}

export function watchEvent(id, cb) {
  return onSnapshot(doc(db, 'events', id), (snap) => cb(snap.exists() ? withId(snap) : null));
}

/**
 * Returns { id, done }. The id is known immediately so callers don't block on
 * the server (offline writes only resolve once reconnected).
 */
export function createEvent(data) {
  const ref = doc(collection(db, 'events'));
  const done = setDoc(ref, { ...data, attendees: data.attendees || {}, createdAt: serverTimestamp() });
  return { id: ref.id, done };
}

export function updateEvent(id, data) {
  return updateDoc(doc(db, 'events', id), data);
}

export function deleteEvent(id) {
  return deleteDoc(doc(db, 'events', id));
}

export function setAttendance(eventId, person, present, role = 'participant') {
  const key = `attendees.${person.id}`;
  return updateDoc(doc(db, 'events', eventId), {
    [key]: present ? { name: person.name, type: personKind(person.type), role } : deleteField(),
  });
}

export function setRole(eventId, personId, role) {
  return updateDoc(doc(db, 'events', eventId), { [`attendees.${personId}.role`]: role });
}

/* ---------- people (frequent flyers) ---------- */

export function watchPeople(cb) {
  return watchCollection(collection(db, 'people'), cb, (a, b) => a.name.localeCompare(b.name));
}

/** Returns { person, done }; person is usable immediately (see createEvent). */
export function addPerson(name, type) {
  const ref = doc(collection(db, 'people'));
  const clean = name.trim();
  const done = setDoc(ref, { name: clean, nameLower: clean.toLowerCase(), type, createdAt: serverTimestamp() });
  return { person: { id: ref.id, name: clean, type }, done };
}

export function updatePerson(id, { name, type }) {
  const data = {};
  if (name !== undefined) Object.assign(data, { name: name.trim(), nameLower: name.trim().toLowerCase() });
  if (type !== undefined) data.type = type;
  return updateDoc(doc(db, 'people', id), data);
}

export function deletePerson(id) {
  return deleteDoc(doc(db, 'people', id));
}

/**
 * Merge duplicate people into one: every event attendee entry for a merged id is
 * re-pointed at keepId (volunteer wins if any entry was), then the merged docs are deleted.
 * Returns the number of events rewritten.
 */
export async function mergePeople(keep, mergeIds) {
  const gone = new Set(mergeIds.filter((id) => id !== keep.id));
  const snap = await getDocs(collection(db, 'events'));
  const jobs = [];
  for (const d of snap.docs) {
    const att = d.data().attendees || {};
    const hit = [keep.id, ...gone].filter((id) => att[id]);
    if (!hit.some((id) => gone.has(id))) continue;
    const volunteer = hit.some((id) => (att[id].role || 'participant') === 'volunteer');
    const patch = { [`attendees.${keep.id}`]: { name: keep.name, type: personKind(keep.type), role: volunteer ? 'volunteer' : 'participant' } };
    for (const id of gone) if (att[id]) patch[`attendees.${id}`] = deleteField();
    jobs.push({ ref: d.ref, patch });
  }
  for (let i = 0; i < jobs.length; i += 400) {
    const batch = writeBatch(db);
    for (const j of jobs.slice(i, i + 400)) batch.update(j.ref, j.patch);
    await batch.commit();
  }
  const batch = writeBatch(db);
  for (const id of gone) batch.delete(doc(db, 'people', id));
  await batch.commit();
  return jobs.length;
}

/* ---------- locations ---------- */

export function watchLocations(cb) {
  return watchCollection(collection(db, 'locations'), cb, (a, b) => a.name.localeCompare(b.name));
}

export const addLocation = (name) => addDoc(collection(db, 'locations'), { name: name.trim() });
export const renameLocation = (id, name) => updateDoc(doc(db, 'locations', id), { name: name.trim() });
export const deleteLocation = (id) => deleteDoc(doc(db, 'locations', id));

/* ---------- invites & members (admin) ---------- */

export function watchInvites(cb) {
  return watchCollection(collection(db, 'invites'), cb, (a, b) => b.expiresAt.seconds - a.expiresAt.seconds);
}

export function createInvite(code, expiresOn, label, uid) {
  const [y, m, d] = expiresOn.split('-').map(Number);
  // Valid through the end of the chosen local day.
  const expiresAt = Timestamp.fromDate(new Date(y, m - 1, d, 23, 59, 59));
  return setDoc(doc(db, 'invites', code), { expiresAt, label: label || '', createdBy: uid });
}

export const deleteInvite = (code) => deleteDoc(doc(db, 'invites', code));

export function watchMembers(cb) {
  return watchCollection(collection(db, 'members'), cb);
}

export const removeMember = (uid) => deleteDoc(doc(db, 'members', uid));

/* ---------- suggestions & bulk import ---------- */

/** Most recent events first (used for name suggestions). */
export async function fetchRecentEvents(max = 500) {
  const snap = await getDocs(query(collection(db, 'events'), orderBy('date', 'desc'), limit(max)));
  return snap.docs.map(withId);
}

export async function loadExisting() {
  const [people, locations, events] = await Promise.all([
    getDocs(collection(db, 'people')),
    getDocs(collection(db, 'locations')),
    getDocs(collection(db, 'events')),
  ]);
  return {
    people: people.docs.map(withId),
    locations: locations.docs.map(withId),
    events: events.docs.map(withId),
  };
}

export const newId = (col) => doc(collection(db, col)).id;

/** Write planned docs in batches of 400. Resolves when the server has them. */
export async function commitOps(ops, onProgress = () => {}) {
  const order = { locations: 0, people: 1, events: 2 };
  const sorted = [...ops].sort((a, b) => order[a.col] - order[b.col]);
  for (let i = 0; i < sorted.length; i += 400) {
    const batch = writeBatch(db);
    for (const op of sorted.slice(i, i + 400)) {
      if (op.merge) {
        batch.set(doc(db, op.col, op.id), op.data, { merge: true });
        continue;
      }
      const data = op.col === 'locations' ? op.data : { ...op.data, createdAt: serverTimestamp() };
      batch.set(doc(db, op.col, op.id), data);
    }
    await batch.commit();
    onProgress(Math.min(i + 400, sorted.length), sorted.length);
  }
}
