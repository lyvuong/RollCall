import { toCSV } from './csv.js';
import { personKind, roleOf, totalVolunteerHours } from './time.js';

export const EXPORT_HEADER = ['name', 'date', 'start', 'end', 'format', 'location', 'description', 'volunteer hours', 'attendees'];

/** "Name:osg|community:participant|volunteer", always explicit so re-import is lossless. */
export function attendeeToken(a) {
  const name = String(a.name || '').replace(/[;|\n:]/g, ' ').replace(/\s+/g, ' ').trim();
  return `${name}:${personKind(a.type)}:${roleOf(a)}`;
}

/**
 * Events -> CSV text in the same layout the importer reads.
 * locations = { [id]: name }. Rows are sorted by date, then start time.
 */
export function eventsToCsv(events, locations = {}) {
  const sorted = [...events].sort(
    (a, b) => a.date.localeCompare(b.date) || (a.startTime || '').localeCompare(b.startTime || ''),
  );
  const rows = sorted.map((e) => {
    const hours = totalVolunteerHours(e);
    const people = Object.values(e.attendees || {})
      .sort((a, b) => String(a.name).localeCompare(String(b.name)))
      .map(attendeeToken);
    return [
      e.name,
      e.date,
      e.startTime,
      e.endTime,
      e.format || 'in-person',
      e.locationId ? locations[e.locationId] || '' : '',
      e.description || '',
      hours > 0 ? Math.round(hours * 100) / 100 : '',
      people.join('; '),
    ];
  });
  return toCSV([EXPORT_HEADER, ...rows]);
}
