// Firebase ID-token verification using WebCrypto only (no dependencies).
// https://firebase.google.com/docs/auth/admin/verify-id-tokens#verify_id_tokens_using_a_third-party_jwt_library

export const JWKS_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

const dec = new TextDecoder();
const enc = new TextEncoder();

function b64url(s) {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '='));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

/**
 * Verify a Firebase ID token. getKeys() resolves to the JWK array.
 * Returns the payload, or throws Error('…') describing why it is invalid.
 */
export async function verifyIdToken(token, projectId, { getKeys, now = Date.now() }) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  let header;
  let payload;
  try {
    header = JSON.parse(dec.decode(b64url(parts[0])));
    payload = JSON.parse(dec.decode(b64url(parts[1])));
  } catch {
    throw new Error('malformed token');
  }
  if (header.alg !== 'RS256' || !header.kid) throw new Error('unsupported algorithm');

  const jwk = (await getKeys()).find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('unknown signing key');
  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64url(parts[2]),
    enc.encode(`${parts[0]}.${parts[1]}`),
  );
  if (!ok) throw new Error('bad signature');

  if (payload.aud !== projectId) throw new Error('wrong audience');
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) throw new Error('wrong issuer');
  if (!(payload.exp * 1000 > now)) throw new Error('token expired');
  if (payload.iat * 1000 > now + 60_000) throw new Error('token issued in the future');
  if (typeof payload.sub !== 'string' || !payload.sub) throw new Error('missing subject');
  return payload;
}
