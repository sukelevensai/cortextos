import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('child_process', () => ({ execFile: vi.fn() }));
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FastChecker } from '../../../src/daemon/fast-checker';
import type { BusPaths } from '../../../src/types';

function createMockAgent(name = 'test-agent') {
  return {
    name,
    isBootstrapped: vi.fn().mockReturnValue(true),
    injectMessage: vi.fn().mockReturnValue(true),
    write: vi.fn(),
  } as any;
}

function createTestPaths(testDir: string): BusPaths {
  const paths: BusPaths = {
    ctxRoot: testDir,
    inbox: join(testDir, 'inbox'),
    inflight: join(testDir, 'inflight'),
    processed: join(testDir, 'processed'),
    logDir: join(testDir, 'logs'),
    stateDir: join(testDir, 'state'),
    taskDir: join(testDir, 'tasks'),
    approvalDir: join(testDir, 'approvals'),
    analyticsDir: join(testDir, 'analytics'),
    heartbeatDir: join(testDir, 'heartbeats'),
  };
  for (const dir of Object.values(paths)) {
    if (dir !== testDir) {
      mkdirSync(dir, { recursive: true });
    }
  }
  return paths;
}

describe('FastChecker ctx-circuit persistence (GAP-0154)', () => {
  let testDir: string;
  let paths: BusPaths;
  let circuitFile: string;
  let log: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-ctxcircuit-test-'));
    paths = createTestPaths(testDir);
    circuitFile = join(paths.stateDir, '.ctx-circuit.json');
    log = vi.fn();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  function makeChecker(): any {
    return new FastChecker(createMockAgent(), paths, '/tmp/framework', { log }) as any;
  }

  it('missing state file loads healthy defaults', () => {
    const checker = makeChecker();
    expect(checker.ctxCircuitBrokenAt).toBeNull();
    expect(checker.ctxCircuitRestarts).toEqual([]);
  });

  it('valid state file restores restarts and brokenAt', () => {
    const brokenAt = Date.now() - 60_000;
    writeFileSync(circuitFile, JSON.stringify({ restarts: [1, 2, 3], brokenAt }), 'utf-8');
    const checker = makeChecker();
    expect(checker.ctxCircuitBrokenAt).toBe(brokenAt);
    expect(checker.ctxCircuitRestarts).toEqual([1, 2, 3]);
  });

  it('BOM-prefixed valid state file parses instead of tripping', () => {
    writeFileSync(circuitFile, '\uFEFF' + JSON.stringify({ restarts: [7], brokenAt: null }), 'utf-8');
    const checker = makeChecker();
    expect(checker.ctxCircuitBrokenAt).toBeNull();
    expect(checker.ctxCircuitRestarts).toEqual([7]);
  });

  it('corrupt (truncated) state file fails CLOSED: breaker tripped, loud log, file re-persisted valid', () => {
    writeFileSync(circuitFile, '{"restarts":[17', 'utf-8');
    const before = Date.now();
    const checker = makeChecker();

    expect(checker.ctxCircuitBrokenAt).toBeGreaterThanOrEqual(before);
    expect(checker.ctxCircuitRestarts).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('failing CLOSED'));

    // saveCtxCircuit replaced the corrupt file with valid tripped state,
    // so the next boot loads it normally instead of re-tripping forever.
    const reread = JSON.parse(readFileSync(circuitFile, 'utf-8'));
    expect(typeof reread.brokenAt).toBe('number');
    expect(reread.restarts).toEqual([]);
  });

  it('parseable-but-non-object state file (e.g. "5") fails CLOSED, not silently healthy', () => {
    writeFileSync(circuitFile, '5', 'utf-8');
    const checker = makeChecker();
    expect(checker.ctxCircuitBrokenAt).not.toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('failing CLOSED'));
  });

  it('bare-array state file fails CLOSED, not silently healthy', () => {
    writeFileSync(circuitFile, '[1,2,3]', 'utf-8');
    const checker = makeChecker();
    expect(checker.ctxCircuitBrokenAt).not.toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('failing CLOSED'));
  });

  it('saveCtxCircuit leaves no temp file and writes parseable JSON', () => {
    const checker = makeChecker();
    checker.ctxCircuitRestarts = [11, 22];
    checker.ctxCircuitBrokenAt = 33;
    checker.saveCtxCircuit();

    const reread = JSON.parse(readFileSync(circuitFile, 'utf-8'));
    expect(reread).toEqual({ restarts: [11, 22], brokenAt: 33 });
    const leftovers = readdirSync(paths.stateDir).filter(f => f.startsWith('.tmp.'));
    expect(leftovers).toEqual([]);
  });
});
