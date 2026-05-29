// session0-pty-test.js
// ---------------------------------------------------------------------------
// ISOLATED session-0 ConPTY viability probe for the PM2 -> Windows Service
// migration (task_1780013521776_58421523).
//
// PURPOSE: prove the two make-or-break unknowns WITHOUT touching the live
// PM2 daemon (zero fleet downtime):
//   1. node-pty (ConPTY) can spawn claude.exe with NO interactive desktop
//      (session 0), and claude.exe can in turn spawn a bash.exe child there.
//   2. ~/.claude OAuth credentials resolve under the service/run-as account
//      (a real model round-trip succeeds).
//
// It spawns ONE throwaway claude.exe via node-pty exactly like
// src/pty/agent-pty.ts does, makes it run a bash echo + emit a sentinel,
// captures everything to a log file, then exits. No Telegram, no agent
// context, no daemon interaction.
//
// Run via a Scheduled Task set to "run whether logged on or not" (session 0),
// run-as .\lukes with profile loaded. See register-pty-test-task.ps1.
//
// Safe to delete after the probe: this file + the log + the scheduled task.
// ---------------------------------------------------------------------------

'use strict';

const fs = require('fs');
const path = require('path');

// Absolute requires/paths so resolution does not depend on the task cwd.
const CORTEX_ROOT = 'C:\\Users\\lukes\\cortextos';
const NODE_PTY = path.join(CORTEX_ROOT, 'node_modules', 'node-pty');
const CLAUDE_EXE = 'C:\\Users\\lukes\\.local\\bin\\claude.exe';
const CTX_ROOT = process.env.CTX_ROOT || 'C:\\Users\\lukes\\.cortextos\\default';
// RUN_LABEL distinguishes the two required runs so their logs/sentinels never clobber:
//   "control" = Luke runs interactively in his own terminal (expected SessionId=1)  -> baseline
//   "task"    = the Scheduled Task runs it (MUST show SessionId=0)                  -> production proxy
// Compare: control PASS + task PASS = green; control PASS + task FAIL = session 0 IS the culprit;
// control FAIL = harness/flags broken, task result meaningless until fixed.
const RUN_LABEL = (process.argv[2] || 'manual').replace(/[^a-z0-9_-]/gi, '');
const LOG = path.join(CTX_ROOT, `session0-pty-test-${RUN_LABEL}.log`);
const TEST_CWD = path.join(CTX_ROOT, 'pty-test-cwd'); // empty throwaway dir = no project context
const MODEL = 'claude-opus-4-6'; // known-working model so a failure cannot be "model unavailable"
const TIMEOUT_MS = 180000; // 3 min hard cap

// Sentinels.
//  - DONE_SENTINEL: printed by claude in its final text -> proves the model round-trip.
//  - BASH file sentinel: claude is told to write it via the Bash tool. We verify the FILE
//    (not claude's stdout) because `claude -p` only prints final assistant text, so a
//    tool-result string would NOT appear in captured output -> false FAIL. The file proves
//    a bash.exe child actually executed in session 0, independent of stdout formatting.
const BASH_SENTINEL = 'PTY_BASH_OK_42';
const DONE_SENTINEL = 'PTY_TEST_DONE';
// Forward slashes: this path is handed to git-bash inside claude, where backslashes escape.
// Per-label so the control and task runs verify their OWN bash child, not each other's.
const BASH_SENTINEL_FILE = (CTX_ROOT.replace(/\\/g, '/')) + `/pty-test-bash-sentinel-${RUN_LABEL}.txt`;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(LOG, line); } catch (_) { /* best effort */ }
}

function finish(code, reason) {
  log(`=== RESULT: ${code === 0 ? 'PASS' : 'FAIL'} (exit ${code}) — ${reason} ===`);
  // Give the fs write a tick to flush, then exit.
  setTimeout(() => process.exit(code), 100);
}

try {
  fs.writeFileSync(LOG, ''); // fresh log each run
} catch (_) { /* if this throws the task account cannot write CTX_ROOT — surfaced below */ }

log(`=== session0-pty-test start (RUN_LABEL=${RUN_LABEL}) ===`);
log(`USERNAME=${process.env.USERNAME || '(unset)'}  USERPROFILE=${process.env.USERPROFILE || '(unset)'}`);
log(`USERDOMAIN=${process.env.USERDOMAIN || '(unset)'}  SESSIONNAME=${process.env.SESSIONNAME || '(unset)'}`);
// CRITICAL fidelity check: the numeric Windows session this process runs in.
// The 'task' run MUST log SessionId=0 to prove it reproduces the production NSSM
// service context. If it shows non-zero, the scheduled task ran in Luke's interactive
// session and a PASS does NOT transfer to the real session-0 service -> escalate.
// (This execSync is itself a child-spawn, so it doubles as a session-0 spawn signal.)
let sid = '?';
try {
  sid = require('child_process')
    .execSync('powershell -NoProfile -Command "(Get-Process -Id $PID).SessionId"', { timeout: 10000 })
    .toString().trim();
} catch (e) { sid = 'err:' + (e && e.message); }
log(`SessionId=${sid}  (task run MUST be 0 for production fidelity; interactive control will be 1)`);
const claudeHome = path.join(process.env.USERPROFILE || 'C:\\Users\\lukes', '.claude');
log(`~/.claude path=${claudeHome}  exists=${fs.existsSync(claudeHome)}`);
log(`claude.exe exists=${fs.existsSync(CLAUDE_EXE)}  node-pty exists=${fs.existsSync(NODE_PTY)}`);

// Ensure throwaway cwd exists and is empty of project context.
try { fs.mkdirSync(TEST_CWD, { recursive: true }); } catch (_) {}
// Clear any stale bash sentinel so a PASS reflects THIS run only.
try { fs.unlinkSync(BASH_SENTINEL_FILE.replace(/\//g, path.sep)); } catch (_) {}

let pty;
try {
  pty = require(NODE_PTY);
} catch (e) {
  finish(1, `node-pty require failed: ${e && e.message}`);
}

if (pty) {
  const prompt =
    'You are a one-shot headless test harness. Do EXACTLY this and nothing else: ' +
    `use your Bash tool to run this single command:  echo ${BASH_SENTINEL} > "${BASH_SENTINEL_FILE}"  ` +
    `then output the single token ${DONE_SENTINEL} on its own line and stop. ` +
    'Do not read files, do not explore, do not ask questions.';

  const args = ['-p', prompt, '--model', MODEL, '--allowedTools', 'Bash'];

  log(`spawning: ${CLAUDE_EXE} -p <prompt> --model ${MODEL} --allowedTools Bash  (cwd=${TEST_CWD})`);

  let captured = '';
  let child;
  try {
    child = pty.spawn(CLAUDE_EXE, args, {
      name: 'xterm-256color',
      cols: 200,
      rows: 50,
      cwd: TEST_CWD,
      env: process.env, // inherit the run-as account's full profile env
    });
  } catch (e) {
    finish(1, `pty.spawn threw (ConPTY may not init headless): ${e && e.message}`);
  }

  if (child) {
    log('pty.spawn returned a handle — ConPTY initialised headless. Awaiting claude output...');

    const killTimer = setTimeout(() => {
      log(`TIMEOUT after ${TIMEOUT_MS}ms — no exit. Captured so far:\n${captured}`);
      try { child.kill(); } catch (_) {}
      finish(1, 'timeout waiting for claude exit');
    }, TIMEOUT_MS);

    child.onData((d) => {
      captured += d;
      // Mirror raw output into the log so we can see auth/spawn errors verbatim.
      log(`[claude] ${d.replace(/\r/g, '').trimEnd()}`);
    });

    child.onExit(({ exitCode, signal }) => {
      clearTimeout(killTimer);
      // bash proof = the FILE the bash child was told to write (decoupled from stdout).
      let sawBash = false;
      try {
        const f = BASH_SENTINEL_FILE.replace(/\//g, path.sep);
        sawBash = fs.existsSync(f) && fs.readFileSync(f, 'utf-8').includes(BASH_SENTINEL);
      } catch (_) { sawBash = false; }
      // model-round-trip proof = sentinel claude printed in its final text.
      const sawDone = captured.includes(DONE_SENTINEL);
      log(`claude exited code=${exitCode} signal=${signal}`);
      log(`proof: bashChildWroteFile=${sawBash}  modelEmittedDone=${sawDone}`);
      if (sawBash && sawDone) {
        finish(0, 'ConPTY headless spawned claude, claude ran bash child in session 0, model round-trip OK');
      } else if (sawDone && !sawBash) {
        finish(1, 'model round-trip OK but bash child did NOT write the sentinel file — bash spawn likely failing in session 0');
      } else if (!sawDone && sawBash) {
        finish(1, 'bash child ran but model never emitted DONE — possible auth/stream issue (check log for errors)');
      } else {
        finish(1, `incomplete — likely auth (~/.claude) or spawn failure under run-as account. exitCode=${exitCode}`);
      }
    });
  }
}
