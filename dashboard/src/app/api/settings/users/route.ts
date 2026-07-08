import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import bcrypt from 'bcryptjs';
import { requireAdmin } from '@/lib/authz';

export const dynamic = 'force-dynamic';

interface DbUser {
  id: number;
  username: string;
  role: string;
  created_at: string;
}

const VALID_ROLES = ['admin', 'member'];

export async function GET(request: NextRequest) {
  // GAP-0074: user management is admin-only
  const authz = await requireAdmin(request);
  if ('response' in authz) return authz.response;
  try {
    const rows = db.prepare('SELECT id, username, role, created_at FROM users ORDER BY id').all() as DbUser[];
    return Response.json({ users: rows.map(r => ({ id: r.id, username: r.username, role: r.role, created_at: r.created_at })) });
  } catch (err) {
    console.error('[api/settings/users] GET error:', err);
    return Response.json({ error: 'Failed to fetch users' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  // GAP-0074: user management is admin-only
  const authz = await requireAdmin(request);
  if ('response' in authz) return authz.response;
  try {
    const { username, password, role } = await request.json();
    const trimmed = (username ?? '').trim();
    if (!trimmed || trimmed.length < 3) return Response.json({ error: 'Username must be at least 3 characters' }, { status: 400 });
    if (!password || password.length < 12) return Response.json({ error: 'Password must be at least 12 characters' }, { status: 400 });
    // New users default to 'member' — admin must be granted explicitly
    const newRole = role ?? 'member';
    if (!VALID_ROLES.includes(newRole)) return Response.json({ error: 'Role must be "admin" or "member"' }, { status: 400 });

    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(trimmed);
    if (existing) return Response.json({ error: 'Username already exists' }, { status: 409 });

    const hash = await bcrypt.hash(password, 12);
    db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(trimmed, hash, newRole);
    return Response.json({ success: true });
  } catch (err) {
    console.error('[api/settings/users] POST error:', err);
    return Response.json({ error: 'Failed to add user' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  // GAP-0074: user management is admin-only
  const authz = await requireAdmin(request);
  if ('response' in authz) return authz.response;
  try {
    const { id } = await request.json();

    // Check-then-delete must be atomic: without a write lock, two concurrent
    // DELETEs can each pass the count guards and together remove the last
    // admin. .immediate() takes the write lock before the first read.
    const deleteUser = db.transaction((userId: unknown) => {
      const count = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
      if (count.count <= 1) return { status: 400 as const, error: 'Cannot delete the last user' };
      const target = db.prepare('SELECT role FROM users WHERE id = ?').get(userId) as { role: string } | undefined;
      if (!target) return { status: 404 as const, error: 'User not found' };
      if (target.role === 'admin') {
        const admins = db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin'").get() as { count: number };
        if (admins.count <= 1) return { status: 400 as const, error: 'Cannot delete the last admin' };
      }
      const result = db.prepare('DELETE FROM users WHERE id = ?').run(userId);
      if (result.changes === 0) return { status: 404 as const, error: 'User not found' };
      return { status: 200 as const, error: null };
    });

    const outcome = deleteUser.immediate(id);
    if (outcome.status !== 200) return Response.json({ error: outcome.error }, { status: outcome.status });
    return Response.json({ success: true });
  } catch (err) {
    console.error('[api/settings/users] DELETE error:', err);
    return Response.json({ error: 'Failed to delete user' }, { status: 500 });
  }
}
