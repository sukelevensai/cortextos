import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { readTodaysCrashCount } from '../../../src/utils/crash-count';

describe('readTodaysCrashCount', () => {
  let ctxRoot: string;
  const agent = 'dev';
  const today = '2026-06-12';

  beforeEach(() => {
    ctxRoot = mkdtempSync(join(tmpdir(), 'crashcount-'));
  });

  afterEach(() => {
    rmSync(ctxRoot, { recursive: true, force: true });
  });

  function writeLedger(value: string): void {
    const dir = join(ctxRoot, 'logs', agent);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.crash_count_today'), value, 'utf-8');
  }

  it('returns 0 when the ledger file is missing', () => {
    expect(readTodaysCrashCount(ctxRoot, agent, today)).toBe(0);
  });

  it('returns the stored count when the stored date is today', () => {
    writeLedger(`${today}:7`);
    expect(readTodaysCrashCount(ctxRoot, agent, today)).toBe(7);
  });

  // The phantom scenario verbatim: smith's real ledger was stuck at
  // 2026-06-01:8 while the state/ counter fabricated 27 for today. A stale
  // stored date must read as 0, not as the old count.
  it('returns 0 when the stored date is a previous day (day-reset)', () => {
    writeLedger('2026-06-01:8');
    expect(readTodaysCrashCount(ctxRoot, agent, today)).toBe(0);
  });

  it('returns 0 for a garbled / non-numeric count', () => {
    writeLedger(`${today}:notanumber`);
    expect(readTodaysCrashCount(ctxRoot, agent, today)).toBe(0);
  });

  it('returns 0 for a negative count', () => {
    writeLedger(`${today}:-3`);
    expect(readTodaysCrashCount(ctxRoot, agent, today)).toBe(0);
  });

  it('tolerates surrounding whitespace in the ledger', () => {
    writeLedger(`  ${today}:3\n`);
    expect(readTodaysCrashCount(ctxRoot, agent, today)).toBe(3);
  });

  it('does not read a different agent ledger', () => {
    writeLedger(`${today}:5`);
    expect(readTodaysCrashCount(ctxRoot, 'other', today)).toBe(0);
  });
});
