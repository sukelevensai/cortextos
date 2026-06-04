/**
 * planmode-resolve.ts - pure plan-source resolution for the ExitPlanMode hook.
 *
 * Extracted from hook-planmode-telegram.ts (GAP-0083 F4) so resolvePlanSource and
 * findMostRecentPlan can be unit-tested without running the hook's main() stack
 * (which reads stdin and calls process-exiting outputDecision).
 *
 * Binding order (GAP-0083): inline plan -> explicit planFilePath -> mtime fallback
 * (age-bounded) -> missing. The hook's main() decides allow/deny; this module only
 * resolves WHICH plan content (if any) is under review and how it was found.
 */

import { createHash } from 'crypto';
import { resolve, join } from 'path';
import { existsSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { readFileTextStripped } from '../utils/strip-bom.js';

export type RawHookInput = {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
};

export type PlanSource =
  | {
      source: 'file';
      path: string;
      // 'explicit' = bound via planFilePath; 'mtime_fallback' = best-guess newest
      // plan on disk (NOT the plan explicitly bound to this exit).
      provenance: 'explicit' | 'mtime_fallback';
      content: string;
      hash: string;
      chars: number;
      excerpt: string;
    }
  | {
      source: 'inline';
      path: null;
      content: string;
      hash: string;
      chars: number;
      excerpt: string;
    }
  | {
      source: 'missing';
      path: string | null;
      reason: string;
      content: '';
      hash: null;
      chars: 0;
      excerpt: '';
    };

// GAP-0083 F2: a plan file older than this is almost certainly not the current
// plan, so the mtime fallback refuses to resurrect it (prevents a stale or
// pre-planted plan being surfaced for rubber-stamp via the timeout path).
export const MTIME_FALLBACK_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function redactPlanExcerpt(content: string): string {
  return content
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{16,}/gi, '$1[REDACTED]')
    .replace(/\b(sk-[A-Za-z0-9_-]{12,}|pat-na1-[A-Za-z0-9_-]{12,}|xox[abprs]-[A-Za-z0-9-]{12,})\b/g, '[REDACTED_TOKEN]')
    .replace(/\b\d{8,}:[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_BOT_TOKEN]')
    .slice(0, 1200);
}

function fileSource(path: string, content: string, provenance: 'explicit' | 'mtime_fallback'): PlanSource {
  return {
    source: 'file',
    path,
    provenance,
    content,
    hash: hashContent(content),
    chars: content.length,
    excerpt: redactPlanExcerpt(content),
  };
}

function inlineSource(content: string): PlanSource {
  return {
    source: 'inline',
    path: null,
    content,
    hash: hashContent(content),
    chars: content.length,
    excerpt: redactPlanExcerpt(content),
  };
}

function missingSource(reason: string, path: string | null): PlanSource {
  return { source: 'missing', path, reason, content: '', hash: null, chars: 0, excerpt: '' };
}

/**
 * Newest *.md in ~/.claude/plans/ within MTIME_FALLBACK_MAX_AGE_MS.
 * Returns null if the dir is absent, has no .md files, or the newest is stale.
 * Per-file statSync is guarded so one unreadable file does not drop all candidates.
 * `nowMs` is injectable for deterministic tests.
 */
export function findMostRecentPlan(nowMs: number = Date.now()): string | null {
  const plansDir = join(homedir(), '.claude', 'plans');
  if (!existsSync(plansDir)) return null;

  let names: string[];
  try {
    names = readdirSync(plansDir);
  } catch {
    return null;
  }

  let best: { path: string; mtime: number } | null = null;
  for (const f of names) {
    if (!f.toLowerCase().endsWith('.md')) continue;
    const p = join(plansDir, f);
    let mtime: number;
    try {
      mtime = statSync(p).mtimeMs;
    } catch {
      continue; // unreadable file: skip it, keep scanning the rest
    }
    if (!best || mtime > best.mtime) best = { path: p, mtime };
  }

  if (!best) return null;
  if (nowMs - best.mtime > MTIME_FALLBACK_MAX_AGE_MS) return null; // stale -> no fallback
  return best.path;
}

/**
 * Resolve the plan under review. `nowMs` is injectable for tests.
 *
 * Order:
 *   (1) inline tool_input.plan (authoritative current content)
 *   (2) explicit tool_input.planFilePath (the real camelCase key)
 *       - file present  -> file source, provenance 'explicit'
 *       - file MISSING   -> missing source, reason 'named_plan_file_missing'
 *                           (GAP-0083 F3: do NOT substitute a different plan)
 *   (3) mtime fallback within 24h -> file source, provenance 'mtime_fallback'
 *   (4) nothing bindable -> missing source
 */
export function resolvePlanSource(
  raw: RawHookInput,
  toolInput: Record<string, unknown>,
  nowMs: number = Date.now(),
): PlanSource {
  const inlinePlan =
    asString(toolInput.plan) ||
    asString(toolInput.plan_text) ||
    asString(toolInput.content);
  if (inlinePlan) {
    return inlineSource(inlinePlan);
  }

  const planFile = asString(toolInput.planFilePath);
  if (planFile) {
    const planPath = resolve(planFile);
    if (existsSync(planPath)) {
      return fileSource(planPath, readFileTextStripped(planPath), 'explicit');
    }
    // F3: an explicit plan was named but the file is gone. Surfacing some OTHER
    // newest file here would review a different plan than the one requested, so
    // we report missing with a specific reason and let main() send a notice.
    return missingSource('named_plan_file_missing', planPath);
  }

  const recentPlan = findMostRecentPlan(nowMs);
  if (recentPlan) {
    return fileSource(recentPlan, readFileTextStripped(recentPlan), 'mtime_fallback');
  }

  return missingSource(
    raw.tool_name === 'ExitPlanMode'
      ? 'no_plan_anywhere'
      : 'hook_input_was_not_exit_plan_mode',
    null,
  );
}
