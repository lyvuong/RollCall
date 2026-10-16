// Photo API for event photos, backed by R2 (mounted by functions/api/[[path]].js on Pages).
//   PUT    /api/photos/:eventId/:photoId?v=full|thumb   body = image/jpeg
//   GET    /api/photos/:eventId/:photoId?v=full|thumb
//   DELETE /api/photos/:eventId/:photoId                (removes both variants)
// Caller must hold a valid Firebase ID token and be a member (members/{uid} readable).
import { verifyIdToken, JWKS_URL } from './auth.js';

const LIMITS = { full: 6 * 1024 * 1024, thumb: 1024 * 1024 };
const ROUTE = /^\/api\/photos\/([\w-]{1,64})\/([\w-]{1,64})$/;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let keyCache = { keys: null, exp: 0 };
async function getKeys() {
  if (keyCache.keys && keyCache.exp > Date.now()) return keyCache.keys;
  const res = await fetch(JWKS_URL);
  if (!res.ok) throw new Error('could not load signing keys');
  const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get('cache-control') || '')?.[1]) || 3600;
  keyCache = { keys: (await res.json()).keys, exp: Date.now() + maxAge * 1000 };
  return keyCache.keys;
}

const memberCache = new Map(); // uid -> expiry ms
async function isMember(uid, token, projectId) {
  if ((memberCache.get(uid) || 0) > Date.now()) return true;
  // Reading the caller's own members doc with their token goes through the Firestore rules.
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/members/${uid}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return false;
  memberCache.set(uid, Date.now() + 60_000);
  return true;
}

const keyFor = (eventId, photoId, variant) => `events/${eventId}/${photoId}/${variant}.jpg`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = ROUTE.exec(url.pathname);
    if (!m) return json({ error: 'not found' }, 404);
    const [, eventId, photoId] = m;

    const token = /^Bearer (.+)$/.exec(request.headers.get('Authorization') || '')?.[1];
    if (!token) return json({ error: 'missing token' }, 401);
    let claims;
    try {
      claims = await verifyIdToken(token, env.FIREBASE_PROJECT_ID, { getKeys });
    } catch (e) {
      return json({ error: e.message }, 401);
    }
    if (!(await isMember(claims.sub, token, env.FIREBASE_PROJECT_ID))) return json({ error: 'not a member' }, 403);

    const variant = url.searchParams.get('v') === 'thumb' ? 'thumb' : 'full';

    if (request.method === 'GET') {
      const obj = await env.PHOTOS.get(keyFor(eventId, photoId, variant));
      if (!obj) return json({ error: 'not found' }, 404);
      return new Response(obj.body, {
        headers: {
          'Content-Type': 'image/jpeg',
          'Cache-Control': 'private, max-age=31536000, immutable',
          ETag: obj.httpEtag,
        },
      });
    }

    if (request.method === 'PUT') {
      if (!/^image\/jpeg\b/.test(request.headers.get('Content-Type') || '')) {
        return json({ error: 'JPEG only' }, 415);
      }
      const data = await request.arrayBuffer();
      if (!data.byteLength) return json({ error: 'empty body' }, 400);
      if (data.byteLength > LIMITS[variant]) return json({ error: 'too large' }, 413);
      await env.PHOTOS.put(keyFor(eventId, photoId, variant), data, {
        httpMetadata: { contentType: 'image/jpeg' },
        customMetadata: { uploadedBy: claims.sub },
      });
      return json({ ok: true }, 201);
    }

    if (request.method === 'DELETE') {
      await env.PHOTOS.delete([keyFor(eventId, photoId, 'full'), keyFor(eventId, photoId, 'thumb')]);
      return json({ ok: true });
    }

    return json({ error: 'method not allowed' }, 405);
  },
};
