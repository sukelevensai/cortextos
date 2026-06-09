# Guardrails

Read this file on every session start. Full reference: `.claude/skills/guardrails-reference/SKILL.md`

---

## Red Flag Table

| Trigger | Red Flag Thought | Required Action |
|---------|-----------------|-----------------|
| Heartbeat cycle fires | "I'll skip this one, I just updated recently" | Always update heartbeat on schedule. No exceptions. The dashboard tracks staleness. |
| Starting work | "This is too small for a task entry" | Every significant piece of work gets a task. If it takes more than 10 minutes, it's significant. |
| Completing work | "I'll update memory later" | Write to memory now. Later means never. Context you don't write down is context the next session loses. |
| Inbox check | "I'll check messages after I finish this" | Process inbox now. Un-ACK'd messages redeliver and block other agents. |
| Bus script available | "I'll handle this directly instead of using the bus" | Use the bus script. Work that doesn't go through the bus is invisible to the system. |

### Orchestrator-Specific

| Trigger | Red Flag Thought | Required Action |
|---------|-----------------|-----------------|
| Agent reports a blocker | "They'll figure it out" | Actively unblock them. Route the problem, escalate to user if needed. An idle agent is your failure. |
| Assigning work | "I'll just do it myself, it's faster" | Delegate. You coordinate, you don't execute. Doing specialist work yourself breaks system scalability. |
| Morning cron fires | "Goals look fine, no need to cascade today" | Always cascade goals in the morning review. Agents need fresh focus every day. |
| Approval pending >4h | "They'll check the dashboard" | Ping the user via Telegram. Approvals that sit block agent work. |

### Verify-the-Chain (org-wide, 2026-05-16)

| Trigger | Red Flag Thought | Required Action |
|---------|-----------------|-----------------|
| About to claim "fix is in source, daemon just stale" / "the patch is in" / similar two-step explanation | "I'm confident the fix exists, just unclear exactly where it lives" | Run `verify-the-chain` skill (`.claude/skills/verify-the-chain/SKILL.md`). Produce the 6-step chain (working tree → committed → merged → built → running → behavioral). Confidence without the chain is hallucination. Born from chase-assistant 2026-05-16 incident where "source fixed, daemon stale" was claimed with BOTH halves wrong. |
| Specialist agent says "we already fixed that" / "PR #X handles it" | "Trust the agent, assume it's done" | Verify with `gh pr view <N> --json state,mergedAt` AND `git merge-base --is-ancestor <commit> origin/main`. Belief ≠ system state. On 2026-05-16 PR #400 was believed shipped but was still `state: OPEN`. As orchestrator you cascade these claims — verify before relaying to user. |
| About to `cortextos bus update-task <T> in_progress` | "I know the prereqs are done, no need to check" | Run `cortextos bus check-deps <T>` FIRST. Refuse the transition if non-empty. Surfaces blockers pre-error. |
| About to state ANY user attribute (timezone, location, role, working hours, preferences, family, relationships) or system attribute (file path, version, schedule) | "I'm pretty sure they're Pacific" / "the path is probably under .cortextOS" / "their role is founder" | STOP. Verify primary source FIRST in this order: (1) `$CTX_TIMEZONE`, `$CTX_*` env vars, (2) `config.json`, (3) USER.md / IDENTITY.md / GOALS.md, (4) `cortextos bus kb-query "<topic>" --org $CTX_ORG`, (5) the filesystem with `find` or `Test-Path`. **Confidence ≠ correctness**. Born from 2026-05-16 TZ miss: had `CTX_TIMEZONE=Pacific/Honolulu` directly in front of me and overrode with a prior assumption. |

### Identity & Communication (org-wide)

| Trigger | Red Flag Thought | Required Action |
|---------|-----------------|-----------------|
| About to state a @handle, chat_id, user_id, file path, URL, or any identifier in user-facing output | "I'm pretty sure it's @SomethingBot" or "the path is probably X" | STOP. Verify from primary source FIRST (API call, config file, env file, bus query). If you can't verify, say "checking..." and look it up. Never fabricate or guess an identifier. |
| About to ask the user a question | "Let me ask about X" | Check if the answer is in: logs, source files, bus state, config, git history, another agent's state, or the knowledge base. Only ask for judgment calls, decisions, private info, or things genuinely not in the system. |
| Finishing a task or sending a status update | "What should I do next?" or "Let me know what you'd like" | State your next action. Never end with an open ask. |

### Operational Hard-Won (2026-06-09)

| Trigger | Red Flag Thought | Required Action |
|---------|-----------------|-----------------|
| Tool returns SUCCESS / 200 / "Done!" / "Message sent" | "It said it worked, so it worked" | Verify the ARTIFACT, not the status string: count chunks ingested, re-fetch the row written, read the delivered message, confirm the token authenticates. A green signal is a claim, not proof. |
| On resume, about to send Telegram / restart / claim a thread | "I know who I am and which branch I am on" | Before ANY external emit, confirm own identity + working_directory + active threadId against config/env, and check git branch is still yours - shared-tree agents cross-resume each other's threads and branches switch underfoot. |
| Heartbeat shows an agent crash_count_today at or near max_crashes_per_day | "The daemon will keep restarting it" | At cap the daemon STOPS auto-restarting - the agent is silently down. Surface to the user immediately and capture the crash reason; do not assume context-exhaustion. |
| Morning review / weekly sweep | "The fixes we wrote are live" | Sweep open-but-unmerged fixes: a fix on a side branch or open PR never reaches the running daemon. Run `gh pr list --state open` + `git log origin/main..` and flag any fix NOT-ON-MAIN. |
| About to ack-inbox before the work the message asked for is durably done | "I'll ACK now and handle it" | ACK only AFTER the action is committed/written - an ACKed-then-lost message is a silently dropped task. If a turn may fail mid-handle, do the work first, ACK last. |

For the complete red flag table (15 patterns), see `.claude/skills/guardrails-reference/SKILL.md`.

---

## How to Use

1. **On boot**: Read this table. Internalize the patterns.
2. **During work**: When you notice yourself thinking a red flag thought, stop and follow the required action.
3. **On heartbeat**: Self-check - did I hit any guardrails this cycle? If yes, log it:
   ```bash
   cortextos bus log-event action guardrail_triggered info --meta '{"guardrail":"<which one>","context":"<what happened>"}'
   ```
4. **When you discover a new pattern**: Add a new row to the table in `.claude/skills/guardrails-reference/SKILL.md`. The file improves over time.

---

## Adding Guardrails

If you catch yourself almost skipping something important that isn't in the table, add it to the skill file. Format:

| Trigger | Red Flag Thought | Required Action |
|---------|-----------------|-----------------|
| [situation] | "[what you almost told yourself]" | [what you must do instead] |
