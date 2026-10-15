import {
  collection,
  doc,
  addDoc,
  getDoc,
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

export async function getIsAdmin(uid) {
  try {
    return (await getDoc(doc(db, 'admins', uid))).exists();
  } catch {
    return false;
  }
}

/** Redeem an invitation code. Rules reject invalid or expired codes. */
export async function redeemInvite(user, code) {
  await setDoc(doc(db, 'members', user.uid), {
    code: code.trim().toUpperCase(),
    email: user.email || '',
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

export function watchEvent(id, cb) {
  return onSnapshot(doc(db, 'events', id), (snap) => cb(snap.exists() ? withId(snap) : null));
}

/**
 * Returns { id, done }. The id is known immediately so callers don't block on
 * the server (offline writes only resolve once reconnected).
 */
export function createEvent(data) {
  const ref = doc(collection(db, 'events'));
  const done = setDoc(ref, { ...data, attendees: {}, createdAt: serverTimestamp() });
  return { id: ref.id, done };
}

export function updateEvent(id, data) {
  return updateDoc(doc(db, 'events', id), data);
}

export function deleteEvent(id) {
  return deleteDoc(doc(db, 'events', id));
}

export function setAttendance(eventId, person, present) {
  const key = `attendees.${person.id}`;
  return updateDoc(doc(db, 'events', eventId), {
    [key]: present ? { name: person.name, type: person.type } : deleteField(),
  });
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
