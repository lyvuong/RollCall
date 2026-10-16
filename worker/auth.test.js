import { describe, it, expect, beforeAll } from 'vitest';
import { verifyIdToken } from './auth.js';

const PROJECT = 'rollcall-test';
const NOW = 1_800_000_000_000;
const enc = new TextEncoder();
const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
const part = (o) => b64(enc.encode(JSON.stringify(o)));

let pair;
let jwk;
let otherPair;

async function sign(payload, { kp = pair, kid = 'k1', alg = 'RS256' } = {}) {
  const head = part({ alg, kid, typ: 'JWT' });
  const body = part(payload);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', kp.privateKey, enc.encode(`${head}.${body}`));
  return `${head}.${body}.${b64(new Uint8Array(sig))}`;
}

const claims = (over = {}) => ({
  aud: PROJECT,
  iss: `https://securetoken.google.com/${PROJECT}`,
  sub: 'user1',
  iat: NOW / 1000 - 60,
  exp: NOW / 1000 + 3600,
  ...over,
});

beforeAll(async () => {
  const gen = () =>
    crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    );
  pair = await gen();
  otherPair = await gen();
  jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
});

const verify = (t) => verifyIdToken(t, PROJECT, { getKeys: async () => [jwk], now: NOW });

describe('verifyIdToken', () => {
  it('accepts a valid token', async () => {
    expect((await verify(await sign(claims()))).sub).toBe('user1');
  });
  it('rejects a token signed by another key', async () => {
    await expect(verify(await sign(claims(), { kp: otherPair }))).rejects.toThrow('bad signature');
  });
  it('rejects wrong audience, issuer and expired tokens', async () => {
    await expect(verify(await sign(claims({ aud: 'other' })))).rejects.toThrow('audience');
    await expect(verify(await sign(claims({ iss: 'https://evil.example' })))).rejects.toThrow('issuer');
    await expect(verify(await sign(claims({ exp: NOW / 1000 - 1 })))).rejects.toThrow('expired');
  });
  it('rejects unknown kid, non-RS256 and garbage', async () => {
    await expect(verify(await sign(claims(), { kid: 'nope' }))).rejects.toThrow('unknown signing key');
    await expect(verify(await sign(claims(), { alg: 'none' }))).rejects.toThrow('algorithm');
    await expect(verify('not.a.jwt')).rejects.toThrow();
    await expect(verify('')).rejects.toThrow('malformed');
  });
});
