import { describe, it, expect } from 'vitest';
import { planNeonEvents, neonOnlyEvents, inferFormat, emptyPastNeonEvents, neonSyncPlan, neonEventPatch } from './neon.js';

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
