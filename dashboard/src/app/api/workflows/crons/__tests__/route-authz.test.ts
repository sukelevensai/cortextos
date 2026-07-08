/**
 * dashboard/src/app/api/workflows/crons/__tests__/route-authz.test.ts
 *
 * AuthZ guard test for POST /api/workflows/crons (add-cron).
 * GAP-0078: creating a cron is a fleet-critical mutation (injects a cron into
 * any agent via IPC add-cron) and must be admin-only. This locks the gate:
 * a non-admin request returns the requireAdmin denial and never reaches IPC.
 *
 * All module-load imports are mocked so the route can be imported without a
 * Next.js runtime, next-auth, or the better-sqlite3 native binding.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockSend = vi.fn();

vi.mock('@/lib/ipc-client', () => {
  function IPCClient() {}
  IPCClient.prototype.send = mockSend;
  return { IPCClient };
});

// Load-time imports of the route module — mocked so importing it is hermetic.
vi.mock('@/lib/config', () => ({ getAllAgents: () => [] }));
vi.mock('@/lib/cron-utils', () => ({ computeNextFire: () => null }));
vi.mock('@/lib/data/crons', () => ({
  readAgentCrons: () => [],
  readLastExecution: () => null,
}));

// Mock authz: default allow-as-admin; the denial test overrides per-call.
type AuthzResult =
  | { user: { id: number; username: string; role: string } }
  | { response: Response };

const mockRequireAdmin = vi.fn<(req?: unknown) => Promise<AuthzResult>>(async () => ({
  user: { id: 1, username: 'admin', role: 'admin' },
}));

vi.mock('@/lib/authz', () => ({
  requireAdmin: (req?: unknown) => mockRequireAdmin(req),
}));

type CronsRouteModule = typeof import('../route');
let route: CronsRouteModule;

beforeEach(async () => {
  mockSend.mockReset();
  mockRequireAdmin.mockClear();
  mockRequireAdmin.mockImplementation(async () => ({
    user: { id: 1, username: 'admin', role: 'admin' },
  }));
  route = await import('../route');
});

function callPost(body: unknown) {
  const req = new NextRequest('http://localhost/api/workflows/crons', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return route.POST(req);
}

describe('POST /api/workflows/crons — authZ (GAP-0078)', () => {
  it('returns the requireAdmin denial response and never calls IPC', async () => {
    mockRequireAdmin.mockImplementationOnce(async () => ({
      response: Response.json({ error: 'Forbidden: admin role required' }, { status: 403 }),
    }));

    const res = await callPost({ agent: 'boris', definition: { name: 'x', schedule: '* * * * *' } });
    expect(res.status).toBe(403);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('proceeds past the gate to input validation when admin', async () => {
    // Admin passes the gate; missing definition then yields the route's 400.
    const res = await callPost({ agent: 'boris' });
    expect(res.status).toBe(400);
    expect(mockSend).not.toHaveBeenCalled();
  });
});
