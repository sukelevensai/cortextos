---
name: press-me
description: Interactive plan-mode, grill-mode, and prompt-compilation walkthrough for complex asks before execution. Use when the user says "press me", "run me through the process", "grill me", "stress-test this", "poke holes in this", asks for a bigger plan, or needs a prompt engineered before plan-check, cross-check, meta-review, and execution.
---

# press-me

Use this when a bigger ask needs clean thinking before work starts.

Promise: no ask is too big, but big asks need a good attack plan. Guide the user from rough idea to clear brief, execution prompt, adversarial checks, and then execution. Do not implement until material ambiguity is resolved and required gates pass.

## Core Loop

1. **Grill me first.** This is the opening engine (the grill-me method, grafted from mattpocock/grill-me). State that this is planning, not execution -- no files, outreach, deploys, paid services, or irreversible actions until approval gates pass. Then interview the user relentlessly about every aspect of the ask, walking down each branch of the decision tree and resolving dependencies between decisions one by one. Ask ONE question at a time. Give your recommended answer with every question. If a question is answerable from the repo, Notion, Odoo, vault, logs, screenshots, code, or docs, research it instead of asking (research-first still holds). Keep grilling until you reach genuine shared understanding on every branch -- relentless, but one-at-a-time, never a 15-question dump.
2. **Rough idea.** Capture goal in plain language. If target is already clear, do not re-ask it.
3. **Grill map.** Build the decision tree the grill walks: branches, dependencies, unknowns, risks, and what must be resolved first.
4. **Simplest effective version.** Reduce scope to smallest version that still creates outcome.
5. **Prompt compiler.** Convert clarity into executor-ready prompt.
6. **Prompt check.** Check prompt for missing inputs, vague verbs, wrong workspace, unsafe assumptions, weak output format, missing verification, and forbidden touches.
7. **Plan-check.** Stress-test plan for missing data, sequencing, permissions, cost, state drift, and future breakage.
8. **Independent cross-check.** Use another model or reviewer when available. Iterate until no critical gaps remain.
9. **Meta-review.** Ask what failure class nearly happened, then check sibling systems for same pattern.
10. **Execute.** Do work only after gates pass. Report changed files/pages, verification, and remaining risks.

## Grill Me (Step 1 -- the opening pass)

The first move is a full grill, run as its own pass before scope-cutting or compiling anything (the grill-me method, grafted from mattpocock/grill-me):

> Interview the user relentlessly about every aspect of this plan until you reach a shared understanding. Walk down each branch of the decision tree, resolving dependencies between decisions one by one. For each question, provide your recommended answer.
>
> Ask the questions one at a time.
>
> If a question can be answered by exploring the codebase, repo, Notion, Odoo, vault, logs, screenshots, or docs, explore that instead of asking.

Run this relentlessly -- one question at a time, recommended answer on each -- until every branch of the Grill Map is resolved: answered, researched, assumed, deferred, or ruled immaterial. Do not soften it into a quick 2-question pass; the point is exhaustive shared understanding before any work.

**Depth gate (this is the overkill skill -- go super in-depth).** The grill is not done because you ran out of questions. Before you exit, run a completeness sweep: ask yourself what you did NOT ask that could change the approach, scope, cost, sequencing, or risk -- then ask those too. Probe second-order effects, edge cases, failure modes, and the "what would make this wrong" angle on each decision. Keep going through additional rounds until an honest sweep finds nothing material left unresolved. Err on the side of one more question, not one fewer. Only then move to scope reduction and the prompt compiler. The Grill Rules below govern how each question is posed.

## Grill Rules

- Be rigorous, not performative.
- Do not praise vague answers.
- Do not dump 15 questions.
- Do not ask compound questions.
- Do not ask for discoverable facts.
- Do not smuggle preferred solution into question wording.
- Surface contradictions directly.
- Challenge new domain terms against existing code identifiers, docs, and skill names before accepting them; if a term collides with or duplicates an existing concept, flag it instead of inventing a parallel vocabulary. (grafted from matpocock/grill-with-docs)
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

## PRD Mode (optional, for build-type asks)

When the ask is to BUILD something new (feature, site, automation, client workflow) rather than fix or research, optionally emit a structured PRD alongside (or instead of) the executor prompt. Keep it lean -- a decision record, not a doc-factory deliverable:

```text
PRD
- Problem: what is broken or missing, and for whom
- User stories: as a <role> I want <X> so that <Y>  (numbered, 3 to 7)
- Implementation decisions: chosen approach + the alternatives ruled out and why
- Testing decisions: what must be tested + the test SEAMS (identify boundaries BEFORE committing to the design)
- Out of scope: explicit non-goals
- Open questions / further notes
```

Save the PRD to the routed location (local file or the correct Notion page per the routing rules). Do NOT publish to any external tracker. (grafted from matpocock/to-prd)

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
