import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Read today's REAL crash count from the daemon's authoritative ledger at
 * logs/<agent>/.crash_count_today.
 *
 * That file is written ONLY by AgentProcess.resetCrashCountIfNewDay on a genuine
 * PTY-exit crash (src/daemon/agent-process.ts). It is the single source of truth
 * for "how many times has this agent actually crashed today".
 *
 * Day-reset aware: a stored date other than `today` means zero crashes have been
 * recorded today yet, so it returns 0 (the daemon rewrites the date on the next
 * real crash). A missing, unreadable, or garbled file also returns 0.
 *
 * GAP-0110: the crash-alert hook previously kept a SEPARATE counter at
 * state/<agent>/.crash_count_today that it incremented on every markerless
 * SessionEnd -- including healthy cold-boot session cycles that never reach
 * handleExit -- so it fabricated "N crashes today / max_crashes_per_day reached"
 * on a perfectly healthy agent. Pointing the alert at this shared ledger makes
 * the notification truthful and keeps the alert and the real restart gate in
 * agreement.
 *
 * @param ctxRoot   The instance root, e.g. ~/.cortextos/<instanceId>. Must match
 *                  the daemon's CtxEnv.ctxRoot so reader and writer hit one file.
 * @param agentName The agent whose ledger to read.
 * @param today     ISO date (YYYY-MM-DD) to compare the stored date against.
 * @returns         The crash count recorded today, or 0 if none/stale/unreadable.
 */
export function readTodaysCrashCount(ctxRoot: string, agentName: string, today: string): number {
  const crashFile = join(ctxRoot, 'logs', agentName, '.crash_count_today');
  try {
    const [storedDate, count] = readFileSync(crashFile, 'utf-8').trim().split(':');
    if (storedDate !== today) return 0;
    const parsed = parseInt(count, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    return 0;
  }
}
