import { describe, it, expect } from 'vitest';
import { parseCSV } from './csv.js';
import { eventsToCsv, EXPORT_HEADER } from './exporter.js';
import { planImport } from './importer.js';

let n = 0;
const newId = (col) => `${col}-${++n}`;

const events = [
  {
    id: 'e2', name: 'Board, "Annual"', date: '2026-03-20', startTime: '18:00', endTime: '19:30',
    format: 'virtual', locationId: null, description: 'Line one\nline two', attendees: {},
  },
  {
    id: 'e1', name: 'Food Drive', date: '2026-03-14', startTime: '09:00', endTime: '12:30',
    format: 'in-person', locationId: 'l1', description: '',
    attendees: {
      p1: { name: 'Jane Doe', type: 'community', role: 'participant' },
      p2: { name: 'Sam Lee', type: 'osg', role: 'volunteer' },
    },
  },
];

describe('eventsToCsv', () => {
  const rows = parseCSV(eventsToCsv(events, { l1: 'Main Hall' }));

  it('uses the import header and sorts by date', () => {
    expect(rows[0]).toEqual(EXPORT_HEADER);
    expect(rows[1][0]).toBe('Food Drive');
    expect(rows[2][0]).toBe('Board, "Annual"');
  });

  it('writes location, hours and explicit attendee type/role', () => {
    expect(rows[1][5]).toBe('Main Hall');
    expect(rows[1][7]).toBe('3.5');
    expect(rows[1][8]).toBe('Jane Doe:community:participant; Sam Lee:osg:volunteer');
  });

  it('round-trips through the importer', () => {
    const existing = { people: [], locations: [], events: [] };
    const plan = planImport('events', eventsToCsv(events, { l1: 'Main Hall' }), existing, newId);
    expect(plan.stats.errors).toBe(0);
    const out = plan.ops.filter((o) => o.col === 'events').map((o) => o.data);
    expect(out.map((d) => d.name)).toEqual(['Food Drive', 'Board, "Annual"']);
    expect(out[0].attendees && Object.values(out[0].attendees).map((a) => a.role).sort()).toEqual(['participant', 'volunteer']);
    expect(out[1].description).toBe('Line one\nline two');
  });
});
