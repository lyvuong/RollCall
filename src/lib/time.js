const pad = (n) => String(n).padStart(2, '0');

/** Local-date 'YYYY-MM-DD'. */
export function ymd(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Add `n` days to a 'YYYY-MM-DD' string (calendar math, DST-safe). */
export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return ymd(new Date(y, m - 1, d + n));
}

export function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** Event length in hours (0 if end is not after start). */
export function eventHours(start, end) {
  if (!start || !end) return 0;
  return Math.max(0, toMinutes(end) - toMinutes(start)) / 60;
}

/** Person type: 'osg' (OSG member) or 'community'. Older records used member/volunteer/both. */
export function personKind(type) {
  return type === 'community' || type === 'volunteer' ? 'community' : 'osg';
}

/** Role at an event: 'participant' or 'volunteer'. Older attendees stored type 'volunteer'. */
export function roleOf(a) {
  if (a?.role === 'volunteer' || a?.role === 'participant') return a.role;
  return a?.type === 'volunteer' ? 'volunteer' : 'participant';
}

export function countRoles(attendees = {}) {
  let volunteers = 0;
  let participants = 0;
  for (const a of Object.values(attendees)) {
    if (roleOf(a) === 'volunteer') volunteers++;
    else participants++;
  }
  return { volunteers, participants };
}

/**
 * Total volunteer hours = event hours x volunteers. Imported events that have no
 * volunteers marked yet fall back to the recorded `volunteerHours`.
 */
export function totalVolunteerHours(event) {
  const { volunteers } = countRoles(event.attendees);
  if (volunteers > 0) return eventHours(event.startTime, event.endTime) * volunteers;
  return Number(event.volunteerHours) || 0;
}

/** Has recorded volunteer hours but nobody is marked as a volunteer yet. */
export function needsVolunteers(event) {
  return (Number(event.volunteerHours) || 0) > 0 && countRoles(event.attendees).volunteers === 0;
}

export function formatHours(h) {
  return `${Math.round(h * 100) / 100}`;
}

export function formatTime(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM';
  return `${((h + 11) % 12) + 1}:${pad(m)} ${ap}`;
}

/** Compact time for small screens: 9a, 12:30p. */
export function formatTimeShort(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return `${((h + 11) % 12) + 1}${m ? ':' + pad(m) : ''}${h >= 12 ? 'p' : 'a'}`;
}

export function formatTime12(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${pad(m)} ${h >= 12 ? 'PM' : 'AM'}`;
}

export function formatDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const label = new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });
  const today = ymd();
  if (dateStr === today) return `Today · ${label}`;
  if (dateStr === addDays(today, -1)) return `Yesterday · ${label}`;
  if (dateStr === addDays(today, 1)) return `Tomorrow · ${label}`;
  return label;
}
