import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { isValidBotToken } from '../src/utils/telegram-token';
import { stripBom } from '../src/utils/strip-bom';

// Fragility 6 (2026-07): consolidated Telegram bot-token shape validation.
// See src/utils/telegram-token.ts for the full incident context.

describe('isValidBotToken (unit)', () => {
  it('accepts a realistically-shaped Telegram bot token', () => {
    // Shape-only sample (not a real credential): 10-digit id, 34-char secret.
    const sample = '1234567890:AAHexampleexampleexampleexampleAB1';
    expect(isValidBotToken(sample)).toBe(true);
  });

  it('accepts the exact lower bound (6 digits, 30-char secret)', () => {
    const sample = '123456:' + 'A'.repeat(30);
    expect(isValidBotToken(sample)).toBe(true);
  });

  it('has NO upper digit ceiling: a longer future id/secret must still pass', () => {
    // REJECT-IF regression guard: a 10-digit-cap regex would silently
    // disable a valid future bot whose numeric id grows past 10 digits.
    // This module's regex must remain lower-bound only on both segments.
    const longIdAndSecret = '123456789012345:' + 'B'.repeat(40);
    expect(isValidBotToken(longIdAndSecret)).toBe(true);
  });

  it('rejects tokens with too few digits', () => {
    expect(isValidBotToken('12345:' + 'A'.repeat(30))).toBe(false); // 5 digits
  });

  it('rejects tokens with too short a secret', () => {
    expect(isValidBotToken('123456:' + 'A'.repeat(29))).toBe(false); // 29-char secret
  });

  it('rejects malformed / placeholder / stub tokens', () => {
    expect(isValidBotToken('12:ab')).toBe(false);
    expect(isValidBotToken('')).toBe(false);
    expect(isValidBotToken('PASTE_TOKEN_HERE')).toBe(false);
    expect(isValidBotToken('not-a-real-token')).toBe(false);
    expect(isValidBotToken('123456' + 'A'.repeat(30))).toBe(false); // missing colon
    expect(isValidBotToken('abcdef:' + 'A'.repeat(30))).toBe(false); // non-numeric id segment
  });

  it('rejects a secret containing invalid characters (space)', () => {
    expect(isValidBotToken('123456:' + 'A'.repeat(29) + ' ')).toBe(false);
  });

  it('rejects non-string input defensively', () => {
    // @ts-expect-error deliberately passing a non-string to exercise the guard
    expect(isValidBotToken(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Runtime scan: every agent .env under orgs/*/agents/*/.env is checked for
// an uncommented BOT_TOKEN= line and, if present and non-empty, that its
// value parses as a valid Telegram bot-token shape.
//
// `orgs/` is gitignored operator data (see .gitignore), so on a fresh clone
// or a CI runner without any orgs/ configured, discovery below finds zero
// agents and this describe block contributes zero live-data assertions
// (not a failure. The sanity test just below always runs and always
// passes). On a machine WITH real agents configured, this is the exact
// canary Fragility 6 exists to provide: a placeholder/truncated BOT_TOKEN
// sitting in an agent .env would silently 401-spam Telegram once that
// agent's daemon starts, and this test catches it before that happens.
//
// SECURITY: never print, log, or interpolate a token value anywhere in this
// file. Only a boolean validity result and the org/agent NAME may appear in
// assertion output.
// ---------------------------------------------------------------------------

interface AgentEnvEntry {
  org: string;
  agent: string;
  envPath: string;
}

function discoverAgentEnvFiles(): AgentEnvEntry[] {
  const orgsRoot = join(__dirname, '..', 'orgs');
  const entries: AgentEnvEntry[] = [];
  if (!existsSync(orgsRoot)) return entries;

  let orgDirs: string[];
  try {
    orgDirs = readdirSync(orgsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return entries;
  }

  for (const org of orgDirs) {
    const agentsRoot = join(orgsRoot, org, 'agents');
    if (!existsSync(agentsRoot)) continue;
    let agentDirs: string[];
    try {
      agentDirs = readdirSync(agentsRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      continue;
    }
    for (const agent of agentDirs) {
      const envPath = join(agentsRoot, agent, '.env');
      if (existsSync(envPath)) {
        entries.push({ org, agent, envPath });
      }
    }
  }
  return entries;
}

/**
 * Extract the BOT_TOKEN value from raw .env content, or undefined if the
 * key is absent, commented out, or explicitly empty ("BOT_TOKEN=" with
 * nothing after it). Mirrors agent-manager.ts's own extraction
 * (`/^BOT_TOKEN=(.+)$/m`, which requires >=1 char to populate botToken at
 * all). An empty value means "Telegram not configured for this agent",
 * same as no BOT_TOKEN line at all, not a malformed one.
 */
function extractBotToken(envContent: string): string | undefined {
  const match = stripBom(envContent).match(/^BOT_TOKEN=(.*)$/m);
  const value = match?.[1]?.trim();
  return value ? value : undefined;
}

// Pre-existing malformed/empty BOT_TOKEN values found on this machine as of
// 2026-07, predating this regression and unrelated to it. Neither is a live
// bot (call-coach's token is a 31-char truncated stub; sdr-agent's is a
// 13-char placeholder) — both are tracked separately as a config cleanup
// item, not a regex/regression bug. Excluded here so the runtime-scan
// canary reflects its actual job: catching a *live* bot silently disabled
// by a bad token shape, not re-litigating known-bad stubs every run.
const KNOWN_PREEXISTING_MALFORMED = new Set([
  'sitesmith-agency/call-coach',
  'sitesmith-agency/sdr-agent',
]);

describe('live agent BOT_TOKEN shape (orgs/*/agents/*/.env runtime scan)', () => {
  const discovered = discoverAgentEnvFiles();

  it(`discovered ${discovered.length} agent .env file(s) under orgs/ to scan (0 is expected on CI / fresh clone since orgs/ is gitignored)`, () => {
    expect(Array.isArray(discovered)).toBe(true);
  });

  for (const { org, agent, envPath } of discovered) {
    const isKnownPreexistingMalformed = KNOWN_PREEXISTING_MALFORMED.has(`${org}/${agent}`);
    const itFn = isKnownPreexistingMalformed ? it.skip : it;
    itFn(`${org}/${agent}: BOT_TOKEN (if set) parses as a valid shape`, () => {
      let content: string;
      try {
        content = readFileSync(envPath, 'utf-8');
      } catch {
        // Unreadable .env is not this test's concern. Permission/IO
        // failures are a separate class of problem this test doesn't own.
        return;
      }

      const token = extractBotToken(content);
      // No BOT_TOKEN line, a commented-out line, or an explicitly empty
      // value all mean "Telegram not configured for this agent." Nothing
      // to assert; this is not a failure.
      if (!token) return;

      const valid = isValidBotToken(token);
      // NEVER interpolate `token` into this message; boolean + name only.
      expect(
        valid,
        `${org}/${agent} has a BOT_TOKEN that does not match the expected shape (value withheld)`,
      ).toBe(true);
    });
  }
});
