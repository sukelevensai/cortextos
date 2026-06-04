/**
 * tests/unit/hooks/planmode-resolve.test.ts
 *
 * Unit tests for the GAP-0083 plan-source resolver (extracted so it is testable
 * without the hook's main() stack). Covers: inline-first binding, the camelCase
 * planFilePath fix + a regression guard that the OLD plan_file/planPath keys do
 * NOT bind, the mtime fallback (newest .md) with its 24h age bound, the F3
 * named-plan-missing case (no silent substitution), and provenance tagging.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolve, join } from 'path';

const fsMocks = vi.hoisted(() => ({
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
  statSync: vi.fn(),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: (...a: unknown[]) => fsMocks.existsSync(...a),
    readdirSync: (...a: unknown[]) => fsMocks.readdirSync(...a),
    statSync: (...a: unknown[]) => fsMocks.statSync(...a),
  };
});

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => '/home/test' };
});

vi.mock('../../../src/utils/strip-bom.js', () => ({
  readFileTextStripped: (p: string) => `CONTENT::${p}`,
}));

import {
  resolvePlanSource,
  findMostRecentPlan,
  MTIME_FALLBACK_MAX_AGE_MS,
} from '../../../src/hooks/planmode-resolve.js';

const NOW = 1_700_000_000_000;
const PLANS_DIR = join('/home/test', '.claude', 'plans');

beforeEach(() => {
  fsMocks.existsSync.mockReset();
  fsMocks.readdirSync.mockReset();
  fsMocks.statSync.mockReset();
});

describe('resolvePlanSource (GAP-0083)', () => {
  it('binds inline plan FIRST, ahead of any planFilePath/file', () => {
    const plan = resolvePlanSource(
      { tool_name: 'ExitPlanMode' },
      { plan: '  the inline plan  ', planFilePath: '/some/explicit.md' },
      NOW,
    );
    expect(plan.source).toBe('inline');
    expect(plan.content).toBe('the inline plan');
    // existsSync must not even be consulted — inline short-circuits
    expect(fsMocks.existsSync).not.toHaveBeenCalled();
  });

  it('binds the explicit planFilePath (camelCase) when present and the file exists', () => {
    fsMocks.existsSync.mockReturnValue(true);
    const plan = resolvePlanSource({}, { planFilePath: '/p/plan.md' }, NOW);
    expect(plan.source).toBe('file');
    if (plan.source === 'file') {
      expect(plan.provenance).toBe('explicit');
      expect(plan.path).toBe(resolve('/p/plan.md'));
      expect(plan.content).toContain('CONTENT::');
    }
  });

  it('REGRESSION GUARD: the old snake_case plan_file / planPath keys do NOT bind', () => {
    // No plans dir, so the mtime fallback yields nothing -> must be missing.
    fsMocks.existsSync.mockReturnValue(false);
    const plan = resolvePlanSource(
      { tool_name: 'ExitPlanMode' },
      { plan_file: '/old/a.md', planPath: '/old/b.md' },
      NOW,
    );
    expect(plan.source).toBe('missing');
    if (plan.source === 'missing') expect(plan.reason).toBe('no_plan_anywhere');
  });

  it('F3: planFilePath given but the file is GONE -> missing/named_plan_file_missing (no substitution)', () => {
    fsMocks.existsSync.mockReturnValue(false); // the named file does not exist
    const plan = resolvePlanSource({}, { planFilePath: '/p/vanished.md' }, NOW);
    expect(plan.source).toBe('missing');
    if (plan.source === 'missing') {
      expect(plan.reason).toBe('named_plan_file_missing');
      expect(plan.path).toBe(resolve('/p/vanished.md'));
    }
    // It must NOT have scanned the plans dir to substitute a different plan
    expect(fsMocks.readdirSync).not.toHaveBeenCalled();
  });

  it('mtime fallback selects the NEWEST .md and tags provenance mtime_fallback', () => {
    fsMocks.existsSync.mockReturnValue(true); // plans dir exists
    fsMocks.readdirSync.mockReturnValue(['old.md', 'newest.md', 'notes.txt']);
    fsMocks.statSync.mockImplementation((p: string) => ({
      mtimeMs: p.endsWith('newest.md') ? NOW - 1_000 : NOW - 5_000,
    }));
    const plan = resolvePlanSource({ tool_name: 'ExitPlanMode' }, {}, NOW);
    expect(plan.source).toBe('file');
    if (plan.source === 'file') {
      expect(plan.provenance).toBe('mtime_fallback');
      expect(plan.path).toBe(join(PLANS_DIR, 'newest.md'));
    }
  });

  it('F2: a stale newest plan (>24h old) is rejected -> missing/no_plan_anywhere', () => {
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readdirSync.mockReturnValue(['stale.md']);
    fsMocks.statSync.mockReturnValue({ mtimeMs: NOW - (MTIME_FALLBACK_MAX_AGE_MS + 60_000) });
    const plan = resolvePlanSource({ tool_name: 'ExitPlanMode' }, {}, NOW);
    expect(plan.source).toBe('missing');
    if (plan.source === 'missing') expect(plan.reason).toBe('no_plan_anywhere');
  });

  it('nothing bindable -> missing/no_plan_anywhere', () => {
    fsMocks.existsSync.mockReturnValue(false);
    const plan = resolvePlanSource({ tool_name: 'ExitPlanMode' }, {}, NOW);
    expect(plan.source).toBe('missing');
    if (plan.source === 'missing') expect(plan.reason).toBe('no_plan_anywhere');
  });
});

describe('findMostRecentPlan (GAP-0083 F2)', () => {
  it('returns null when the plans dir does not exist', () => {
    fsMocks.existsSync.mockReturnValue(false);
    expect(findMostRecentPlan(NOW)).toBeNull();
  });

  it('skips non-.md and unreadable files, returns the newest readable .md within age', () => {
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readdirSync.mockReturnValue(['broken.md', 'a.md', 'b.md', 'readme.txt']);
    fsMocks.statSync.mockImplementation((p: string) => {
      if (p.endsWith('broken.md')) throw new Error('EACCES');
      if (p.endsWith('a.md')) return { mtimeMs: NOW - 100 }; // newest readable
      return { mtimeMs: NOW - 200 };
    });
    expect(findMostRecentPlan(NOW)).toBe(join(PLANS_DIR, 'a.md'));
  });

  it('returns null when the newest file is older than the age bound', () => {
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readdirSync.mockReturnValue(['x.md']);
    fsMocks.statSync.mockReturnValue({ mtimeMs: NOW - (MTIME_FALLBACK_MAX_AGE_MS + 1) });
    expect(findMostRecentPlan(NOW)).toBeNull();
  });
});
