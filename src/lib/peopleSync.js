// Weekly copy of the Neon One account list into Firestore `neonPeople` (doc id = Neon account id),
// so name search never calls Neon. People who left Neon are marked inactive, never deleted.

const clean = (s) => String(s || '').trim().replace(/\s+/g, ' ');

/** The fields stored for one Neon account. */
export function neonPersonDoc(a) {
  const first = clean(a.firstName);
  const last = clean(a.lastName);
  const name = [first, last].filter(Boolean).join(' ');
  return { neonAccountId: String(a.accountId), name, nameLower: name.toLowerCase(), lastLower: last.toLowerCase(), email: clean(a.email), active: true };
}

const FIELDS = ['name', 'nameLower', 'lastLower', 'email', 'active'];

/** A drop of more than this share of active people in one run is treated as a bad fetch, not as everyone leaving. */
const MAX_DROP = 0.5;

/**
 * Compare a full Neon account list with the stored people (array of docs with `id`).
 * Returns { add, update, deactivate, unchanged, suspicious }; add/update are ready-to-write docs keyed by id.
 */
export function planPeopleSync(accounts, stored) {
  const have = new Map(stored.map((p) => [p.id, p]));
  const seen = new Set();
  const add = [];
  const update = [];
  for (const a of accounts) {
    const doc = neonPersonDoc(a);
    if (!doc.name || seen.has(doc.neonAccountId)) continue;
    seen.add(doc.neonAccountId);
    const cur = have.get(doc.neonAccountId);
    if (!cur) add.push({ id: doc.neonAccountId, data: doc });
    else if (FIELDS.some((f) => cur[f] !== doc[f])) update.push({ id: doc.neonAccountId, data: doc });
  }
  const deactivate = stored.filter((p) => p.active !== false && !seen.has(p.id)).map((p) => p.id);
  const activeBefore = stored.filter((p) => p.active !== false).length;
  const suspicious = activeBefore >= 20 && deactivate.length > activeBefore * MAX_DROP;
  return { add, update, deactivate, unchanged: seen.size - add.length - update.length, suspicious };
}

/** Whole days since an ISO/ms timestamp, or null when never synced. */
export function daysSince(at, now = Date.now()) {
  const t = typeof at === 'number' ? at : Date.parse(at);
  return Number.isFinite(t) ? Math.floor((now - t) / 86_400_000) : null;
}
