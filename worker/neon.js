// Neon One CRM proxy (mounted by worker/index.js under /api/neon/*).
//   GET  /api/neon/status                       connection check
//   GET  /api/neon/events?from=YYYY-MM-DD&to=   events in a date range (normalized)
//   GET  /api/neon/events/:id/registrations     registrations for one event
//   GET  /api/neon/events/:id/attendees         attendees with markedAttended (check-in) state
//   POST /api/neon/accounts/search              {name?, email?} -> candidate accounts
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
    if (hit) return hit;
  } catch {
    /* cache unavailable: fall through to Neon */
  }
  const res = await handleNeonUncached(request, url, env);
  if (cache && res.status === 200) {
    const copy = new Response(res.clone().body, res);
    copy.headers.set('Cache-Control', `public, max-age=${CACHE_SECONDS}`);
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
    return json({ org, sandbox: /sandbox/i.test(org) });
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
