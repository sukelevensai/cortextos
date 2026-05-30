import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { Heartbeat, BusPaths } from '../types/index.js';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';

/**
 * Update heartbeat for the current agent.
 * Writes to: {ctxRoot}/state/{agent}/heartbeat.json
 * Matches bash update-heartbeat.sh format exactly.
 */
export function updateHeartbeat(
  paths: BusPaths,
  agentName: string,
  status: string,
  options?: { org?: string; timezone?: string; loopInterval?: string; currentTask?: string; displayName?: string; dayStart?: string; dayEnd?: string },
): void {
  ensureDir(paths.stateDir);

  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const mode = detectDayNightMode(
    options?.timezone || process.env.CTX_TIMEZONE || 'UTC',
    options?.dayStart,
    options?.dayEnd,
  );

  const heartbeat: Heartbeat = {
    agent: agentName,
    org: options?.org ?? '',
    ...(options?.displayName ? { display_name: options.displayName } : {}),
    status,
    current_task: options?.currentTask ?? '',
    mode,
    last_heartbeat: ts,
    loop_interval: options?.loopInterval ?? '',
  };

  atomicWriteSync(
    join(paths.stateDir, 'heartbeat.json'),
    JSON.stringify(heartbeat),
  );
}

/**
 * Detect day/night mode based on timezone and optional HH:MM boundaries.
 * If dayStart/dayEnd are omitted, defaults to 08:00-22:00.
 * Accepts wrap-around windows (e.g. dayStart=22:00 dayEnd=06:00 = overnight).
 */
export function detectDayNightMode(
  timezone: string,
  dayStart?: string,
  dayEnd?: string,
): 'day' | 'night' {
  const startMin = parseHHMM(dayStart) ?? 8 * 60;
  const endMin = parseHHMM(dayEnd) ?? 22 * 60;

  try {
    const now = new Date();
    const formatted = now.toLocaleString('en-US', {
      timeZone: timezone,
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
    });
    // Normalize "24:00" → "00:00" (some locales emit 24 instead of 00 for midnight)
    const normalized = formatted.replace(/^24:/, '00:');
    const [h, m] = normalized.split(':').map(s => parseInt(s, 10));
    const nowMin = (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
    return inWindow(nowMin, startMin, endMin) ? 'day' : 'night';
  } catch {
    const now = new Date();
    const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
    return inWindow(nowMin, startMin, endMin) ? 'day' : 'night';
  }
}

/**
 * Parse "HH:MM" → minutes since midnight. Returns undefined for missing/bad input.
 */
function parseHHMM(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return undefined;
  const h = parseInt(match[1], 10);
  const m = parseInt(match[2], 10);
  if (h < 0 || h > 23 || m < 0 || m > 59) return undefined;
  return h * 60 + m;
}

/**
 * True if nowMin falls within [startMin, endMin). Handles wrap-around
 * (when endMin <= startMin, the window crosses midnight).
 */
function inWindow(nowMin: number, startMin: number, endMin: number): boolean {
  if (startMin === endMin) return false; // zero-length window = always night
  if (startMin < endMin) return nowMin >= startMin && nowMin < endMin;
  // wrap-around: e.g. 22:00 - 06:00 = night-shift "day"
  return nowMin >= startMin || nowMin < endMin;
}

/**
 * Read all agent heartbeats.
 * Scans state/ directory for agent subdirs containing heartbeat.json.
 * Matches dashboard heartbeat path: state/{agent}/heartbeat.json
 */
export function readAllHeartbeats(paths: BusPaths): Heartbeat[] {
  const heartbeats: Heartbeat[] = [];
  const stateDir = join(paths.ctxRoot, 'state');
  let agentDirs: string[];
  try {
    agentDirs = readdirSync(stateDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    return [];
  }

  for (const agent of agentDirs) {
    const hbPath = join(stateDir, agent, 'heartbeat.json');
    try {
      const content = readFileSync(hbPath, 'utf-8');
      heartbeats.push(JSON.parse(content));
    } catch {
      // Skip agents without heartbeat
    }
  }

  return heartbeats;
}
