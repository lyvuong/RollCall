// Neon One CRM proxy (mounted by worker/index.js under /api/neon/*).
//   GET  /api/neon/status                       connection check
//   GET  /api/neon/events?from=YYYY-MM-DD&to=   events in a date range (normalized)
//   GET  /api/neon/events/:id/registrations     registrations for one event
//   GET  /api/neon/events/:id/attendees         attendees with markedAttended (check-in) state
//   POST /api/neon/accounts/search              {name?, email?} -> candidate accounts
//   GET  /api/neon/events/:id/sync              fresh event details + attendees (never cached), for sync checks
//   PATCH /api/neon/events/:id                  {name?, date?, endDate?, startTime?, endTime?, location?} -> event
//   PATCH /api/neon/registrations/:id/attendance {attendeeId, attended} -> sets markedAttended
// Writes only run against a sandbox org, or when NEON_ALLOW_WRITES=1 (so production stays read-only until enabled).
// The API key lives in env.NEON_API_KEY and never reaches the browser.
// Event field names and pagination (currentPage) were verified against a live org; account search
// field names ("First Name", "Last Name", "Email", "Account ID", "Email 1") still need checking.

const DEFAULT_BASE = 'https://api.neoncrm.com/v2';
const DEFAULT_VERSION = '2.11';
const PAGE_SIZE = 200;
const MAX_PAGES = 10;

export const EVENT_FIELDS = {
  id: 'Event ID',
  name: 'Event Name',
  start: 'Event Start Date',
  end: 'Event End Date',
  startTime: 'Event Start Time',
  endTime: 'Event End Time',
  location: 'Event Location Name',
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class NeonError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/** Authenticated Neon request; retries 429 with backoff. Returns parsed JSON. */
export async function neonFetch(env, path, init = {}, { retries = 3, wait = sleep } = {}) {
  if (!env.NEON_ORG_ID || !env.NEON_API_KEY) throw new NeonError('Neon One is not configured', 503);
  const base = env.NEON_BASE_URL || DEFAULT_BASE;
  const headers = {
    Authorization: `Basic ${btoa(`${env.NEON_ORG_ID}:${env.NEON_API_KEY}`)}`,
    'NEON-API-VERSION': env.NEON_API_VERSION || DEFAULT_VERSION,
    Accept: 'application/json',
    ...(init.body ? { 'Content-Type': 'application/json' } : {}),
  };
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${base}${path}`, { ...init, headers });
    if (res.status === 429 && attempt < retries) {
      await wait(500 * 2 ** attempt);
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new NeonError(`Neon One ${res.status}: ${text.slice(0, 200)}`, res.status === 429 ? 429 : 502);
    }
    return res.status === 204 ? null : res.json();
  }
}

/** Run a paginated search; yields normalized rows via map(). */
async function searchAll(env, path, body, map) {
  const out = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await neonFetch(env, path, {
      method: 'POST',
      body: JSON.stringify({ ...body, pagination: { currentPage: page, pageSize: PAGE_SIZE } }),
    });
    out.push(...(data?.searchResults || []).map(map));
    const total = data?.pagination?.totalPages ?? 1;
    if (page + 1 >= total) break;
  }
  return out;
}

/** GET list endpoint that pages with currentPage (Neon fixes the page size at 20 here). */
async function listAll(env, path, key) {
  const out = [];
  for (let page = 0; page < MAX_PAGES * 5; page++) {
    const data = await neonFetch(env, `${path}?currentPage=${page}`);
    out.push(...(data?.[key] || []));
    if (page + 1 >= (data?.pagination?.totalPages ?? 1)) break;
  }
  return out;
}

// Neon sends times as "17:30:00" (sometimes "19:00:01"); the app uses "HH:MM".
const hm = (t) => String(t || '').slice(0, 5);

const normalizeEvent = (r) => ({
  neonEventId: String(r[EVENT_FIELDS.id]),
  name: r[EVENT_FIELDS.name] || '',
  date: String(r[EVENT_FIELDS.start] || '').slice(0, 10),
  endDate: String(r[EVENT_FIELDS.end] || '').slice(0, 10),
  startTime: hm(r[EVENT_FIELDS.startTime]),
  endTime: hm(r[EVENT_FIELDS.endTime]),
  location: String(r[EVENT_FIELDS.location] || '').trim(),
});

const normalizeAttendee = (a) => ({
  attendeeId: String(a.attendeeId),
  accountId: a.accountId == null ? '' : String(a.accountId),
  registrationId: a.registrationId == null ? '' : String(a.registrationId),
  name: [a.firstName, a.lastName].filter(Boolean).join(' '),
  email: a.email || '',
  status: a.registrationStatus || '',
  markedAttended: a.markedAttended === true,
});

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Writes are allowed on a sandbox org, or anywhere NEON_ALLOW_WRITES=1. */
export const isSandbox = (env) => /sandbox/i.test(env.NEON_ORG_ID || '');
export const canWrite = (env) => isSandbox(env) || env.NEON_ALLOW_WRITES === '1';

/** "17:30" -> "05:30 PM" (the only time format Neon accepts when writing). */
export function toNeonTime(hm24) {
  const [h, m] = hm24.split(':').map(Number);
  return `${String(h % 12 || 12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** "05:30 PM" or "17:30:00" -> "17:30"; empty when missing. */
function fromNeonTime(t) {
  const s = String(t || '').trim();
  const ampm = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(s);
  if (!ampm) return hm(s);
  const h = (Number(ampm[1]) % 12) + (ampm[3].toUpperCase() === 'PM' ? 12 : 0);
  return `${String(h).padStart(2, '0')}:${ampm[2]}`;
}

/** GET /events/:id as the same shape the events list uses. */
const normalizeEventDetail = (e) => ({
  neonEventId: String(e.id),
  name: e.name || '',
  date: String(e.eventDates?.startDate || '').slice(0, 10),
  endDate: String(e.eventDates?.endDate || '').slice(0, 10),
  startTime: fromNeonTime(e.eventDates?.startTime),
  endTime: fromNeonTime(e.eventDates?.endTime),
  location: String(e.location?.name || '').trim(),
});

// Writes make cached lists stale; entries older than the newest write are ignored (best effort, per data center).
const EPOCH_KEY = 'https://neon.internal/write-epoch';
async function writeEpoch(cache) {
  try {
    return Number((await (await cache?.match(EPOCH_KEY))?.text()) || 0);
  } catch {
    return 0;
  }
}
async function bumpEpoch() {
  try {
    await globalThis.caches?.default?.put(EPOCH_KEY, new Response(String(Date.now()), { headers: { 'Cache-Control': 'public, max-age=3600' } }));
  } catch {
    /* best effort */
  }
}

const CACHE_SECONDS = 300;
const cacheable = (method, pathname) =>
  method === 'GET' && (pathname === '/api/neon/events' || /^\/api\/neon\/events\/\d+\/(attendees|registrations)$/.test(pathname));

/**
 * Neon allows one event search per second, so successful event lists and attendee lists are shared for a few
 * minutes through the Workers cache (every staff member and tab reuses one Neon call). Callers are already
 * authenticated by worker/index.js. Where the Cache API is missing (tests, some hosts) it simply passes through.
 */
export async function handleNeon(request, url, env) {
  const cache = cacheable(request.method, url.pathname) ? globalThis.caches?.default : null;
  const key = new Request(url.toString(), { method: 'GET' });
  try {
    const hit = await cache?.match(key);
    if (hit && Number(hit.headers.get('X-Cached-At') || 0) >= (await writeEpoch(cache))) return hit;
  } catch {
    /* cache unavailable: fall through to Neon */
  }
  const res = await handleNeonUncached(request, url, env);
  if (cache && res.status === 200) {
    const copy = new Response(res.clone().body, res);
    copy.headers.set('Cache-Control', `public, max-age=${CACHE_SECONDS}`);
    copy.headers.set('X-Cached-At', String(Date.now()));
    try {
      await cache.put(key, copy);
    } catch {
      /* best effort */
    }
  }
  return res;
}

async function handleNeonUncached(request, url, env) {
  const { pathname } = url;
  const method = request.method;

  // Which Neon org this deployment talks to (no Neon call), so the app can flag a sandbox.
  if (pathname === '/api/neon/info' && method === 'GET') {
    const org = env.NEON_ORG_ID || '';
    return json({ org, sandbox: isSandbox(env), canWrite: canWrite(env) });
  }

  if (pathname === '/api/neon/status' && method === 'GET') {
    await neonFetch(env, '/events/search/searchFields');
    return json({ ok: true });
  }

  if (pathname === '/api/neon/events' && method === 'GET') {
    const from = url.searchParams.get('from') || '';
    const to = url.searchParams.get('to') || '';
    if (!DATE.test(from) || !DATE.test(to) || from > to) return json({ error: 'from/to must be YYYY-MM-DD' }, 400);
    const events = await searchAll(
      env,
      '/events/search',
      {
        searchFields: [
          { field: EVENT_FIELDS.start, operator: 'GREATER_AND_EQUAL', value: from },
          { field: EVENT_FIELDS.start, operator: 'LESS_AND_EQUAL', value: to },
        ],
        outputFields: Object.values(EVENT_FIELDS),
      },
      normalizeEvent,
    );
    return json({ events });
  }

  const reg = /^\/api\/neon\/events\/(\d{1,12})\/registrations$/.exec(pathname);
  if (reg && method === 'GET') {
    return json({ registrations: await listAll(env, `/events/${reg[1]}/eventRegistrations`, 'eventRegistrations') });
  }

  const att = /^\/api\/neon\/events\/(\d{1,12})\/attendees$/.exec(pathname);
  if (att && method === 'GET') {
    const attendees = await listAll(env, `/events/${att[1]}/attendees`, 'attendees');
    return json({ attendees: attendees.map(normalizeAttendee) });
  }

  const sync = /^\/api\/neon\/events\/(\d{1,12})\/sync$/.exec(pathname);
  if (sync && method === 'GET') {
    const [event, attendees] = await Promise.all([
      neonFetch(env, `/events/${sync[1]}`),
      listAll(env, `/events/${sync[1]}/attendees`, 'attendees'),
    ]);
    return json({ event: normalizeEventDetail(event), attendees: attendees.map(normalizeAttendee), canWrite: canWrite(env) });
  }

  const evWrite = /^\/api\/neon\/events\/(\d{1,12})$/.exec(pathname);
  if (evWrite && method === 'PATCH') {
    if (!canWrite(env)) return json({ error: 'Sending to the OSG Website is turned off for this site' }, 403);
    const body = await readJson(request);
    if (!body) return json({ error: 'invalid JSON' }, 400);
    const bad = validateEventPatch(body);
    if (bad) return json({ error: bad }, 400);
    const patch = {};
    if (body.name !== undefined) patch.name = body.name.trim();
    if (body.location !== undefined) patch.location = { name: body.location.trim() };
    if (body.date !== undefined || body.endDate !== undefined || body.startTime !== undefined || body.endTime !== undefined) {
      // eventDates is sent whole; fill what the caller left out from the event as it is now.
      const cur = (await neonFetch(env, `/events/${evWrite[1]}`)).eventDates || {};
      patch.eventDates = {
        startDate: body.date ?? cur.startDate,
        endDate: body.endDate ?? body.date ?? cur.endDate,
        startTime: body.startTime !== undefined ? toNeonTime(body.startTime) : cur.startTime ?? null,
        endTime: body.endTime !== undefined ? toNeonTime(body.endTime) : cur.endTime ?? null,
      };
    }
    if (!Object.keys(patch).length) return json({ error: 'nothing to change' }, 400);
    await neonFetch(env, `/events/${evWrite[1]}`, { method: 'PATCH', body: JSON.stringify(patch) });
    await bumpEpoch();
    return json({ ok: true });
  }

  const attWrite = /^\/api\/neon\/registrations\/(\d{1,12})\/attendance$/.exec(pathname);
  if (attWrite && method === 'PATCH') {
    if (!canWrite(env)) return json({ error: 'Sending to the OSG Website is turned off for this site' }, 403);
    const body = await readJson(request);
    const attendeeId = Number(body?.attendeeId);
    if (!Number.isInteger(attendeeId) || attendeeId <= 0 || typeof body?.attended !== 'boolean') {
      return json({ error: 'attendeeId and attended (boolean) required' }, 400);
    }
    await neonFetch(env, `/eventRegistrations/${attWrite[1]}`, {
      method: 'PATCH',
      body: JSON.stringify({ tickets: [{ attendees: [{ attendeeId, markedAttended: body.attended }] }] }),
    });
    await bumpEpoch();
    return json({ ok: true });
  }

  if (pathname === '/api/neon/accounts/search' && method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'invalid JSON' }, 400);
    }
    const name = String(body?.name || '').trim();
    const email = String(body?.email || '').trim();
    if (!name && !email) return json({ error: 'name or email required' }, 400);
    const searchFields = [];
    if (email) searchFields.push({ field: 'Email', operator: 'EQUAL', value: email });
    else {
      const [first, ...rest] = name.split(/\s+/);
      searchFields.push({ field: 'First Name', operator: 'EQUAL', value: first });
      if (rest.length) searchFields.push({ field: 'Last Name', operator: 'EQUAL', value: rest.join(' ') });
    }
    const accounts = await searchAll(
      env,
      '/accounts/search',
      { searchFields, outputFields: ['Account ID', 'First Name', 'Last Name', 'Email 1'] },
      (r) => ({
        accountId: String(r['Account ID']),
        name: [r['First Name'], r['Last Name']].filter(Boolean).join(' '),
        email: r['Email 1'] || '',
      }),
    );
    return json({ accounts });
  }

  return json({ error: 'not found' }, 404);
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/** Returns an error message, or '' when the body is a valid event patch. */
function validateEventPatch(b) {
  const str = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
  if (b.name !== undefined && !str(b.name, 200)) return 'name must be 1-200 characters';
  if (b.location !== undefined && !str(b.location, 200)) return 'location must be 1-200 characters';
  for (const k of ['date', 'endDate']) if (b[k] !== undefined && !DATE.test(b[k])) return `${k} must be YYYY-MM-DD`;
  for (const k of ['startTime', 'endTime']) if (b[k] !== undefined && !HM.test(b[k])) return `${k} must be HH:MM`;
  return '';
}
