import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./auth.js', () => ({
  JWKS_URL: 'https://example.test/jwks',
  verifyIdToken: vi.fn(async (t) => {
    if (t === 'good') return { sub: 'u1' };
    throw new Error('bad signature');
  }),
}));

import worker from './index.js';
import { neonFetch } from './neon.js';

const env = { FIREBASE_PROJECT_ID: 'p', NEON_ORG_ID: 'org', NEON_API_KEY: 'key' };
const ok = (body, status = 200) => new Response(JSON.stringify(body), { status });

const call = (path, init = {}, e = env) =>
  worker.fetch(
    new Request(`https://app.test${path}`, { ...init, headers: { Authorization: 'Bearer good', ...init.headers } }),
    e,
  );

let neonCalls;
// First fetch is the Firestore membership lookup; the rest go to Neon.
function mockFetch(handler) {
  neonCalls = [];
  globalThis.fetch = vi.fn(async (url, init) => {
    if (String(url).includes('firestore.googleapis.com')) return ok({});
    neonCalls.push({ url: String(url), init });
    return handler(String(url), init);
  });
}

beforeEach(() => mockFetch(() => ok({})));

describe('neon proxy auth', () => {
  it('requires a valid token', async () => {
    const res = await worker.fetch(new Request('https://app.test/api/neon/status'), env);
    expect(res.status).toBe(401);
  });

  it('reports 503 when not configured', async () => {
    const res = await call('/api/neon/status', {}, { FIREBASE_PROJECT_ID: 'p' });
    expect(res.status).toBe(503);
  });

  it('sends Basic auth and the pinned API version', async () => {
    await call('/api/neon/status');
    const { url, init } = neonCalls[0];
    expect(url).toBe('https://api.neoncrm.com/v2/events/search/searchFields');
    expect(init.headers.Authorization).toBe(`Basic ${btoa('org:key')}`);
    expect(init.headers['NEON-API-VERSION']).toBe('2.11');
  });
});

describe('events', () => {
  it('validates the date range', async () => {
    expect((await call('/api/neon/events?from=nope&to=2026-01-01')).status).toBe(400);
    expect((await call('/api/neon/events?from=2026-02-01&to=2026-01-01')).status).toBe(400);
  });

  it('pages through search results and normalizes events', async () => {
    mockFetch((url, init) => {
      const page = JSON.parse(init.body).pagination.currentPage;
      return ok({
        pagination: { totalPages: 2 },
        searchResults: [
          {
            'Event ID': 100 + page,
            'Event Name': `Event ${page}`,
            'Event Start Date': '2026-03-0' + (page + 1),
            'Event End Date': '2026-03-0' + (page + 1),
            'Event Start Time': '18:00',
            'Event End Time': '20:00',
          },
        ],
      });
    });
    const res = await call('/api/neon/events?from=2026-03-01&to=2026-03-31');
    const { events } = await res.json();
    expect(events.map((e) => e.neonEventId)).toEqual(['100', '101']);
    expect(events[0]).toMatchObject({ name: 'Event 0', date: '2026-03-01', startTime: '18:00', endTime: '20:00' });
  });
});

describe('registrations and accounts', () => {
  it('only accepts numeric event ids', async () => {
    expect((await call('/api/neon/events/abc/registrations')).status).toBe(404);
    mockFetch(() => ok({ eventRegistrations: [{ id: '9' }] }));
    const res = await call('/api/neon/events/42/registrations');
    expect((await res.json()).registrations).toEqual([{ id: '9' }]);
    expect(neonCalls[0].url).toContain('/events/42/eventRegistrations');
  });

  it('searches accounts by name', async () => {
    mockFetch(() =>
      ok({ searchResults: [{ 'Account ID': 7, 'First Name': 'Ada', 'Last Name': 'Lovelace', 'Email 1': 'a@x.org' }] }),
    );
    const res = await call('/api/neon/accounts/search', { method: 'POST', body: JSON.stringify({ name: 'Ada Lovelace' }) });
    expect((await res.json()).accounts).toEqual([{ accountId: '7', name: 'Ada Lovelace', email: 'a@x.org' }]);
    const sent = JSON.parse(neonCalls[0].init.body);
    expect(sent.searchFields.map((f) => f.field)).toEqual(['First Name', 'Last Name']);
  });

  it('requires a name or email', async () => {
    const res = await call('/api/neon/accounts/search', { method: 'POST', body: JSON.stringify({}) });
    expect(res.status).toBe(400);
  });
});

describe('neonFetch', () => {
  it('retries on 429 then succeeds', async () => {
    let n = 0;
    globalThis.fetch = vi.fn(async () => (n++ < 2 ? ok({}, 429) : ok({ fine: true })));
    const wait = vi.fn(async () => {});
    expect(await neonFetch(env, '/x', {}, { wait })).toEqual({ fine: true });
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it('surfaces a persistent 429', async () => {
    globalThis.fetch = vi.fn(async () => ok({}, 429));
    await expect(neonFetch(env, '/x', {}, { retries: 1, wait: async () => {} })).rejects.toMatchObject({ status: 429 });
  });
});
