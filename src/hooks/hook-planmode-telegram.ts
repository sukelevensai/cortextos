
/**
 * hook-planmode-telegram.ts - ExitPlanMode PermissionRequest hook
 * Reads the plan file, sends it to Telegram with Approve/Deny buttons.
 * Timeout: 1800s (30 min), auto-allows so agents are not stranded if user is away.
 */

import { TelegramAPI } from '../telegram/api';
import {
  readStdin,
  parseHookInput,
  loadEnv,
  outputDecision,
  generateId,
  waitForResponseFile,
  buildPlanKeyboard,
  cleanupResponseFile,
} from './index';
import { createHash } from 'crypto';
import { appendFile } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { mkdirSync, existsSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { readFileTextStripped } from '../utils/strip-bom.js';

type RawHookInput = {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
};

type PlanSource =
  | {
      source: 'file';
      path: string;
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

type PlanAuditOutcome =
  | 'requested'
  | 'approved'
  | 'denied'
  | 'missing_plan_denied'
  | 'timeout_auto_allowed'
  | 'send_failed_auto_allowed'
  | 'invalid_response_auto_allowed'
  | 'telegram_not_configured_auto_allowed';

function parseRawHookInput(input: string): RawHookInput {
  try {
    return JSON.parse(input) as RawHookInput;
  } catch {
    return {};
  }
}

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

function buildContentSource(source: 'file', path: string, content: string): PlanSource;
function buildContentSource(source: 'inline', path: null, content: string): PlanSource;
function buildContentSource(source: 'file' | 'inline', path: string | null, content: string): PlanSource {
  const base = {
    content,
    hash: hashContent(content),
    chars: content.length,
    excerpt: redactPlanExcerpt(content),
  };

  if (source === 'file') {
    return { source, path: path as string, ...base };
  }

  return { source, path: null, ...base };
}

/**
 * Find the most recent plan file in ~/.claude/plans/ (newest .md by mtime).
 * Restored as the GAP-0083 safe fallback: when a hook fires with no inline plan
 * and no explicit planFilePath (e.g. a real plan-mode exit arriving with empty
 * stdin), degrade to the newest plan on disk rather than denying. The chosen
 * plan still goes through Telegram human review downstream.
 */
function findMostRecentPlan(): string | null {
  const plansDir = join(homedir(), '.claude', 'plans');
  if (!existsSync(plansDir)) return null;
  try {
    const files = readdirSync(plansDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => ({
        path: join(plansDir, f),
        mtime: statSync(join(plansDir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);
    return files.length > 0 ? files[0].path : null;
  } catch {
    return null;
  }
}

function resolvePlanSource(raw: RawHookInput, toolInput: Record<string, unknown>): PlanSource {
  // (1) Inline plan content is the authoritative current plan and is almost
  //     always present on a real ExitPlanMode call. Prefer it over anything on
  //     disk so we review exactly what the agent is exiting with.
  const inlinePlan =
    asString(toolInput.plan) ||
    asString(toolInput.plan_text) ||
    asString(toolInput.content);
  if (inlinePlan) {
    return buildContentSource('inline', null, inlinePlan);
  }

  // (2) Explicit plan file. The runtime sends the camelCase `planFilePath`; the
  //     previous `plan_file`/`planPath` keys never matched (GAP-0083), so every
  //     call fell through to the deny path.
  const planFile = asString(toolInput.planFilePath);
  if (planFile) {
    const planPath = resolve(planFile);
    if (existsSync(planPath)) {
      const content = readFileTextStripped(planPath);
      return buildContentSource('file', planPath, content);
    }
    // Named file is gone -- fall through to the mtime fallback rather than deny.
  }

  // (3) SAFE fallback: newest plan on disk by mtime (the original behavior).
  //     Empty/absent payloads happen on genuine plan-mode exits; the old
  //     deny-all bricked those. Degrade to mtime; never auto-deny.
  const recentPlan = findMostRecentPlan();
  if (recentPlan) {
    const content = readFileTextStripped(recentPlan);
    return buildContentSource('file', recentPlan, content);
  }

  // Nothing anywhere. Still NOT denied and NOT silently allowed -- the caller
  // routes this to Telegram for human review with a placeholder body, and the
  // existing 30-min timeout-auto-approve remains the decider.
  return {
    source: 'missing',
    path: null,
    reason: raw.tool_name === 'ExitPlanMode'
      ? 'no_inline_plan_no_plan_file_no_recent_plan'
      : 'hook_input_was_not_exit_plan_mode',
    content: '',
    hash: null,
    chars: 0,
    excerpt: '',
  };
}

function truncateForTelegram(content: string): string {
  if (content.length <= 3600) return content;
  return `${content.slice(0, 3600)}...(truncated)`;
}

function isCortextContext(): boolean {
  return Boolean(process.env.CTX_ROOT && process.env.CTX_AGENT_NAME);
}

async function appendJsonl(filePath: string, entry: Record<string, unknown>): Promise<void> {
  mkdirSync(dirname(filePath), { recursive: true });
  await appendFile(filePath, JSON.stringify(entry) + '\n', { encoding: 'utf-8' });
}

async function appendPlanAudit(
  env: ReturnType<typeof loadEnv>,
  raw: RawHookInput,
  requestId: string,
  plan: PlanSource,
  outcome: PlanAuditOutcome,
  extra: Record<string, unknown> = {},
): Promise<void> {
  if (!isCortextContext()) return;

  const entry = {
    schema_version: 1,
    timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    request_id: requestId,
    outcome,
    agent: env.agentName,
    org: env.org ?? null,
    ctx_root: env.ctxRoot,
    cwd: raw.cwd ?? process.cwd(),
    session_id: raw.session_id ?? null,
    transcript_path: raw.transcript_path ?? null,
    plan: {
      source: plan.source,
      path: plan.path,
      hash: plan.hash,
      chars: plan.chars,
      excerpt: plan.excerpt,
      reason: plan.source === 'missing' ? plan.reason : null,
    },
    ...extra,
  };

  const paths = [
    join(env.ctxRoot, 'logs', 'plan-mode-audit.jsonl'),
    join(env.ctxRoot, 'logs', env.agentName, 'plan-mode-audit.jsonl'),
  ];

  await Promise.allSettled(paths.map((p) => appendJsonl(p, entry)));
}

async function main(): Promise<void> {
  const input = await readStdin();
  const raw = parseRawHookInput(input);
  const { tool_input } = parseHookInput(input);

  const env = loadEnv();
  const requestId = generateId();
  const plan = resolvePlanSource(raw, tool_input);

  if (!env.botToken || !env.chatId) {
    await appendPlanAudit(env, raw, requestId, plan, 'telegram_not_configured_auto_allowed');
    outputDecision('allow');
    return;
  }

  mkdirSync(env.stateDir, { recursive: true });
  const responseFile = join(env.stateDir, `hook-response-${requestId}.json`);

  // Register cleanup
  const cleanup = () => cleanupResponseFile(responseFile);
  process.on('exit', cleanup);
  process.on('SIGTERM', () => { cleanup(); process.exit(1); });
  process.on('SIGINT', () => { cleanup(); process.exit(1); });

  const api = new TelegramAPI(env.botToken);

  // GAP-0083: a 'missing' source (no inline plan, no planFilePath, no recent plan
  // on disk) is NOT denied (deny-all bricks genuine empty-stdin exits) and NOT
  // silently auto-allowed (that would bypass human review). It falls through to
  // the same Telegram review path below with a placeholder body, so the human --
  // or the existing 30-min timeout-auto-approve -- stays the decider.

  const messageText = `PLAN REVIEW - ${env.agentName}\nPlan source: ${plan.source}${plan.path ? `\nPlan file: ${plan.path}` : ''}\nPlan hash: ${plan.hash}\n\n${truncateForTelegram(plan.content || '(No plan content found - inline plan, planFilePath, and newest plan file on disk were all absent. Approve only if you intend to allow this exit.)')}`;
  const keyboard = buildPlanKeyboard(requestId);

  try {
    const sent = await api.sendMessage(env.chatId, messageText, keyboard);
    await appendPlanAudit(env, raw, requestId, plan, 'requested', {
      telegram_message_id: sent?.result?.message_id ?? null,
    });
  } catch {
    // If send fails, auto-allow so the agent is not stranded.
    await appendPlanAudit(env, raw, requestId, plan, 'send_failed_auto_allowed');
    outputDecision('allow');
    return;
  }

  // Poll for response (30 min timeout)
  const TIMEOUT_MS = 1800 * 1000;
  const content = await waitForResponseFile(responseFile, TIMEOUT_MS);

  if (content !== null) {
    try {
      const response = JSON.parse(content);
      const decision = response.decision || 'deny';
      if (decision === 'allow') {
        await appendPlanAudit(env, raw, requestId, plan, 'approved', {
          decision_source: response.response_kind === 'plan_review' ? 'plan_button' : 'telegram_button',
        });
        outputDecision('allow');
      } else {
        await appendPlanAudit(env, raw, requestId, plan, 'denied', {
          decision_source: response.response_kind === 'plan_review' ? 'plan_button' : 'telegram_button',
        });
        outputDecision('deny', 'Plan denied by user via Telegram. Ask what they want to change.');
      }
    } catch {
      await appendPlanAudit(env, raw, requestId, plan, 'invalid_response_auto_allowed');
      outputDecision('allow');
    }
  } else {
    // Timeout means auto-allowed, not human-approved.
    await appendPlanAudit(env, raw, requestId, plan, 'timeout_auto_allowed', {
      timeout_ms: TIMEOUT_MS,
    });
    try {
      await api.sendMessage(
        env.chatId,
        `Plan review TIMED OUT (auto-allowed): ${env.agentName}`,
      );
    } catch {
      // Ignore notification failure
    }
    outputDecision('allow');
  }
}

main().catch((err) => {
  process.stderr.write(`hook-planmode-telegram error: ${err}\n`);
  outputDecision('allow');
});
