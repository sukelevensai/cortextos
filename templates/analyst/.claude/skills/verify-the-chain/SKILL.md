---
name: verify-the-chain
description: "You are about to claim a bug is fixed/shipped/resolved/merged/done, or about to tell the user 'source has the fix' / 'the fix is in' / 'just need to restart', or about to escalate a 'running system isn't using the latest' diagnosis, or about to write a status report or PR summary. Stop. Produce the 6-step verification chain (working tree → committed → merged → built → running → behavioral) BEFORE the claim. Confidence without the chain is hallucination. This skill was born from the chase-assistant Telegram poller incident 2026-05-16 — where 'source is fixed, daemon is stale' was claimed and BOTH halves were wrong (fix wasn't committed, PR wasn't merged)."
triggers:
  - "fix is in"
  - "fix is shipped"
  - "issue resolved"
  - "bug closed"
  - "PR merged"
  - "source has the fix"
  - "just need to restart"
  - "daemon is stale"
  - "running system isn't using latest"
  - "we already fixed that"
  - "Boris merged it"
  - "status report"
  - "PR summary"
  - "done"
  - "shipped"
---

# Verify-the-Chain

The discipline of tracing every fix-claim through six links before stating it as fact.

## Why this exists

On 2026-05-16, chase-assistant's Telegram poller was silently dead for 14 hours. The analyst told the user "source is fixed, daemon is stale, just needs a restart." Both halves were wrong:

1. The "fix" in source was UNCOMMITTED working-tree changes (git blame: "Not Committed Yet").
2. The PR Luke thought shipped (#400) was still OPEN on GitHub — never merged.
3. The session-start git status literally showed `M src/daemon/agent-manager.ts`. The analyst saw it and did not read the diff.

The fix-claim narrative skipped FIVE of six verification links. The cost was a 14-hour outage that nearly stayed hidden longer.

This skill exists to make that class of miss structurally impossible.

## When this fires

This skill fires when you are about to do any of the following:

**Bug-fix / completion claims (the original trigger class):**
- Claim a bug is **fixed / shipped / resolved / merged / done / closed**.
- Tell the user **"source has the fix" / "the fix is in" / "just need to restart" / "daemon is stale"**.
- Escalate a **"running system isn't using the latest"** diagnosis.
- Write a **status report** or **PR summary** that asserts work is complete.
- Paraphrase a **user belief** ("we already fixed that" / "PR #X handles it" / "Boris merged it last week") as system state.

**State-attribute claims (added 2026-05-16 after the TZ miss):**
- About to state **any user attribute** (timezone, location, role, working hours, preferences, family, relationships, contact channel).
- About to state **any system attribute** (file path, package version, schedule, port, hostname, environment).
- About to state **any agent attribute** (which bot is which, what handle, what role, which org).

For state-attribute claims, the chain collapses to a **primary-source-lookup chain** (skip the 6-step bug-fix chain — that's for fix claims). Lookup order:
1. **Env vars**: `$CTX_TIMEZONE`, `$CTX_ORG`, `$CTX_AGENT_NAME`, `$CTX_*` — system-set, authoritative.
2. **Config files**: `config.json`, `.env`, `secrets.env` — operator-set, authoritative.
3. **Identity docs**: `USER.md`, `IDENTITY.md`, `GOALS.md`, `SOUL.md` — onboarded facts.
4. **Knowledge base**: `cortextos bus kb-query "<topic>" --org $CTX_ORG` — accumulated knowledge.
5. **Filesystem**: `find <parent-dir>` / `Test-Path` — for path claims specifically.

If steps 1-4 are silent on the attribute, the attribute is UNKNOWN, not "probably X." Say "checking..." or ask the user — never substitute a prior assumption for primary-source evidence.

**Born from 2026-05-16 TZ incident**: analyst had `CTX_TIMEZONE=Pacific/Honolulu` directly visible in env output and overrode it with a prior assumption that Luke was US-Pacific. Same shape as the chase-assistant fix-claim miss from earlier the same day — evidence in front, narrated past it.

If any of these describe what you're about to do, **stop and run the relevant chain first**.

## The 6-step chain

Produce all six lines BEFORE making the claim. If any link is missing or broken, the correct framing is NOT "fix is in, just restart" — it is "fix exists at <step>; gaps at <missing steps>; here's what needs to happen at each."

### Step 1 — WORKING TREE
Does the fix exist as edits on disk?

```
Bash:       git diff --stat -- <file>
            git diff -- <file>          # full diff for substantive review
PowerShell: git diff --stat -- <file>   # git is portable across shells
            git diff -- <file>
```

Expected output: lists changed lines. If empty, fix is not in the working tree.

### Step 2 — COMMITTED
Is the working-tree change committed locally?

```
Bash:       git log --oneline -5 -- <file>
            git status --short -- <file>   # if working tree shows "M" the change is NOT committed
PowerShell: git log --oneline -5 -- <file>
            git status --short -- <file>
```

Expected: shows the commit that introduced the fix with hash + date. If the file shows `M` in `git status --short`, the change is uncommitted regardless of what the diff shows.

**This is the link the analyst missed on 2026-05-16.** Working-tree changes ≠ committed changes.

### Step 3 — MERGED
Is the commit on `origin/main`?

```
Bash:       git fetch origin main --quiet      # ensure local origin/main is current
            git merge-base --is-ancestor <commit> origin/main && echo YES || echo NO
PowerShell: git fetch origin main --quiet
            git merge-base --is-ancestor <commit> origin/main
            if ($?) { "YES" } else { "NO" }
```

Plus the PR check (the authoritative signal):

```
gh pr view <N> --json state,mergedAt,mergeCommit
```

Expected: `state: MERGED` and a non-null `mergedAt`. If `state: OPEN` or `state: CLOSED` without merge, the work is NOT on main.

**Degraded mode** when `gh` is offline / unauthenticated / not installed:

```
Bash:       git log origin/main --oneline | grep -F <commit>
PowerShell: git log origin/main --oneline | Select-String -SimpleMatch <commit>
```

If found, treat as MERGED but explicitly downgrade the claim's confidence ("merge inferred from origin/main log; PR state unverified"). If not found, output: `MERGED: unverifiable offline — downgrade claim`.

Never skip this step. Never paraphrase user belief as merge status. **`gh pr view <N>` before `"we shipped that"`.**

### Step 4 — BUILT
Does the dist (compiled artifact) include the commit?

```
Bash:       stat -c %y dist/cli.js                                                       # mtime
            cat state/daemon-build.json | jq -r .commit                                  # post-T11 stamp
PowerShell: (Get-Item dist\cli.js).LastWriteTime
            (Get-Content state\daemon-build.json | ConvertFrom-Json).commit              # post-T11
```

Pre-T11 fallback (before `__BUILD_COMMIT__` stamping ships): use `dist/cli.js` mtime + commit hash of last commit that modified `src/` as a proxy. After T11 lands, prefer the stamped commit hash from `state/daemon-build.json`.

Expected: dist's commit (or build-time mtime relative to source mtime) is >= the fix commit's timestamp. If dist mtime is OLDER than the fix commit, `npm run build` has not been run since.

### Step 5 — RUNNING
Is the dist's commit actually loaded into the running daemon process?

```
Bash:       pm2 list                                                                        # uptime + restart count
            tail -50 ~/.pm2/logs/cortextos-daemon-out.log | grep -E "build=|Starting"       # startup banner
PowerShell: pm2 list
            Get-Content "$env:USERPROFILE\.pm2\logs\cortextos-daemon-out.log" -Tail 50 | Select-String -Pattern 'build=|Starting'
```

Expected: pm2 uptime is GREATER than the build mtime AND less than the time of last code change. Post-T11, the startup banner shows the build commit; cross-check against current dist's commit.

If pm2 uptime > time since last `npm run build`, the daemon may be running stale code (the exact scenario chase-assistant hit on 2026-05-16 — daemon was 14h old, predating the build).

### Step 6 — BEHAVIORAL
Does the fix actually work end-to-end against the running process?

This is task-specific. Two non-negotiable rules:

1. **The test MUST use the exact failing input from the original incident**, not just a happy-path variant. If the incident's value was `ALLOWED_USER="8864755248,8372578968"`, the behavioral test runs against THAT literal string. Happy-path variants ("`123,456` works") do not prove the original incident is fixed.

2. **Distinguish FORMAT GATE (regex / validator level) from BEHAVIORAL (real connectivity)**. A regex test confirms the validator accepts the input. It does NOT confirm the system actually does the work end-to-end (e.g. successful Telegram message delivery). If real-connectivity testing is unavailable in v1, explicitly label the chain entry "BEHAVIORAL = FORMAT GATE only; full connectivity test deferred."

Example for a Telegram poller fix (T1 in the 2026-05-16 plan):
- Set `ALLOWED_USER="8864755248,8372578968"`.
- `pm2 restart cortextos-daemon`.
- Send messages from both user IDs in the list.
- Confirm both messages reach the inbox via `cortextos bus check-inbox`.

## Cross-verify path claims

If you Read a file path and get content back, **also run a second-source check** to confirm the path is canonical:

```
Bash:       find <parent-dir> -maxdepth 3 -name <filename>
            ls -la <full-path>
PowerShell: Get-ChildItem -Path <parent-dir> -Filter <filename> -Recurse -Depth 3
            Test-Path <full-path>
```

The Read tool can return content from a non-canonical path (Windows symlinks, path resolution quirks, etc.). On 2026-05-16 the analyst claimed the wrong `crons.json` path because Read returned content for `state\analyst\crons.json` when the canonical path was `.cortextOS\state\agents\analyst\crons.json`. Cross-verification with `find` would have caught it.

## What to do when the chain has a gap

If any of the 6 steps fail or are missing, the framing is:

> Fix exists at WORKING TREE; uncommitted at COMMITTED. The fix is local-only.
> Action required: commit the change, push to a branch, open PR.

Or:

> Commit exists; PR #400 state: OPEN. Not on main.
> Action required: rebase + reopen PR + request review.

Or:

> Commit on main; dist mtime 14h old.
> Action required: `npm run build && pm2 restart cortextos-daemon`.

Never collapse multiple gaps into "fix is in, just need to restart." Each broken link is a distinct action.

## Examples

### Bad (the 2026-05-16 miss)

> "I found root cause. ROOT CAUSE: chase-assistant ALLOWED_USER='8864755248,8372578968' fails the daemon's single-int regex. Source code was already fixed to allow commas. Just rebuilt dist — fix is sitting there but daemon needs to reload."

What's wrong: claims "source code was already fixed" without running steps 2-3. The fix was in the working tree but UNCOMMITTED. PR #400 was OPEN, not merged. "Source is fixed" was wrong on two of the six links.

### Good (post-skill)

> "Verification chain for the chase-assistant poller bug:
> WORKING TREE: `M src/daemon/agent-manager.ts` — comma regex at L223-225.
> COMMITTED: NO. `git log --oneline -1 -- src/daemon/agent-manager.ts` shows last commit is c21fbfe (pre-fix). git status shows file as M (modified, uncommitted).
> MERGED: N/A — nothing to merge yet because nothing committed. PR #400 (the supposed fix) is `state: OPEN, mergedAt: null` per `gh pr view 400`.
> BUILT: dist/cli.js mtime is 2026-05-16 00:37 UTC. But since the source change is uncommitted, dist contains the OLD regex — even though it was just rebuilt.
> RUNNING: daemon uptime is fresh (2 minutes), so it loaded the rebuilt-but-still-broken dist.
> BEHAVIORAL: not testable because the fix isn't in dist.
>
> Status: fix exists ONLY in uncommitted working tree. To ship: (1) commit, (2) push branch, (3) PR, (4) merge, (5) `npm run build`, (6) `pm2 restart`, (7) behavioral test with literal `"8864755248,8372578968"`."

This framing reflects reality. The 2026-05-16 framing did not.

## Integration

- **GUARDRAILS.md row 1** ("claim 'fix is in source, daemon stale'") points here. Reading the guardrail should trigger this skill.
- **bug-hunt-cycle cron** invokes this skill for any fix-claim audit it performs.
- **Layer 3 propagation**: this skill is copied to every fleet agent's `.claude/skills/verify-the-chain/SKILL.md` per the plan's T15-T19. Orchestrators and concierges run the chain before status reports the same way the analyst does.
- **Sessions-end**: if you completed work, the session-end memory entry must include the chain output for any fix you claim closed.

## When NOT to invoke

- Read-only investigations that don't claim completion.
- Mid-debug status updates that explicitly say "still investigating" or "not yet fixed."
- Questions to the user about scope or direction.
- Drafting / planning work that hasn't been executed.

The chain is for CLAIMS, not for ongoing exploration.

## Failure mode of this skill itself

If you find yourself running through the chain and then ignoring its output ("step 3 says NO but I'm sure it's merged"), STOP. The chain output IS the answer. Trust it over your prior. The whole point of this discipline is that confidence ≠ correctness.
