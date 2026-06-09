import { appendFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { BusPaths } from '../types/index.js';
import { ensureDir } from '../utils/atomic.js';

/**
 * A5 instrumentation (Track A — context recalibration). Records a context-QUALITY
 * observation paired with the token count at that moment, so the real
 * output-degradation onset can be MEASURED (not assumed) and the soft-warn
 * threshold recalibrated with data later.
 *
 * The instrument is the FLAG: an agent (or the user, via the orchestrator) calls
 * this the moment a degraded output is observed. We snapshot the live
 * context_status.json that the statusLine hook maintains and append the
 * (quality, tokens) pair to state/<agent>/ctx-quality-log.jsonl. A passive
 * token-vs-time trajectory is deliberately NOT used: it has no quality axis, so
 * it carries no degradation-onset signal — there would be nothing to correlate.
 *
 * ADD-ONLY: a new append-only log; no edit to the daemon's safety-critical poll
 * path. Best-effort but never silently drops the observation — if the token
 * snapshot is missing or unreadable the record is still written with the token
 * fields null and ctx_status_available=false, so the quality flag is never lost.
 */
export function logCtxQuality(
  paths: BusPaths,
  agentName: string,
  note: string,
  source: string = 'agent',
): void {
  ensureDir(paths.stateDir);

  const statusPath = join(paths.stateDir, 'context_status.json');
  let usedPercentage: number | null = null;
  let contextWindowSize: number | null = null;
  let sessionId: string | null = null;
  let tokens: { input: number | null; output: number | null; cache_creation: number | null; cache_read: number | null } | null = null;
  let totalTokens: number | null = null;
  let ctxStatusAgeMs: number | null = null;
  let ctxStatusAvailable = false;

  try {
    if (existsSync(statusPath)) {
      const data = JSON.parse(readFileSync(statusPath, 'utf-8'));
      ctxStatusAvailable = true;
      usedPercentage = typeof data.used_percentage === 'number' ? data.used_percentage : null;
      contextWindowSize = typeof data.context_window_size === 'number' ? data.context_window_size : null;
      sessionId = typeof data.session_id === 'string' ? data.session_id : null;
      const cu = data.current_usage;
      if (cu && typeof cu === 'object') {
        const input = numOrNull(cu.input_tokens);
        const output = numOrNull(cu.output_tokens);
        const cacheCreation = numOrNull(cu.cache_creation_input_tokens);
        const cacheRead = numOrNull(cu.cache_read_input_tokens);
        tokens = { input, output, cache_creation: cacheCreation, cache_read: cacheRead };
        const parts = [input, output, cacheCreation, cacheRead].filter((n): n is number => n !== null);
        totalTokens = parts.length > 0 ? parts.reduce((a, b) => a + b, 0) : null;
      }
      const writtenAt = typeof data.written_at === 'string' ? Date.parse(data.written_at) : NaN;
      if (!Number.isNaN(writtenAt)) ctxStatusAgeMs = Date.now() - writtenAt;
    }
  } catch {
    // Token snapshot unreadable/corrupt — still record the observation below with
    // null token fields. The quality flag is the load-bearing datum; never drop it.
    ctxStatusAvailable = false;
  }

  const record = {
    ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    agent: agentName,
    source,
    note,
    used_percentage: usedPercentage,
    total_tokens: totalTokens,
    tokens,
    context_window_size: contextWindowSize,
    session_id: sessionId,
    ctx_status_age_ms: ctxStatusAgeMs,
    ctx_status_available: ctxStatusAvailable,
  };

  appendFileSync(join(paths.stateDir, 'ctx-quality-log.jsonl'), JSON.stringify(record) + '\n', 'utf-8');
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' ? v : null;
}
