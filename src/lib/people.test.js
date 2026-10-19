import { describe, it, expect } from 'vitest';
import { normalizeName, editDistance, findDuplicateGroups, attendanceStats, inactivePeople, ignoredPairs } from './people.js';

const P = (id, name) => ({ id, name });
const names = (groups) => groups.map((g) => g.map((p) => p.name).sort());

describe('normalizeName', () => {
  it('ignores case, accents, punctuation and spacing', () => {
    expect(normalizeName('  José   O\'Brien-Smith ')).toBe('jose o brien smith');
  });
});

describe('editDistance', () => {
  it('counts single edits and bails out early', () => {
    expect(editDistance('jon smith', 'john smith')).toBe(1);
    expect(editDistance('abc', 'xyz', 1)).toBe(2);
  });
});

describe('findDuplicateGroups', () => {
  it('groups case, spacing and punctuation variants', () => {
    const g = findDuplicateGroups([P(1, 'Mary Jones'), P(2, 'mary  jones'), P(3, 'Mary-Jones'), P(4, 'Bob Lee')]);
    expect(names(g)).toEqual([['Mary Jones', 'Mary-Jones', 'mary  jones'].sort()]);
  });

  it('catches a one-letter typo', () => {
    expect(names(findDuplicateGroups([P(1, 'Jon Smith'), P(2, 'John Smith')]))).toEqual([['John Smith', 'Jon Smith'].sort()]);
  });

  it('matches swapped word order and extra middle names', () => {
    expect(findDuplicateGroups([P(1, 'Smith John'), P(2, 'John Smith')])).toHaveLength(1);
    expect(findDuplicateGroups([P(1, 'Ann Marie Lee'), P(2, 'Ann Lee')])).toHaveLength(1);
  });

  it('keeps different people apart, including short names', () => {
    expect(findDuplicateGroups([P(1, 'Ann Lee'), P(2, 'Ann Li'), P(3, 'Bob Lee'), P(4, 'Tom'), P(5, 'Tim')])).toEqual([]);
  });

  it('chains transitive matches into one group and skips blank names', () => {
    const g = findDuplicateGroups([P(1, 'Jon Smith'), P(2, 'John Smith'), P(3, 'John  Smith'), P(4, '')]);
    expect(g).toHaveLength(1);
    expect(g[0]).toHaveLength(3);
  });
});

describe('marked distinct', () => {
  it('stops suggesting a pair marked as different people, from either side', () => {
    const marty = { id: 1, name: 'Marty Sullivan', notSame: [2] };
    const mary = { id: 2, name: 'Mary Sullivan' };
    expect(findDuplicateGroups([P(1, 'Marty Sullivan'), P(2, 'Mary Sullivan')])).toHaveLength(1);
    expect(findDuplicateGroups([marty, mary])).toEqual([]);
    expect(findDuplicateGroups([{ id: 1, name: 'Marty Sullivan' }, { id: 2, name: 'Mary Sullivan', notSame: [1] }])).toEqual([]);
  });

  it('still groups the genuine duplicates once the odd one out is marked', () => {
    const g = findDuplicateGroups([
      { id: 1, name: 'Marty Sullivan', notSame: [2] },
      { id: 2, name: 'Mary Sullivan' },
      { id: 3, name: 'Marty  Sullivan', notSame: [2] },
    ]);
    expect(names(g)).toEqual([['Marty  Sullivan', 'Marty Sullivan'].sort()]);
  });
});

describe('ignoredPairs', () => {
  it('lists each marked pair once, even when marked on both sides, and drops deleted people', () => {
    const people = [
      { id: 1, name: 'Marty Sullivan', notSame: [2, 99] },
      { id: 2, name: 'Mary Sullivan', notSame: [1] },
      { id: 3, name: 'Bob' },
    ];
    expect(ignoredPairs(people).map((p) => p.map((x) => x.name))).toEqual([['Marty Sullivan', 'Mary Sullivan']]);
  });
});

describe('attendance', () => {
  const events = [
    { date: '2026-01-10', attendees: { a: {}, b: {} } },
    { date: '2026-03-01', attendees: { a: {} } },
    { date: '2026-12-01', attendees: { c: {} } }, // upcoming
  ];
  const stats = attendanceStats(events, '2026-06-01');

  it('counts past and upcoming and tracks the latest past date', () => {
    expect(stats.get('a')).toEqual({ past: 2, upcoming: 0, last: '2026-03-01' });
    expect(stats.get('c')).toEqual({ past: 0, upcoming: 1, last: '' });
  });

  it('lists people who never attended, sparing those with upcoming events', () => {
    const people = [P('a', 'A'), P('b', 'B'), P('c', 'C'), P('d', 'D')];
    expect(inactivePeople(people, stats).map((p) => p.id)).toEqual(['d']);
  });

  it('lists people last seen before a cutoff date', () => {
    const people = [P('a', 'A'), P('b', 'B'), P('d', 'D')];
    expect(inactivePeople(people, stats, '2026-02-01').map((p) => p.id)).toEqual(['b']);
  });
});
