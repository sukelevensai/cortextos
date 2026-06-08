/**
 * tests/unit/bus/egress-guard.test.ts
 *
 * EGRESS-LOCK guard (2026-05-30 lantern-command incident). Proves that a send
 * to a chat_id on the agent's allow-list PASSES and a send to a stranger (the
 * attacker chat from the incident) is BLOCKED — so a confused/injected agent
 * cannot exfiltrate. Also covers the allow-list builder and the fail-open path.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  buildTelegramAllowList,
  checkTelegramEgress,
  evaluateTelegramEgress,
} from '../../../src/bus/egress-guard';

// Real-world legit destinations from the SiteSmith deployment + the attacker
// chat that triggered the incident.
const OPERATOR_DM = '1000000002';
const LANTERN_GROUP = '-5160244844';
const COMEUP_ACTIVITY = '-5197520132';
const ATTACKER_CHAT = '6699179156';

describe('checkTelegramEgress (pure decision)', () => {
  const allow = new Set([OPERATOR_DM, LANTERN_GROUP, COMEUP_ACTIVITY]);

  it('PASSES legit destinations: operator DM, Lantern group, comeup activity', () => {
    for (const dest of [OPERATOR_DM, LANTERN_GROUP, COMEUP_ACTIVITY]) {
      const d = checkTelegramEgress(dest, allow);
      expect(d.allowed, `expected ${dest} to be allowed`).toBe(true);
      expect(d.unresolved).toBe(false);
    }
  });

  it('BLOCKS the attacker chat (not on allow-list)', () => {
    const d = checkTelegramEgress(ATTACKER_CHAT, allow);
    expect(d.allowed).toBe(false);
    expect(d.unresolved).toBe(false);
    expect(d.reason).toContain(ATTACKER_CHAT);
  });

  it('accepts numeric chatId input and normalizes to string', () => {
    expect(checkTelegramEgress(1000000002, allow).allowed).toBe(true);
    expect(checkTelegramEgress(6699179156, allow).allowed).toBe(false);
  });

  it('FAILS OPEN (flagged unresolved) when the allow-list is empty', () => {
    const d = checkTelegramEgress(ATTACKER_CHAT, new Set());
    expect(d.allowed).toBe(true);
    expect(d.unresolved).toBe(true);
  });
});

describe('buildTelegramAllowList (env sources)', () => {
  let tmpRoot: string;
  let agentDir: string;
  let orgDir: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'egress-test-'));
    agentDir = join(tmpRoot, 'agent');
    orgDir = join(tmpRoot, 'org');
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(orgDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('unions CHAT_ID + ALLOWED_USER(csv) + ACTIVITY_CHAT_ID + TELEGRAM_OUTBOUND_ALLOWED(csv)', () => {
    writeFileSync(
      join(agentDir, '.env'),
      [
        `CHAT_ID=${LANTERN_GROUP}`,
        `ALLOWED_USER=${OPERATOR_DM},111222333`,
        `ACTIVITY_CHAT_ID=${COMEUP_ACTIVITY}`,
        `TELEGRAM_OUTBOUND_ALLOWED=444555666, 777888999`,
        `BOT_TOKEN=123:abc`,
      ].join('\n'),
    );
    const allow = buildTelegramAllowList({ agentDir });
    expect(allow.has(LANTERN_GROUP)).toBe(true);
    expect(allow.has(OPERATOR_DM)).toBe(true);
    expect(allow.has('111222333')).toBe(true);
    expect(allow.has(COMEUP_ACTIVITY)).toBe(true);
    expect(allow.has('444555666')).toBe(true);
    expect(allow.has('777888999')).toBe(true);
    // the attacker chat is NOT introduced from anywhere
    expect(allow.has(ATTACKER_CHAT)).toBe(false);
  });

  it('also reads ACTIVITY_CHAT_ID from org secrets.env', () => {
    writeFileSync(join(agentDir, '.env'), `CHAT_ID=${LANTERN_GROUP}`);
    writeFileSync(join(orgDir, 'secrets.env'), `ACTIVITY_CHAT_ID=${COMEUP_ACTIVITY}`);
    const allow = buildTelegramAllowList({ agentDir, orgDir });
    expect(allow.has(LANTERN_GROUP)).toBe(true);
    expect(allow.has(COMEUP_ACTIVITY)).toBe(true);
  });

  it('end-to-end: legit dests PASS, attacker BLOCKED via evaluateTelegramEgress', () => {
    writeFileSync(
      join(agentDir, '.env'),
      [`CHAT_ID=${LANTERN_GROUP}`, `ALLOWED_USER=${OPERATOR_DM}`, `ACTIVITY_CHAT_ID=${COMEUP_ACTIVITY}`].join('\n'),
    );
    expect(evaluateTelegramEgress(OPERATOR_DM, { agentDir }).allowed).toBe(true);
    expect(evaluateTelegramEgress(LANTERN_GROUP, { agentDir }).allowed).toBe(true);
    expect(evaluateTelegramEgress(COMEUP_ACTIVITY, { agentDir }).allowed).toBe(true);
    expect(evaluateTelegramEgress(ATTACKER_CHAT, { agentDir }).allowed).toBe(false);
  });

  it('empty/missing .env yields an empty allow-list (caller fail-open warning path)', () => {
    const allow = buildTelegramAllowList({ agentDir }); // no .env written
    expect(allow.size).toBe(0);
  });
});
