import { describe, it, expect } from 'vitest';
import { planNeonEvents, neonOnlyEvents, inferFormat, emptyPastNeonEvents, staleRegistrantEvents, registrantUpdates } from './neon.js';

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
