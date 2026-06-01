---
name: press-me
description: Interactive plan-mode, grill-mode, and prompt-compilation walkthrough for complex asks before execution. Use when the user says "press me", "run me through the process", "grill me", "stress-test this", "poke holes in this", asks for a bigger plan, or needs a prompt engineered before plan-check, cross-check, meta-review, and execution.
---

# press-me

Use this when a bigger ask needs clean thinking before work starts.

Promise: no ask is too big, but big asks need a good attack plan. Guide the user from rough idea to clear brief, execution prompt, adversarial checks, and then execution. Do not implement until material ambiguity is resolved and required gates pass.

## Core Loop

1. **Plan mode.** State that this is planning, not execution. No files, outreach, deploys, paid services, or irreversible actions until approval gates pass.
2. **Rough idea.** Capture goal in plain language. If target is already clear, do not re-ask it.
3. **Research first.** Inspect available artifacts before asking questions. Never ask user for facts the repo, Notion, Odoo, vault, logs, screenshots, code, or docs can reveal.
4. **Grill map.** Build decision tree: branches, dependencies, unknowns, risks, and what must be resolved first.
5. **Ask only judgment calls.** Ask 1 to 3 bounded questions per round. Prefer 2 when independent. Use 1 when dependency order matters.
6. **Simplest effective version.** Reduce scope to smallest version that still creates outcome.
7. **Prompt compiler.** Convert clarity into executor-ready prompt.
8. **Prompt check.** Check prompt for missing inputs, vague verbs, wrong workspace, unsafe assumptions, weak output format, missing verification, and forbidden touches.
9. **Plan-check.** Stress-test plan for missing data, sequencing, permissions, cost, state drift, and future breakage.
10. **Independent cross-check.** Use another model or reviewer when available. Iterate until no critical gaps remain.
11. **Meta-review.** Ask what failure class nearly happened, then check sibling systems for same pattern.
12. **Execute.** Do work only after gates pass. Report changed files/pages, verification, and remaining risks.

## Grill Rules

- Be rigorous, not performative.
- Do not praise vague answers.
- Do not dump 15 questions.
- Do not ask compound questions.
- Do not ask for discoverable facts.
- Do not smuggle preferred solution into question wording.
- Surface contradictions directly.
- Convert soft words like "soon", "better", "cheap", "clean", "safe", or "simple" into dates, metrics, owners, scope limits, or explicit choices.
- Every material ambiguity must become answered, researched, assumed, deferred, or immaterial.

## Grill Map

When task is complex, show this before questions:

```text
Grill Map: [title]
Domain: [website | infra | Notion | Odoo | automation | outreach | research | other]

What I know:
- ...

Branches:
- [ ] Outcome
- [ ] Scope and non-goals
- [ ] Source of truth
- [ ] Workspaces and routing
- [ ] Dependencies
- [ ] Risks and failure modes
- [ ] Verification

Starting with: [branch] because [dependency reason]
```

## Snapshot

Maintain this internally. Show compact version when user needs orientation or every 5 to 8 exchanges.

```text
Snapshot
- Stage: Research | Grill | Define | Prompt | Check | Execute
- Problem statement:
- Users / stakeholders:
- Source of truth:
- Scope:
- Non-goals:
- Success criteria:
- Constraints:
- Facts:
- Decisions:
- Assumptions:
- Risks / edge cases:
- Deferred items:
- Open questions:
```

## Question Handling

Use bounded questions when possible:

- Stable `snake_case` id.
- Header 12 chars or fewer.
- One sentence question.
- 2 to 3 mutually exclusive options.
- Recommended option first, labeled `(Recommended)`.
- Re-ask vague answer with same id.

Ask follow-ups when:

- Answer expands scope.
- Answer introduces dependency.
- Answer reveals trade-off.
- Answer uses soft language.
- Root problem may be wrong.
- Verification or owner is unclear.
- Workspace, repo, Notion space, or client lane is unclear.

## Prompt Compiler

Turn final clarity into this executor-ready prompt:

```text
PROMPT COMPILER

<context>
What are we doing?
Why does it matter?
Who is output for?
What has already been decided?
What has already been ruled out?
</context>

<sources>
Required files, URLs, Notion pages, Odoo objects, repos, screenshots, or docs.
Mark each as required, optional, or forbidden.
</sources>

<task>
Exact work to perform.
Use clear verbs: audit, build, rewrite, compare, verify, publish, summarize.
</task>

<constraints>
Do not touch:
Must preserve:
Approval gates:
Security limits:
Workspace routing:
Budget or time limits:
</constraints>

<output>
Final format:
Audience:
Length:
Tone:
Tables, checklists, docs, or dashboards needed:
Where result should be saved:
</output>

<quality_bar>
Success means:
Failure means:
Required checks:
Edge cases:
How to verify:
</quality_bar>

<execution_rules>
Before editing, inspect source state.
Bind outputs to exact files, pages, IDs, or URLs.
Do not rely on newest/latest unless explicitly approved.
If info is missing, make safest explicit assumption or ask one focused question.
After execution, report changed files/pages and verification.
</execution_rules>
```

## Hard Gates

- Timeout is not approval.
- Plan approval must bind to actual plan file or inline plan text.
- If plan cannot be bound, stop and ask user to re-run plan mode.
- Outward-facing, paid, irreversible, shared-infra, repo-routing, or workspace-routing work needs explicit approval before execution.
- Do not write to Notion until correct workspace and page are verified.
- Do not store secrets in wiki docs.
- Every plan-mode run should be logged and audited so system learns from planning wins and misses.

## Closure

Before execution, output:

1. Final brief.
2. Locked decisions.
3. Assumptions carried forward.
4. Risks and deferred items.
5. Execution prompt.
6. Verification plan.

Then ask for approval if gate requires it.
