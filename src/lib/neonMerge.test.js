import { describe, it, expect } from 'vitest';
import { normName, titleScore, similarNeonEvents, matchParticipants, planMerge, planMove } from './neonMerge.js';

describe('normName', () => {
  it('ignores case, accents, punctuation and extra spaces', () => {
    expect(normName("  José  O'Neil ")).toBe('jose o neil');
  });
});

describe('titleScore', () => {
  it('ignores format words and filler', () => {
    expect(titleScore('Book Club', 'Book Club (Virtual)')).toBe(1);
    expect(titleScore('Open Art Studio', 'Open Art Studio at The Waypoint (Alexandria)')).toBeGreaterThan(0.6);
  });
  it('is low for different events', () => {
    expect(titleScore('Book Club', 'Dinner Club')).toBeLessThan(0.34);
  });
});

describe('similarNeonEvents', () => {
  const ev = { id: 'a', name: 'Game Night at the Arden', date: '2026-10-20', startTime: '18:00' };
  const n = (o) => ({ neonEventId: '1', name: 'Game Night at the Arden (Alexandria)', date: '2026-10-20', startTime: '18:00', location: 'The Arden', ...o });

  it('finds the same event and explains why', () => {
    const [hit] = similarNeonEvents(ev, [n()], { locationName: 'The Arden' });
    expect(hit.neon.neonEventId).toBe('1');
    expect(hit.reasons).toEqual(['Same title', 'Same date', 'Same start time', 'Same location']);
  });

  it('ranks by score and skips taken, far-away and unrelated events', () => {
    const list = [
      n({ neonEventId: '1', startTime: '10:00' }),
      n({ neonEventId: '2' }),
      n({ neonEventId: '3', date: '2026-10-25' }),
      n({ neonEventId: '4', name: 'Dinner Club' }),
      n({ neonEventId: '5' }),
    ];
    const out = similarNeonEvents(ev, list, { locationName: 'The Arden', takenIds: new Set(['5']) });
    expect(out.map((x) => x.neon.neonEventId)).toEqual(['2', '1']);
  });

  it('still offers a day-before-or-after match, lower down', () => {
    const [hit] = similarNeonEvents(ev, [n({ date: '2026-10-21' })], { locationName: 'The Arden' });
    expect(hit.reasons).toContain('Day before or after');
  });
});

describe('matchParticipants', () => {
  const neon = [
    { attendeeId: '1', registrationId: '9', name: 'Ada  Lovelace ', status: 'SUCCEEDED', markedAttended: false },
    { attendeeId: '2', registrationId: '10', name: 'Bo Diddley', status: 'CANCELED' },
    { attendeeId: '3', registrationId: '11', name: 'Ada Lovelace', status: 'SUCCEEDED' },
  ];
  it('pairs by name, uses each registration once, and skips cancelled ones', () => {
    const rows = matchParticipants(
      { p1: { name: 'ada lovelace' }, p2: { name: 'Ada Lovelace' }, p3: { name: 'Bo Diddley' }, p4: { name: 'Cy Young', role: 'volunteer' } },
      neon,
    );
    expect(rows.map((r) => [r.name, r.attendee?.attendeeId ?? null])).toEqual([
      ['ada lovelace', '1'],
      ['Ada Lovelace', '3'],
      ['Bo Diddley', null],
      ['Cy Young', null],
    ]);
    expect(rows[3].role).toBe('volunteer');
  });
});

describe('planMerge', () => {
  const event = { id: 'ev1', name: 'Local name', date: '2026-10-19', format: 'in-person', locationId: 'L1' };
  const neon = { neonEventId: '42', name: 'Walk (Virtual)', date: '2026-10-20', startTime: '17:00', endTime: '', location: 'Cadence' };
  const att = [
    { attendeeId: '1', accountId: '100', name: 'Ada', status: 'SUCCEEDED' },
    { attendeeId: '2', name: 'Bo', status: 'CANCELED' },
    { attendeeId: '3', accountId: '', name: 'Cy', status: 'SUCCEEDED' },
  ];
  const ids = () => {
    let n = 0;
    return (col) => `${col}-${++n}`;
  };

  it('adopts the OSG details and links the event; confirmed people become Here', () => {
    const { ops, data } = planMerge(event, neon, att, new Set(['3']), [], ids());
    expect(data).toMatchObject({ name: 'Walk (Virtual)', date: '2026-10-20', startTime: '17:00', endTime: '18:00', format: 'virtual', locationId: null, neonEventId: '42' });
    expect(data.registrants).toEqual({
      1: { name: 'Ada', accountId: '100', status: 'pending' },
      3: { name: 'Cy', accountId: '', status: 'present' },
    });
    expect(ops).toEqual([{ col: 'events', id: 'ev1', data, merge: true }]);
    expect(data).not.toHaveProperty('attendees');
    expect(data).not.toHaveProperty('description');
  });

  it('keeps the chosen format when the title says nothing, and creates a missing location', () => {
    const { ops, data } = planMerge(event, { ...neon, name: 'Walk' }, [], new Set(), [{ id: 'L9', name: 'Queens Court' }], ids());
    expect(data.format).toBe('in-person');
    expect(ops[0]).toEqual({ col: 'locations', id: 'locations-1', data: { name: 'Cadence' } });
    expect(data.locationId).toBe('locations-1');
  });

  it('reuses an existing location by name and keeps the local one when OSG has none', () => {
    expect(planMerge(event, { ...neon, name: 'Walk' }, [], new Set(), [{ id: 'L9', name: 'cadence ' }], ids()).data.locationId).toBe('L9');
    expect(planMerge(event, { ...neon, name: 'Walk', location: '' }, [], new Set(), [], ids()).data.locationId).toBe('L1');
  });
});

describe('planMove', () => {
  const source = { id: 's', attendees: { a: { name: 'Ada', role: 'participant' }, b: { name: 'Bo', role: 'volunteer' } }, volunteerHours: 2, description: 'notes' };
  const attendees = [{ attendeeId: '9', accountId: '100', name: 'Ada' }, { attendeeId: '10', name: 'Cy' }];

  it('adds people missing from the target, confirms the chosen ones, and copies hours and notes', () => {
    const target = { id: 't', attendees: { b: { name: 'Bo', role: 'participant' } }, volunteerHours: 0, description: '' };
    const { ops, data } = planMove(source, target, attendees, new Set(['9']));
    expect(data.attendees).toEqual({ a: { name: 'Ada', role: 'participant' } }); // Bo is already there and is left alone
    expect(data.registrants).toEqual({ 9: { name: 'Ada', accountId: '100', status: 'present' } });
    expect(data.volunteerHours).toBe(2);
    expect(data.description).toBe('notes');
    expect(ops).toEqual([{ col: 'events', id: 't', data, merge: true }]);
  });

  it("keeps the target's own hours and description", () => {
    const { data } = planMove(source, { id: 't', attendees: {}, volunteerHours: 5, description: 'mine' }, [], new Set());
    expect(data).not.toHaveProperty('volunteerHours');
    expect(data).not.toHaveProperty('description');
  });
});
