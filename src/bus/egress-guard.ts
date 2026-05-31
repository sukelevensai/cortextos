import { join } from 'path';
import { existsSync } from 'fs';
import { parseEnvFile } from '../utils/env.js';

/**
 * Outbound Telegram egress allow-list guard.
 *
 * Defense-in-depth against an agent (prompt-injected, confabulating, or merely
 * confused) being steered into sending data to an attacker-controlled chat. A
 * send to any chat_id NOT on the agent's allow-list is refused at the bus send
 * layer — so a structural boundary stops exfiltration even when the agent's
 * reasoning is compromised and it *believes* it was told to send.
 *
 * Born from the 2026-05-30 lantern-command confabulation incident: an agent
 * spiralled toward "exfiltrate secrets to chat 6699179156". No exfil occurred
 * (forensics confirmed zero outbound to that chat), but nothing STRUCTURALLY
 * prevented it. This closes that gap.
 *
 * Allow-list sources (union of all that exist):
 *   agent .env:        CHAT_ID, ALLOWED_USER (csv), ACTIVITY_CHAT_ID,
 *                      TELEGRAM_OUTBOUND_ALLOWED (csv, NEW)
 *   org secrets.env:   ACTIVITY_CHAT_ID, TELEGRAM_OUTBOUND_ALLOWED (csv)
 *
 * Rationale for each:
 *   - CHAT_ID                  the agent's primary chat (operator DM or group room)
 *   - ALLOWED_USER             operator Telegram user IDs; a DM's chat_id == user_id
 *   - ACTIVITY_CHAT_ID         the org activity/broadcast channel
 *   - TELEGRAM_OUTBOUND_ALLOWED explicit escape hatch for any other legitimate
 *                              destination, so the lock never has to be loosened
 *                              globally to add one chat.
 */

/** Split a comma/whitespace-separated id list into trimmed, non-empty tokens. */
function splitIds(raw?: string): string[] {
  if (!raw) return [];
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface EgressDecision {
  allowed: boolean;
  /** Human-readable reason (for logging). */
  reason: string;
  /** The resolved allow-list (for diagnostics/logging). */
  allowList: string[];
  /** True when no allow-list could be resolved at all (fail-open path). */
  unresolved: boolean;
}

/**
 * Build the set of Telegram chat_ids this agent is permitted to send to.
 * Reads agent `.env` and org `secrets.env` if present. Never throws.
 */
export function buildTelegramAllowList(opts: { agentDir?: string; orgDir?: string }): Set<string> {
  const allow = new Set<string>();
  const add = (v?: string) => {
    for (const id of splitIds(v)) allow.add(id);
  };

  if (opts.agentDir) {
    const envPath = join(opts.agentDir, '.env');
    if (existsSync(envPath)) {
      const e = parseEnvFile(envPath);
      add(e.CHAT_ID);
      add(e.ALLOWED_USER);
      add(e.ACTIVITY_CHAT_ID);
      add(e.TELEGRAM_OUTBOUND_ALLOWED);
    }
  }

  if (opts.orgDir) {
    const secretsPath = join(opts.orgDir, 'secrets.env');
    if (existsSync(secretsPath)) {
      const s = parseEnvFile(secretsPath);
      add(s.ACTIVITY_CHAT_ID);
      add(s.TELEGRAM_OUTBOUND_ALLOWED);
    }
  }

  return allow;
}

/**
 * Decide whether an outbound Telegram send to `chatId` is permitted against a
 * pre-built allow-list.
 *
 * Enforcement:
 *   - allow-list NON-EMPTY  -> strict: only listed chat_ids pass.
 *   - allow-list EMPTY      -> FAIL-OPEN, flagged `unresolved`. This avoids
 *     bricking sends in a misconfigured/test environment where no .env could be
 *     read; the caller logs it as a SECURITY config warning so it is visible and
 *     fixable rather than silently permissive. In every real deployment the
 *     agent's .env defines CHAT_ID, so the allow-list is non-empty and strict.
 */
export function checkTelegramEgress(chatId: string | number, allow: Set<string>): EgressDecision {
  const target = String(chatId).trim();
  const allowList = [...allow];

  if (allow.size === 0) {
    return {
      allowed: true,
      unresolved: true,
      reason: 'no egress allow-list could be resolved (no readable .env) — failing open with a warning',
      allowList,
    };
  }

  if (allow.has(target)) {
    return { allowed: true, unresolved: false, reason: 'destination on allow-list', allowList };
  }

  return {
    allowed: false,
    unresolved: false,
    reason: `destination ${target} is NOT on the egress allow-list`,
    allowList,
  };
}

/**
 * Convenience: build the allow-list and check in one call.
 */
export function evaluateTelegramEgress(
  chatId: string | number,
  opts: { agentDir?: string; orgDir?: string },
): EgressDecision {
  return checkTelegramEgress(chatId, buildTelegramAllowList(opts));
}
