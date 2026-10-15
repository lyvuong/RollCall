import { describe, it, expect } from 'vitest';
import { parseCSV, toCSV } from './csv.js';
import { parseDate, parseTime, parseFormat, parseType, planImport } from './importer.js';

let n = 0;
const newId = (col) => `${col}-${++n}`;
const empty = () => ({ people: [], locations: [], events: [] });

describe('csv', () => {
  it('handles quotes, commas, newlines and BOM', () => {
    const rows = parseCSV('﻿name,notes\r\n"Doe, Jane","said ""hi""\nthere"\r\nBob,\r\n');
    expect(rows).toEqual([
      ['name', 'notes'],
      ['Doe, Jane', 'said "hi"\nthere'],
      ['Bob', ''],
    ]);
  });
  it('detects tab and semicolon delimiters', () => {
    expect(parseCSV('a\tb\n1\t2')).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseCSV('a;b\n1;2')).toEqual([['a', 'b'], ['1', '2']]);
  });
  it('round-trips', () => {
    const rows = [['a', 'b,c'], ['"q"', 'x']];
    expect(parseCSV(toCSV(rows))).toEqual(rows);
  });
});

describe('field parsers', () => {
  it('dates', () => {
    expect(parseDate('2026-03-14')).toBe('2026-03-14');
    expect(parseDate('3/4/2026')).toBe('2026-03-04');
    expect(parseDate('3/4/26')).toBe('2026-03-04');
    expect(parseDate('2026-02-30')).toBeNull();
    expect(parseDate('nope')).toBeNull();
  });
  it('times', () => {
    expect(parseTime('9:00')).toBe('09:00');
    expect(parseTime('6:30 PM')).toBe('18:30');
    expect(parseTime('12 AM')).toBe('00:00');
    expect(parseTime('9am')).toBe('09:00');
    expect(parseTime('25:00')).toBeNull();
  });
  it('format and type', () => {
    expect(parseFormat('')).toBe('in-person');
    expect(parseFormat('In Person')).toBe('in-person');
    expect(parseFormat('Online')).toBe('virtual');
    expect(parseFormat('Hybrid')).toBe('both');
    expect(parseFormat('???')).toBeNull();
    expect(parseType('OSG Member')).toBe('osg');
    expect(parseType('Community Member')).toBe('community');
    expect(parseType('Volunteer')).toBe('community');
    expect(parseType('x')).toBeNull();
  });
});

describe('planImport', () => {
  it('people: creates, skips duplicates, flags errors', () => {
    const ex = { ...empty(), people: [{ id: 'p0', name: 'Jane Doe', type: 'osg' }] };
    const plan = planImport('people', 'name,type\nJane Doe,community\nBob Roe,community\nbob roe,osg\nNo Type,\n', ex, newId);
    expect(plan.stats).toMatchObject({ ready: 1, skipped: 2, errors: 1 });
    expect(plan.ops).toHaveLength(1);
    expect(plan.ops[0].data).toMatchObject({ name: 'Bob Roe', nameLower: 'bob roe', type: 'community' });
  });

  it('events: parses, creates locations/people, builds attendees', () => {
    const csv = [
      'name,date,start,end,format,location,description,attendees',
      'Food Drive,3/14/2026,9:00 AM,12:30 PM,in-person,Main Hall,Monthly,"Jane Doe:community:volunteer; New Person:osg"',
      'Webinar,2026-03-20,18:00,19:00,virtual,Ignored,,',
      'Bad,2026-03-20,10:00,09:00,virtual,,,',
    ].join('\n');
    const ex = { ...empty(), people: [{ id: 'p1', name: 'Jane Doe', type: 'community' }] };
    const plan = planImport('events', csv, ex, newId);
    expect(plan.stats).toMatchObject({ ready: 2, errors: 1, newLocations: 1, newPeople: 1 });
    const food = plan.ops.find((o) => o.col === 'events' && o.data.name === 'Food Drive');
    expect(food.data).toMatchObject({ date: '2026-03-14', startTime: '09:00', endTime: '12:30', format: 'in-person' });
    expect(Object.values(food.data.attendees).map((a) => `${a.type}:${a.role}`).sort()).toEqual([
      'community:volunteer',
      'osg:participant',
    ]);
    const web = plan.ops.find((o) => o.data.name === 'Webinar');
    expect(web.data.locationId).toBeNull();
  });

  it('events: skips ones that already exist and reports missing columns', () => {
    const csv = 'name,date,start,end\nFood Drive,2026-03-14,09:00,10:00\n';
    const ex = { ...empty(), events: [{ name: 'food drive', date: '2026-03-14', startTime: '09:00' }] };
    expect(planImport('events', csv, ex, newId).stats.skipped).toBe(1);
    expect(planImport('events', 'name,date\nx,y', empty(), newId).fatal).toMatch(/start, end/);
  });
});

describe('AMS export', () => {
  const csv = [
    'Date,Event Name,Description,Total Volunteer Hours,Location,Format,FirstName,LastName,Member',
    '2026-01-12 10:00:00,Walk,desc,3.0,Gilliam Place,In-Person,Ann,Lee,Community Member',
    '2026-01-12 10:00:00,Walk,desc,3.0,Gilliam Place,In-Person,Bo,,Community Member',
    '2026-01-12 10:00:00,Walk,desc,3.0,Gilliam Place,In-Person,Cy,Day,OSG Member',
    '2026-01-13 09:00:00.5,Yoga,,0.0,Unspecified,Virtual or In-Person,Ann,Lee,Community Member',
  ].join('\n');

  it('rolls attendee rows into events: all participants, recorded hours kept', async () => {
    const { isAmsExport, amsToEventsCsv } = await import('./importer.js');
    expect(isAmsExport(csv)).toBe(true);
    const plan = planImport('events', amsToEventsCsv(csv), empty(), (c) => `${c}-x${++n}`);
    expect(plan.stats.errors).toBe(0);
    const [walk, yoga] = plan.ops.filter((o) => o.col === 'events').map((o) => o.data);
    expect(walk).toMatchObject({ startTime: '10:00', endTime: '11:00', volunteerHours: 3 });
    expect(Object.values(walk.attendees).every((a) => a.role === 'participant')).toBe(true);
    expect(Object.values(walk.attendees).map((a) => a.type).sort()).toEqual(['community', 'community', 'osg']);
    expect(yoga.volunteerHours).toBeUndefined();
    expect(yoga.format).toBe('both');
    expect(yoga.locationId).toBeNull();
  });

  it('overwrite replaces matching events in place instead of skipping', () => {
    const csv = ['name,date,start,end,format,attendees', 'Food Drive,3/14/2026,9:00 AM,10:00 AM,in-person,Jane Doe:community:volunteer'].join(String.fromCharCode(10));
    const ex = { people: [], locations: [], events: [{ id: 'evt1', name: 'Food Drive', date: '2026-03-14', startTime: '09:00' }] };
    expect(planImport('events', csv, ex, newId).stats.skipped).toBe(1);
    const plan = planImport('events', csv, ex, newId, { overwrite: true });
    expect(plan.stats.replaced).toBe(1);
    const op = plan.ops.find((o) => o.col === 'events');
    expect(op.id).toBe('evt1');
    expect(Object.values(op.data.attendees)[0].role).toBe('volunteer');
  });
});
