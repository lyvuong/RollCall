import { describe, it, expect } from 'vitest';
import { planNeonEvents, neonOnlyEvents, inferFormat, emptyPastNeonEvents, neonSyncPlan, neonEventPatch, friendlyNeonReason, staleRegistrantEvents, registrantUpdates, neonReconcile } from './neon.js';

describe('staleRegistrantEvents', () => {
  const local = (o) => ({ id: 'e1', neonEventId: '1', date: '2026-10-30', ...o });
  const neon = (registered) => [{ neonEventId: '1', registered }];
  it('flags an upcoming event whose count changed', () => {
    expect(staleRegistrantEvents(neon(5), [local({ neonCount: 4 })], '2026-10-21')).toHaveLength(1);
  });
  it('ignores an unchanged count, past events, unlinked events and a missing count', () => {
    expect(staleRegistrantEvents(neon(4), [local({ neonCount: 4 })], '2026-10-21')).toHaveLength(0);
    expect(staleRegistrantEvents(neon(5), [local({ neonCount: 4, date: '2026-10-01' })], '2026-10-21')).toHaveLength(0);
    expect(staleRegistrantEvents(neon(5), [], '2026-10-21')).toHaveLength(0);
    expect(staleRegistrantEvents(neon(null), [local({ neonCount: 4 })], '2026-10-21')).toHaveLength(0);
  });
  it('treats a never-counted event as stale only when Neon has registrations', () => {
    expect(staleRegistrantEvents(neon(3), [local()], '2026-10-21')).toHaveLength(1);
    expect(staleRegistrantEvents(neon(0), [local()], '2026-10-21')).toHaveLength(0);
  });
});

describe('swaps and cancellations', () => {
  const att = (id, name) => ({ attendeeId: id, accountId: '', name });
  const stored = { a: { name: 'Ann', status: 'present' }, b: { name: 'Bob', status: 'pending' } };
  it('adds the new person and flags the one who dropped out, keeping confirmations', () => {
    expect(registrantUpdates([att('a', 'Ann'), att('c', 'Cy')], stored)).toEqual({
      c: { name: 'Cy', accountId: '', status: 'pending' },
      b: { cancelled: true },
    });
  });
  it('clears the flag when someone comes back and ignores an unfetched list', () => {
    expect(registrantUpdates([att('a', 'Ann'), att('b', 'Bob')], { ...stored, b: { ...stored.b, cancelled: true } })).toEqual({ b: { cancelled: false } });
    expect(registrantUpdates(undefined, stored)).toEqual({});
  });
  it('plans a swap on an already-imported event without a count change', () => {
    const existing = { events: [{ id: 'e1', neonEventId: '1', name: 'Food Drive', date: '2026-03-14', startTime: '09:00', registrants: stored, neonCount: 2, neonRegs: 2 }], locations: [] };
    const n = { neonEventId: '1', name: 'Food Drive', date: '2026-03-14', startTime: '09:00', registered: 2, registrations: 2 };
    const plan = planNeonEvents([n], existing, () => 'x', { 1: [att('a', 'Ann'), att('c', 'Cy')] });
    expect(plan.ops[0].data.registrants).toEqual({ c: { name: 'Cy', accountId: '', status: 'pending' }, b: { cancelled: true } });
    expect(plan.rows[0].message).toBe('already imported · 1 registered name added · 1 cancelled');
    expect(plan.stats.registrants).toBe(1);
  });
  it('always rechecks today and tomorrow, and rechecks later events when the registration count moves', () => {
    const e = (date, o) => ({ id: 'e', neonEventId: '1', date, neonCount: 4, neonRegs: 3, ...o });
    const same = [{ neonEventId: '1', registered: 4, registrations: 3 }];
    expect(staleRegistrantEvents(same, [e('2026-10-21')], '2026-10-21')).toHaveLength(1);
    expect(staleRegistrantEvents(same, [e('2026-10-22')], '2026-10-21')).toHaveLength(1);
    expect(staleRegistrantEvents(same, [e('2026-10-23')], '2026-10-21')).toHaveLength(0);
    expect(staleRegistrantEvents([{ neonEventId: '1', registered: 4, registrations: 2 }], [e('2026-10-23')], '2026-10-21')).toHaveLength(1);
  });
});

describe('planNeonEvents neonCount', () => {
  const att = (id, name) => ({ attendeeId: id, accountId: '', name });
  it('adds only the new names and records the count on an already-imported event', () => {
    const existing = { events: [{ id: 'e1', neonEventId: '1', name: 'Food Drive', date: '2026-03-14', startTime: '09:00', registrants: { a: { name: 'Ann', status: 'present' } }, neonCount: 1 }], locations: [] };
    const plan = planNeonEvents([{ neonEventId: '1', name: 'Food Drive', date: '2026-03-14', startTime: '09:00', registered: 2 }], existing, () => 'x', { 1: [att('a', 'Ann'), att('b', 'Bob')] });
    expect(plan.ops).toEqual([{ col: 'events', id: 'e1', data: { registrants: { b: { name: 'Bob', accountId: '', status: 'pending' } }, neonCount: 2 }, merge: true }]);
  });
  it('does not record a count when the names were not fetched', () => {
    const existing = { events: [{ id: 'e1', neonEventId: '1', name: 'Food Drive', date: '2026-03-14', startTime: '09:00', neonCount: 1 }], locations: [] };
    const plan = planNeonEvents([{ neonEventId: '1', name: 'Food Drive', date: '2026-03-14', startTime: '09:00', registered: 2 }], existing, () => 'x', {});
    expect(plan.ops).toEqual([]);
  });
});

describe('emptyPastNeonEvents', () => {
  it('keeps only past imported events nobody used', () => {
    const e = (o) => ({ id: 'x', name: 'A', date: '2026-01-01', neonEventId: '1', attendees: {}, ...o });
    const out = emptyPastNeonEvents(
      [e({ id: 'a' }), e({ id: 'b', attendees: { p: { name: 'P' } } }), e({ id: 'c', neonEventId: undefined }), e({ id: 'd', date: '2026-12-01' }), e({ id: 'f', volunteerHours: 3 })],
      '2026-06-01',
    );
    expect(out.map((x) => x.id)).toEqual(['a']);
  });
});

let n = 0;
const newId = (col) => `${col}-${++n}`;
const ev = (o) => ({ neonEventId: '1', name: 'Food Drive', date: '2026-03-14', startTime: '09:00', endTime: '12:00', ...o });
const none = { events: [], locations: [] };

describe('planNeonEvents registrants', () => {
  const regs = { 1: [{ attendeeId: 'a1', accountId: '9', name: 'Sam  Lee' }, { attendeeId: 'a2', name: 'Jo Ng' }] };

  it('stores registered names as pending on new events', () => {
    const plan = planNeonEvents([ev()], none, newId, regs);
    expect(plan.ops[0].data.registrants).toEqual({
      a1: { name: 'Sam Lee', accountId: '9', status: 'pending' },
      a2: { name: 'Jo Ng', accountId: '', status: 'pending' },
    });
    expect(plan.stats.registrants).toBe(2);
  });

  it('adds only missing names to an already imported event and keeps confirmations', () => {
    const existing = { events: [{ id: 'e1', name: 'Food Drive', date: '2026-03-14', startTime: '09:00', neonEventId: '1', registrants: { a1: { name: 'Sam Lee', status: 'present' } } }], locations: [] };
    const plan = planNeonEvents([ev()], existing, newId, regs);
    expect(plan.ops).toEqual([{ col: 'events', id: 'e1', data: { registrants: { a2: { name: 'Jo Ng', accountId: '', status: 'pending' } } }, merge: true }]);
  });

  it('writes nothing extra when there are no registrants', () => {
    expect(planNeonEvents([ev()], none, newId).ops[0].data).not.toHaveProperty('registrants');
  });
});

describe('planNeonEvents', () => {
  it('creates new events with the Neon id and empty attendance', () => {
    const plan = planNeonEvents([ev()], none, newId);
    expect(plan.stats).toMatchObject({ created: 1, linked: 0, errors: 0 });
    expect(plan.ops[0]).toMatchObject({
      col: 'events',
      data: { name: 'Food Drive', date: '2026-03-14', startTime: '09:00', endTime: '12:00', neonEventId: '1', attendees: {}, locationId: null },
    });
    expect(plan.ops[0].merge).toBeUndefined();
  });

  it('skips events already linked by Neon id', () => {
    const existing = { events: [{ id: 'e1', name: 'Renamed', date: '2026-03-14', startTime: '09:00', neonEventId: '1' }], locations: [] };
    const plan = planNeonEvents([ev()], existing, newId);
    expect(plan.ops).toEqual([]);
    expect(plan.stats.skipped).toBe(1);
  });

  it('links a matching local event without touching its data', () => {
    const existing = { events: [{ id: 'e9', name: 'Food Drive', date: '2026-03-14', startTime: '09:00' }], locations: [] };
    const plan = planNeonEvents([ev({ name: 'food  drive' })], existing, newId);
    expect(plan.ops).toEqual([{ col: 'events', id: 'e9', data: { neonEventId: '1' }, merge: true }]);
    expect(plan.stats.linked).toBe(1);
  });

  it('defaults missing times to a one-hour slot that satisfies end > start', () => {
    const plan = planNeonEvents([ev({ startTime: '', endTime: '' }), ev({ neonEventId: '2', startTime: '23:30', endTime: '' })], none, newId);
    expect(plan.ops[0].data).toMatchObject({ startTime: '09:00', endTime: '10:00' });
    const late = plan.ops[1].data;
    expect(late.endTime > late.startTime).toBe(true);
  });

  it('reports bad rows and de-duplicates repeated Neon ids', () => {
    const plan = planNeonEvents([ev({ neonEventId: '' }), ev({ neonEventId: '3', date: 'nope' }), ev({ neonEventId: '4' }), ev({ neonEventId: '4' })], none, newId);
    expect(plan.stats).toMatchObject({ created: 1, errors: 2, skipped: 1 });
  });

  it('reuses saved locations by name and creates each new one once', () => {
    const existing = { events: [], locations: [{ id: 'l1', name: 'Main Hall' }] };
    const plan = planNeonEvents(
      [
        ev({ neonEventId: '1', location: 'main  hall' }),
        ev({ neonEventId: '2', date: '2026-03-15', location: 'Lost Dog Cafe' }),
        ev({ neonEventId: '3', date: '2026-03-16', location: 'lost dog cafe' }),
        ev({ neonEventId: '4', date: '2026-03-17', location: '' }),
      ],
      existing,
      newId,
    );
    const events = plan.ops.filter((o) => o.col === 'events');
    const locs = plan.ops.filter((o) => o.col === 'locations');
    expect(locs).toHaveLength(1);
    expect(plan.stats.newLocations).toBe(1);
    expect(events.map((o) => o.data.locationId)).toEqual(['l1', locs[0].id, locs[0].id, null]);
  });
});

describe('neonOnlyEvents', () => {
  const local = (o) => ({ id: 'e1', name: 'Food Drive', date: '2026-03-14', startTime: '09:00', ...o });

  it('keeps Neon events that are not in RollCall, sorted by date then time', () => {
    const out = neonOnlyEvents(
      [ev({ neonEventId: '2', name: 'B', date: '2026-03-15' }), ev({ neonEventId: '3', name: 'A', startTime: '10:00' }), ev({ neonEventId: '4', name: 'C', startTime: '08:00' })],
      [],
    );
    expect(out.map((e) => e.name)).toEqual(['C', 'A', 'B']);
  });

  it('hides events already linked by Neon id', () => {
    expect(neonOnlyEvents([ev()], [local({ name: 'Renamed', neonEventId: '1' })])).toEqual([]);
  });

  it('hides events that match a local event by name, date and start', () => {
    expect(neonOnlyEvents([ev({ name: 'food  DRIVE' })], [local()])).toEqual([]);
  });

  it('treats a missing start time as 09:00 when matching, but leaves it blank for display', () => {
    const n = ev({ startTime: '', endTime: '' });
    expect(neonOnlyEvents([n], [local()])).toEqual([]);
    expect(neonOnlyEvents([n], [])[0]).toMatchObject({ startTime: '', endTime: '' });
  });

  it('drops duplicates, unnamed and undated events', () => {
    const out = neonOnlyEvents([ev(), ev(), ev({ neonEventId: '5', name: '' }), ev({ neonEventId: '6', date: 'nope' })], []);
    expect(out).toHaveLength(1);
  });

  it('copes with no Neon data', () => {
    expect(neonOnlyEvents(null, [local()])).toEqual([]);
  });
});

describe('inferFormat', () => {
  it('reads the format OSG puts in the event name', () => {
    expect(inferFormat('Book Club (Virtual)')).toBe('virtual');
    expect(inferFormat('Book Club (Virtual/Hybrid)')).toBe('both');
    expect(inferFormat('Dinner Club (In-person)')).toBe('in-person');
    expect(inferFormat('Fun (Virtual and In Person)')).toBe('both');
    expect(inferFormat('Explore DC')).toBe('in-person');
  });

  it('creates virtual events without a location', () => {
    const plan = planNeonEvents([ev({ name: 'Club (Virtual)', location: 'Zoom' })], none, newId);
    expect(plan.ops[0].data).toMatchObject({ format: 'virtual', locationId: null });
    expect(plan.ops.some((o) => o.col === 'locations')).toBe(false);
  });
});

describe('neonSyncPlan', () => {
  const ev = { name: 'Walk', date: '2026-10-20', startTime: '09:00', endTime: '10:00' };
  const neon = { name: 'Walk', date: '2026-10-20', endDate: '2026-10-20', startTime: '09:00', endTime: '10:00', location: 'Cadence' };

  it('is in sync when nothing differs', () => {
    expect(neonSyncPlan(ev, neon, [], 'Cadence').inSync).toBe(true);
  });

  it('ignores extra whitespace in names and the case of locations', () => {
    expect(neonSyncPlan({ ...ev, name: ' Walk  ' }, { ...neon, name: 'Walk' }, [], 'cadence').inSync).toBe(true);
  });

  it('lists changed details', () => {
    const plan = neonSyncPlan({ ...ev, name: 'Walk 2', date: '2026-10-21', endTime: '11:00' }, neon, [], 'Queens Court');
    expect(plan.details.map((d) => d.field)).toEqual(['name', 'date', 'endTime', 'location']);
    expect(plan.details[3]).toMatchObject({ local: 'Queens Court', neon: 'Cadence' });
  });

  it('does not treat times Neon lacks, or an unset local location, as differences', () => {
    expect(neonSyncPlan(ev, { ...neon, startTime: '', endTime: '' }, [], '').inSync).toBe(true);
  });

  it('pushes confirmed check-ins that differ, never pending ones', () => {
    const attendees = [
      { attendeeId: '1', registrationId: '90', name: 'Ada', markedAttended: false },
      { attendeeId: '2', registrationId: '91', name: 'Bo', markedAttended: true },
      { attendeeId: '3', registrationId: '92', name: 'Cy', markedAttended: true },
      { attendeeId: '4', registrationId: '93', name: 'Di', markedAttended: false },
    ];
    const registrants = {
      1: { name: 'Ada', status: 'present' }, // Neon says no -> send true
      2: { name: 'Bo', status: 'missing' }, // Neon says yes -> send false
      3: { name: 'Cy', status: 'present' }, // already agrees
      4: { name: 'Di' }, // pending: left alone
      9: { name: 'Gone', status: 'present' }, // not on Neon any more: skipped
    };
    const plan = neonSyncPlan({ ...ev, registrants }, neon, attendees, 'Cadence');
    expect(plan.checkins).toEqual([
      { attendeeId: '1', registrationId: '90', name: 'Ada', attended: true },
      { attendeeId: '2', registrationId: '91', name: 'Bo', attended: false },
    ]);
    expect(plan.count).toBe(2);
  });

  it('registers roll people missing from Neon and checks in registered ones not yet marked', () => {
    const attendees = [
      { attendeeId: '1', registrationId: '90', name: 'Ada Lovelace', markedAttended: false },
      { attendeeId: '2', registrationId: '91', name: 'Bo Peep', markedAttended: true },
    ];
    const roll = { p1: { name: 'Ada Lovelace' }, p2: { name: 'Bo Peep' }, p3: { name: 'Walk In' } };
    const plan = neonSyncPlan({ ...ev, attendees: roll }, neon, attendees, 'Cadence');
    expect(plan.checkins).toEqual([{ attendeeId: '1', registrationId: '90', name: 'Ada Lovelace', attended: true }]);
    expect(plan.walkins).toEqual([{ personId: 'p3', name: 'Walk In' }]);
    expect(plan.count).toBe(2);
  });

  it('maps Here, Missing and Unconfirmed onto Neon attended / not attended', () => {
    const attendees = [
      { attendeeId: '1', registrationId: '90', name: 'Ada Lovelace', markedAttended: true }, // Here but removed from the roll
      { attendeeId: '2', registrationId: '91', name: 'Bo Peep', markedAttended: true }, // Missing
      { attendeeId: '3', registrationId: '92', name: 'Cy Young', markedAttended: false }, // Here, Neon says no
      { attendeeId: '4', registrationId: '93', name: 'Di Dee', markedAttended: true }, // Unconfirmed, Neon checked them in: leave alone
      { attendeeId: '5', registrationId: '94', name: 'Ed Eng', markedAttended: true }, // Unconfirmed after a Here we synced: undo
    ];
    const registrants = {
      1: { name: 'Ada Lovelace', status: 'present' },
      2: { name: 'Bo Peep', status: 'missing' },
      3: { name: 'Cy Young', status: 'present' },
      4: { name: 'Di Dee' },
      5: { name: 'Ed Eng', neonSeen: true },
    };
    const plan = neonSyncPlan({ ...ev, registrants, attendees: { p3: { name: 'Cy Young' } } }, neon, attendees, 'Cadence');
    expect(plan.checkins.map((c) => [c.name, c.attended])).toEqual([
      ['Ada Lovelace', false],
      ['Bo Peep', false],
      ['Cy Young', true],
      ['Ed Eng', false],
    ]);
  });

  it('leaves unknown, unregistered Neon check-ins alone', () => {
    const attendees = [{ attendeeId: '1', registrationId: '90', name: 'Ada', markedAttended: true }];
    expect(neonSyncPlan({ ...ev, attendees: {} }, neon, attendees, 'Cadence').checkins).toEqual([]);
  });

  it('skips check-ins when attendees are not loaded', () => {
    expect(neonSyncPlan({ ...ev, registrants: { 1: { name: 'Ada', status: 'present' } } }, neon, null, 'Cadence').checkins).toEqual([]);
  });
});

describe('neonEventPatch', () => {
  it('moves a one-day event as one day and keeps a multi-day end', () => {
    const d = [{ field: 'date', local: '2026-10-21' }];
    expect(neonEventPatch(d, { date: '2026-10-20', endDate: '2026-10-20' })).toEqual({ date: '2026-10-21', endDate: '2026-10-21' });
    expect(neonEventPatch(d, { date: '2026-10-20', endDate: '2026-10-22' })).toEqual({ date: '2026-10-21' });
  });
});

describe('friendlyNeonReason', () => {
  it('explains the form-registration coupon rejection', () => {
    expect(friendlyNeonReason('Neon One 400: [{"code":"14014","message":"Event coupon code is invalid."}]')).toMatch(/online form/);
  });
  it('strips the prefix from other errors', () => {
    expect(friendlyNeonReason('Neon One 400: Something else')).toBe('Something else');
  });
});

describe('neonReconcile', () => {
  const att = (id, name, markedAttended, extra = {}) => ({ attendeeId: id, registrationId: `r${id}`, name, markedAttended, status: 'SUCCEEDED', ...extra });

  it('pulls a check-in made on Neon into an Unconfirmed row, once', () => {
    const ev = { attendees: {}, registrants: { 1: { name: 'Ada' } } };
    expect(neonReconcile(ev, [att('1', 'Ada', true)])).toEqual([{ type: 'pull', key: '1', name: 'Ada' }]);
    const done = { attendees: { p1: { name: 'Ada' } }, registrants: { 1: { name: 'Ada', status: 'present', neonSeen: true } } };
    expect(neonReconcile(done, [att('1', 'Ada', true)])).toEqual([]);
  });

  it('does not pull a person RollCall just took back (Neon attended as of the last sync)', () => {
    const ev = { attendees: {}, registrants: { 1: { name: 'Ada', neonSeen: true } } };
    expect(neonReconcile(ev, [att('1', 'Ada', true)])).toEqual([]);
  });

  it('remembers the Neon value once both sides agree', () => {
    const ev = { attendees: { p1: { name: 'Ada' } }, registrants: { 1: { name: 'Ada', status: 'present' }, 2: { name: 'Bo', status: 'missing' } } };
    expect(neonReconcile(ev, [att('1', 'Ada', true), att('2', 'Bo', false)])).toEqual([
      { type: 'ack', key: '1', seen: true },
      { type: 'ack', key: '2', seen: false },
    ]);
  });

  it('marks the rest Missing once a finished event has reported attendance, never before', () => {
    const ev = { date: '2026-10-20', attendees: {}, registrants: { 1: { name: 'Ada' }, 2: { name: 'Bo' } } };
    const list = [att('1', 'Ada', true), att('2', 'Bo', false)];
    expect(neonReconcile(ev, list, '2026-10-21')).toEqual([
      { type: 'pull', key: '1', name: 'Ada' },
      { type: 'miss', key: '2' },
    ]);
    expect(neonReconcile(ev, list, '2026-10-20').map((o) => o.type)).toEqual(['pull', 'ack']); // same day: roll still being taken, nobody marked Missing
    expect(neonReconcile(ev, [att('1', 'Ada', false), att('2', 'Bo', false)], '2026-10-21').filter((o) => o.type === 'miss')).toEqual([]); // nobody reported
  });

  it('adds rows for new registrations: Here when already on the roll, else Unconfirmed (pulled if checked in)', () => {
    const ev = { attendees: { p1: { name: 'Walk In' } }, registrants: {} };
    const ops = neonReconcile(ev, [att('7', 'Walk In', true), att('8', 'New Person', true), att('9', 'Quiet One', false), att('10', 'Gone', false, { status: 'CANCELLED' })]);
    expect(ops).toEqual([
      { type: 'add', key: '7', entry: { name: 'Walk In', accountId: '', status: 'present', neonSeen: true } },
      { type: 'add', key: '8', entry: { name: 'New Person', accountId: '', status: 'pending' } },
      { type: 'pull', key: '8', name: 'New Person' },
      { type: 'add', key: '9', entry: { name: 'Quiet One', accountId: '', status: 'pending' } },
    ]);
  });
});
