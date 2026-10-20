import { describe, it, expect } from 'vitest';
import { planPeopleSync, neonPersonDoc, daysSince } from './peopleSync.js';

const acct = (id, first, last, email = '') => ({ accountId: id, firstName: first, lastName: last, email });
const stored = (id, first, last, o = {}) => ({ id: String(id), ...neonPersonDoc(acct(id, first, last)), ...o });

describe('neonPersonDoc', () => {
  it('builds lowercase search fields and collapses spaces', () => {
    expect(neonPersonDoc(acct(7, ' Ada ', 'De  Lovelace', 'a@x.org'))).toEqual({
      neonAccountId: '7', name: 'Ada De Lovelace', nameLower: 'ada de lovelace', lastLower: 'de lovelace', email: 'a@x.org', active: true,
    });
  });
});

describe('planPeopleSync', () => {
  it('adds new accounts and leaves identical ones alone', () => {
    const plan = planPeopleSync([acct(1, 'Ada', 'L'), acct(2, 'Bo', 'K')], [stored(1, 'Ada', 'L')]);
    expect(plan.add.map((a) => a.id)).toEqual(['2']);
    expect(plan.update).toEqual([]);
    expect(plan.unchanged).toBe(1);
  });

  it('updates a renamed account and reactivates one that came back', () => {
    const plan = planPeopleSync([acct(1, 'Ada', 'Byron'), acct(2, 'Bo', 'K')], [stored(1, 'Ada', 'L'), stored(2, 'Bo', 'K', { active: false })]);
    expect(plan.update.map((u) => u.id).sort()).toEqual(['1', '2']);
    expect(plan.update.find((u) => u.id === '2').data.active).toBe(true);
  });

  it('marks accounts missing from Neon inactive, once', () => {
    const plan = planPeopleSync([acct(1, 'Ada', 'L')], [stored(1, 'Ada', 'L'), stored(2, 'Bo', 'K'), stored(3, 'Cy', 'M', { active: false })]);
    expect(plan.deactivate).toEqual(['2']);
  });

  it('skips nameless and repeated accounts', () => {
    const plan = planPeopleSync([acct(1, '', ''), acct(2, 'Bo', 'K'), acct(2, 'Bo', 'K')], []);
    expect(plan.add.map((a) => a.id)).toEqual(['2']);
  });

  it('flags a fetch that would drop most people', () => {
    const many = Array.from({ length: 40 }, (_, i) => stored(i + 1, 'P', String(i)));
    expect(planPeopleSync([acct(1, 'P', '0')], many).suspicious).toBe(true);
    expect(planPeopleSync(many.slice(0, 30).map((p) => acct(p.id, 'P', p.name.slice(2))), many).suspicious).toBe(false);
  });
});

describe('daysSince', () => {
  it('counts whole days, null when never', () => {
    const now = Date.parse('2026-10-20T12:00:00Z');
    expect(daysSince('2026-10-10T12:00:00Z', now)).toBe(10);
    expect(daysSince(undefined, now)).toBeNull();
  });
});
