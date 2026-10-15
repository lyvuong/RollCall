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

export function countByType(attendees = {}) {
  let volunteers = 0;
  let members = 0;
  for (const a of Object.values(attendees)) {
    // Someone who is both a member and a volunteer counts as a volunteer once they attend.
    if (a.type === 'member') members++;
    else volunteers++;
  }
  return { volunteers, members };
}

/** Total hours for an event = event hours x number of volunteers. */
export function totalVolunteerHours(event) {
  const { volunteers } = countByType(event.attendees);
  return eventHours(event.startTime, event.endTime) * volunteers;
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
