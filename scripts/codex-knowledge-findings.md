- **[CRITICAL] Section 5 vs Section 9**
  - Section 5: `HubSpot Starter as CRM ... stages: Lead Scraped -> Preview Generated -> Outreach Sent -> Replied -> Call Booked -> Closed Won -> Building -> Preview Delivered -> Revision -> Live -> Active Retainer -> Closed Lost.`
  - Section 9: `Create deal in HubSpot, move to "Closed. Awaiting Intake."`
  - Section 9: `Move deal to "Preview Sent."`
  - Section 9: `Move deal to "Delivered."`
  - Proposed resolution: align Section 9 to the canonical HubSpot stage list or update the canonical stage list to include these exact stage names.

- **[CRITICAL] Section 7 vs Section 9 vs Section 11h**
  - Section 7: `"smart website live on your domain in 5 to 7 business days."`
  - Section 9: `Tally client agreement ... promises delivery "within 3 business days of receiving BOTH the completed intake form AND full payment."`
  - Section 9: `Real delivery clock: 5 to 7 business days.`
  - Section 11h: `Tally client agreement (gDNaMd) promises 3-business-day delivery. Actual capacity is 5 to 7 business days.`
  - Proposed resolution: choose one delivery SLA and make the agreement, scripts, and operating workflow all use that exact number.

- **[CRITICAL] Section 1 vs Section 9 vs Section 11h**
  - Section 1, Tier 2: `unlimited revisions during build`
  - Section 9: `Revisions: agreement says unlimited, reality is 2 to 3 rounds before scope-creep pushback.`
  - Section 11h: `Same agreement promises unlimited revisions during build. Actual practice caps at 2 to 3 rounds before scope-creep pushback.`
  - Proposed resolution: make the offer description, agreement, and delivery policy all use the same revision policy.

- **[CRITICAL] Section 17 vs Section 33**
  - Section 17: `External-comms | Always per-action. NEVER graduates to auto.`
  - Section 33: `Send a verify-and-confirm message ... before taking any external-comms or financial action ... Wait for explicit "ok go" before acting externally.`
  - Proposed resolution: clarify whether `"ok go"` is only onboarding clearance or whether every external communication still needs separate per-action approval.

- **[HIGH] Section 9 (same section internal numeric drift)**
  - Section 9: `Real delivery clock: 5 to 7 business days.`
  - Section 9: `Hour 48 to 72 (Tier 1) or Day 5 to 7 (Tier 2). Go live.`
  - Proposed resolution: state a distinct Tier 1 SLA explicitly everywhere if Tier 1 is 48 to 72 hours, or remove the Tier 1 exception.

- **[HIGH] Section 2 vs Section 8**
  - Section 2: `Cold email plus calling. Active. About 650 sends per day via Instantly across 8 to 10 warmed domains.`
  - Section 8: `Current send volume. About 550 sends / day (last 7-day avg), below the 650 / day published capacity.`
  - Proposed resolution: separate current volume from capacity consistently, or update Section 2 to the current actual send rate.

- **[HIGH] Section 1 vs Section 19**
  - Section 1: `Priority Sun Belt metros: Phoenix, Dallas, Houston, Atlanta, Tampa, Charlotte, Jacksonville.`
  - Section 19: `Nationwide outbound, no fixed-metro start. Updated 2026-05-14.`
  - Section 19: `Outscraper queries run across US cities without geographic gating.`
  - Proposed resolution: decide whether geography is nationwide-first or Sun-Belt-priority and make both sections reflect the same targeting rule.

- **[HIGH] Section 12 vs Section 24**
  - Section 12: `R-024 (proposed) | Zero em / en dashes / double hyphens in any generated copy`
  - Section 24: `Em-dash / en-dash / double-hyphen-as-punctuation are HARD-DENIED. R-024.`
  - Proposed resolution: either make R-024 fully canonical everywhere or keep it clearly marked as proposed everywhere.

- **[HIGH] Section 12 vs Section 11e**
  - Section 12: `R-005 | Never commit .env*, never write to sources/**`
  - Section 11e: `This violates R-005.`
  - Section 11e context: `AIAgency/wiki/concepts/accounts-and-logins.md contains in plaintext...`
  - Proposed resolution: expand R-005’s one-line definition to cover committing secrets anywhere, or stop citing R-005 for non-`.env` secret leaks.

- **[HIGH] Section 12 vs Section 21**
  - Section 12: `Show Luke the script contents or plain-English summary. Wait for explicit go-ahead. Then run via the PowerShell tool.`
  - Section 21: `Don't ask to confirm reversible work. Just do the thing.`
  - Proposed resolution: add an explicit exception stating whether script execution is exempt from the reversible-work default.

- **[HIGH] Section 4 (table schema/semantic inconsistency)**
  - Section 4 table header: `| Person | Role | Lane | Not crossing |`
  - Luke row, `Not crossing`: `Running the cold-outbound / cold-call SALES MOTION end-to-end until $30K MRR. Chase owns prospecting, demos, pricing-stage objection handling.`
  - Chase row, `Not crossing`: `Build, infra, templates. Escalate to Luke.`
  - Proposed resolution: rewrite Luke’s `Not crossing` cell so it matches the same negative/excluded-lane semantics as the Chase row.

- **[LOW] Section 6 (table schema inconsistency)**
  - Table header: `| Name | URL | What |`
  - Non-URL entries in `URL` column: `tools/sales-cheat-sheet/index.html (deployed)`, `TBD on first social-agent provisioning`, `TBD per-agency sub-account login`
  - Proposed resolution: rename the column to something broader like `Location` or make every value in that column an actual URL.

- **[LOW] Section 6 (entity-name inconsistency)**
  - Section 6: `three names appear across the AIAgency wiki: sitesmith-previews ... sitesmith-templates ... sightsmith-previews`
  - Section 12: `sightsmith-previews is permanently excluded`
  - Proposed resolution: pick one canonical project name and mark the others strictly as legacy/invalid aliases.

- **[LOW] Section 22 vs Section 1**
  - Section 22: `Tier | One of the 3 offer tiers (Bare Bones $97, Full Website $297, Custom $5K / mo).`
  - Section 1, Tier 3: `$5K / mo retainer, or $1K plus 8 to 10 percent revenue share`
  - Proposed resolution: update the vocabulary entry so Tier 3 reflects both currently defined pricing structures.
