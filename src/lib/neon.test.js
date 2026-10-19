import { describe, it, expect } from 'vitest';
import { planNeonEvents, neonOnlyEvents } from './neon.js';

let n = 0;
const newId = (col) => `${col}-${++n}`;
const ev = (o) => ({ neonEventId: '1', name: 'Food Drive', date: '2026-03-14', startTime: '09:00', endTime: '12:00', ...o });
const none = { events: [], locations: [] };

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
