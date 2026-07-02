import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/pty/agent-pty.js', () => ({
  AgentPTY: function AgentPTY() {
    return {
      spawn: vi.fn().mockResolvedValue(undefined),
      kill: vi.fn(),
      write: vi.fn(),
      getPid: vi.fn().mockReturnValue(12345),
      isAlive: vi.fn().mockReturnValue(true),
      onExit: vi.fn(),
    };
  },
}));

vi.mock('../../../src/pty/inject.js', () => ({
  injectMessage: vi.fn(),
  MessageDedup: class { isDuplicate() { return false; } },
}));

vi.mock('../../../src/utils/atomic.js', () => ({
  ensureDir: vi.fn(),
  atomicWriteSync: vi.fn(),
}));

vi.mock('../../../src/utils/env.js', () => ({
  writeCortextosEnv: vi.fn(),
  resolveEnv: vi.fn().mockReturnValue({ instanceId: 'test', ctxRoot: '/tmp/test' }),
}));

vi.mock('../../../src/bus/reminders.js', () => ({
  getOverdueReminders: vi.fn().mockReturnValue([]),
}));

vi.mock('../../../src/utils/paths.js', () => ({
  resolvePaths: vi.fn().mockReturnValue({ stateDir: '/tmp/test-ctx/state/alice' }),
}));

const fsMocks = {
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  appendFileSync: vi.fn(),
  statSync: vi.fn(),
};

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    mkdirSync: vi.fn(),
    get existsSync() { return fsMocks.existsSync; },
    get readFileSync() { return fsMocks.readFileSync; },
    get writeFileSync() { return fsMocks.writeFileSync; },
    get appendFileSync() { return fsMocks.appendFileSync; },
    get statSync() { return fsMocks.statSync; },
  };
});

const { AgentProcess } = await import('../../../src/daemon/agent-process.js');
import { atomicWriteSync } from '../../../src/utils/atomic.js';

const mockEnv = {
  instanceId: 'test',
  ctxRoot: '/tmp/test-ctx',
  frameworkRoot: '/tmp/fw',
  agentName: 'alice',
  agentDir: '/tmp/fw/orgs/acme/agents/alice',
  org: 'acme',
  projectRoot: '/tmp/fw',
};

const TODAY = '2026-07-02';

function makeAgent(config: Record<string, unknown> = {}): any {
  const ap = new AgentProcess('alice', mockEnv as any, config as any) as any;
  ap.log = vi.fn();
  return ap;
}

function ledger(content: string): void {
  fsMocks.existsSync.mockReturnValue(true);
  fsMocks.readFileSync.mockReturnValue(content);
}

describe('AgentProcess crash-count ledger (GAP-0156)', () => {
  beforeEach(() => {
    fsMocks.existsSync.mockReset().mockReturnValue(false);
    fsMocks.readFileSync.mockReset();
    fsMocks.writeFileSync.mockReset();
    vi.mocked(atomicWriteSync).mockReset();
  });

  it('valid same-day ledger increments the count and persists atomically', () => {
    const ap = makeAgent();
    ledger(`${TODAY}:4`);
    ap.resetCrashCountIfNewDay(TODAY);
    expect(ap.crashCount).toBe(5);
    expect(atomicWriteSync).toHaveBeenCalledWith(expect.stringContaining('.crash_count_today'), `${TODAY}:5`);
    expect(fsMocks.writeFileSync).not.toHaveBeenCalled();
  });

  it('valid other-day ledger resets the count to 1', () => {
    const ap = makeAgent();
    ledger('2026-07-01:7');
    ap.resetCrashCountIfNewDay(TODAY);
    expect(ap.crashCount).toBe(1);
  });

  it('missing ledger keeps the in-memory count', () => {
    const ap = makeAgent();
    ap.crashCount = 3;
    ap.resetCrashCountIfNewDay(TODAY);
    expect(ap.crashCount).toBe(3);
    expect(atomicWriteSync).toHaveBeenCalledWith(expect.any(String), `${TODAY}:3`);
  });

  it('torn write "today:" fails CLOSED at one-below-cap, not NaN', () => {
    const ap = makeAgent();
    ledger(`${TODAY}:`);
    ap.resetCrashCountIfNewDay(TODAY);
    expect(ap.crashCount).toBe(9);
    expect(Number.isFinite(ap.crashCount)).toBe(true);
    expect(ap.log).toHaveBeenCalledWith(expect.stringContaining('failing CLOSED'));
  });

  it('NaN-poisoned ledger "today:NaN" fails CLOSED instead of propagating NaN', () => {
    const ap = makeAgent();
    ledger(`${TODAY}:NaN`);
    ap.resetCrashCountIfNewDay(TODAY);
    expect(ap.crashCount).toBe(9);
    expect(atomicWriteSync).toHaveBeenCalledWith(expect.any(String), `${TODAY}:9`);
  });

  it('garbage ledger without a date fails CLOSED', () => {
    const ap = makeAgent();
    ledger('garbage-no-colon');
    ap.resetCrashCountIfNewDay(TODAY);
    expect(ap.crashCount).toBe(9);
    expect(ap.log).toHaveBeenCalledWith(expect.stringContaining('failing CLOSED'));
  });

  it('fail-CLOSED respects a custom max_crashes_per_day', () => {
    const ap = makeAgent({ max_crashes_per_day: 3 });
    ledger(`${TODAY}:`);
    ap.resetCrashCountIfNewDay(TODAY);
    expect(ap.crashCount).toBe(2);
  });

  it('fail-CLOSED clamps to 1 when max_crashes_per_day is 1', () => {
    const ap = makeAgent({ max_crashes_per_day: 1 });
    ledger(`${TODAY}:`);
    ap.resetCrashCountIfNewDay(TODAY);
    expect(ap.crashCount).toBe(1);
  });

  it('non-numeric max_crashes_per_day in config is ignored (default 10 kept)', () => {
    const bad = makeAgent({ max_crashes_per_day: 'ten' });
    expect(bad.maxCrashesPerDay).toBe(10);
    const nan = makeAgent({ max_crashes_per_day: NaN });
    expect(nan.maxCrashesPerDay).toBe(10);
    const good = makeAgent({ max_crashes_per_day: 5 });
    expect(good.maxCrashesPerDay).toBe(5);
  });
});
