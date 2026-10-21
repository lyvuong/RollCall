/** Name as compared for duplicates: case, punctuation, spacing and a leading "the" ignored. */
export const locationKey = (name) =>
  String(name || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^the /, '');

/** The saved location a typed name already stands for, if any. */
export const matchLocation = (locations, name) => {
  const key = locationKey(name);
  return key ? locations.find((l) => locationKey(l.name) === key) : undefined;
};

/**
 * Groups of locations that look like the same place: identical once normalized ("Ovation at Arrowbrook" and
 * "The Ovation at Arrowbrook"), or one name contained in the other as whole words ("Ovation" is not matched with
 * "Ovation at Arrowbrook" unless it is at least two words long). Each group has 2+ locations; none overlap.
 */
export function findDuplicateLocations(locations) {
  const keyed = locations.map((l) => ({ l, key: locationKey(l.name) })).filter((x) => x.key);
  const same = (a, b) => {
    if (a.key === b.key) return true;
    const [s, t] = a.key.length <= b.key.length ? [a.key, b.key] : [b.key, a.key];
    return s.includes(' ') && ` ${t} `.includes(` ${s} `);
  };
  const parent = keyed.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < keyed.length; i++) for (let j = i + 1; j < keyed.length; j++) if (same(keyed[i], keyed[j])) parent[find(i)] = find(j);
  const groups = new Map();
  keyed.forEach((x, i) => groups.set(find(i), [...(groups.get(find(i)) || []), x.l]));
  return [...groups.values()].filter((g) => g.length > 1);
}
