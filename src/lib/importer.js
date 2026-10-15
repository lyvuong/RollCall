import { parseCSV, toObjects, toCSV } from './csv.js';
import { toMinutes, personKind } from './time.js';

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
  hours: ['volunteer hours', 'total volunteer hours', 'hours'],
};

export const TEMPLATES = {
  people: [
    ['name', 'type'],
    ['Jane Doe', 'community'],
    ['John Smith', 'osg'],
  ],
  events: [
    ['name', 'date', 'start', 'end', 'format', 'location', 'description', 'attendees'],
    ['Food Drive', '2026-03-14', '09:00', '12:30', 'in-person', 'Main Hall', 'Monthly food drive', 'Jane Doe; John Smith:osg; Sam Lee:community:volunteer'],
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

/** Person type: 'osg' or 'community' (legacy member/volunteer/both are mapped). */
export function parseType(s) {
  const v = String(s || '').toLowerCase();
  if (/community|vol/.test(v)) return 'community';
  if (/osg|member|both/.test(v)) return 'osg';
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
export function planImport(kind, text, existing, newId, { overwrite = false } = {}) {
  const aliases = kind === 'people' ? PEOPLE_ALIASES : EVENT_ALIASES;
  const required = kind === 'people' ? ['name', 'type'] : ['name', 'date', 'start', 'end'];
  const { objects, missing } = toObjects(parseCSV(text), aliases);

  const lacking = required.filter((f) => missing.includes(f));
  if (lacking.length) {
    return { kind, rows: [], ops: [], stats: {}, fatal: `Missing required column(s): ${lacking.join(', ')}` };
  }

  const peopleByName = new Map(existing.people.map((p) => [lower(p.name), p]));
  const locByName = new Map(existing.locations.map((l) => [lower(l.name), l]));
  const eventIds = new Map(existing.events.map((e) => [eventKey(e.name, e.date, e.startTime), e.id]));
  const seen = new Set();
  const ops = [];
  const rows = [];
  const stats = { ready: 0, skipped: 0, errors: 0, newPeople: 0, newLocations: 0, replaced: 0 };

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
      else if (!type) push(o, 'error', 'Type must be "osg" or "community"', name);
      else if (peopleByName.has(lower(name))) {
        const cur = peopleByName.get(lower(name));
        if (overwrite && personKind(cur.type) !== type && !seen.has(`p:${lower(name)}`)) {
          seen.add(`p:${lower(name)}`);
          ops.push({ col: 'people', id: cur.id, data: { name: cur.name, nameLower: lower(name), type } });
          stats.replaced++;
          push(o, 'ok', `updated to ${type}`, name);
        } else push(o, 'skip', 'Already saved', name);
      }
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
    const key = eventKey(name, date, start);
    const existingId = eventIds.get(key);
    const known = eventIds.has(key);
    if (seen.has(key) || (known && !overwrite)) {
      push(o, 'skip', 'Event already exists', label);
      continue;
    }
    seen.add(key);

    let locationId = null;
    if (format !== 'virtual' && o.location) {
      const locName = o.location.replace(/\s+/g, ' ');
      locationId = (locByName.get(lower(locName)) || addLocation(locName)).id;
    }

    const attendees = {};
    const names = (o.attendees || '').split(/[;\n|]/).map((s) => s.trim()).filter(Boolean);
    for (const raw of names) {
      const m = raw.match(/^(.*?)\s*:\s*(osg|community|member|volunteer|both)(?:\s*:\s*(participant|volunteer))?$/i);
      const pname = (m ? m[1] : raw).replace(/\s+/g, ' ');
      if (!pname) continue;
      const person = peopleByName.get(lower(pname)) || addPerson(pname, m ? parseType(m[2]) : 'community');
      const role = m?.[3]?.toLowerCase() === 'volunteer' ? 'volunteer' : 'participant';
      attendees[person.id] = { name: person.name, type: personKind(person.type), role };
    }

    const data = { name, description: o.description || '', date, startTime: start, endTime: end, format, locationId, attendees };
    const hrs = parseFloat(o.hours);
    if (hrs > 0) data.volunteerHours = hrs;
    ops.push({ col: 'events', id: existingId || newId('events'), data });
    if (known) stats.replaced++;
    push(o, 'ok', `${known ? 'replaces existing · ' : ''}${Object.keys(attendees).length} attendee(s)`, label);
  }

  return { kind, rows, ops, stats };
}

/* ---------- AMS export (one row per attendee) ---------- */

const AMS_COLS = ['date', 'event name', 'total volunteer hours', 'firstname', 'lastname', 'member'];

export function isAmsExport(text) {
  const head = (parseCSV(text)[0] || []).map((h) => h.trim().toLowerCase());
  return AMS_COLS.every((c) => head.includes(c));
}

const amsKind = (s) => (/community/i.test(s || '') ? 'community' : 'osg');
const amsName = (r, f, l) => `${r[f] || ''} ${r[l] || ''}`.replace(/[;|\n]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Roll AMS attendee rows up into the standard events CSV.
 * "Community Member" => community, "OSG Member"/"Unspecified" => osg.
 * The export has no per-person role, so everyone is a participant; the recorded
 * total is kept as volunteer hours until volunteers are marked. No end time is
 * exported, so events default to one hour.
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
    const person = amsName(r, ix.firstname, ix.lastname);
    if (person) events.get(key).people.set(person.toLowerCase(), { person, type: amsKind(get('member')) });
  }

  const unset = (s) => (/^unspecified$/i.test(s) ? '' : s);
  const out = [['name', 'date', 'start', 'end', 'format', 'location', 'description', 'volunteer hours', 'attendees']];
  for (const e of events.values()) {
    const [d, t] = e.date.split(' ');
    const start = Math.min(toMinutes((t || '00:00').slice(0, 5)), 23 * 60 + 58);
    const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    out.push([
      e.name, d, hhmm(start), hhmm(Math.min(start + 60, 23 * 60 + 59)), unset(e.format) || 'in-person',
      unset(e.location), e.description, e.hours || '',
      [...e.people.values()].map((p) => `${p.person}:${p.type}`).join('; '),
    ]);
  }
  return toCSV(out);
}

/** People list (name,type) from an AMS export. */
export function amsToPeopleCsv(text) {
  const [head, ...rows] = parseCSV(text);
  const col = (n) => head.findIndex((h) => h.trim().toLowerCase() === n);
  const [f, l, m] = ['firstname', 'lastname', 'member'].map(col);
  const people = new Map();
  for (const r of rows) {
    const name = amsName(r, f, l);
    if (name) people.set(name.toLowerCase(), { name, type: amsKind(r[m]) });
  }
  return toCSV([['name', 'type'], ...[...people.values()].map((p) => [p.name, p.type])]);
}
