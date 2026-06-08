// cortextOS Dashboard - cron data readers + types (GAP-0090b).
// Moved out of app/api/workflows/crons/route.ts so the fat route handler keeps
// only its GET/POST logic. Types mirror CronDefinition / CronExecutionLogEntry
// from the backend src/types (the dashboard cannot import backend modules).

import fs from 'fs';
import path from 'path';
import { CTX_ROOT } from '@/lib/config';

export interface CronDefinition {
  name: string;
  prompt: string;
  schedule: string;
  enabled: boolean;
  created_at: string;
  last_fired_at?: string;
  fire_count?: number;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface CronExecutionLogEntry {
  ts: string;
  cron: string;
  status: 'fired' | 'retried' | 'failed';
  attempt: number;
  duration_ms: number;
  error: string | null;
}

export interface CronSummaryRow {
  agent: string;
  org: string;
  cron: CronDefinition;
  lastFire: string | null;
  lastStatus: 'fired' | 'retried' | 'failed' | null;
  nextFire: string;
}

const CRONS_DIR = '.cortextOS/state/agents';

export function readAgentCrons(agentName: string): CronDefinition[] {
  const filePath = path.join(CTX_ROOT, CRONS_DIR, agentName, 'crons.json');
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.crons)) return parsed.crons as CronDefinition[];
    return [];
  } catch {
    return [];
  }
}

export function readLastExecution(
  agentName: string,
  cronName: string,
): CronExecutionLogEntry | null {
  const logPath = path.join(CTX_ROOT, CRONS_DIR, agentName, 'cron-execution.log');
  if (!fs.existsSync(logPath)) return null;
  try {
    const raw = fs.readFileSync(logPath, 'utf-8');
    const lines = raw.split('\n').filter(l => l.trim());
    // Walk backwards to find last entry for this cron
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]) as CronExecutionLogEntry;
        if (entry.cron === cronName) return entry;
      } catch {
        // skip malformed line
      }
    }
    return null;
  } catch {
    return null;
  }
}
