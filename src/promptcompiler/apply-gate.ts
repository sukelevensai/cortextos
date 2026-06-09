/**
 * Prompt-Compiler — Apply Gate (Conservative V1).
 *
 * `decideApply(task)` is a PURE, default-deny veto layer. Given a compiled task
 * (the output of the org compiler), it decides whether the compiled prompt may be
 * AUTO-APPLIED (silent execution of low-risk reversible work) or must PASS THROUGH
 * to the original human-routed behavior unchanged.
 *
 * DESIGN INVARIANTS (do not weaken without re-running the eval + Luke sign-off):
 *
 *  1. DEFAULT-DENY. The decision starts at `passthrough` and only becomes `apply`
 *     when EVERY positive condition holds and ZERO veto fires. A missing, malformed,
 *     or unexpected field can never reach the apply branch.
 *
 *  2. INDEPENDENT VETO LAYER, not a rubber-stamp of the compiler's mode.
 *     `mode === 'silent_compile'` is NECESSARY-BUT-NOT-SUFFICIENT. The sentinels,
 *     trust tags, sender auth, and push-back state can only ever DOWNGRADE the
 *     verdict to passthrough — never upgrade it to apply. "Gates outrank compiler."
 *
 *  3. FAIL-SAFE. The function never throws. Any unexpected error -> passthrough.
 *     Passthrough is always the safe direction: it runs the original message
 *     unchanged, so a gate fault can never drop, mutate, or mis-route a message.
 *
 *  4. DELIBERATE TIGHTENING vs. the eval. The Phase-0 eval scored gate-miss=0 with
 *     {silent_compile, notify_assumption} as the non-gated bucket. This gate
 *     auto-applies `silent_compile` ONLY, so `notify_assumption` -> passthrough.
 *     That makes the gate a STRICT SUBSET of what the eval validated = strictly
 *     safer. "Eval passed" is NOT "gate validated"; this gate is tighter by design.
 *
 * This module is generic framework logic (no org secrets / PII / strategy) and is a
 * James-upstream candidate. It performs NO I/O and is not wired into any live path;
 * activation (a daemon/fast-checker call site) is a SEPARATE, higher-blast-radius
 * gate that requires its own review + sign-off.
 */

import type { ApplyDecision } from './types.js';

/** All 21 top-level keys the compiled-task schema declares (additionalProperties:false). */
const ALLOWED_TOP_KEYS: ReadonlySet<string> = new Set([
  'schema_version',
  'compiled_prompt',
  'intent_summary',
  'task_type',
  'target_agent',
  'context_to_load',
  'constraints',
  'success_criteria',
  'output_contract',
  'risk_class',
  'signal_strength',
  'ambiguity_map',
  'mode',
  'assumptions',
  'source_message_hash',
  'sender_id',
  'sender_auth',
  'retrieval_scopes',
  'invocation_origin',
  'sentinel_state',
  'provenance_tags',
  'trust_tags',
]);

/** Every top-level key is `required` in the schema. */
const REQUIRED_TOP_KEYS: readonly string[] = Array.from(ALLOWED_TOP_KEYS);

const SUPPORTED_SCHEMA_VERSION = 'phase0.v1';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Render an unknown enum-ish value for a veto code without throwing. */
function describe(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Default-deny read of a push-back state. Returns true (i.e. VETO) unless the value
 * is a well-formed push-back object whose `fired` is explicitly `false`. A missing
 * or malformed push-back state is treated as fired — the safe direction.
 *
 * `pushback_compiled` is the most load-bearing veto: push-back is evaluated on the
 * EXPANDED prompt, so a 5-word message that compiles into a 6-file edit trips the
 * >3-files trigger and must NOT auto-apply.
 */
function pushbackFiredOrMissing(value: unknown): boolean {
  if (!isPlainObject(value)) return true;
  return value.fired !== false;
}

/** True (VETO) if trust_tags is malformed or any span is untrusted. */
function hasUntrustedSpan(value: unknown): boolean {
  if (!Array.isArray(value)) return true; // schema: minItems 1; malformed -> deny
  return value.some((tag) => !isPlainObject(tag) || tag.trust !== 'trusted');
}

/** True (VETO) if context_to_load is malformed or any loaded ref is untrusted. */
function hasUntrustedContext(value: unknown): boolean {
  if (!Array.isArray(value)) return true;
  // An empty context list is valid (read-nothing) and not itself a veto.
  return value.some((ref) => !isPlainObject(ref) || ref.trust === 'untrusted');
}

function passthrough(reason: string, vetoes: string[]): ApplyDecision {
  return { action: 'passthrough', reason, vetoes };
}

/**
 * Decide whether a compiled task may be auto-applied.
 *
 * @param input the compiled task (treated as `unknown`: it may be malformed,
 *   partial, or hostile — the gate validates before trusting any field).
 * @returns an {@link ApplyDecision}. `action: 'apply'` ONLY when every positive
 *   condition holds and no veto fires; otherwise `action: 'passthrough'`.
 */
export function decideApply(input: unknown): ApplyDecision {
  try {
    // --- Step 1: structural validation (any failure -> passthrough) ------------
    if (!isPlainObject(input)) {
      return passthrough('invalid_compiled_task: not an object', ['structure:not_object']);
    }

    const extraKeys = Object.keys(input).filter((k) => !ALLOWED_TOP_KEYS.has(k));
    if (extraKeys.length > 0) {
      // additionalProperties:false — an unexpected key signals a malformed/tampered task.
      return passthrough(
        `invalid_compiled_task: unexpected keys [${extraKeys.join(', ')}]`,
        ['structure:extra_keys'],
      );
    }

    const missingKeys = REQUIRED_TOP_KEYS.filter((k) => !(k in input));
    if (missingKeys.length > 0) {
      return passthrough(
        `invalid_compiled_task: missing required keys [${missingKeys.join(', ')}]`,
        ['structure:missing_keys'],
      );
    }

    if (input.schema_version !== SUPPORTED_SCHEMA_VERSION) {
      return passthrough(
        `unsupported schema_version: ${describe(input.schema_version)}`,
        ['structure:schema_version'],
      );
    }

    // --- Step 2: collect ALL applicable vetoes (default-deny, no short-circuit) -
    const vetoes: string[] = [];

    // Necessary mode: silent_compile ONLY (notify_assumption and every gate mode
    // pass through). This is the deliberate tightening vs. the eval (invariant 4).
    if (input.mode !== 'silent_compile') {
      vetoes.push(`mode:${describe(input.mode)}`);
    }

    // Independent risk check: low risk only.
    if (input.risk_class !== 'low') {
      vetoes.push(`risk_class:${describe(input.risk_class)}`);
    }

    // Independent ambiguity check: only non-material ambiguity may auto-apply.
    const ambiguityMap = input.ambiguity_map;
    const materiality = isPlainObject(ambiguityMap) ? ambiguityMap.materiality : undefined;
    if (materiality !== 'none' && materiality !== 'low') {
      vetoes.push(`materiality:${describe(materiality)}`);
    }

    // Sentinel vetoes.
    const sentinel = input.sentinel_state;
    if (!isPlainObject(sentinel)) {
      vetoes.push('sentinel:malformed');
    } else {
      if (sentinel.gateway_killed === true) vetoes.push('sentinel:gateway_killed');
      if (sentinel.compiler_killed === true) vetoes.push('sentinel:compiler_killed');
      if (pushbackFiredOrMissing(sentinel.pushback_raw)) vetoes.push('sentinel:pushback_raw');
      if (pushbackFiredOrMissing(sentinel.pushback_compiled)) {
        vetoes.push('sentinel:pushback_compiled');
      }
      // Stale classifier -> fail-closed-degrade to confirm-bias: do not auto-apply.
      if (sentinel.review_status_fresh !== true) vetoes.push('sentinel:review_status_stale');
      // Slash-command exemption is OWNER-ONLY (R52): an active exemption from a
      // non-authorized sender (e.g. a non-owner typing /deploy-leads) is a veto.
      const exemption = sentinel.slash_command_exemption;
      if (isPlainObject(exemption) && exemption.active === true && exemption.authorized_sender !== true) {
        vetoes.push('sentinel:slash_exemption_unauthorized');
      }
    }

    // Sender auth: only the profile owner's own messages may auto-apply.
    const senderAuth = input.sender_auth;
    if (!isPlainObject(senderAuth) || senderAuth.profile_owner !== true) {
      vetoes.push('sender:not_profile_owner');
    }

    // Invocation origin: only the owner's typed message or a compiler re-route.
    // No auto-apply on non-owner, cron, or agent-to-agent traffic (V1 scope).
    if (input.invocation_origin !== 'user_typed' && input.invocation_origin !== 'compiler_routed') {
      vetoes.push(`origin:${describe(input.invocation_origin)}`);
    }

    // Trust: untrusted spans are DATA-ONLY and may never drive a silent auto-apply.
    if (hasUntrustedSpan(input.trust_tags)) vetoes.push('trust:untrusted_span');
    if (hasUntrustedContext(input.context_to_load)) vetoes.push('trust:untrusted_context');

    // --- Step 3: verdict --------------------------------------------------------
    if (vetoes.length === 0) {
      return {
        action: 'apply',
        reason: 'silent_compile, low-risk, non-material ambiguity, owner-typed, trusted, all sentinels clear',
        vetoes: [],
      };
    }
    return passthrough(`held by ${vetoes.length} veto(es): ${vetoes.join(', ')}`, vetoes);
  } catch (err) {
    // Invariant 3: never throw. Any unexpected error is the safe direction.
    const message = err instanceof Error ? err.message : String(err);
    return passthrough(`gate_error: ${message}`, ['gate_error']);
  }
}
