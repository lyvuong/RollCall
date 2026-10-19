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

/** Last good Neon result per date range, so the list still shows them offline or when Neon is down. */
export function readNeonCache(from, to) {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}')[`${from}|${to}`]?.events || null;
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
export async function fetchNeonRegistrants(neonEventId) {
  const { attendees } = await neonApi(`events/${encodeURIComponent(neonEventId)}/attendees`);
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
