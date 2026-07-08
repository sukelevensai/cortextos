/**
 * GET /api/workflows/crons
 *
 * Returns a flat array of CronSummaryRow objects — one per cron across all
 * enabled agents.  Used by the Workflows dashboard page (read-only, Subtask 4.1).
 *
 * Data is read directly from disk (crons.json + cron-execution.log) — no daemon
 * IPC required.  This matches the pattern used by /api/agents/[name]/crons which
 * also reads config files directly from the server-side Next.js process.
 *
 * Optional query params:
 *   ?agent=<name>   — filter to a single agent
 *   ?search=<text>  — filter by cron name (case-insensitive substring)
 */

import { NextRequest } from 'next/server';
import { getAllAgents } from '@/lib/config';
import { computeNextFire } from '@/lib/cron-utils';
import { readAgentCrons, readLastExecution, type CronSummaryRow } from '@/lib/data/crons';
import { IPCClient } from '@/lib/ipc-client';
import { requireAdmin } from '@/lib/authz';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// GET handler
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const agentFilter = searchParams.get('agent') ?? undefined;
  const searchFilter = searchParams.get('search')?.toLowerCase() ?? undefined;

  try {
    const allAgents = getAllAgents();
    const agents = agentFilter
      ? allAgents.filter(a => a.name === agentFilter)
      : allAgents;

    const now = Date.now();
    const rows: CronSummaryRow[] = [];

    for (const agent of agents) {
      const crons = readAgentCrons(agent.name);
      for (const cron of crons) {
        if (searchFilter && !cron.name.toLowerCase().includes(searchFilter)) continue;

        const lastEntry = readLastExecution(agent.name, cron.name);

        rows.push({
          agent: agent.name,
          org: agent.org,
          cron,
          lastFire: lastEntry?.ts ?? null,
          lastStatus: lastEntry?.status ?? null,
          nextFire: computeNextFire(cron.schedule, cron.last_fired_at, now),
        });
      }
    }

    return Response.json(rows);
  } catch (err) {
    console.error('[api/workflows/crons] GET error:', err);
    return Response.json({ error: 'Failed to list crons' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// nextFire computation — pure helper, no external deps
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// POST /api/workflows/crons — create a new cron via IPC add-cron
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  // GAP-0078: creating a cron is fleet-critical - admin only
  const authz = await requireAdmin(request);
  if ('response' in authz) return authz.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { agent, definition } = (body ?? {}) as {
    agent?: unknown;
    definition?: unknown;
  };

  if (!agent || typeof agent !== 'string') {
    return Response.json({ error: 'agent is required', field: 'agent' }, { status: 400 });
  }
  if (!definition || typeof definition !== 'object') {
    return Response.json({ error: 'definition is required', field: 'definition' }, { status: 400 });
  }

  const ipc = new IPCClient();
  try {
    const resp = await ipc.send({
      type: 'add-cron',
      agent,
      data: { definition: definition as Record<string, unknown> },
      source: 'dashboard/api',
    } as Parameters<typeof ipc.send>[0]);

    if (resp.success) {
      return Response.json({ ok: true }, { status: 201 });
    }

    // Detect duplicate name → 409
    const errMsg = resp.error ?? '';
    if (errMsg.includes('already exists')) {
      return Response.json({ error: errMsg, field: 'name' }, { status: 409 });
    }

    // Otherwise 400 with structured error from MutationResult
    const detail = (resp.data ?? {}) as Record<string, unknown>;
    return Response.json(
      { error: errMsg, field: detail.field ?? undefined },
      { status: 400 },
    );
  } catch (err) {
    console.error('[api/workflows/crons] POST error:', err);
    return Response.json({ error: 'Failed to create cron (IPC error)' }, { status: 500 });
  }
}
