import { describe, it, expect } from 'vitest';
import { activeOthers, STALE_MS } from './presence.js';

describe('activeOthers', () => {
  const now = Date.parse('2026-10-21T15:00:00Z');
  const row = (uid, name, agoMs, where = 'participants') => ({ uid, name, where, at: agoMs === null ? null : new Date(now - agoMs) });

  it('leaves out me and anyone not seen for a minute', () => {
    const rows = [row('me', 'Me', 1000), row('a', 'Lisa', 5000), row('b', 'Old', STALE_MS + 1)];
    expect(activeOthers(rows, 'me', now).map((r) => r.name)).toEqual(['Lisa']);
  });

  it('counts a marker the server has not stamped yet as present, sorted by name', () => {
    const rows = [row('b', 'Max', null), row('a', 'Ada', 100)];
    expect(activeOthers(rows, 'me', now).map((r) => r.name)).toEqual(['Ada', 'Max']);
  });

  it('ignores markers with no name', () => {
    expect(activeOthers([row('a', '', 100)], 'me', now)).toEqual([]);
  });
});
