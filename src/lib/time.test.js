import { describe, it, expect } from 'vitest';
import {
  addDays,
  eventHours,
  countRoles,
  roleOf,
  personKind,
  totalVolunteerHours,
  formatTime,
  formatHours,
} from './time.js';

describe('time helpers', () => {
  it('computes event hours', () => {
    expect(eventHours('09:00', '11:30')).toBe(2.5);
    expect(eventHours('10:00', '10:00')).toBe(0);
    expect(eventHours('11:00', '10:00')).toBe(0);
  });

  it('total hours = event hours x volunteers; participants excluded', () => {
    const event = {
      startTime: '09:00',
      endTime: '11:30',
      attendees: {
        a: { type: 'community', role: 'volunteer' },
        b: { type: 'osg', role: 'volunteer' },
        c: { type: 'community', role: 'volunteer' },
        d: { type: 'community', role: 'volunteer' },
        e: { type: 'osg', role: 'participant' },
      },
    };
    expect(countRoles(event.attendees)).toEqual({ volunteers: 4, participants: 1 });
    expect(totalVolunteerHours(event)).toBe(10);
  });

  it('role is per event; legacy attendees and recorded hours still work', () => {
    expect(roleOf({ type: 'community', role: 'participant' })).toBe('participant');
    expect(roleOf({ type: 'volunteer' })).toBe('volunteer');
    expect(roleOf({ type: 'member' })).toBe('participant');
    expect(personKind('both')).toBe('osg');
    expect(personKind('volunteer')).toBe('community');
    const noVols = { startTime: '09:00', endTime: '10:00', volunteerHours: 7.5, attendees: { a: { role: 'participant' } } };
    expect(totalVolunteerHours(noVols)).toBe(7.5);
  });

  it('adds days across month and year boundaries', () => {
    expect(addDays('2026-10-15', -1)).toBe('2026-10-14');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('formats', () => {
    expect(formatTime('00:05')).toBe('12:05 AM');
    expect(formatTime('13:30')).toBe('1:30 PM');
    expect(formatHours(2.3333)).toBe('2.33');
  });
});
