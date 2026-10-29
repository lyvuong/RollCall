import { describe, it, expect } from 'vitest';
import { clampCount, cleanCounts, tally, percent, summaryLine, pollRows, MAX_COUNT } from './poll.js';

describe('clampCount', () => {
  it('keeps whole numbers in range', () => {
    expect(clampCount(3)).toBe(3);
    expect(clampCount('7')).toBe(7);
    expect(clampCount(2.9)).toBe(2);
  });
  it('turns junk and negatives into 0 and caps the top', () => {
    expect(clampCount(-4)).toBe(0);
    expect(clampCount('abc')).toBe(0);
    expect(clampCount(undefined)).toBe(0);
    expect(clampCount(9999)).toBe(MAX_COUNT);
  });
});

describe('cleanCounts', () => {
  it('fills missing keys', () => {
    expect(cleanCounts({ up: 2 })).toEqual({ up: 2, mid: 0, down: 0 });
  });
});

describe('tally', () => {
  it('sums docs', () => {
    const t = tally([{ up: 1, mid: 0, down: 0 }, { up: 3, mid: 2, down: 1 }]);
    expect(t).toEqual({ up: 4, mid: 2, down: 1, total: 7, entries: 2 });
  });
  it('handles none', () => {
    expect(tally()).toEqual({ up: 0, mid: 0, down: 0, total: 0, entries: 0 });
  });
});

describe('percent', () => {
  it('rounds and guards zero', () => {
    expect(percent(1, 3)).toBe(33);
    expect(percent(0, 0)).toBe(0);
  });
});

describe('summaryLine', () => {
  it('is empty without reactions', () => {
    expect(summaryLine(tally([]))).toBe('');
  });
  it('lists the three counts', () => {
    expect(summaryLine(tally([{ up: 5, mid: 2, down: 1 }]))).toBe('👍 5 · 👌 2 · 👎 1');
  });
});

describe('pollRows', () => {
  it('skips events with no reactions', () => {
    const events = [{ id: 'a', name: 'A', date: '2026-01-01' }, { id: 'b', name: 'B', date: '2026-01-02' }];
    const rows = pollRows(events, { b: [{ up: 1, mid: 1, down: 0 }] });
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual(['B', '2026-01-02', 1, 1, 0, 2, 1]);
  });
});
