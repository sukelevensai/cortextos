import { describe, it, expect } from 'vitest';
import { decideApply } from '../src/promptcompiler/apply-gate.js';

/**
 * Prompt-Compiler apply-gate unit tests.
 *
 * LEAK GUARD: every fixture here is SYNTHETIC. The 69 real-Luke-message eval
 * fixtures NEVER enter tracked space — they are replayed only by a gitignored
 * workspace script for smith's verification.
 *
 * The base task below is a fully-valid, auto-apply-ELIGIBLE compiled task (all 21
 * required schema keys present, silent_compile, low risk, non-material ambiguity,
 * owner-typed, trusted, all sentinels clear). Each test clones it and flips ONE
 * field to assert the corresponding veto fires (default-deny), plus the structural
 * and fail-safe cases.
 */

const VALID_TASK = {
  schema_version: 'phase0.v1',
  compiled_prompt: 'Read the referenced brief and summarize the open questions.',
  intent_summary: 'summarize open questions from the brief',
  task_type: 'review',
  target_agent: 'analyst',
  context_to_load: [{ ref: 'brief.md', kind: 'file', scope: 'sitesmith-only', trust: 'trusted' }],
  constraints: [],
  success_criteria: [{ text: 'a concise summary of the open questions' }],
  output_contract: {
    artifact: 'summary',
    format: 'markdown',
    destination: 'reply',
    review_status: 'known_reviewed',
    deterministically_bound: true,
  },
  risk_class: 'low',
  signal_strength: 'strong',
  ambiguity_map: {
    materiality: 'none',
    missing_slots: [],
    candidate_interpretations: [],
    evpi_operands: {
      info_gain: 0,
      blast_radius: 'low',
      interruption_cost: 1,
      operand_source: 'deterministic_rule',
    },
  },
  mode: 'silent_compile',
  assumptions: [],
  source_message_hash: 'sha256:' + 'a'.repeat(64),
  sender_id: 'luke',
  sender_auth: { profile_owner: true, command_authorized: true, profile_scope: 'luke-global' },
  retrieval_scopes: ['luke-global'],
  invocation_origin: 'user_typed',
  sentinel_state: {
    pushback_raw: { fired: false, matching_rules: [], risk_floor: 'low' },
    pushback_compiled: { fired: false, matching_rules: [], risk_floor: 'low' },
    slash_command_exemption: { active: false, command_at_head: false, authorized_sender: false },
    gateway_killed: false,
    compiler_killed: false,
    review_status_fresh: true,
    max_one_interruption: { applies: false, merged_surface_count: 0 },
  },
  provenance_tags: [
    {
      field: 'mode',
      source: 'compiler_inferred',
      trust: 'trusted',
      scope: 'luke-global',
      set_by: 'compiler',
      evidence_ref: 'msg',
    },
  ],
  trust_tags: [{ span_id: 's1', trust: 'trusted' }],
};

/** Deep clone so each test mutates an independent copy. */
function validTask(): Record<string, any> {
  return structuredClone(VALID_TASK);
}

describe('decideApply — happy path', () => {
  it('auto-applies a fully-valid silent_compile low-risk owner-typed task', () => {
    const decision = decideApply(validTask());
    expect(decision.action).toBe('apply');
    expect(decision.vetoes).toEqual([]);
  });

  it('an active slash-command exemption from an AUTHORIZED sender does not veto', () => {
    const t = validTask();
    t.sentinel_state.slash_command_exemption = {
      active: true,
      command_at_head: true,
      authorized_sender: true,
    };
    expect(decideApply(t).action).toBe('apply');
  });

  it('compiler_routed origin is auto-apply-eligible', () => {
    const t = validTask();
    t.invocation_origin = 'compiler_routed';
    expect(decideApply(t).action).toBe('apply');
  });

  it('materiality "low" is still eligible', () => {
    const t = validTask();
    t.ambiguity_map.materiality = 'low';
    expect(decideApply(t).action).toBe('apply');
  });

  it('an empty context_to_load is not a veto', () => {
    const t = validTask();
    t.context_to_load = [];
    expect(decideApply(t).action).toBe('apply');
  });
});

describe('decideApply — mode vetoes (deliberate tightening: silent_compile ONLY)', () => {
  for (const mode of [
    'notify_assumption',
    'confirm_required',
    'ask_questions',
    'press_me',
    'approval_gate',
    'reject',
  ]) {
    it(`passes through mode="${mode}"`, () => {
      const t = validTask();
      t.mode = mode;
      const d = decideApply(t);
      expect(d.action).toBe('passthrough');
      expect(d.vetoes).toContain(`mode:${mode}`);
    });
  }
});

describe('decideApply — risk vetoes', () => {
  for (const risk of ['medium', 'high', 'critical']) {
    it(`passes through risk_class="${risk}"`, () => {
      const t = validTask();
      t.risk_class = risk;
      const d = decideApply(t);
      expect(d.action).toBe('passthrough');
      expect(d.vetoes).toContain(`risk_class:${risk}`);
    });
  }
});

describe('decideApply — ambiguity vetoes', () => {
  for (const m of ['medium', 'high']) {
    it(`passes through material ambiguity "${m}"`, () => {
      const t = validTask();
      t.ambiguity_map.materiality = m;
      const d = decideApply(t);
      expect(d.action).toBe('passthrough');
      expect(d.vetoes).toContain(`materiality:${m}`);
    });
  }
});

describe('decideApply — sentinel vetoes', () => {
  it('gateway_killed kill-switch -> passthrough', () => {
    const t = validTask();
    t.sentinel_state.gateway_killed = true;
    const d = decideApply(t);
    expect(d.action).toBe('passthrough');
    expect(d.vetoes).toContain('sentinel:gateway_killed');
  });

  it('compiler_killed kill-switch -> passthrough', () => {
    const t = validTask();
    t.sentinel_state.compiler_killed = true;
    const d = decideApply(t);
    expect(d.action).toBe('passthrough');
    expect(d.vetoes).toContain('sentinel:compiler_killed');
  });

  it('pushback_raw.fired -> passthrough', () => {
    const t = validTask();
    t.sentinel_state.pushback_raw.fired = true;
    const d = decideApply(t);
    expect(d.action).toBe('passthrough');
    expect(d.vetoes).toContain('sentinel:pushback_raw');
  });

  it('pushback_compiled.fired (push-back on the EXPANDED prompt) -> passthrough', () => {
    const t = validTask();
    t.sentinel_state.pushback_compiled.fired = true;
    const d = decideApply(t);
    expect(d.action).toBe('passthrough');
    expect(d.vetoes).toContain('sentinel:pushback_compiled');
  });

  it('a MISSING pushback_compiled is treated as fired (default-deny)', () => {
    const t = validTask();
    delete t.sentinel_state.pushback_compiled;
    const d = decideApply(t);
    expect(d.action).toBe('passthrough');
    expect(d.vetoes).toContain('sentinel:pushback_compiled');
  });

  it('a MALFORMED pushback_compiled is treated as fired (default-deny)', () => {
    const t = validTask();
    t.sentinel_state.pushback_compiled = 'nope';
    const d = decideApply(t);
    expect(d.action).toBe('passthrough');
    expect(d.vetoes).toContain('sentinel:pushback_compiled');
  });

  it('stale review_status (review_status_fresh=false) -> passthrough', () => {
    const t = validTask();
    t.sentinel_state.review_status_fresh = false;
    const d = decideApply(t);
    expect(d.action).toBe('passthrough');
    expect(d.vetoes).toContain('sentinel:review_status_stale');
  });

  it('active slash exemption from an UNAUTHORIZED sender (owner-only, R52) -> passthrough', () => {
    const t = validTask();
    t.sentinel_state.slash_command_exemption = {
      active: true,
      command_at_head: true,
      authorized_sender: false,
    };
    const d = decideApply(t);
    expect(d.action).toBe('passthrough');
    expect(d.vetoes).toContain('sentinel:slash_exemption_unauthorized');
  });

  it('a malformed sentinel_state -> passthrough', () => {
    const t = validTask();
    t.sentinel_state = null;
    const d = decideApply(t);
    expect(d.action).toBe('passthrough');
    expect(d.vetoes).toContain('sentinel:malformed');
  });
});

describe('decideApply — sender / origin vetoes', () => {
  it('non-owner sender -> passthrough', () => {
    const t = validTask();
    t.sender_auth.profile_owner = false;
    const d = decideApply(t);
    expect(d.action).toBe('passthrough');
    expect(d.vetoes).toContain('sender:not_profile_owner');
  });

  for (const origin of ['non_owner_typed', 'system_cron', 'agent_message']) {
    it(`origin "${origin}" -> passthrough`, () => {
      const t = validTask();
      t.invocation_origin = origin;
      const d = decideApply(t);
      expect(d.action).toBe('passthrough');
      expect(d.vetoes).toContain(`origin:${origin}`);
    });
  }
});

describe('decideApply — trust vetoes', () => {
  it('an untrusted trust_tag span -> passthrough', () => {
    const t = validTask();
    t.trust_tags = [{ span_id: 's1', trust: 'untrusted' }];
    const d = decideApply(t);
    expect(d.action).toBe('passthrough');
    expect(d.vetoes).toContain('trust:untrusted_span');
  });

  it('an untrusted loaded context ref -> passthrough', () => {
    const t = validTask();
    t.context_to_load = [{ ref: 'pasted-email', kind: 'message', scope: 'client-overlay', trust: 'untrusted' }];
    const d = decideApply(t);
    expect(d.action).toBe('passthrough');
    expect(d.vetoes).toContain('trust:untrusted_context');
  });

  it('a malformed trust_tags array -> passthrough', () => {
    const t = validTask();
    t.trust_tags = 'nope';
    const d = decideApply(t);
    expect(d.action).toBe('passthrough');
    expect(d.vetoes).toContain('trust:untrusted_span');
  });
});

describe('decideApply — structural validation (fail-safe)', () => {
  it('rejects a non-object', () => {
    expect(decideApply('a string').action).toBe('passthrough');
    expect(decideApply(42).action).toBe('passthrough');
    expect(decideApply(null).action).toBe('passthrough');
    expect(decideApply(undefined).action).toBe('passthrough');
    expect(decideApply([]).action).toBe('passthrough');
  });

  it('rejects an unexpected top-level key (additionalProperties:false)', () => {
    const t = validTask();
    t.injected_field = 'surprise';
    const d = decideApply(t);
    expect(d.action).toBe('passthrough');
    expect(d.vetoes).toContain('structure:extra_keys');
  });

  it('rejects a task missing a required key', () => {
    const t = validTask();
    delete t.risk_class;
    const d = decideApply(t);
    expect(d.action).toBe('passthrough');
    expect(d.vetoes).toContain('structure:missing_keys');
  });

  it('rejects an unsupported schema_version', () => {
    const t = validTask();
    t.schema_version = 'phase9.v2';
    const d = decideApply(t);
    expect(d.action).toBe('passthrough');
    expect(d.vetoes).toContain('structure:schema_version');
  });
});

describe('decideApply — never throws (fuzz)', () => {
  const garbage: unknown[] = [
    {},
    { mode: 'silent_compile' },
    { ...VALID_TASK, sentinel_state: 123 },
    { ...VALID_TASK, ambiguity_map: [] },
    { ...VALID_TASK, sender_auth: null },
    Object.create(null),
  ];
  for (const [i, g] of garbage.entries()) {
    it(`returns a passthrough decision for garbage input #${i}`, () => {
      const d = decideApply(g);
      expect(d.action).toBe('passthrough');
      expect(Array.isArray(d.vetoes)).toBe(true);
      expect(typeof d.reason).toBe('string');
    });
  }
});

describe('decideApply — auditability', () => {
  it('collects ALL applicable vetoes, not just the first', () => {
    const t = validTask();
    t.mode = 'approval_gate';
    t.risk_class = 'critical';
    t.sender_auth.profile_owner = false;
    const d = decideApply(t);
    expect(d.action).toBe('passthrough');
    expect(d.vetoes).toEqual(
      expect.arrayContaining(['mode:approval_gate', 'risk_class:critical', 'sender:not_profile_owner']),
    );
    expect(d.vetoes.length).toBeGreaterThanOrEqual(3);
  });
});
