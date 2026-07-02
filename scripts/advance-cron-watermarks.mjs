#!/usr/bin/env node
// advance-cron-watermarks.mjs
//
// Purpose: after a daemon restart, write fresh last_fire watermarks into each
// agent's cron-state.json so the scheduler sees "recently fired" for every
// defined cron and skips the catch-up storm (one immediate job per cron on
// boot). See src/daemon/cron-scheduler.ts:354-370 for the matching-by-name
// logic this file's output is consumed by.
//
// Usage: node scripts/advance-cron-watermarks.mjs

import fs from "node:fs";
import path from "node:path";

const DEFINITIONS_DIR =
  "C:\\Users\\lukes\\.cortextos\\default\\.cortextOS\\state\\agents";
const STATE_ROOT = "C:\\Users\\lukes\\.cortextos\\default\\state";

function stripBom(content) {
  return content.replace(/^﻿/, "");
}

function readJsonLenient(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(stripBom(raw));
}

function main() {
  if (!fs.existsSync(DEFINITIONS_DIR)) {
    console.error(`Definitions dir not found: ${DEFINITIONS_DIR}`);
    process.exit(1);
  }

  const agentDirs = fs
    .readdirSync(DEFINITIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  const nowIso = new Date().toISOString();
  let processedCount = 0;
  let totalStamped = 0;
  const skipped = [];

  for (const agent of agentDirs) {
    const cronsPath = path.join(DEFINITIONS_DIR, agent, "crons.json");

    if (!fs.existsSync(cronsPath)) {
      // Agent has no cron definitions yet (e.g. scaffolded but unconfigured).
      // Nothing to stamp; not an error.
      continue;
    }

    let cronsParsed;
    try {
      cronsParsed = readJsonLenient(cronsPath);
    } catch (err) {
      console.warn(
        `WARNING: failed to parse ${cronsPath}: ${err.message}. Skipping agent "${agent}".`
      );
      skipped.push({ agent, reason: `crons.json parse failure: ${err.message}` });
      continue;
    }

    // crons.json in this install is an object of shape { updated_at, crons: [...] },
    // not a bare array. Accept both shapes defensively.
    let cronDefs;
    if (Array.isArray(cronsParsed)) {
      cronDefs = cronsParsed;
    } else if (cronsParsed && Array.isArray(cronsParsed.crons)) {
      cronDefs = cronsParsed.crons;
    } else {
      console.warn(
        `WARNING: ${cronsPath} did not contain a recognizable cron list (expected array or { crons: [...] }). Skipping agent "${agent}".`
      );
      skipped.push({ agent, reason: "crons.json not array or {crons:[...]}" });
      continue;
    }

    const cronNames = cronDefs
      .map((c) => c && c.name)
      .filter((name) => typeof name === "string" && name.length > 0);

    const agentStateDir = path.join(STATE_ROOT, agent);
    const statePath = path.join(agentStateDir, "cron-state.json");

    let stateObj = { updated_at: nowIso, crons: [] };

    if (fs.existsSync(statePath)) {
      try {
        const existing = readJsonLenient(statePath);
        if (existing && typeof existing === "object") {
          stateObj = existing;
          if (!Array.isArray(stateObj.crons)) {
            stateObj.crons = [];
          }
        }
      } catch (err) {
        console.warn(
          `WARNING: failed to parse existing ${statePath}: ${err.message}. Skipping agent "${agent}" to avoid clobbering an unreadable file.`
        );
        skipped.push({ agent, reason: `cron-state.json parse failure: ${err.message}` });
        continue;
      }
    }

    // Set/overwrite last_fire for every defined cron name; preserve any
    // extra records already present in cron-state.json that aren't in
    // crons.json.
    const byName = new Map(stateObj.crons.map((rec) => [rec.name, rec]));

    for (const name of cronNames) {
      const existingRec = byName.get(name);
      if (existingRec) {
        existingRec.last_fire = nowIso;
      } else {
        const newRec = { name, last_fire: nowIso };
        byName.set(name, newRec);
      }
    }

    stateObj.crons = Array.from(byName.values());
    stateObj.updated_at = nowIso;

    fs.mkdirSync(agentStateDir, { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(stateObj, null, 2));

    processedCount += 1;
    totalStamped += cronNames.length;

    console.log(`${agent} | ${cronNames.length} crons stamped | ${statePath}`);
  }

  console.log(
    `\nTotal: ${processedCount} agents processed, ${totalStamped} cron watermarks stamped, ${skipped.length} agents skipped (parse failure).`
  );

  if (skipped.length > 0) {
    console.log("Skipped agents:");
    for (const s of skipped) {
      console.log(`  - ${s.agent}: ${s.reason}`);
    }
  }

  if (processedCount === 0) {
    console.error("No agents processed. Exiting non-zero.");
    process.exit(1);
  }
}

main();
