# Upstream Delivery — cortextOS Framework Gap Report

**Source:** SiteSmith Agency production deployment (https://github.com/sukelevensai/cortextos, fork of grandamenium/cortextos).
**Maintained by:** Luke Stevens + analyst agent (the analyst maintains this file; rolling updates as new gaps surface in production).
**Audience:** James Goldbach (cortextOS upstream maintainer) and any other contributor working the silent-failure class.
**Status conventions:** **open** = gap exists in current `grandamenium/cortextos:main`; **PR #N open** = fix written, awaiting merge; **shipped <SHA>** = merged upstream.

> Live file. Last refresh: 2026-05-17. To subscribe to updates: watch this file in the fork, or watch the tracking issue on `grandamenium/cortextos` that references it.

---

## Silent-failure class — origins and shape

Every gap below shares one shape: a file-read, parse, or background-task failure caught by `try { ... } catch {}` (or empty `continue`) and treated as "feature not configured." The daemon stays up, the agent looks healthy from PM2 / heartbeat / dashboard, but a feature silently dies. Operators only discover the breakage when something stops working hours later. The 2026-05-17 SiteSmith incident — all 6 agents went dark after a Windows restart because `ALLOWED_USER=` in every `.env` had a non-numeric value the daemon rejected with no operator-visible alert — is the canonical example.

The fix pattern is repeatable: **(a)** strip BOM + handle CRLF on every operator-editable file read; **(b)** replace empty `catch {}` with a structured `console.error` line naming the file + the specific failure mode; **(c)** where the failure causes a high-blast feature loss (Telegram poller, crash-loop alerts, cron registry, dashboard config propagation), send a one-shot outbound Telegram notice via the unaffected outbound path so the operator hears about it within seconds.

---

## Gap inventory

### GAP-0001 — `ALLOWED_USER` validator too narrow
- **File:** `src/daemon/agent-manager.ts:224`
- **Symptom:** Daemon silently refuses Telegram poller on any multi-user agent because the regex `/^\d+$/` rejects comma-separated user IDs.
- **Real-world:** 14h chase-assistant outage 2026-05-16.
- **Fix:** Switch to `/^\d+(,\d+)*$/` + parse to `Set<number>` for membership.
- **Status:** PR #458 (sukelevensai), PR #467 (storypixel), PR #400 partially address. All open.

### GAP-0004 / 0005 / 0006 / 0008 — silent-failure sites in daemon (PM2-stdout-only)
- **Files:** `src/daemon/agent-manager.ts` + `src/daemon/cron-scheduler.ts` — 12 sites that log refusal-to-start only to PM2 stdout.
- **Sites:** CHAT_ID-missing fall-through (worst — zero log line), `config.json` parse failures empty-defaulting, cron-scheduler 4 silent skip sites, `ACTIVITY_CHAT_ID` has no validator at all.
- **Real-world:** Dashboard health doesn't reflect daemon health; operators cannot distinguish "feature not configured" from "feature failed to start."
- **Fix:** Emit `telegram_disabled` warning event + dashboard activity-feed event for every fail-closed branch.
- **Status:** Companion commit `495caa4` lives on a side branch, never merged. **Open.**

### GAP-0007 — validator duplication + drift across call sites
- **Files:** `src/daemon/agent-manager.ts`, `src/bus/system.ts`, `src/cli/setup.ts`, `dashboard/src/app/api/agents/route.ts` — Telegram bot-token / chat-ID / user-ID regexes duplicated inline at 5+ sites. Stricter at some, missing at others. GAP-0001's bug exists because one of the 5 copies wasn't updated when comma-list was added.
- **Fix:** Centralize in `src/utils/validate.ts` with pinned per-semantic regexes.
- **Status:** Open.

### GAP-0009 — dashboard API has zero format validation
- **File:** `dashboard/src/app/api/agents/route.ts:95-100, 129-136`
- **Symptom:** Accepts `botToken`, `chatId`, `allowedUser` as raw strings with no regex check. Bypasses every CLI-level guard. Defense-in-depth gap.
- **Prerequisite:** Confirm auth middleware exists on the route before tightening (else info-disclosure surface widens). PR #471 + GAP-0030 in fork closed this prereq 2026-05-17.
- **Status:** Open.

### GAP-0011 / 0012 / 0013 / 0014 — no build-version stamping anywhere
- **Files:** `tsup.config.ts` has no `define:` block; `dist/cli.js` has no commit hash baked in; `cortextos doctor` has no staleness check; `package.json` has no `postbuild` hint; `Heartbeat` interface has no `daemon_build` field.
- **Symptom:** Operator has no signal that a `npm run build` requires a `pm2 restart` to take effect. Source can be fixed but dist running stale.
- **Real-world:** Root cause of the 14h chase-assistant delay. Same chain-gap class verified again on 2026-05-17 (BOM fix `7882a0e` on `fix/windows-crash-audit-bom-class` was never merged, so `dist/daemon.js` still has the raw `readFileSync` even though source-of-truth contributors wrote the fix).
- **Status:** Open.

### GAP-0015 — `update-task` does not enforce `blocked_by`
- **File:** `src/bus/task.ts:268`
- **Symptom:** `updateTask()` accepts any status transition regardless of `checkTaskDependencies()` output. `check-deps` lists open dependencies but is advisory only.
- **Fix:** Preflight `checkTaskDependencies(taskId)` before applying `status='in_progress'`; refuse with error if non-empty; add `--force` for explicit override.
- **Status:** Open.

### GAP-0018 — KB doesn't auto-ingest USER.md / IDENTITY.md / GOALS.md
- **File:** Heartbeat KB-ingest list (varies by agent template).
- **Symptom:** `memory-{agent}` collection only re-ingests `MEMORY.md` + daily memory. User/agent identity facts in `USER.md` / `IDENTITY.md` / `GOALS.md` never reach the KB. Result: `kb-query "Luke timezone"` returns empty even though the answer exists.
- **Fix:** Extend the heartbeat KB-ingest list to include identity docs; or add a separate `identity-{agent}` collection.
- **Status:** Open.

### GAP-0035 — `getOperatorChatCreds()` BOM-fragile + silent skip
- **File:** `src/daemon/index.ts:113-148`
- **Symptom:** Raw `readFileSync(envFile, 'utf-8')` + `/^BOT_TOKEN=(.+)$/m` regex inside `try { ... } catch { /* skip this agent */ }`. A UTF-8 BOM or malformed first line on the first scanned agent's `.env` makes the regex miss `BOT_TOKEN`, the function skips that agent and returns `null`, and the daemon's entire crash-loop Telegram alert path silently dies. Operator has no signal.
- **Real-world:** Would have masked the 2026-05-17 6-agent ALLOWED_USER incident even if crash-loop had fired.
- **Fix:** Strip BOM before regex match + emit `console.error` line per skipped agent naming the org/agent + failure mode.
- **Status:** **PR #472 open** (`sukelevensai:fix/daemon-operator-creds-bom-GAP-0035`). Includes 6 regression tests, all pass; type-check clean.

### GAP-0036 — PR #459 merge-order trap with PR #458 / #467
- **Symptom:** `fix/windows-crash-audit-bom-class` (PR #459) keeps the single-ID `ALLOWED_USER` regex `/^\d+$/` and string-equality compare; commit `5f1c7c5` (PR #458) and PR #467 change it to `/^\d+(,\d+)*$/` + Set-based membership. Naive merge of #459 after #458/#467 silently reverts multi-user support — same silent-failure class that PR #458 was opened to fix.
- **Fix:** Before landing #459, rebase it on top of whichever multi-user PR is chosen (#458 recommended); manually carry forward the comma-list regex + Set-based gate during conflict resolution. Document this constraint in PR descriptions.
- **Status:** **Open.** Cross-referenced on PR #459 via comment 2026-05-17.

### GAP-0037 — uncovered raw `.env` reads after PR #459 lands
- **Codex cross-check verified PR #459 does NOT touch these. Same failure class as GAP-0035. Each needs its own follow-up PR:**
  - `src/daemon/agent-manager.ts:85` — `enabled-agents.json` JSON.parse with no BOM strip.
  - `src/hooks/hook-crash-alert.ts:89` — `config.json` JSON.parse with no BOM strip.
  - `src/pty/agent-pty.ts:86-93` — org-level `secrets.env` manual `split('\n')` parse loop.
  - `src/pty/agent-pty.ts:102-111` — agent `.env` manual `split('\n')` parse loop.
  - `src/daemon/ipc-server.ts:160, :230, :311` — three `enabled-agents.json` reads fall back to empty state on parse failure (cron list, fleet health, cron-mutation validation all silently degrade to "no enabled agents").
  - `src/bus/system.ts:420-438` — activity-channel env raw `split('\n')` parse, returns `false` on read/parse/send failure (silently drops activity-channel notifications).
  - `src/hooks/index.ts:54-72` — hook script `.env` loader uses raw `split('\n')`, hook-driven Telegram flows can quietly lose `BOT_TOKEN`/`CHAT_ID` and look merely "not configured."
- **Fix:** Centralize on `src/utils/env.ts:parseEnvFile()` with BOM strip prepended; refactor all 7 sites to use the helper.
- **Status:** Open. Tracked as a single GAP for batching; individual PRs to follow.

### GAP-0038 — no operator-visible signal when a `.env` parse fails
- **Symptom:** Across every site in GAP-0035 / GAP-0037, the operator's only signal is PM2 stdout. PR #400 addresses the specific `ALLOWED_USER` missing/non-numeric case by sending an outbound Telegram notice (bus outbound has no `ALLOWED_USER` gate, so it reaches the operator even when the inbound poller is disabled). Same pattern is needed for: missing/malformed `BOT_TOKEN`, parse failures on `config.json`, parse failures on `enabled-agents.json`, parse failures on `context.json`.
- **Real-world:** 2026-05-17 incident would have been seen in 30 sec instead of 35+ min if any of these existed.
- **Fix:** Generalize PR #400's `[<agent>] Telegram inbound DISABLED — <reason>...` pattern into a daemon-level `notifyOperatorOfConfigError(reason, fixHint)` helper, called from every fail-closed branch in `src/daemon/agent-manager.ts`, `src/daemon/index.ts`, `src/daemon/ipc-server.ts`, `src/daemon/cron-scheduler.ts`.
- **Status:** Open. PR #400 is the seed; this is the generalization.

### GAP-0039 — no fleet-startup health surface for the operator
- **Symptom:** Daemon cold boot can leave one or more agents in a fail-closed degraded state (Telegram disabled, cron not loaded, hook missing), and the only way to detect it is to read PM2 stdout. The dashboard's `/api/workflows/health` and the per-agent heartbeat both report at the agent level, not the daemon-startup level.
- **Fix:** Add a `daemon_startup` event class emitted at the end of `discoverAndStart()` containing: count of agents started successfully, count of agents that hit any fail-closed branch with reasons, total elapsed boot time. Wire to dashboard activity feed and to `cortextos status` so a one-line "daemon last booted at T, 5/6 agents OK, 1 in fail-closed (analyst: ALLOWED_USER non-numeric)" appears in both surfaces.
- **Status:** Open.

---

## Cross-references — open PRs in this class

| PR | Title | Status | GAP coverage |
|---|---|---|---|
| #400 | seed ALLOWED_USER + surface silent poller-skip | open 5d, CI pass | GAP-0038 seed |
| #458 | allow comma-separated ALLOWED_USER list | open | GAP-0001 |
| #459 | BOM + PATH-unaware execFile + supervision audit | open | GAP-0035 partial, GAP-0036 trap |
| #467 | multi-user ALLOWED_USER (comma-separated) | open, CI pass | GAP-0001 |
| #472 | BOM-tolerant operator chat creds + warn-on-skip | open 2026-05-17, CI pass | GAP-0035 |
| #449 | Telegram poller observability | open 2d | GAP-0038 partial |
| #388 | surface config.json parse failures | open 7d, CI pass | adjacent class |
| #398 | register hook-loop-detector in tsup.config.ts | open 7d, CI pass | build-pipeline class |
| #445 | session-refresh marker writer | open | crash-attribution class |
| #446 | image-poison crash recovery | open, CI pass | crash-class |
| #463 | shouldContinue runtime gate | open, CI pass | runtime-class |
| #448 | cron reload-while-firing race | open | cron-class |
| #393 | codex-app-server back-online ping | open, CI pass | observability |

---

## How to consume this report

- Browse the GAPs in numbered order. Each is independently shippable.
- The "Status" line tells you whether work is in flight already.
- When a GAP is closed in a merged upstream commit, the analyst moves it to the **Closures** section below and stamps the SHA.
- Suggestions and disagreements welcome via Issues or comments on the tracking issue (link at top of this doc).
- New GAPs are appended as the SiteSmith production deployment surfaces them.

## Closures

_(empty as of 2026-05-17; will populate as upstream merges land)_
