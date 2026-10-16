// Neon One CRM proxy (mounted by worker/index.js under /api/neon/*).
//   GET  /api/neon/status                       connection check
//   GET  /api/neon/events?from=YYYY-MM-DD&to=   events in a date range (normalized)
//   GET  /api/neon/events/:id/registrations     registrations for one event
//   POST /api/neon/accounts/search              {name?, email?} -> candidate accounts
// The API key lives in env.NEON_API_KEY and never reaches the browser.
// NOTE: search field / output field names are unverified against a live org (see plan, Phase 0).

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

const normalizeEvent = (r) => ({
  neonEventId: String(r[EVENT_FIELDS.id]),
  name: r[EVENT_FIELDS.name] || '',
  date: String(r[EVENT_FIELDS.start] || '').slice(0, 10),
  endDate: String(r[EVENT_FIELDS.end] || '').slice(0, 10),
  startTime: r[EVENT_FIELDS.startTime] || '',
  endTime: r[EVENT_FIELDS.endTime] || '',
});

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function handleNeon(request, url, env) {
  const { pathname } = url;
  const method = request.method;

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
    const data = await neonFetch(env, `/events/${reg[1]}/eventRegistrations?pageSize=${PAGE_SIZE}`);
    return json({ registrations: data?.eventRegistrations || [] });
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
