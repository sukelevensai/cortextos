import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// node-pty is native; stub it so constructing AgentPTY never touches it.
vi.mock('node-pty', () => ({ spawn: vi.fn() }));

// existsSync=false → the local/*.md system-prompt block is skipped in buildClaudeArgs.
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn(),
    readdirSync: vi.fn().mockReturnValue([]),
  };
});

// buildClaudeArgs branches on platform: win32 hard-bypasses the permission
// system (`--permission-mode bypassPermissions` + Bash disallowed; the
// dangerously_skip_permissions config is a no-op there), while non-win32
// honors the config-driven skip flag. Pin the platform per describe block so
// the suite is deterministic regardless of the host OS.
let mockPlatform: string = process.platform;
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, platform: () => mockPlatform };
});

const { AgentPTY } = await import('../../../src/pty/agent-pty.js');

const mockEnv = {
  instanceId: 'test',
  ctxRoot: '/tmp/test-ctx',
  frameworkRoot: '/tmp/fw',
  agentName: 'alice',
  agentDir: '/tmp/fw/orgs/acme/agents/alice',
  org: 'acme',
  projectRoot: '/tmp/fw',
} as any;

function argsFor(config: any): string[] {
  const pty = new AgentPTY(mockEnv, config);
  return (pty as unknown as { buildClaudeArgs(m: 'fresh' | 'continue', p: string): string[] })
    .buildClaudeArgs('fresh', 'PROMPT');
}

describe('AgentPTY --dangerously-skip-permissions toggle (non-win32)', () => {
  beforeEach(() => { mockPlatform = 'linux'; });
  afterEach(() => { mockPlatform = process.platform; });

  it('includes the flag by default (back-compat: skip stays ON)', () => {
    expect(argsFor({})).toContain('--dangerously-skip-permissions');
  });

  it('includes the flag when dangerously_skip_permissions is explicitly true', () => {
    expect(argsFor({ dangerously_skip_permissions: true })).toContain('--dangerously-skip-permissions');
  });

  it('does NOT include the flag when dangerously_skip_permissions is false (permission gate engaged)', () => {
    expect(argsFor({ dangerously_skip_permissions: false })).not.toContain('--dangerously-skip-permissions');
  });

  it('includes the flag when dangerously_skip_permissions is explicitly undefined (treated as default)', () => {
    expect(argsFor({ dangerously_skip_permissions: undefined })).toContain('--dangerously-skip-permissions');
  });

  it('fails safe (keeps the flag) and warns on a non-boolean value, e.g. the string "false"', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // A typo'd string must NOT silently disable the skip flag.
      expect(argsFor({ dangerously_skip_permissions: 'false' as any })).toContain('--dangerously-skip-permissions');
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('AgentPTY permission args on win32 (hard bypass, config is a no-op)', () => {
  beforeEach(() => { mockPlatform = 'win32'; });
  afterEach(() => { mockPlatform = process.platform; });

  it('uses --permission-mode bypassPermissions and disallows Bash', () => {
    const args = argsFor({});
    expect(args).toContain('--permission-mode');
    expect(args).toContain('bypassPermissions');
    expect(args).toContain('--disallowedTools');
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  it('dangerously_skip_permissions=false does NOT engage the gate on win32', () => {
    const args = argsFor({ dangerously_skip_permissions: false });
    expect(args).toContain('--permission-mode');
    expect(args).not.toContain('--dangerously-skip-permissions');
  });
});
