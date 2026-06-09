/**
 * Prompt-Compiler framework module (Conservative V1).
 *
 * Exposes the pure apply-gate and its types. NOT wired into any live path — see
 * apply-gate.ts header. Activation is a separate, higher-blast-radius gate.
 */

export { decideApply } from './apply-gate.js';
export type {
  ApplyAction,
  ApplyDecision,
  CompiledTask,
  Mode,
  RiskClass,
  Materiality,
  InvocationOrigin,
  Trust,
  SentinelState,
  PushbackState,
  SlashCommandExemption,
  SenderAuth,
  ContextRef,
  TrustTag,
  AmbiguityMap,
  OutputContract,
} from './types.js';
