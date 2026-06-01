
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
import { mkdirSync, existsSync } from 'fs';
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

function resolvePlanSource(raw: RawHookInput, toolInput: Record<string, unknown>): PlanSource {
  const planFile = asString(toolInput.plan_file) || asString(toolInput.planPath);
  if (planFile) {
    const planPath = resolve(planFile);
    if (!existsSync(planPath)) {
      return {
        source: 'missing',
        path: planPath,
        reason: 'explicit_plan_file_not_found',
        content: '',
        hash: null,
        chars: 0,
        excerpt: '',
      };
    }
    const content = readFileTextStripped(planPath);
    return buildContentSource('file', planPath, content);
  }

  const inlinePlan =
    asString(toolInput.plan) ||
    asString(toolInput.plan_text) ||
    asString(toolInput.content);
  if (inlinePlan) {
    return buildContentSource('inline', null, inlinePlan);
  }

  return {
    source: 'missing',
    path: null,
    reason: raw.tool_name === 'ExitPlanMode'
      ? 'no_plan_file_or_inline_plan_in_hook_input'
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

  if (plan.source === 'missing') {
    await appendPlanAudit(env, raw, requestId, plan, 'missing_plan_denied');
    try {
      await api.sendMessage(
        env.chatId,
        `PLAN REVIEW BLOCKED - ${env.agentName}\n\nNo explicit plan was bound to this ExitPlanMode hook. Refusing to approve by newest-file fallback.\n\nReason: ${plan.reason}`,
        undefined,
        { parseMode: null },
      );
    } catch {
      // Telegram notification is secondary to preventing wrong-plan approval.
    }
    outputDecision('deny', 'Plan review could not bind the actual plan. Re-run plan mode so ExitPlanMode sends an explicit plan_file or inline plan.');
    return;
  }

  const messageText = `PLAN REVIEW - ${env.agentName}\nPlan source: ${plan.source}${plan.path ? `\nPlan file: ${plan.path}` : ''}\nPlan hash: ${plan.hash}\n\n${truncateForTelegram(plan.content)}`;
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
