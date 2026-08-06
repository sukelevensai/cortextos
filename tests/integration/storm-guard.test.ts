/**
 * tests/integration/storm-guard.test.ts — agent-to-agent runaway guards.
 *
 * Regression cover for the 2026-08-06 usage spike, where agent-to-agent messages went
 * 101 -> 792 in a day and turned ~2,200 baseline turns into ~20,000, burning roughly
 * 80% of a weekly plan cap overnight. Two agents ping-ponged corrections on `reply_to`
 * chains with nothing to damp them.
 *
 * The guards under test:
 *   1. thread depth cap  — stops the reply chain
 *   2. per-pair hourly rate limit — stops the obvious evasion, which is to drop
 *      `reply_to` and reopen the same argument as a fresh thread
 *
 * Both must hold, because either alone is trivially routed around.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { sendMessage, checkInbox } from '../../src/bus/message.js';
import {
  checkSendAllowed,
  resolveThreadPosition,
  StormGuardError,
  MAX_THREAD_DEPTH,
  MAX_PAIR_MSGS_PER_HOUR,
} from '../../src/bus/storm-guard.js';
import type { BusPaths, InboxMessage } from '../../src/types/index.js';

let testDir: string;
let ctxRoot: string;

function makePaths(agent: string): BusPaths {
  return {
    ctxRoot,
    inbox: join(ctxRoot, 'inbox', agent),
    inflight: join(ctxRoot, 'inflight', agent),
    processed: join(ctxRoot, 'processed', agent),
    logDir: join(ctxRoot, 'logs', agent),
    stateDir: join(ctxRoot, '.cortextOS', 'state', 'agents', agent),
    taskDir: join(ctxRoot, 'orgs', 'test-org', 'tasks'),
    approvalDir: join(ctxRoot, 'orgs', 'test-org', 'approvals'),
    analyticsDir: join(ctxRoot, 'orgs', 'test-org', 'analytics'),
  };
}

/** Read the single message sitting in an agent's inbox. */
function readInbox(agent: string): InboxMessage[] {
  const dir = join(ctxRoot, 'inbox', agent);
  let files: string[];
  try {
    files = readdirSync(dir).filter(f => f.endsWith('.json'));
  } catch {
    return [];
  }
  return files.map(f => JSON.parse(readFileSync(join(dir, f), 'utf-8')) as InboxMessage);
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'storm-guard-'));
  ctxRoot = join(testDir, '.cortextos', 'test');
  mkdirSync(ctxRoot, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('thread depth cap', () => {
  it('marks a thread opener as depth 0 and its own root', () => {
    const id = sendMessage(makePaths('alice'), 'alice', 'bob', 'normal', 'opening claim');
    const [msg] = readInbox('bob');
    expect(msg.depth).toBe(0);
    expect(msg.thread_root).toBe(id);
  });

  it('increments depth along a reply chain and preserves the root', () => {
    const alice = makePaths('alice');
    const bob = makePaths('bob');

    const rootId = sendMessage(alice, 'alice', 'bob', 'normal', 'claim');
    // bob must hold the parent to reply to it — that is how the real flow works.
    checkInbox(bob);
    const r1 = sendMessage(bob, 'bob', 'alice', 'normal', 'correction', rootId);
    checkInbox(alice);
    const r2 = sendMessage(alice, 'alice', 'bob', 'normal', 'counter-correction', r1);

    const onBob = readInbox('bob').find(m => m.id === r2)!;
    expect(onBob.depth).toBe(2);
    expect(onBob.thread_root).toBe(rootId);
  });

  it('refuses the reply that would exceed MAX_THREAD_DEPTH', () => {
    const alice = makePaths('alice');
    const bob = makePaths('bob');

    let last = sendMessage(alice, 'alice', 'bob', 'normal', 'claim');
    let senderIsBob = true;

    // Walk the chain up to the cap. Each hop the replier first takes delivery.
    for (let depth = 1; depth <= MAX_THREAD_DEPTH; depth++) {
      const from = senderIsBob ? bob : alice;
      const fromName = senderIsBob ? 'bob' : 'alice';
      const toName = senderIsBob ? 'alice' : 'bob';
      checkInbox(from);
      last = sendMessage(from, fromName, toName, 'normal', `round ${depth}`, last);
      senderIsBob = !senderIsBob;
    }

    // One more reply is depth MAX+1 and must be refused.
    const from = senderIsBob ? bob : alice;
    const fromName = senderIsBob ? 'bob' : 'alice';
    const toName = senderIsBob ? 'alice' : 'bob';
    checkInbox(from);
    expect(() =>
      sendMessage(from, fromName, toName, 'normal', 'one more thing', last),
    ).toThrow(StormGuardError);
  });

  it('tracks depth when an agent replies to a message it SENT, not received', () => {
    // Regression: resolveThreadPosition originally searched only the sender's dirs, so
    // quoting your own msg_id found nothing, failed open, and reset depth to 0 on every
    // hop — the cap became decoration. Only surfaced by driving the built CLI.
    const alice = makePaths('alice');
    let last = sendMessage(alice, 'alice', 'bob', 'normal', 'opening claim');
    for (let d = 1; d <= MAX_THREAD_DEPTH; d++) {
      last = sendMessage(alice, 'alice', 'bob', 'normal', `round ${d}`, last);
    }
    expect(() => sendMessage(alice, 'alice', 'bob', 'normal', 'one more', last)).toThrow(
      StormGuardError,
    );
  });

  it('fails OPEN when the parent cannot be found', () => {
    // A pre-guard message, or one whose parent was never delivered here. Blocking would
    // strand legitimate replies to older threads, so this must be allowed at depth 0.
    const verdict = checkSendAllowed(makePaths('alice'), 'alice', 'bob', 'no-such-parent-id');
    expect(verdict.allowed).toBe(true);
    expect(verdict.depth).toBe(0);
    expect(resolveThreadPosition(makePaths('alice'), 'no-such-parent-id')).toBeNull();
  });
});

describe('per-pair hourly rate limit', () => {
  it('refuses once the pair cap is reached, without any reply_to at all', () => {
    // This is the new-thread evasion: drop reply_to, reopen the same argument. The
    // depth cap cannot see it; the pair limit must.
    const alice = makePaths('alice');
    for (let i = 0; i < MAX_PAIR_MSGS_PER_HOUR; i++) {
      sendMessage(alice, 'alice', 'bob', 'normal', `fresh thread ${i}`);
    }
    expect(() => sendMessage(alice, 'alice', 'bob', 'normal', 'one too many')).toThrow(
      StormGuardError,
    );
  });

  it('does not consume budget on a refused send', () => {
    const alice = makePaths('alice');
    for (let i = 0; i < MAX_PAIR_MSGS_PER_HOUR; i++) {
      sendMessage(alice, 'alice', 'bob', 'normal', `msg ${i}`);
    }
    // Several refusals must not push the counter further; the cap is a ceiling, not a
    // ratchet that punishes retries.
    for (let i = 0; i < 3; i++) {
      expect(() => sendMessage(alice, 'alice', 'bob', 'normal', 'nope')).toThrow();
    }
    expect(readInbox('bob').length).toBe(MAX_PAIR_MSGS_PER_HOUR);
  });

  it('scopes the cap per ordered pair, not globally', () => {
    const alice = makePaths('alice');
    for (let i = 0; i < MAX_PAIR_MSGS_PER_HOUR; i++) {
      sendMessage(alice, 'alice', 'bob', 'normal', `msg ${i}`);
    }
    // alice -> bob is exhausted, but alice -> carol is a different pair and must work.
    expect(() => sendMessage(alice, 'alice', 'carol', 'normal', 'unrelated')).not.toThrow();
  });
});

describe('exemptions and flags', () => {
  it('exempts the system sender so approval notifications cannot be blocked', () => {
    // bus/approval.ts updateApproval notifies from `system`. An agent blocked on an
    // approval it already received is a deadlock, not a saving.
    const sys = makePaths('system');
    for (let i = 0; i < MAX_PAIR_MSGS_PER_HOUR + 5; i++) {
      expect(() => sendMessage(sys, 'system', 'bob', 'urgent', `approval ${i}`)).not.toThrow();
    }
  });

  it('persists no_reply so the injector can suppress the reply footer', () => {
    const id = sendMessage(makePaths('alice'), 'alice', 'bob', 'normal', 'FYI only', undefined, {
      noReply: true,
    });
    const msg = readInbox('bob').find(m => m.id === id)!;
    expect(msg.no_reply).toBe(true);
  });

  it('leaves no_reply absent by default so existing senders are unaffected', () => {
    const id = sendMessage(makePaths('alice'), 'alice', 'bob', 'normal', 'normal traffic');
    const msg = readInbox('bob').find(m => m.id === id)!;
    expect(msg.no_reply).toBeUndefined();
  });
});
