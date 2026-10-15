import { parseCSV, toObjects, toCSV } from './csv.js';
import { toMinutes } from './time.js';

export const PEOPLE_ALIASES = {
  name: ['name', 'full name', 'participant', 'person'],
  type: ['type', 'role', 'category', 'status'],
};

export const EVENT_ALIASES = {
  name: ['name', 'event', 'event name', 'title'],
  date: ['date', 'event date', 'day'],
  start: ['start', 'start time', 'time start', 'from'],
  end: ['end', 'end time', 'time end', 'to'],
  format: ['format', 'mode'],
  location: ['location', 'venue', 'place'],
  description: ['description', 'notes', 'details'],
  attendees: ['attendees', 'participants', 'people', 'names'],
};

export const TEMPLATES = {
  people: [
    ['name', 'type'],
    ['Jane Doe', 'volunteer'],
    ['John Smith', 'member'],
  ],
  events: [
    ['name', 'date', 'start', 'end', 'format', 'location', 'description', 'attendees'],
    ['Food Drive', '2026-03-14', '09:00', '12:30', 'in-person', 'Main Hall', 'Monthly food drive', 'Jane Doe; John Smith:member'],
    ['Board Meeting', '3/20/2026', '6:00 PM', '7:30 PM', 'virtual', '', '', ''],
  ],
};

/* ---------- field parsers (return null when invalid) ---------- */

export function parseDate(s) {
  s = String(s || '').trim();
  let y, m, d, match;
  if ((match = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))) [, y, m, d] = match;
  else if ((match = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/))) {
    [, m, d, y] = match;
    if (y.length === 2) y = `20${y}`;
  } else {
    const t = Date.parse(s);
    if (Number.isNaN(t)) return null;
    const dt = new Date(t);
    [y, m, d] = [dt.getFullYear(), dt.getMonth() + 1, dt.getDate()];
  }
  y = +y; m = +m; d = +d;
  const check = new Date(y, m - 1, d);
  if (check.getFullYear() !== y || check.getMonth() !== m - 1 || check.getDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function parseTime(s) {
  const match = String(s || '').trim().match(/^(\d{1,2})(?::?(\d{2}))?\s*([ap])?\.?m?\.?$/i);
  if (!match) return null;
  let h = +match[1];
  const min = match[2] ? +match[2] : 0;
  const ap = match[3]?.toLowerCase();
  if (min > 59) return null;
  if (ap) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (ap === 'p' ? 12 : 0);
  } else if (h > 23) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

export function parseFormat(s) {
  const v = String(s || '').toLowerCase().trim();
  if (!v) return 'in-person';
  if (/hybrid|both/.test(v)) return 'both';
  if (/virtual|online|zoom|remote/.test(v)) return /person|site/.test(v) ? 'both' : 'virtual';
  if (/person|site|onsite|physical/.test(v)) return 'in-person';
  return null;
}

export function parseType(s) {
  const v = String(s || '').toLowerCase();
  if (/both|vol.*(member|osg)|(member|osg).*vol/.test(v)) return 'both';
  if (/vol/.test(v)) return 'volunteer';
  if (/member|osg/.test(v)) return 'member';
  return null;
}

/* ---------- planning ---------- */

const lower = (s) => s.trim().toLowerCase();
const eventKey = (name, date, start) => `${lower(name)}|${date}|${start}`;

/**
 * Build a write plan from CSV text.
 * existing = { people:[{id,name,type}], locations:[{id,name}], events:[{name,date,startTime}] }
 * newId(collection) -> string (so the plan is pure and testable).
 * Returns { kind, rows:[{line,status,message,label}], ops:[{col,id,data}], stats, fatal? }.
 */
export function planImport(kind, text, existing, newId) {
  const aliases = kind === 'people' ? PEOPLE_ALIASES : EVENT_ALIASES;
  const required = kind === 'people' ? ['name', 'type'] : ['name', 'date', 'start', 'end'];
  const { objects, missing } = toObjects(parseCSV(text), aliases);

  const lacking = required.filter((f) => missing.includes(f));
  if (lacking.length) {
    return { kind, rows: [], ops: [], stats: {}, fatal: `Missing required column(s): ${lacking.join(', ')}` };
  }

  const peopleByName = new Map(existing.people.map((p) => [lower(p.name), p]));
  const locByName = new Map(existing.locations.map((l) => [lower(l.name), l]));
  const eventKeys = new Set(existing.events.map((e) => eventKey(e.name, e.date, e.startTime)));
  const ops = [];
  const rows = [];
  const stats = { ready: 0, skipped: 0, errors: 0, newPeople: 0, newLocations: 0 };

  const addPerson = (name, type) => {
    const person = { id: newId('people'), name, type };
    peopleByName.set(lower(name), person);
    ops.push({ col: 'people', id: person.id, data: { name, nameLower: lower(name), type } });
    stats.newPeople++;
    return person;
  };
  const addLocation = (name) => {
    const loc = { id: newId('locations'), name };
    locByName.set(lower(name), loc);
    ops.push({ col: 'locations', id: loc.id, data: { name } });
    stats.newLocations++;
    return loc;
  };
  const push = (o, status, message, label) => {
    rows.push({ line: o._line, status, message, label });
    stats[status === 'ok' ? 'ready' : status === 'skip' ? 'skipped' : 'errors']++;
  };

  for (const o of objects) {
    if (kind === 'people') {
      const name = o.name.replace(/\s+/g, ' ');
      const type = parseType(o.type);
      if (!name) push(o, 'error', 'Name is empty', '');
      else if (!type) push(o, 'error', 'Type must be "member", "volunteer" or "both"', name);
      else if (peopleByName.has(lower(name))) push(o, 'skip', 'Already saved', name);
      else (addPerson(name, type), push(o, 'ok', type, name));
      continue;
    }

    // events
    const name = o.name.replace(/\s+/g, ' ');
    const date = parseDate(o.date);
    const start = parseTime(o.start);
    const end = parseTime(o.end);
    const format = parseFormat(o.format);
    const label = `${name} · ${o.date}`;
    const problem = !name
      ? 'Name is empty'
      : !date
        ? `Invalid date "${o.date}"`
        : !start
          ? `Invalid start time "${o.start}"`
          : !end
            ? `Invalid end time "${o.end}"`
            : toMinutes(end) <= toMinutes(start)
              ? 'End time must be after start time'
              : !format
                ? `Unknown format "${o.format}" (use in-person, virtual or both)`
                : '';
    if (problem) {
      push(o, 'error', problem, label);
      continue;
    }
    if (eventKeys.has(eventKey(name, date, start))) {
      push(o, 'skip', 'Event already exists', label);
      continue;
    }
    eventKeys.add(eventKey(name, date, start));

    let locationId = null;
    if (format !== 'virtual' && o.location) {
      const locName = o.location.replace(/\s+/g, ' ');
      locationId = (locByName.get(lower(locName)) || addLocation(locName)).id;
    }

    const attendees = {};
    const names = (o.attendees || '').split(/[;\n|]/).map((s) => s.trim()).filter(Boolean);
    for (const raw of names) {
      const m = raw.match(/^(.*?)\s*:\s*(member|volunteer|both)$/i);
      const pname = (m ? m[1] : raw).replace(/\s+/g, ' ');
      if (!pname) continue;
      const person = peopleByName.get(lower(pname)) || addPerson(pname, m ? parseType(m[2]) : 'volunteer');
      attendees[person.id] = { name: person.name, type: person.type };
    }

    ops.push({
      col: 'events',
      id: newId('events'),
      data: { name, description: o.description || '', date, startTime: start, endTime: end, format, locationId, attendees },
    });
    push(o, 'ok', `${Object.keys(attendees).length} attendee(s)`, label);
  }

  return { kind, rows, ops, stats };
}

/* ---------- AMS export (one row per attendee) ---------- */

const AMS_COLS = ['date', 'event name', 'total volunteer hours', 'firstname', 'lastname', 'member'];

export function isAmsExport(text) {
  const head = (parseCSV(text)[0] || []).map((h) => h.trim().toLowerCase());
  return AMS_COLS.every((c) => head.includes(c));
}

/**
 * Roll AMS attendee rows up into the standard events CSV.
 * - "Community Member" => volunteer, "OSG Member"/"Unspecified" => member.
 * - The export has no end time: end = start + totalHours / volunteers, so
 *   RollCall's hours x volunteers reproduces the recorded total.
 *   Events with 0 recorded hours get a 1 minute placeholder (RollCall needs end > start).
 */
export function amsToEventsCsv(text) {
  const [head, ...rows] = parseCSV(text);
  const col = (n) => head.findIndex((h) => h.trim().toLowerCase() === n);
  const ix = Object.fromEntries(
    ['date', 'event name', 'description', 'total volunteer hours', 'location', 'format', 'firstname', 'lastname', 'member']
      .map((n) => [n, col(n)]),
  );
  const events = new Map();
  for (const r of rows) {
    const get = (n) => (ix[n] < 0 ? '' : (r[ix[n]] || '').trim());
    const date = get('date').slice(0, 16);
    const name = get('event name').replace(/\s+/g, ' ');
    if (!date || !name) continue;
    const key = `${date}|${name.toLowerCase()}`;
    if (!events.has(key)) {
      events.set(key, {
        name, date, description: get('description'), hours: parseFloat(get('total volunteer hours')) || 0,
        location: get('location'), format: get('format'), people: new Map(),
      });
    }
    const person = `${get('firstname')} ${get('lastname')}`.replace(/[;|\n]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!person) continue;
    const type = /community/i.test(get('member')) ? 'volunteer' : 'member';
    events.get(key).people.set(person.toLowerCase(), { person, type });
  }

  const out = [['name', 'date', 'start', 'end', 'format', 'location', 'description', 'attendees']];
  for (const e of events.values()) {
    const [d, t] = e.date.split(' ');
    const start = toMinutes((t || '00:00').slice(0, 5));
    const people = [...e.people.values()];
    const vols = people.filter((p) => p.type === 'volunteer').length;
    const minutes = e.hours > 0 && vols > 0 ? Math.max(1, Math.round((e.hours / vols) * 60)) : 1;
    const end = Math.min(start + minutes, 23 * 60 + 59);
    const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    const unset = (s) => (/^(unspecified|other)?$/i.test(s) && !/^other$/i.test(s) ? '' : s);
    out.push([
      e.name, d, hhmm(Math.min(start, end - 1)), hhmm(end), unset(e.format) || 'in-person', unset(e.location),
      e.description, people.map((p) => `${p.person}:${p.type}`).join('; '),
    ]);
  }
  return toCSV(out);
}
