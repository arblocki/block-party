import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';

export const TOKEN_HEADER = 'x-block-party-token';

/** `__Host-` makes the browser refuse the cookie unless Secure, Path=/ and no Domain, so
 *  sibling apps on the same parent domain can't set or overwrite it. */
export const SESSION_COOKIE = '__Host-bp_session';

/** Parses BLOCK_PARTY_ALLOWED_HOSTS: comma-separated `host[:port]` values, lowercased. */
export function parseAllowedHosts(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export function tokensMatch(expected: string, actual: string | undefined): boolean {
  if (!actual) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Rejects requests whose Host/Origin is not this server (DNS rebinding / cross-site).
 * `extraHosts` are additional hosts (e.g. a reverse proxy's name) served over https.
 */
export function hostGuard(
  getPort: () => number,
  extraHosts: readonly string[] = [],
): MiddlewareHandler {
  return async (c, next) => {
    const port = getPort();
    const localHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    const host = c.req.header('host')?.toLowerCase();
    if (!host || !(localHosts.includes(host) || extraHosts.includes(host))) {
      return c.json({ error: 'bad host' }, 403);
    }
    const origins = [
      ...localHosts.map((h) => `http://${h}`),
      ...extraHosts.map((h) => `https://${h}`),
    ];
    const origin = c.req.header('origin');
    if (origin !== undefined && !origins.includes(origin)) {
      return c.json({ error: 'bad origin' }, 403);
    }
    await next();
  };
}

/**
 * Accepts the token from the header, or else from the session cookie. A header that is
 * present but wrong is rejected without trying the cookie. Cookie-only requests must carry
 * `Sec-Fetch-Site: same-origin`.
 */
export function tokenGuard(token: string): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header(TOKEN_HEADER);
    if (header) {
      // Truthiness, not `!== undefined`: an empty header falls through to the cookie.
      if (!tokensMatch(token, header)) return c.json({ error: 'unauthorized' }, 401);
      await next();
      return;
    }
    if (!tokensMatch(token, getCookie(c, SESSION_COOKIE))) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    // Browsers attach cookies to cross-site requests too, so cookie-only auth requires the
    // browser to vouch that the request is same-origin (for every method, GET included).
    if (c.req.header('sec-fetch-site') !== 'same-origin') {
      return c.json({ error: 'cross-site' }, 403);
    }
    await next();
  };
}
