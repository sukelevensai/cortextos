/**
 * Prompt-Compiler — Compiled-Task types (schema_version "phase0.v1").
 *
 * Mirrors the org compiled-task JSON schema
 * (orgs/.../promptcompiler-phase0/schema/compiled-task.schema.json), but only the
 * fields the framework apply-gate reads to make its apply | passthrough decision.
 *
 * The org-specific COMPILER that PRODUCES these objects lives in the (gitignored)
 * org workspace. This module is GENERIC FRAMEWORK logic: no org secrets, PII, or
 * strategy. Safe for the public fork (James-upstream candidate).
 */

export type RiskClass = 'low' | 'medium' | 'high' | 'critical';

export type Materiality = 'none' | 'low' | 'medium' | 'high';

export type Mode =
  | 'silent_compile'
  | 'notify_assumption'
  | 'confirm_required'
  | 'ask_questions'
  | 'press_me'
  | 'approval_gate'
  | 'reject';

export type InvocationOrigin =
  | 'user_typed'
  | 'compiler_routed'
  | 'non_owner_typed'
  | 'system_cron'
  | 'agent_message';

export type Trust = 'trusted' | 'untrusted';

export interface PushbackState {
  fired: boolean;
  matching_rules: string[];
  risk_floor: RiskClass;
}

export interface SlashCommandExemption {
  active: boolean;
  command_at_head: boolean;
  authorized_sender: boolean;
}

export interface MaxOneInterruption {
  applies: boolean;
  merged_surface_count: number;
}

export interface SentinelState {
  pushback_raw: PushbackState;
  pushback_compiled: PushbackState;
  slash_command_exemption: SlashCommandExemption;
  gateway_killed: boolean;
  compiler_killed: boolean;
  review_status_fresh: boolean;
  max_one_interruption: MaxOneInterruption;
}

export interface SenderAuth {
  profile_owner: boolean;
  command_authorized: boolean;
  profile_scope: string;
}

export interface ContextRef {
  ref: string;
  kind: 'file' | 'profile' | 'memory' | 'task' | 'message' | 'policy' | 'none';
  scope: string;
  trust: Trust;
}

export interface TrustTag {
  span_id: string;
  trust: Trust;
  // Additional schema fields (source, set_by, reason, verbatim, ...) exist but are
  // not read by the apply-gate.
}

export interface AmbiguityMap {
  materiality: Materiality;
  // missing_slots / candidate_interpretations / evpi_operands exist but are not
  // read by the apply-gate.
}

export interface OutputContract {
  artifact: string;
  format: string;
  destination: string;
  review_status: 'known_reviewed' | 'known_unreviewed' | 'unknown';
  deterministically_bound: boolean;
}

/**
 * The fields of a compiled task the apply-gate depends on. The full schema has 22
 * required top-level keys (see REQUIRED_TOP_KEYS in apply-gate.ts); the runtime gate
 * validates all of them are present, but only the typed fields below are read for
 * the decision.
 */
export interface CompiledTask {
  schema_version: string;
  mode: Mode;
  risk_class: RiskClass;
  ambiguity_map: AmbiguityMap;
  sentinel_state: SentinelState;
  sender_auth: SenderAuth;
  invocation_origin: InvocationOrigin;
  context_to_load: ContextRef[];
  trust_tags: TrustTag[];
  output_contract: OutputContract;
}

export type ApplyAction = 'apply' | 'passthrough';

/**
 * The gate's verdict. `action: 'apply'` means the compiled prompt is safe to
 * auto-apply (silent execution of low-risk reversible work). `action: 'passthrough'`
 * means the ORIGINAL behavior must run unchanged (human-routed / compiler bypassed).
 *
 * `vetoes` lists every condition that forced passthrough (empty when applied). It is
 * for audit/observability — the gate collects ALL applicable vetoes, never
 * short-circuits, so a single decision is fully explainable.
 */
export interface ApplyDecision {
  action: ApplyAction;
  reason: string;
  vetoes: string[];
}
