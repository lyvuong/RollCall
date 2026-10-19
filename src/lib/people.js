// Review helpers for Saved Members: spot likely duplicates and people who no longer attend.

/** Lower-case, accent-free, punctuation-free, single-spaced version of a name. */
export function normalizeName(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Edit distance, giving up early once it must exceed `max` (returns max + 1). */
export function editDistance(a, b, max = 2) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

function similar(a, b) {
  if (a.norm === b.norm) return true;
  // Same words in a different order ("Smith John").
  if (a.sorted === b.sorted) return true;
  // Same first and last name, different middle name or initial.
  if (a.tokens.length >= 2 && b.tokens.length >= 2 && a.first === b.first && a.last === b.last) return true;
  // One typo (two for long names): "Jon Smith" / "John Smith".
  const min = Math.min(a.norm.length, b.norm.length);
  if (min < 5) return false;
  return editDistance(a.norm, b.norm, min >= 12 ? 2 : 1) <= (min >= 12 ? 2 : 1);
}

/** True when either person was marked as a different human from the other (`notSame` holds ids). */
export const markedDistinct = (a, b) => !!(a.notSame?.includes(b.id) || b.notSame?.includes(a.id));

/**
 * Groups of people whose names look like the same person. people = [{id, name, notSame?, ...}].
 * Pairs marked distinct (see markedDistinct) are never linked directly.
 * Returns [[person, person, ...], ...], each group sorted by name, groups sorted by first name.
 */
export function findDuplicateGroups(people) {
  const items = people.map((p) => {
    const norm = normalizeName(p.name);
    const tokens = norm.split(' ').filter(Boolean);
    return { p, norm, tokens, sorted: [...tokens].sort().join(' '), first: tokens[0], last: tokens[tokens.length - 1] };
  }).filter((x) => x.norm);

  const parent = items.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let x = 0; x < items.length; x++) {
    for (let y = x + 1; y < items.length; y++) {
      if (!markedDistinct(items[x].p, items[y].p) && similar(items[x], items[y])) parent[find(x)] = find(y);
    }
  }
  const groups = new Map();
  items.forEach((it, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(it.p);
  });
  return [...groups.values()]
    .filter((g) => g.length > 1)
    .map((g) => g.sort((a, b) => a.name.localeCompare(b.name)))
    .sort((a, b) => a[0].name.localeCompare(b[0].name));
}

/**
 * Attendance per person across events. Returns Map(personId -> {past, upcoming, last}),
 * where `past` counts events dated up to and including `today`, `upcoming` later ones,
 * and `last` is the most recent past date ('' if none).
 */
export function attendanceStats(events, today) {
  const stats = new Map();
  for (const e of events) {
    for (const id of Object.keys(e.attendees || {})) {
      const s = stats.get(id) || { past: 0, upcoming: 0, last: '' };
      if (e.date <= today) {
        s.past++;
        if (e.date > s.last) s.last = e.date;
      } else {
        s.upcoming++;
      }
      stats.set(id, s);
    }
  }
  return stats;
}

const NONE = { past: 0, upcoming: 0, last: '' };

/**
 * People with no attendance: never (sinceDate = null), or none on or after `sinceDate` (YYYY-MM-DD).
 * Anyone on an upcoming event is left out, so planned attendance is never flagged.
 */
export function inactivePeople(people, stats, sinceDate = null) {
  return people
    .filter((p) => {
      const s = stats.get(p.id) || NONE;
      if (s.upcoming > 0) return false;
      return sinceDate ? s.past > 0 && s.last < sinceDate : s.past === 0;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
