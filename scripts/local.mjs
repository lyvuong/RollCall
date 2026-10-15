// One-command local dev: Firebase emulators (auth + firestore) + Vite.
// Seeds sample data once and auto-grants admin + membership to anyone who signs in.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const PROJECT = 'demo-rollcall';
const AUTH = 'http://127.0.0.1:9099';
const FS = `http://127.0.0.1:8080/v1/projects/${PROJECT}/databases/(default)/documents`;
const H = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' };
const shell = process.platform === 'win32';

mkdirSync('.emulator-data', { recursive: true });
const run = (cmd, args) => spawn(cmd, args, { stdio: 'inherit', shell });
const emu = run('npx', [
  'firebase', 'emulators:start', '--only', 'auth,firestore', '--project', PROJECT,
  '--import', '.emulator-data', '--export-on-exit', '.emulator-data',
]);
const vite = run('npx', ['vite', '--mode', 'emulator']);
const stop = () => { emu.kill(); vite.kill(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

const toValue = (v) =>
  v === null ? { nullValue: null }
  : typeof v === 'string' ? { stringValue: v }
  : typeof v === 'number' ? { integerValue: String(v) }
  : { mapValue: { fields: toFields(v) } };
const toFields = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, toValue(v)]));
const put = (path, data) =>
  fetch(`${FS}/${path}`, { method: 'PATCH', headers: H, body: JSON.stringify({ fields: toFields(data) }) });

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dayOffset = (n) => ymd(new Date(Date.now() + n * 86400000));

async function seedSample() {
  const locs = { loc1: 'Main Hall', loc2: 'Community Center', loc3: 'Public Library' };
  for (const [id, name] of Object.entries(locs)) await put(`locations/${id}`, { name });
  const names = ['Alice Nguyen', 'Ben Carter', 'Chloe Tran', 'David Kim', 'Elena Rossi', 'Farid Hassan',
    'Grace Lee', 'Hector Diaz', 'Ivy Chen', 'Jon Park', 'Kara Singh', 'Liam Brooks'];
  const people = names.map((name, i) => ({
    id: `p${i}`, name, type: i < 5 ? 'member' : 'volunteer',
  }));
  for (const p of people) await put(`people/${p.id}`, { name: p.name, nameLower: p.name.toLowerCase(), type: p.type });
  const att = (...ix) => Object.fromEntries(ix.map((i) => [people[i].id, { name: people[i].name, type: people[i].type }]));
  const events = [
    ['Food Drive', -1, '09:00', '12:30', 'in-person', 'loc1', 'Monthly food distribution', att(0, 5, 6, 7)],
    ['Board Meeting', 0, '18:00', '19:30', 'virtual', null, 'Quarterly board sync', att(1, 2)],
    ['Volunteer Orientation', 1, '10:00', '11:30', 'both', 'loc2', 'Welcome new volunteers', att()],
    ['Food Drive', -29, '09:00', '12:30', 'in-person', 'loc1', 'Monthly food distribution', att(0, 5, 6, 8, 9)],
    ['Food Drive', -57, '09:00', '12:30', 'in-person', 'loc1', 'Monthly food distribution', att(0, 5, 7, 10)],
    ['Community Workshop', -14, '14:00', '16:00', 'in-person', 'loc3', 'Skills workshop for families', att(1, 6, 11)],
    ['Board Meeting', -90, '18:00', '19:30', 'virtual', null, 'Quarterly board sync', att(1, 2, 3)],
  ];
  for (const [i, [name, off, startTime, endTime, format, locationId, description, attendees]] of events.entries()) {
    await put(`events/seed${i}`, { name, description, date: dayOffset(off), startTime, endTime, format, locationId, attendees });
  }
  console.log('[local] sample data seeded');
}

async function ready() {
  for (;;) {
    try {
      await fetch(`${FS}/locations`, { headers: H });
      await fetch(`${AUTH}/`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

const granted = new Set();
async function grantUsers() {
  try {
    const res = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:query`, {
      method: 'POST', headers: H, body: '{}',
    });
    const { userInfo = [] } = await res.json();
    for (const u of userInfo) {
      if (granted.has(u.localId)) continue;
      granted.add(u.localId);
      await put(`admins/${u.localId}`, { email: u.email || '' });
      await put(`members/${u.localId}`, { email: u.email || '', code: 'LOCAL' });
      console.log(`[local] granted admin + member to ${u.email || u.localId}`);
    }
  } catch {
    /* emulator not up yet */
  }
}

await ready();
const existing = await (await fetch(`${FS}/locations`, { headers: H })).json();
if (!existing.documents?.length) await seedSample();
console.log('\n[local] App: http://localhost:5173   Emulator UI: http://localhost:4000');
console.log('[local] Click "Sign in with Google", then "Add new account" > "Auto-generate user information".\n');
setInterval(grantUsers, 2000);
