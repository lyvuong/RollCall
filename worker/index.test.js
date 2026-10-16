import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./auth.js', () => ({
  JWKS_URL: 'https://example.test/jwks',
  verifyIdToken: vi.fn(async (t) => {
    if (t === 'good') return { sub: 'u1' };
    throw new Error('bad signature');
  }),
}));

import worker from './index.js';

const store = new Map();
const env = {
  FIREBASE_PROJECT_ID: 'p',
  PHOTOS: {
    put: async (k, v) => void store.set(k, v),
    get: async (k) => (store.has(k) ? { body: store.get(k), httpEtag: '"x"' } : null),
    delete: async (keys) => void [].concat(keys).forEach((k) => store.delete(k)),
  },
};

const call = (path, init = {}, token = 'good') =>
  worker.fetch(
    new Request(`https://app.test${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } }),
    env,
  );
const jpeg = { 'Content-Type': 'image/jpeg' };

beforeEach(() => {
  store.clear();
  // Firestore members/{uid} lookup
  globalThis.fetch = vi.fn(async () => new Response('{}', { status: 200 }));
});

describe('photo API', () => {
  it('rejects missing and invalid tokens', async () => {
    expect((await worker.fetch(new Request('https://app.test/api/photos/e1/p1'), env)).status).toBe(401);
    expect((await call('/api/photos/e1/p1', {}, 'bad')).status).toBe(401);
  });

  it('rejects non-members', async () => {
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 403 }));
    expect((await call('/api/photos/e1/p1')).status).toBe(403);
  });

  it('uploads, reads and deletes both variants', async () => {
    const body = new Uint8Array([1, 2, 3]);
    expect((await call('/api/photos/e1/p1?v=full', { method: 'PUT', headers: jpeg, body })).status).toBe(201);
    expect((await call('/api/photos/e1/p1?v=thumb', { method: 'PUT', headers: jpeg, body })).status).toBe(201);
    expect([...store.keys()].sort()).toEqual(['events/e1/p1/full.jpg', 'events/e1/p1/thumb.jpg']);

    const got = await call('/api/photos/e1/p1?v=thumb');
    expect(got.status).toBe(200);
    expect(got.headers.get('Content-Type')).toBe('image/jpeg');

    expect((await call('/api/photos/e1/p1', { method: 'DELETE' })).status).toBe(200);
    expect(store.size).toBe(0);
    expect((await call('/api/photos/e1/p1')).status).toBe(404);
  });

  it('validates content type, size and ids', async () => {
    const png = await call('/api/photos/e1/p1', { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: new Uint8Array(3) });
    expect(png.status).toBe(415);
    const big = await call('/api/photos/e1/p1?v=thumb', { method: 'PUT', headers: jpeg, body: new Uint8Array(1024 * 1024 + 1) });
    expect(big.status).toBe(413);
    expect((await call('/api/photos/../x/p1')).status).toBe(404);
  });
});
