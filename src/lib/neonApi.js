import { auth } from '../firebase.js';

export async function neonApi(path, init = {}) {
  const user = auth.currentUser;
  if (!user) throw new Error('Not signed in');
  const token = await user.getIdToken();
  const res = await fetch(`/api/neon/${path}`, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${token}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { status: res.status });
  return body;
}

const CACHE_KEY = 'rollcall.neonEvents.v1';
const CACHE_MAX = 12; // ranges kept
const FRESH_MS = 5 * 60_000; // a cached range this young is used without asking Neon again

/** Last good Neon result per date range, so the list still shows them offline or when Neon is down. */
export function readNeonCache(from, to, maxAgeMs = Infinity) {
  try {
    const hit = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}')[`${from}|${to}`];
    return hit && Date.now() - hit.at <= maxAgeMs ? hit.events : null;
  } catch {
    return null;
  }
}

export function writeNeonCache(from, to, events) {
  try {
    const all = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
    all[`${from}|${to}`] = { events, at: Date.now() };
    const keep = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, CACHE_MAX);
    localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(keep)));
  } catch {
    /* storage unavailable or full: the cache is optional */
  }
}

/** Neon events for a range; resolves null (never throws) when Neon is unreachable or not configured. */
export async function fetchNeonEvents(from, to) {
  const fresh = readNeonCache(from, to, FRESH_MS);
  if (fresh) return fresh;
  try {
    const { events } = await neonApi(`events?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    writeNeonCache(from, to, events);
    return events;
  } catch {
    return null;
  }
}

const CANCELLED = /cancel|fail|refund|declin/i;

/**
 * Registered names for one Neon event: [{attendeeId, accountId, name}]. Cancelled or failed registrations are
 * left out. Throws when Neon is unreachable.
 */
export async function fetchNeonRegistrants(neonEventId, { force = false } = {}) {
  const memo = REG_MEMO.get(String(neonEventId));
  if (!force && memo && Date.now() - memo.at < FRESH_MS) return memo.list;
  const list = await loadRegistrants(neonEventId, force);
  REG_MEMO.set(String(neonEventId), { list, at: Date.now() });
  return list;
}

const REG_MEMO = new Map(); // neonEventId -> {list, at}, for this page session

async function loadRegistrants(neonEventId, force = false) {
  // A throwaway query string makes the worker skip its shared 5-minute cache for this one call.
  const { attendees } = await neonApi(`events/${encodeURIComponent(neonEventId)}/attendees${force ? `?fresh=${Date.now()}` : ''}`);
  const seen = new Set();
  return (attendees || []).filter((a) => {
    if (!a.name || !a.attendeeId || seen.has(a.attendeeId) || CANCELLED.test(a.status || '')) return false;
    seen.add(a.attendeeId);
    return true;
  });
}

/**
 * Registrants for several events, a few requests at a time (Neon rate-limits).
 * Resolves { byEvent: {neonEventId: [...]}, failed: n }; a failed event is simply left out.
 */
export async function fetchRegistrantsFor(neonEventIds, onProgress = () => {}, concurrency = 4) {
  const byEvent = {};
  let failed = 0;
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < neonEventIds.length) {
      const id = neonEventIds[next++];
      try {
        byEvent[id] = await fetchNeonRegistrants(id);
      } catch {
        failed++;
      }
      onProgress(++done, neonEventIds.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, neonEventIds.length) }, worker));
  return { byEvent, failed };
}

/** Every named Neon account, one worker call per 200. onPage(done, total) reports progress. */
export async function fetchAllNeonAccounts(onPage) {
  const out = [];
  let total = 1;
  for (let page = 0; page < total; page++) {
    const r = await neonApi('accounts/page', { method: 'POST', body: JSON.stringify({ page }) });
    out.push(...r.accounts);
    total = r.totalPages;
    onPage?.(page + 1, total);
  }
  return out;
}
