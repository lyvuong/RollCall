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

describe('neon info', () => {
  it('flags a sandbox org without calling Neon', async () => {
    const res = await call('/api/neon/info', {}, { ...env, NEON_ORG_ID: 'ourstompinggroundsandbox' });
    expect(await res.json()).toEqual({ org: 'ourstompinggroundsandbox', sandbox: true, canWrite: true });
    expect(neonCalls).toHaveLength(0);
  });

  it('reports a live org as not sandbox', async () => {
    const info = await (await call('/api/neon/info')).json();
    expect(info.sandbox).toBe(false);
    expect(info.canWrite).toBe(false);
  });

  it('allows writes on a live org only when NEON_ALLOW_WRITES=1', async () => {
    expect((await (await call('/api/neon/info', {}, { ...env, NEON_ALLOW_WRITES: '1' })).json()).canWrite).toBe(true);
  });
});

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

describe('event times and location', () => {
  it('trims Neon times to HH:MM and passes the location through', async () => {
    mockFetch(() =>
      ok({
        pagination: { totalPages: 1 },
        searchResults: [
          {
            'Event ID': '5',
            'Event Name': 'Dinner',
            'Event Start Date': '2026-10-14',
            'Event Start Time': '17:30:01',
            'Event End Time': '19:00:00',
            'Event Location Name': ' Lost Dog Cafe ',
          },
        ],
      }),
    );
    const { events } = await (await call('/api/neon/events?from=2026-10-01&to=2026-10-31')).json();
    expect(events[0]).toMatchObject({ startTime: '17:30', endTime: '19:00', location: 'Lost Dog Cafe' });
  });
});

describe('attendees', () => {
  it('pages through attendees and normalizes them', async () => {
    mockFetch((url) => {
      const page = Number(/currentPage=(\d+)/.exec(url)[1]);
      return ok({
        pagination: { totalPages: 2 },
        attendees: [
          { attendeeId: 10 + page, accountId: 100 + page, registrationId: 7, firstName: 'Ada', lastName: 'Lovelace', registrationStatus: 'SUCCEEDED', markedAttended: page === 0 },
        ],
      });
    });
    const res = await call('/api/neon/events/42/attendees');
    const { attendees } = await res.json();
    expect(attendees).toEqual([
      { attendeeId: '10', accountId: '100', registrationId: '7', name: 'Ada Lovelace', email: '', status: 'SUCCEEDED', markedAttended: true },
      { attendeeId: '11', accountId: '101', registrationId: '7', name: 'Ada Lovelace', email: '', status: 'SUCCEEDED', markedAttended: false },
    ]);
    expect(neonCalls.map((c) => c.url)).toEqual([
      'https://api.neoncrm.com/v2/events/42/attendees?currentPage=0',
      'https://api.neoncrm.com/v2/events/42/attendees?currentPage=1',
    ]);
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

const SANDBOX = { ...env, NEON_ORG_ID: 'ourstompinggroundsandbox' };
const patch = (path, body, e = SANDBOX) =>
  call(path, { method: 'PATCH', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }, e);

describe('sync snapshot', () => {
  it('returns the event (24h times) and attendees, fresh from Neon', async () => {
    mockFetch((url) =>
      url.endsWith('/events/5')
        ? ok({ id: '5', name: ' Walk ', eventDates: { startDate: '2026-10-20', endDate: '2026-10-20', startTime: '05:30 PM', endTime: null }, location: { name: 'Cadence' } })
        : ok({ pagination: { totalPages: 1 }, attendees: [{ attendeeId: 1, registrationId: 9, firstName: 'Ada', lastName: 'L', markedAttended: true }] }),
    );
    const body = await (await call('/api/neon/events/5/sync')).json();
    expect(body.event).toMatchObject({ neonEventId: '5', date: '2026-10-20', startTime: '17:30', endTime: '', location: 'Cadence' });
    expect(body.attendees[0]).toMatchObject({ attendeeId: '1', registrationId: '9', markedAttended: true });
  });
});

describe('writes', () => {
  it('refuses to write to a live org unless enabled', async () => {
    expect((await patch('/api/neon/events/5', { name: 'x' }, env)).status).toBe(403);
    expect((await patch('/api/neon/registrations/9/attendance', { attendeeId: 1, attended: true }, env)).status).toBe(403);
    expect(neonCalls).toHaveLength(0);
  });

  it('marks an attendee attended with the ticket/attendee shape Neon expects', async () => {
    mockFetch(() => ok({ id: 9 }));
    const res = await patch('/api/neon/registrations/9/attendance', { attendeeId: '415', attended: false });
    expect(res.status).toBe(200);
    expect(neonCalls[0].url).toBe('https://api.neoncrm.com/v2/eventRegistrations/9');
    expect(neonCalls[0].init.method).toBe('PATCH');
    expect(JSON.parse(neonCalls[0].init.body)).toEqual({ tickets: [{ attendees: [{ attendeeId: 415, markedAttended: false }] }] });
  });

  it('validates attendance bodies', async () => {
    expect((await patch('/api/neon/registrations/9/attendance', { attendeeId: 'x', attended: true })).status).toBe(400);
    expect((await patch('/api/neon/registrations/9/attendance', { attendeeId: 1, attended: 'yes' })).status).toBe(400);
  });

  it('sends event dates whole, in 12-hour format, filling gaps from the current event', async () => {
    mockFetch((url, init) =>
      init?.method === 'PATCH'
        ? ok({ id: '5' })
        : ok({ id: '5', eventDates: { startDate: '2026-10-20', endDate: '2026-10-20', startTime: '09:00 AM', endTime: '10:00 AM' } }),
    );
    const res = await patch('/api/neon/events/5', { name: ' New name ', location: 'Cadence', date: '2026-10-21', endTime: '17:30' });
    expect(res.status).toBe(200);
    const sent = JSON.parse(neonCalls.find((c) => c.init?.method === 'PATCH').init.body);
    expect(sent).toEqual({
      name: 'New name',
      location: { name: 'Cadence' },
      eventDates: { startDate: '2026-10-21', endDate: '2026-10-21', startTime: '09:00 AM', endTime: '05:30 PM' },
    });
  });

  it('validates event patches', async () => {
    expect((await patch('/api/neon/events/5', {})).status).toBe(400);
    expect((await patch('/api/neon/events/5', { date: '10/20/2026' })).status).toBe(400);
    expect((await patch('/api/neon/events/5', { startTime: '5pm' })).status).toBe(400);
    expect((await patch('/api/neon/events/5', { name: '   ' })).status).toBe(400);
  });
});
