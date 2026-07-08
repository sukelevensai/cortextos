// Handler-level authorization (GAP-0074/0078).
// Middleware (src/middleware.ts) provides authN only — any logged-in user or
// valid mobile bearer token reaches every non-public route with equal
// privilege. This helper adds role-based authZ: it resolves the requesting
// user from EITHER the NextAuth session or the mobile bearer JWT (both are
// minted against the same users table), then reads the user's CURRENT role
// fresh from the database so role changes take effect immediately (no
// stale-JWT window).

import jwt from 'jsonwebtoken';
import { auth } from './auth';
import { db } from './db';

export interface AuthzUser {
  id: number;
  username: string;
  role: string;
}

async function resolveUserId(request: Request): Promise<number | null> {
  const session = await auth();
  if (session?.user?.id) {
    const id = Number(session.user.id);
    if (Number.isInteger(id)) return id;
  }

  const header = request.headers.get('Authorization');
  if (header?.startsWith('Bearer ')) {
    const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
    if (!secret) return null;
    try {
      // Pin the algorithm the mobile mint endpoint uses (jsonwebtoken default
      // HS256) so no other HMAC variant is accepted.
      const payload = jwt.verify(header.slice(7), secret, { algorithms: ['HS256'] }) as {
        sub?: unknown;
        exp?: unknown;
      };
      // jwt.verify only enforces expiry when the exp claim exists; a no-exp
      // token signed with AUTH_SECRET would otherwise be valid forever.
      if (typeof payload.exp !== 'number') return null;
      // Strict decimal user id — reject "01"-style, exponent forms, floats.
      if (typeof payload.sub === 'string' && /^[1-9]\d*$/.test(payload.sub)) {
        const id = Number(payload.sub);
        if (Number.isSafeInteger(id)) return id;
      }
      return null;
    } catch {
      return null;
    }
  }

  return null;
}

/** Resolve the authenticated user (session or bearer) with their current DB role. */
export async function getRequestUser(request: Request): Promise<AuthzUser | null> {
  const userId = await resolveUserId(request);
  if (userId === null) return null;
  const row = db
    .prepare('SELECT id, username, role FROM users WHERE id = ?')
    .get(userId) as AuthzUser | undefined;
  return row ?? null;
}

/**
 * Gate a route handler on the admin role.
 * Usage:
 *   const authz = await requireAdmin(request);
 *   if ('response' in authz) return authz.response;
 */
export async function requireAdmin(
  request: Request,
): Promise<{ user: AuthzUser } | { response: Response }> {
  const user = await getRequestUser(request);
  if (!user) {
    return { response: Response.json({ error: 'Unauthorized' }, { status: 401 }) };
  }
  if (user.role !== 'admin') {
    return {
      response: Response.json(
        { error: 'Forbidden: admin role required' },
        { status: 403 },
      ),
    };
  }
  return { user };
}
