import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { BusPaths, InboxMessage } from '../types/index.js';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { withFileLockSync } from '../utils/lock.js';

/**
 * Storm guard — stops two agents from talking each other into a token fire.
 *
 * WHY THIS EXISTS
 * ---------------
 * On 2026-08-06 the fleet burned ~80% of a weekly plan cap overnight. Root cause was
 * not efficiency (per-turn cost actually FELL) but volume: agent-to-agent messages went
 * 101 -> 792 in a day while cron wake-ups fell 52%. One delivered message is not one
 * API call, it is a full agentic turn chain of roughly 19 turns, so 792 messages became
 * ~20,000 turns against a clean baseline of ~2,200/day.
 *
 * The messages were peer-review corrections ("CORRECTION to a claim we both carry",
 * "RETRACTION, SAME NIGHT") ping-ponging on reply_to chains with nothing to damp them.
 * It was the third occurrence: 07-30 and 08-03 were the same failure, smaller, and went
 * unnoticed because they did not cross a billing threshold.
 *
 * THREE GUARDS, because each alone is trivially evaded:
 *
 *   1. Thread depth cap. A reply chain may run MAX_THREAD_DEPTH deep, then further
 *      replies are refused. Closes the ping-pong.
 *   2. Per-ordered-pair hourly rate limit. Closes the obvious evasion of the depth
 *      cap, which is to drop reply_to and open a brand new thread about the same
 *      argument. Depth alone leaves that hole wide open.
 *   3. Fleet-wide hourly and daily ceilings. The pair cap bounds ONE conversation;
 *      with 13 agents there are 156 ordered pairs, so per-pair limits alone still
 *      permit far more fleet traffic than the storm ever produced. The daily ceiling
 *      is sized to catch the slow-burn precursors (07-30, 08-03) that no hourly
 *      threshold would have seen.
 *
 * DESIGN NOTES
 * ------------
 * Parent lookup reads the SENDER's own inbox/inflight/processed. The sender must have
 * received the parent to be replying to it, and `ackInbox` moves handled messages to
 * `processed/` where nothing prunes them. So the parent is already durably persisted
 * per-agent and a separate global thread ledger is unnecessary — a ledger would add a
 * rotation window in which a surviving thread silently resets to depth 0, which is
 * itself an evasion.
 *
 * FAIL OPEN on an unresolvable parent (pre-existing message, or genuinely missing).
 * Failing closed would block replies to legitimate older threads, and the pair rate
 * limit still bounds the damage.
 *
 * `system` is exempt. Approval notifications are sent from `system` (see
 * bus/approval.ts updateApproval) and an agent blocked on an approval it already
 * received is a deadlock, not a saving.
 */

/** Replies allowed on one thread before further replies are refused. */
export const MAX_THREAD_DEPTH = Number(process.env.CTX_MAX_THREAD_DEPTH ?? 4);

/** Messages allowed from one agent to one other agent per rolling hour. */
export const MAX_PAIR_MSGS_PER_HOUR = Number(process.env.CTX_MAX_PAIR_MSGS_PER_HOUR ?? 10);

/**
 * Fleet-wide ceilings. The per-pair cap does NOT bound total volume: 13 agents is 156
 * ordered pairs, so a 10/hour pair cap still permits a theoretical 1,560 messages/hour,
 * far above the ~42/hour the 2026-08-06 storm actually sustained. Without these the
 * guard bounds any single conversation but not the fleet.
 *
 * Hourly 60: quiet days ran under 5/hour, the storm ~42/hour sustained with higher
 * bursts. Daily 200: deliberately sized to catch the two PRECURSOR storms that nobody
 * noticed, 07-30 at 226 messages/day and 08-03 at 259, both of which sat under any
 * plausible hourly threshold. Quiet days were 71-101/day.
 */
export const MAX_FLEET_MSGS_PER_HOUR = Number(process.env.CTX_MAX_FLEET_MSGS_PER_HOUR ?? 60);
export const MAX_FLEET_MSGS_PER_DAY = Number(process.env.CTX_MAX_FLEET_MSGS_PER_DAY ?? 200);

/** Senders exempt from both guards. */
const EXEMPT_SENDERS = new Set(['system']);

const WINDOW_MS = 60 * 60 * 1000;
const DAY_MS = 24 * WINDOW_MS;

export interface ThreadPosition {
  threadRoot: string;
  depth: number;
}

export interface GuardVerdict extends ThreadPosition {
  allowed: boolean;
  /** Operator-facing explanation. Present only when `allowed` is false. */
  reason?: string;
}

function rateFilePath(ctxRoot: string): string {
  return join(ctxRoot, 'bus', 'pair-rate.json');
}

function guardDir(ctxRoot: string): string {
  return join(ctxRoot, 'bus');
}

/**
 * Locate the parent message in the sender's own message directories and return the
 * thread position a reply to it would occupy.
 *
 * Returns null when the parent cannot be found, which callers must treat as fail-open.
 */
export function resolveThreadPosition(
  paths: BusPaths,
  replyTo: string,
  to?: string,
): ThreadPosition | null {
  // Search the sender's own dirs first: the normal case is replying to something you
  // RECEIVED, which lands in your inflight then processed.
  //
  // Then search the RECIPIENT's dirs. An agent can also reply to a message it SENT
  // (quoting its own msg_id), and that message only ever existed in the recipient's
  // inbox. Without this second pass the lookup fails open and depth resets to 0 on
  // every hop, which turns the cap into decoration. Caught by running the built CLI
  // rather than the unit tests, which only exercised the receive-then-reply path.
  const dirs = [paths.inflight, paths.processed, paths.inbox];
  if (to) {
    dirs.push(
      join(paths.ctxRoot, 'inbox', to),
      join(paths.ctxRoot, 'inflight', to),
      join(paths.ctxRoot, 'processed', to),
    );
  }
  for (const dir of dirs) {
    let files: string[];
    try {
      files = readdirSync(dir).filter(f => f.endsWith('.json'));
    } catch {
      continue;
    }
    for (const file of files) {
      try {
        const msg = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as Partial<InboxMessage>;
        if (msg.id !== replyTo) continue;
        const parentDepth = typeof msg.depth === 'number' ? msg.depth : 0;
        return {
          threadRoot: msg.thread_root ?? msg.id ?? replyTo,
          depth: parentDepth + 1,
        };
      } catch {
        // Corrupt or partially written file — skip, do not fail the send.
      }
    }
  }
  return null;
}

interface RateCounts {
  /** Sends from this ordered pair in the last hour. */
  pair: number;
  /** Sends fleet-wide in the last hour. */
  fleetHour: number;
  /** Sends fleet-wide in the last 24 hours. */
  fleetDay: number;
}

/**
 * Read-modify-write the rolling counters under the repo's mkdir-lock convention.
 * `commit: false` counts without recording, so a refused send never consumes budget.
 *
 * Timestamps are retained for a full day because the daily fleet ceiling needs them;
 * the hourly figures are derived by filtering the same list.
 */
function bumpRates(ctxRoot: string, from: string, to: string, commit: boolean): RateCounts {
  const dir = guardDir(ctxRoot);
  ensureDir(dir);
  const file = rateFilePath(ctxRoot);
  const key = `${from}>${to}`;

  return withFileLockSync(dir, () => {
    let store: Record<string, number[]> = {};
    if (existsSync(file)) {
      try {
        store = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, number[]>;
      } catch {
        store = {};
      }
    }
    const now = Date.now();

    // Prune to the daily window up front so both the counts and the persisted file
    // work from the same pruned view.
    for (const k of Object.keys(store)) {
      store[k] = (store[k] ?? []).filter(ts => now - ts < DAY_MS);
      if (store[k].length === 0) delete store[k];
    }

    if (commit) {
      store[key] = [...(store[key] ?? []), now];
      atomicWriteSync(file, JSON.stringify(store));
    }

    const all = Object.values(store).flat();
    return {
      pair: (store[key] ?? []).filter(ts => now - ts < WINDOW_MS).length,
      fleetHour: all.filter(ts => now - ts < WINDOW_MS).length,
      fleetDay: all.length,
    };
  });
}

/**
 * Decide whether `from` may send to `to` right now, and where in its thread the
 * message would sit.
 *
 * Call this BEFORE any side effect that constitutes delivery — in particular before
 * writing an urgent-signal file. A guard that runs after the signal is written guards
 * nothing.
 */
export function checkSendAllowed(
  paths: BusPaths,
  from: string,
  to: string,
  replyTo?: string,
): GuardVerdict {
  if (EXEMPT_SENDERS.has(from)) {
    return { allowed: true, threadRoot: replyTo ?? '', depth: 0 };
  }

  const pos = replyTo ? resolveThreadPosition(paths, replyTo, to) : null;
  const threadRoot = pos?.threadRoot ?? '';
  const depth = pos?.depth ?? 0;

  if (pos && depth > MAX_THREAD_DEPTH) {
    return {
      allowed: false,
      threadRoot,
      depth,
      reason:
        `Thread ${threadRoot} is capped at ${MAX_THREAD_DEPTH} replies and this would be ` +
        `depth ${depth}. Do not restate the point in a new thread — that is the same ` +
        `loop wearing a hat. Either escalate to a human via ` +
        `\`cortextos bus request-approval\`, or drop it and move on.`,
    };
  }

  // FAIL OPEN on a counter-read failure, for the same reason recordSend fails open on a
  // counter-write failure. withFileLockSync THROWS on acquire timeout (default 5s) and
  // acquireLock rethrows any non-EEXIST fs error, so with the whole fleet contending on
  // this one mkdir-lock a lock timeout would otherwise crash a legitimate send — and the
  // caller in cli/bus.ts rethrows anything that is not a StormGuardError. Introducing a
  // new silent-loss path inside the fix for a silent-loss incident is not a trade worth
  // making: the depth cap above has already run, and all that is lost is rate accounting
  // for this one message.
  let rates: RateCounts;
  try {
    rates = bumpRates(paths.ctxRoot, from, to, false);
  } catch {
    return { allowed: true, threadRoot, depth };
  }

  if (rates.pair >= MAX_PAIR_MSGS_PER_HOUR) {
    return {
      allowed: false,
      threadRoot,
      depth,
      reason:
        `Rate limit: ${from} has already sent ${rates.pair} messages to ${to} in the ` +
        `last hour (cap ${MAX_PAIR_MSGS_PER_HOUR}). Batch what is left into one message ` +
        `next hour, or escalate to a human. This cap exists because an unbounded ` +
        `agent-to-agent exchange burned 80% of a weekly plan cap on 2026-08-06.`,
    };
  }

  // Fleet ceilings. A per-pair cap bounds one conversation; only these bound the fleet.
  if (rates.fleetHour >= MAX_FLEET_MSGS_PER_HOUR) {
    return {
      allowed: false,
      threadRoot,
      depth,
      reason:
        `Fleet rate limit: ${rates.fleetHour} agent-to-agent messages fleet-wide in the ` +
        `last hour (cap ${MAX_FLEET_MSGS_PER_HOUR}; quiet days ran under 5/hour). The ` +
        `fleet is in a message storm. Stop sending, finish the work in front of you, and ` +
        `let a human look at it.`,
    };
  }

  if (rates.fleetDay >= MAX_FLEET_MSGS_PER_DAY) {
    return {
      allowed: false,
      threadRoot,
      depth,
      reason:
        `Fleet daily limit: ${rates.fleetDay} agent-to-agent messages fleet-wide in 24h ` +
        `(cap ${MAX_FLEET_MSGS_PER_DAY}; quiet days ran 71-101). This ceiling is sized to ` +
        `catch the slow-burn storms that went unnoticed on 2026-07-30 and 2026-08-03. ` +
        `Escalate to a human rather than continuing.`,
    };
  }

  return { allowed: true, threadRoot, depth };
}

/** Record a send that actually happened. Call only after the message is written. */
export function recordSend(ctxRoot: string, from: string, to: string): void {
  if (EXEMPT_SENDERS.has(from)) return;
  try {
    bumpRates(ctxRoot, from, to, true);
  } catch {
    // Never fail a delivered send on a counter write.
  }
}

/** Error thrown by sendMessage when a guard refuses. Distinguishable from IO errors. */
export class StormGuardError extends Error {
  readonly verdict: GuardVerdict;
  constructor(verdict: GuardVerdict) {
    super(verdict.reason ?? 'refused by storm guard');
    this.name = 'StormGuardError';
    this.verdict = verdict;
  }
}
