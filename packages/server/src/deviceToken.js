import { createHmac, timingSafeEqual } from 'node:crypto';

// Device tokens let the desktop overlay log in as a specific user. The overlay is a separate program, so it
// can't use the web app's session cookie. Your backend issues a token for the logged-in user (see
// `notify.createDeviceToken`) and the user pastes it into the overlay once.
//
// A token is `<payload>.<signature>`: the payload is base64url JSON {u: userId, e: expiry (epoch seconds)} and the
// signature is HMAC-SHA256(secret, payload). It is stateless, so tokens survive restarts and work across several
// server instances that share the secret. The flip side: a token can't be revoked individually. Give it a sensible
// lifetime, and rotate the secret to invalidate every token at once.

const b64 = (buf) => Buffer.from(buf).toString('base64url');

export function createDeviceTokens(secret) {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new Error('notify-server: `secret` must be a string of at least 16 characters');
  }
  const sign = (payload) => createHmac('sha256', secret).update(payload).digest();

  return {
    /** @returns {string} */
    create(userId, ttlSeconds) {
      const payload = b64(JSON.stringify({ u: String(userId), e: Math.floor(Date.now() / 1000) + ttlSeconds }));
      return `${payload}.${b64(sign(payload))}`;
    },

    /** @returns {string | null} the user id, or null if the token is malformed, tampered with, or expired */
    verify(token) {
      if (typeof token !== 'string') return null;
      const parts = token.split('.');
      if (parts.length !== 2) return null;
      const [payload, signature] = parts;

      const expected = sign(payload);
      let given;
      try { given = Buffer.from(signature, 'base64url'); } catch { return null; }
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

      try {
        const { u, e } = JSON.parse(Buffer.from(payload, 'base64url').toString());
        if (typeof u !== 'string' || !u || typeof e !== 'number') return null;
        return e > Math.floor(Date.now() / 1000) ? u : null;
      } catch {
        return null;
      }
    },
  };
}
