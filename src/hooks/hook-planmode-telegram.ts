/**
 * hook-planmode-telegram.ts - ExitPlanMode PermissionRequest hook
 * Binds the plan (inline -> planFilePath -> mtime fallback), sends it to Telegram
 * with Approve/Deny buttons. Timeout: 1800s (30 min). For a verifiably-bound plan,
 * a send outage or timeout AUTO-ALLOWS so agents are not stranded. For an
 * UNVERIFIABLE 'missing' source there is nothing to review, so outage/timeout fail
 * CLOSED (deny) -- never silently allow an unverified plan (GAP-0083).
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
import { appendFile } from 'fs/promises';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';
import {
  resolvePlanSource,
  type PlanSource,
  type RawHookInput,
} from './planmode-resolve.js';

type PlanAuditOutcome =
  | 'requested'
  | 'approved'
  | 'denied'
  | 'missing_send_failed_denied'
  | 'missing_timeout_denied'
  | 'missing_invalid_response_denied'
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
      provenance: plan.source === 'file' ? plan.provenance : null,
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

/**
 * Build the Telegram review body. 'missing' sources get an explicit NOTICE and an
 * mtime fallback gets a WARNING, so a human never rubber-stamps an unverified or
 * best-guess plan as if it were the exact bound plan.
 */
function buildReviewBody(plan: PlanSource): string {
  if (plan.source === 'missing' && plan.reason === 'named_plan_file_missing') {
    return `NOTICE: the named plan file could not be found:\n${plan.path}\nThe actual plan cannot be verified. APPROVE only if you intend to allow this exit blind; otherwise DENY. (No response = denied.)`;
  }
  if (plan.source === 'missing') {
    return `NOTICE: no plan content was bound to this exit (no inline plan, no plan file, no recent plan within 24h). There is nothing to verify. APPROVE only if you intend to allow this exit blind; otherwise DENY. (No response = denied.)`;
  }
  if (plan.source === 'file' && plan.provenance === 'mtime_fallback') {
    return `WARNING: this is the NEWEST plan file on disk, NOT a plan explicitly bound to this exit -- it may not be what the agent is actually exiting with.\nPlan file: ${plan.path}\n\n${truncateForTelegram(plan.content)}`;
  }
  return truncateForTelegram(plan.content);
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

  // GAP-0083 fail direction. When no plan could be verifiably bound (source
  // 'missing': nothing inline, no recent plan within 24h, OR an explicitly named
  // planFilePath that has vanished), there is no reviewable content -- so a send
  // failure or a review timeout must fail CLOSED (deny), never silently allow. For
  // a real bound plan the existing fail-open-on-outage behavior stands so a Telegram
  // hiccup does not strand the agent. Principle: never silently brick a legit exit,
  // never silently allow an unverified/substitute plan.
  const failClosed = plan.source === 'missing';

  const messageText = `PLAN REVIEW - ${env.agentName}\nPlan source: ${plan.source}${plan.source === 'file' ? ` (${plan.provenance})` : ''}\nPlan hash: ${plan.hash ?? 'none'}\n\n${buildReviewBody(plan)}`;
  const keyboard = buildPlanKeyboard(requestId);

  try {
    const sent = await api.sendMessage(env.chatId, messageText, keyboard);
    await appendPlanAudit(env, raw, requestId, plan, 'requested', {
      telegram_message_id: sent?.result?.message_id ?? null,
    });
  } catch {
    // Send failed (Telegram unreachable). Fail-closed for unverifiable plans;
    // fail-open for a real bound plan so an outage does not strand the agent.
    if (failClosed) {
      await appendPlanAudit(env, raw, requestId, plan, 'missing_send_failed_denied');
      outputDecision('deny', 'No verifiable plan was bound and Telegram is unreachable for review. Re-run plan mode with an explicit plan.');
    } else {
      await appendPlanAudit(env, raw, requestId, plan, 'send_failed_auto_allowed');
      outputDecision('allow');
    }
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
      // Unreadable response. Fail-closed for unverifiable plans.
      if (failClosed) {
        await appendPlanAudit(env, raw, requestId, plan, 'missing_invalid_response_denied');
        outputDecision('deny', 'No verifiable plan was bound and the review response was unreadable.');
      } else {
        await appendPlanAudit(env, raw, requestId, plan, 'invalid_response_auto_allowed');
        outputDecision('allow');
      }
    }
  } else {
    // Timeout. Fail-closed for unverifiable plans (never silently allow); existing
    // auto-allow stands for a real bound plan.
    if (failClosed) {
      await appendPlanAudit(env, raw, requestId, plan, 'missing_timeout_denied', { timeout_ms: TIMEOUT_MS });
      try {
        await api.sendMessage(env.chatId, `Plan review TIMED OUT (DENIED - no verifiable plan was bound): ${env.agentName}`);
      } catch { /* ignore notification failure */ }
      outputDecision('deny', 'No verifiable plan was bound and the review timed out. Re-run plan mode with an explicit plan.');
    } else {
      await appendPlanAudit(env, raw, requestId, plan, 'timeout_auto_allowed', { timeout_ms: TIMEOUT_MS });
      try {
        await api.sendMessage(
          env.chatId,
          `Plan review TIMED OUT (auto-allowed): ${env.agentName}`,
        );
      } catch { /* ignore notification failure */ }
      outputDecision('allow');
    }
  }
}

main().catch((err) => {
  process.stderr.write(`hook-planmode-telegram error: ${err}\n`);
  outputDecision('allow');
});