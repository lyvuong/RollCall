import { readFileSync } from 'node:fs';
import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, deleteDoc, setLogLevel, Timestamp, writeBatch } from 'firebase/firestore';

let env;
const future = () => Timestamp.fromMillis(Date.now() + 86_400_000);
const past = () => Timestamp.fromMillis(Date.now() - 86_400_000);

beforeAll(async () => {
  setLogLevel('error');
  env = await initializeTestEnvironment({
    projectId: 'demo-rollcall',
    firestore: { rules: readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 },
  });
});
afterAll(() => env.cleanup());

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'invites', 'GOODCODE'), { expiresAt: future(), createdBy: 'admin1' });
    await setDoc(doc(db, 'invites', 'OLDCODE'), { expiresAt: past(), createdBy: 'admin1' });
    await setDoc(doc(db, 'admins', 'admin1'), {});
    await setDoc(doc(db, 'members', 'member1'), { code: 'GOODCODE', email: 'm@x.org' });
    await setDoc(doc(db, 'events', 'e1'), {
      name: 'E', format: 'virtual', startTime: '09:00', endTime: '10:00', date: '2026-10-15',
    });
  });
});

const redeem = (uid, code) => ({ code, email: `${uid}@x.org`, redeemedAt: Timestamp.now() });

describe('invitation codes', () => {
  it('valid code grants membership', async () => {
    const db = env.authenticatedContext('u1').firestore();
    await assertSucceeds(setDoc(doc(db, 'members', 'u1'), redeem('u1', 'GOODCODE')));
    await assertSucceeds(getDoc(doc(db, 'events', 'e1')));
  });

  it('expired code is denied', async () => {
    const db = env.authenticatedContext('u1').firestore();
    await assertFails(setDoc(doc(db, 'members', 'u1'), redeem('u1', 'OLDCODE')));
  });

  it('unknown code is denied', async () => {
    const db = env.authenticatedContext('u1').firestore();
    await assertFails(setDoc(doc(db, 'members', 'u1'), redeem('u1', 'NOPE')));
  });

  it('cannot redeem for another uid', async () => {
    const db = env.authenticatedContext('u1').firestore();
    await assertFails(setDoc(doc(db, 'members', 'u2'), redeem('u2', 'GOODCODE')));
  });
});

describe('data access', () => {
  it('non-member cannot read events', async () => {
    const db = env.authenticatedContext('stranger').firestore();
    await assertFails(getDoc(doc(db, 'events', 'e1')));
  });

  it('unauthenticated cannot read events', async () => {
    const db = env.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, 'events', 'e1')));
  });

  it('member can read and write events, but end must follow start', async () => {
    const db = env.authenticatedContext('member1').firestore();
    await assertSucceeds(getDoc(doc(db, 'events', 'e1')));
    const base = { name: 'N', format: 'both', date: '2026-10-16' };
    await assertSucceeds(setDoc(doc(db, 'events', 'e2'), { ...base, startTime: '09:00', endTime: '10:00' }));
    await assertFails(setDoc(doc(db, 'events', 'e3'), { ...base, startTime: '10:00', endTime: '09:00' }));
  });

  it('only admins manage invites', async () => {
    const member = env.authenticatedContext('member1').firestore();
    const admin = env.authenticatedContext('admin1').firestore();
    const data = { expiresAt: future(), createdBy: 'x' };
    await assertFails(setDoc(doc(member, 'invites', 'NEW'), data));
    await assertSucceeds(setDoc(doc(admin, 'invites', 'NEW'), data));
  });

  it('member can bulk-import a large batch of people and events', async () => {
    const db = env.authenticatedContext('member1').firestore();
    const batch = writeBatch(db);
    for (let i = 0; i < 200; i++) {
      batch.set(doc(db, 'people', 'p' + i), { name: 'Person ' + i, nameLower: 'person ' + i, type: 'volunteer' });
    }
    for (let i = 0; i < 100; i++) {
      batch.set(doc(db, 'events', 'ev' + i), {
        name: 'Past ' + i, format: 'in-person', date: '2025-01-01', startTime: '09:00', endTime: '10:00',
        attendees: { p1: { name: 'Person 1', type: 'volunteer' } },
      });
    }
    await assertSucceeds(batch.commit());
  });
});

describe('event photos', () => {
  const meta = (uid, extra = {}) => ({
    uploadedBy: uid, uploadedByName: 'Pat', width: 800, height: 600, uploadedAt: Timestamp.now(), ...extra,
  });

  it('members can add, read and delete photo metadata', async () => {
    const db = env.authenticatedContext('member1').firestore();
    const ref = doc(db, 'events', 'e1', 'photos', 'p1');
    await assertSucceeds(setDoc(ref, meta('member1')));
    await assertSucceeds(getDoc(ref));
    await assertSucceeds(deleteDoc(ref));
  });

  it('non-members are denied', async () => {
    const db = env.authenticatedContext('stranger').firestore();
    await assertFails(setDoc(doc(db, 'events', 'e1', 'photos', 'p1'), meta('stranger')));
    await assertFails(getDoc(doc(db, 'events', 'e1', 'photos', 'p1')));
  });

  it('cannot claim another uploader or add extra fields', async () => {
    const db = env.authenticatedContext('member1').firestore();
    await assertFails(setDoc(doc(db, 'events', 'e1', 'photos', 'p1'), meta('someone-else')));
    await assertFails(setDoc(doc(db, 'events', 'e1', 'photos', 'p2'), meta('member1', { url: 'http://x' })));
  });
});
