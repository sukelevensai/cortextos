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
 *     UNEXPECTED, or wrong-typed field can never reach the apply branch — the task is
 *     FULLY shape-validated (every field's type/enum) before any decision logic runs.
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

/** All 22 top-level keys the compiled-task schema declares (additionalProperties:false). */
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

// Enum vocabularies (from the compiled-task schema).
const TASK_TYPES = new Set(['build', 'research', 'review', 'route', 'comms', 'approval', 'site_build', 'schema', 'redaction', 'unknown']);
const RISK_CLASSES = new Set(['low', 'medium', 'high', 'critical']);
const SIGNAL_STRENGTHS = new Set(['none', 'weak', 'medium', 'strong']);
const MATERIALITIES = new Set(['none', 'low', 'medium', 'high']);
const MODES = new Set(['silent_compile', 'notify_assumption', 'confirm_required', 'ask_questions', 'press_me', 'approval_gate', 'reject']);
const ORIGINS = new Set(['user_typed', 'compiler_routed', 'non_owner_typed', 'system_cron', 'agent_message']);
const REVIEW_STATUSES = new Set(['known_reviewed', 'known_unreviewed', 'unknown']);
const TRUSTS = new Set(['trusted', 'untrusted']);
const CONTEXT_KINDS = new Set(['file', 'profile', 'memory', 'task', 'message', 'policy', 'none']);

// --- primitive validators ----------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isString(value: unknown): value is string {
  return typeof value === 'string';
}
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}
function isEnum(value: unknown, set: ReadonlySet<string>): boolean {
  return typeof value === 'string' && set.has(value);
}
function isTextItem(value: unknown): boolean {
  return isPlainObject(value) && isNonEmptyString(value.text);
}

/** Render an unknown enum-ish value for a veto code without throwing. */
function describe(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

// --- composite shape validators ----------------------------------------------

/** A push-back state is valid only if fully well-formed (default-deny on malformed). */
function isValidPushback(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    isBoolean(value.fired) &&
    Array.isArray(value.matching_rules) &&
    isEnum(value.risk_floor, RISK_CLASSES)
  );
}

function isValidSlashExemption(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    isBoolean(value.active) &&
    isBoolean(value.command_at_head) &&
    isBoolean(value.authorized_sender)
  );
}

function isValidMaxOneInterruption(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    isBoolean(value.applies) &&
    Number.isInteger(value.merged_surface_count) &&
    (value.merged_surface_count as number) >= 0
  );
}

function isValidSentinelState(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    isValidPushback(value.pushback_raw) &&
    isValidPushback(value.pushback_compiled) &&
    isValidSlashExemption(value.slash_command_exemption) &&
    isBoolean(value.gateway_killed) &&
    isBoolean(value.compiler_killed) &&
    isBoolean(value.review_status_fresh) &&
    isValidMaxOneInterruption(value.max_one_interruption)
  );
}

function isValidSenderAuth(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    isBoolean(value.profile_owner) &&
    isBoolean(value.command_authorized) &&
    isString(value.profile_scope)
  );
}

function isValidOutputContract(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    isNonEmptyString(value.artifact) &&
    isNonEmptyString(value.format) &&
    isNonEmptyString(value.destination) &&
    isEnum(value.review_status, REVIEW_STATUSES) &&
    isBoolean(value.deterministically_bound)
  );
}

function isValidAmbiguityMap(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    isEnum(value.materiality, MATERIALITIES) &&
    Array.isArray(value.missing_slots) &&
    Array.isArray(value.candidate_interpretations) &&
    isPlainObject(value.evpi_operands)
  );
}

/** trust_tags: schema minItems 1; every span well-formed with a valid trust enum. */
function isValidTrustTags(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.every((tag) => isPlainObject(tag) && isNonEmptyString(tag.span_id) && isEnum(tag.trust, TRUSTS))
  );
}

/** context_to_load: may be empty, but every present ref must be well-formed. */
function isValidContextToLoad(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (ref) =>
        isPlainObject(ref) &&
        isNonEmptyString(ref.ref) &&
        isEnum(ref.kind, CONTEXT_KINDS) &&
        isString(ref.scope) &&
        isEnum(ref.trust, TRUSTS),
    )
  );
}

/**
 * Full shape validation of every required field. Returns a list of invalid-field
 * codes (empty => structurally valid). ANY entry forces passthrough (invariant 1).
 * Patterns (hash format, scope grammar) are validated only as strings to avoid
 * over-rejecting real compiler output on a format nuance — the decision-critical
 * enums, booleans, and object shapes are validated strictly.
 */
function structuralErrors(t: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const bad = (field: string): void => {
    errors.push(`structure:${field}`);
  };

  if (!isNonEmptyString(t.compiled_prompt)) bad('compiled_prompt');
  if (!isNonEmptyString(t.intent_summary)) bad('intent_summary');
  if (!isEnum(t.task_type, TASK_TYPES)) bad('task_type');
  if (!isNonEmptyString(t.target_agent)) bad('target_agent');
  if (!isValidContextToLoad(t.context_to_load)) bad('context_to_load');
  if (!Array.isArray(t.constraints) || !t.constraints.every(isTextItem)) bad('constraints');
  if (!Array.isArray(t.success_criteria) || t.success_criteria.length < 1 || !t.success_criteria.every(isTextItem)) {
    bad('success_criteria');
  }
  if (!isValidOutputContract(t.output_contract)) bad('output_contract');
  if (!isEnum(t.risk_class, RISK_CLASSES)) bad('risk_class');
  if (!isEnum(t.signal_strength, SIGNAL_STRENGTHS)) bad('signal_strength');
  if (!isValidAmbiguityMap(t.ambiguity_map)) bad('ambiguity_map');
  if (!isEnum(t.mode, MODES)) bad('mode');
  if (!Array.isArray(t.assumptions) || !t.assumptions.every(isTextItem)) bad('assumptions');
  if (!isNonEmptyString(t.source_message_hash)) bad('source_message_hash');
  if (!isNonEmptyString(t.sender_id)) bad('sender_id');
  if (!isValidSenderAuth(t.sender_auth)) bad('sender_auth');
  if (!Array.isArray(t.retrieval_scopes) || t.retrieval_scopes.length < 1 || !t.retrieval_scopes.every(isNonEmptyString)) {
    bad('retrieval_scopes');
  }
  if (!isEnum(t.invocation_origin, ORIGINS)) bad('invocation_origin');
  if (!isValidSentinelState(t.sentinel_state)) bad('sentinel_state');
  if (!Array.isArray(t.provenance_tags) || t.provenance_tags.length < 1 || !t.provenance_tags.every(isPlainObject)) {
    bad('provenance_tags');
  }
  if (!isValidTrustTags(t.trust_tags)) bad('trust_tags');

  return errors;
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
    // --- Step 1: top-level structure -------------------------------------------
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

    // --- Step 2: full field-shape validation (any failure -> passthrough) ------
    // Returning 'apply' vouches the WHOLE task is safe to execute (the executor
    // reads compiled_prompt etc.), so a malformed field anywhere must deny.
    const shapeErrors = structuralErrors(input);
    if (shapeErrors.length > 0) {
      return passthrough(`invalid_compiled_task: malformed fields [${shapeErrors.join(', ')}]`, shapeErrors);
    }

    // --- Step 3: collect ALL applicable vetoes (default-deny, no short-circuit) -
    // Every field below is now shape-validated; the reads are still defensive.
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
    const ambiguityMap = input.ambiguity_map as Record<string, unknown>;
    const materiality = ambiguityMap.materiality;
    if (materiality !== 'none' && materiality !== 'low') {
      vetoes.push(`materiality:${describe(materiality)}`);
    }

    // Sentinel vetoes (shape validated above).
    const sentinel = input.sentinel_state as Record<string, unknown>;
    if (sentinel.gateway_killed === true) vetoes.push('sentinel:gateway_killed');
    if (sentinel.compiler_killed === true) vetoes.push('sentinel:compiler_killed');
    if ((sentinel.pushback_raw as Record<string, unknown>).fired !== false) vetoes.push('sentinel:pushback_raw');
    // pushback_compiled is the most load-bearing veto: push-back is evaluated on the
    // EXPANDED prompt, so a short message that compiles into a >3-file edit must NOT auto-apply.
    if ((sentinel.pushback_compiled as Record<string, unknown>).fired !== false) {
      vetoes.push('sentinel:pushback_compiled');
    }
    // Stale classifier -> fail-closed-degrade to confirm-bias: do not auto-apply.
    if (sentinel.review_status_fresh !== true) vetoes.push('sentinel:review_status_stale');
    // Slash-command exemption is OWNER-ONLY (R52): an active exemption from a
    // non-authorized sender (e.g. a non-owner typing /deploy-leads) is a veto.
    const exemption = sentinel.slash_command_exemption as Record<string, unknown>;
    if (exemption.active === true && exemption.authorized_sender !== true) {
      vetoes.push('sentinel:slash_exemption_unauthorized');
    }

    // Sender auth: only the profile owner's own messages may auto-apply.
    if ((input.sender_auth as Record<string, unknown>).profile_owner !== true) {
      vetoes.push('sender:not_profile_owner');
    }

    // Invocation origin: only the owner's typed message or a compiler re-route.
    // No auto-apply on non-owner, cron, or agent-to-agent traffic (V1 scope).
    if (input.invocation_origin !== 'user_typed' && input.invocation_origin !== 'compiler_routed') {
      vetoes.push(`origin:${describe(input.invocation_origin)}`);
    }

    // Trust: untrusted spans/context are DATA-ONLY and may never drive a silent
    // auto-apply. Default-deny: anything not explicitly 'trusted' is a veto.
    const trustTags = input.trust_tags as Array<Record<string, unknown>>;
    if (trustTags.some((tag) => tag.trust !== 'trusted')) vetoes.push('trust:untrusted_span');
    const contextRefs = input.context_to_load as Array<Record<string, unknown>>;
    if (contextRefs.some((ref) => ref.trust !== 'trusted')) vetoes.push('trust:untrusted_context');

    // --- Step 4: verdict --------------------------------------------------------
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
