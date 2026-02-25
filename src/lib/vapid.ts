/**
 * Klubz - VAPID JWT Signing (Web Push)
 *
 * Generates VAPID Authorization headers for sending Web Push notifications.
 * Uses the Web Crypto API (edge-compatible, no Node.js dependencies).
 *
 * VAPID spec: https://datatracker.ietf.org/doc/html/rfc8292
 */

/**
 * Decode a base64url string to a Uint8Array.
 */
function base64urlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = (4 - (padded.length % 4)) % 4;
  const b64 = padded + '='.repeat(pad);
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/**
 * Encode a Uint8Array to a base64url string (no padding).
 */
function base64urlEncode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/**
 * Import a raw P-256 private key (base64url-encoded) as a CryptoKey.
 */
async function importPrivateKey(privateKeyB64url: string): Promise<CryptoKey> {
  const rawBytes = base64urlDecode(privateKeyB64url);
  // VAPID private keys are 32-byte raw scalars; import as PKCS8 JWK instead
  const jwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    d: base64urlEncode(rawBytes),
    // The public key coordinates are not needed for signing; we use ext=true to allow export
    ext: true,
    key_ops: ['sign'],
  };
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

/**
 * Build a VAPID JWT for the given push endpoint audience.
 *
 * @param endpoint - The push endpoint URL (used to extract the audience)
 * @param vapidSubject - VAPID subject (mailto: or https: URL)
 * @param vapidPublicKey - VAPID public key (base64url, uncompressed 65-byte P-256 point)
 * @param vapidPrivateKey - VAPID private key (base64url, 32-byte P-256 scalar)
 * @returns Authorization header value ("vapid t=...,k=...")
 */
export async function buildVapidAuthHeader(
  endpoint: string,
  vapidSubject: string,
  vapidPublicKey: string,
  vapidPrivateKey: string,
): Promise<string> {
  const url = new URL(endpoint);
  const audience = `${url.protocol}//${url.host}`;

  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = {
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600, // 12 hours
    sub: vapidSubject,
  };

  const enc = new TextEncoder();
  const headerB64 = base64urlEncode(enc.encode(JSON.stringify(header)));
  const payloadB64 = base64urlEncode(enc.encode(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;

  const privateKey = await importPrivateKey(vapidPrivateKey);
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    enc.encode(signingInput),
  );

  const jwt = `${signingInput}.${base64urlEncode(signature)}`;
  return `vapid t=${jwt},k=${vapidPublicKey}`;
}
