import { describe, it, expect } from 'vitest';
import { locationKey, matchLocation, findDuplicateLocations } from './locations.js';

const L = (id, name) => ({ id, name });

describe('locationKey', () => {
  it('ignores case, punctuation, spacing and a leading "the"', () => {
    expect(locationKey('The Ovation at Arrowbrook')).toBe('ovation at arrowbrook');
    expect(locationKey('  ovation   at Arrowbrook. ')).toBe('ovation at arrowbrook');
    expect(locationKey('Lost Dog Cafe & Bar')).toBe('lost dog cafe and bar');
  });
});

describe('matchLocation', () => {
  it('finds the saved location a typed name stands for', () => {
    const locs = [L('1', 'The Ovation at Arrowbrook'), L('2', 'Library')];
    expect(matchLocation(locs, 'ovation at arrowbrook')?.id).toBe('1');
    expect(matchLocation(locs, 'Park')).toBeUndefined();
    expect(matchLocation(locs, '  ')).toBeUndefined();
  });
});

describe('findDuplicateLocations', () => {
  it('groups look-alike names and leaves different places alone', () => {
    const locs = [L('1', 'Ovation at Arrowbrook'), L('2', 'The Ovation at Arrowbrook'), L('3', 'Library'), L('4', 'Herndon Library')];
    const groups = findDuplicateLocations(locs);
    expect(groups.map((g) => g.map((l) => l.id).sort())).toEqual([['1', '2']]);
  });
  it('matches a name contained in another as whole words, but not a single-word name', () => {
    expect(findDuplicateLocations([L('1', 'Ovation at Arrowbrook Clubhouse'), L('2', 'Ovation at Arrowbrook')])).toHaveLength(1);
    expect(findDuplicateLocations([L('1', 'Park'), L('2', 'Park Avenue Hall')])).toHaveLength(0);
  });
});
