import { describe, it, expect } from 'vitest';
import {
  addDays,
  eventHours,
  countByType,
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

  it('total hours = event hours x volunteers, members excluded', () => {
    const event = {
      startTime: '09:00',
      endTime: '11:30',
      attendees: {
        a: { type: 'volunteer' },
        b: { type: 'volunteer' },
        c: { type: 'volunteer' },
        d: { type: 'volunteer' },
        e: { type: 'member' },
      },
    };
    expect(countByType(event.attendees)).toEqual({ volunteers: 4, members: 1 });
    expect(totalVolunteerHours(event)).toBe(10);
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
