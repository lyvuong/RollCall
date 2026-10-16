import { describe, it, expect } from 'vitest';
import { planNeonEvents } from './neon.js';

let n = 0;
const newId = (col) => `${col}-${++n}`;
const ev = (o) => ({ neonEventId: '1', name: 'Food Drive', date: '2026-03-14', startTime: '09:00', endTime: '12:00', ...o });

describe('planNeonEvents', () => {
  it('creates new events with the Neon id and empty attendance', () => {
    const plan = planNeonEvents([ev()], [], newId);
    expect(plan.stats).toMatchObject({ created: 1, linked: 0, errors: 0 });
    expect(plan.ops[0]).toMatchObject({
      col: 'events',
      data: { name: 'Food Drive', date: '2026-03-14', startTime: '09:00', endTime: '12:00', neonEventId: '1', attendees: {} },
    });
    expect(plan.ops[0].merge).toBeUndefined();
  });

  it('skips events already linked by Neon id', () => {
    const plan = planNeonEvents([ev()], [{ id: 'e1', name: 'Renamed', date: '2026-03-14', startTime: '09:00', neonEventId: '1' }], newId);
    expect(plan.ops).toEqual([]);
    expect(plan.stats.skipped).toBe(1);
  });

  it('links a matching local event without touching its data', () => {
    const plan = planNeonEvents([ev({ name: 'food  drive' })], [{ id: 'e9', name: 'Food Drive', date: '2026-03-14', startTime: '09:00' }], newId);
    expect(plan.ops).toEqual([{ col: 'events', id: 'e9', data: { neonEventId: '1' }, merge: true }]);
    expect(plan.stats.linked).toBe(1);
  });

  it('defaults missing times to a one-hour slot that satisfies end > start', () => {
    const plan = planNeonEvents([ev({ startTime: '', endTime: '' }), ev({ neonEventId: '2', startTime: '23:30', endTime: '' })], [], newId);
    expect(plan.ops[0].data).toMatchObject({ startTime: '09:00', endTime: '10:00' });
    const late = plan.ops[1].data;
    expect(late.endTime > late.startTime).toBe(true);
  });

  it('reports bad rows and de-duplicates repeated Neon ids', () => {
    const plan = planNeonEvents([ev({ neonEventId: '' }), ev({ neonEventId: '3', date: 'nope' }), ev({ neonEventId: '4' }), ev({ neonEventId: '4' })], [], newId);
    expect(plan.stats).toMatchObject({ created: 1, errors: 2, skipped: 1 });
  });
});
