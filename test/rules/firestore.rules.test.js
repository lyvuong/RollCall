import { readFileSync } from 'node:fs';
import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} from '@firebase/rules-unit-testing';
import { collectionGroup, getDocs, doc, getDoc, setDoc, updateDoc, deleteDoc, setLogLevel, Timestamp, writeBatch } from 'firebase/firestore';

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

describe('member role', () => {
  it('a member can set their own role to staff or volunteer, nothing else', async () => {
    await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), 'members', 'member1'), { code: 'GOODCODE', email: 'm@x.org', name: 'Mo' }));
    const db = env.authenticatedContext('member1').firestore();
    await assertSucceeds(updateDoc(doc(db, 'members', 'member1'), { role: 'staff' }));
    await assertSucceeds(updateDoc(doc(db, 'members', 'member1'), { role: 'volunteer' }));
    await assertFails(updateDoc(doc(db, 'members', 'member1'), { role: 'admin' }));
    await assertFails(updateDoc(doc(db, 'members', 'member1'), { email: 'x@y.org' }));
  });

  it("an admin can set anyone's role, but nothing else", async () => {
    await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), 'members', 'member1'), { code: 'GOODCODE', email: 'm@x.org', name: 'Mo' }));
    const db = env.authenticatedContext('admin1').firestore();
    await assertSucceeds(updateDoc(doc(db, 'members', 'member1'), { role: 'staff' }));
    await assertFails(updateDoc(doc(db, 'members', 'member1'), { role: 'boss' }));
    await assertFails(updateDoc(doc(db, 'members', 'member1'), { name: 'Other' }));
  });

  it("cannot set someone else's role", async () => {
    await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), 'members', 'member1'), { code: 'GOODCODE', email: 'm@x.org', name: 'Mo' }));
    const db = env.authenticatedContext('stranger').firestore();
    await assertFails(updateDoc(doc(db, 'members', 'member1'), { role: 'staff' }));
  });
});

describe('roster', () => {
  const entry = { name: 'Mo', role: 'staff' };

  it("members read it; a member writes only their own entry, an admin anyone's", async () => {
    const db = env.authenticatedContext('member1').firestore();
    await assertSucceeds(setDoc(doc(db, 'roster', 'member1'), entry));
    await assertFails(setDoc(doc(db, 'roster', 'someone'), entry));
    await assertSucceeds(getDoc(doc(db, 'roster', 'member1')));
    await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), 'members', 'admin1'), { code: 'GOODCODE', email: 'a@x.org', name: 'Al' }));
    const admin = env.authenticatedContext('admin1').firestore();
    await assertSucceeds(setDoc(doc(admin, 'roster', 'someone'), { name: 'Al', role: 'volunteer' }));
  });

  it('needs a valid role and no extra fields; non-members are denied', async () => {
    const db = env.authenticatedContext('member1').firestore();
    await assertFails(setDoc(doc(db, 'roster', 'member1'), { ...entry, role: 'boss' }));
    await assertFails(setDoc(doc(db, 'roster', 'member1'), { ...entry, extra: 1 }));
    const stranger = env.authenticatedContext('stranger').firestore();
    await assertFails(getDoc(doc(stranger, 'roster', 'member1')));
  });
});

describe('neon people copy', () => {
  const person = { neonAccountId: '7', name: 'Ada L', nameLower: 'ada l', lastLower: 'l', email: '', active: true };

  it('members can write and search it, but never delete', async () => {
    const db = env.authenticatedContext('member1').firestore();
    await assertSucceeds(setDoc(doc(db, 'neonPeople', '7'), person));
    await assertSucceeds(setDoc(doc(db, 'neonPeople', '7'), { ...person, active: false }));
    await assertSucceeds(getDoc(doc(db, 'neonPeople', '7')));
    await assertFails(deleteDoc(doc(db, 'neonPeople', '7')));
  });

  it('needs a name and an active flag; non-members are denied', async () => {
    const db = env.authenticatedContext('member1').firestore();
    await assertFails(setDoc(doc(db, 'neonPeople', '8'), { ...person, name: '' }));
    await assertFails(setDoc(doc(db, 'neonPeople', '8'), { ...person, active: 'yes' }));
    const stranger = env.authenticatedContext('stranger').firestore();
    await assertFails(setDoc(doc(stranger, 'neonPeople', '9'), person));
    await assertFails(getDoc(doc(stranger, 'appMeta', 'neonPeopleSync')));
  });
});

describe('event photos', () => {
  const meta = (uid, extra = {}) => ({
    uploadedBy: uid, uploadedByName: 'Pat', width: 800, height: 600, uploadedAt: Timestamp.now(),
    expireAt: Timestamp.fromMillis(Date.now() + 30 * 86_400_000), ...extra,
  });

  it('members can add, read and delete photo metadata', async () => {
    const db = env.authenticatedContext('member1').firestore();
    const ref = doc(db, 'events', 'e1', 'photos', 'p1');
    await assertSucceeds(setDoc(ref, meta('member1')));
    await assertSucceeds(getDoc(ref));
    await assertSucceeds(deleteDoc(ref));
  });

  it('members can list photos across events; non-members cannot', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'events', 'e1', 'photos', 'p1'), meta('member1'));
    });
    await assertSucceeds(getDocs(collectionGroup(env.authenticatedContext('member1').firestore(), 'photos')));
    await assertFails(getDocs(collectionGroup(env.authenticatedContext('stranger').firestore(), 'photos')));
  });

  it('non-members are denied', async () => {
    const db = env.authenticatedContext('stranger').firestore();
    await assertFails(setDoc(doc(db, 'events', 'e1', 'photos', 'p1'), meta('stranger')));
    await assertFails(getDoc(doc(db, 'events', 'e1', 'photos', 'p1')));
  });

  it('expireAt must be a timestamp at most ~31 days out', async () => {
    const db = env.authenticatedContext('member1').firestore();
    const far = Timestamp.fromMillis(Date.now() + 90 * 86_400_000);
    await assertFails(setDoc(doc(db, 'events', 'e1', 'photos', 'p1'), meta('member1', { expireAt: far })));
    await assertFails(setDoc(doc(db, 'events', 'e1', 'photos', 'p2'), meta('member1', { expireAt: 'never' })));
  });

  it('cannot claim another uploader or add extra fields', async () => {
    const db = env.authenticatedContext('member1').firestore();
    await assertFails(setDoc(doc(db, 'events', 'e1', 'photos', 'p1'), meta('someone-else')));
    await assertFails(setDoc(doc(db, 'events', 'e1', 'photos', 'p2'), meta('member1', { url: 'http://x' })));
  });
});
