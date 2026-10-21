import { describe, it, expect } from 'vitest';
import { rosterMap, fixedRole } from './roster.js';

describe('fixedRole', () => {
  const map = rosterMap([{ name: 'Ada Lovelace', role: 'staff' }, { name: 'Bo Kim', role: 'volunteer' }]);
  it('makes staff participants and volunteers volunteers, ignoring case', () => {
    expect(fixedRole(map, 'ada lovelace')).toBe('participant');
    expect(fixedRole(map, 'BO KIM')).toBe('volunteer');
  });
  it('is null for people the roster does not know', () => {
    expect(fixedRole(map, 'Cy Moss')).toBeNull();
  });
});
