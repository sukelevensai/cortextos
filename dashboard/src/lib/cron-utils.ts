/**
 * cron-utils.ts — Pure cron/schedule helpers for the Next.js dashboard.
 *
 * These are intentionally duplicated from src/bus/cron-state.ts so that
 * the dashboard (a Next.js app) does not need to import daemon-side Node.js
 * modules at runtime.  Any changes to the core parsing logic should be
 * reflected here as well.
 */

/**
 * Parse an interval string like "6h", "30m", "1d", "2w" into milliseconds.
 * Returns NaN for unrecognised formats (e.g. cron expressions like "0 8 * * *").
 */
export function parseDurationMs(interval: string): number {
  const match = /^(\d+)(m|h|d|w)$/.exec(interval.trim());
  if (!match) return NaN;
  const n = parseInt(match[1], 10);
  const unit = match[2];
  const multipliers: Record<string, number> = {
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
  };
  return n * multipliers[unit];
}

/**
 * Format a duration in milliseconds as a human-readable string.
 * e.g. 3600000 => "1h", 86400000 => "1d"
 */
export function formatDuration(ms: number): string {
  if (ms >= 604_800_000 && ms % 604_800_000 === 0) return `${ms / 604_800_000}w`;
  if (ms >= 86_400_000 && ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms >= 3_600_000 && ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${ms}ms`;
}

/**
 * Format a schedule string (interval shorthand or cron expression) as a
 * human-readable label for display in the dashboard.
 *
 * e.g. "6h"         => "every 6 hours"
 *      "30m"        => "every 30 minutes"
 *      "0 9 * * *"  => "0 9 * * *"  (returned as-is — cron exprs are opaque)
 */
export function formatSchedule(schedule: string): string {
  const ms = parseDurationMs(schedule);
  if (!isNaN(ms)) {
    const weeks   = ms / 604_800_000;
    const days    = ms / 86_400_000;
    const hours   = ms / 3_600_000;
    const minutes = ms / 60_000;

    if (ms >= 604_800_000 && ms % 604_800_000 === 0)
      return `every ${weeks} week${weeks !== 1 ? 's' : ''}`;
    if (ms >= 86_400_000 && ms % 86_400_000 === 0)
      return `every ${days} day${days !== 1 ? 's' : ''}`;
    if (ms >= 3_600_000 && ms % 3_600_000 === 0)
      return `every ${hours} hour${hours !== 1 ? 's' : ''}`;
    return `every ${minutes} minute${minutes !== 1 ? 's' : ''}`;
  }
  // Cron expression — return as-is
  return schedule;
}

// ---------------------------------------------------------------------------
// Form / mutation validation helpers — Subtask 4.2
// ---------------------------------------------------------------------------

/** Interval shorthand: digits followed by one of s/m/h/d/w */
const INTERVAL_REGEX = /^\d+(s|m|h|d|w)$/;

/** Minimal 5-field cron expression validator (same logic as ipc-server.ts) */
function isValidCronExpr(s: string): boolean {
  const parts = s.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  // Validate each field against its allowed range
  const ranges: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
  for (let i = 0; i < 5; i++) {
    const field = parts[i];
    const [min, max] = ranges[i];
    try {
      expandFieldClient(field, min, max);
    } catch {
      return false;
    }
  }
  return true;
}

function expandFieldClient(field: string, min: number, max: number): void {
  for (const part of field.split(',')) {
    if (part === '*') continue;
    if (part.startsWith('*/')) {
      const step = parseInt(part.slice(2), 10);
      if (isNaN(step) || step <= 0) throw new Error('bad step');
      continue;
    }
    if (part.includes('-')) {
      const [lo, hi] = part.split('-').map(s => parseInt(s, 10));
      if (isNaN(lo) || isNaN(hi) || lo > hi || lo < min || hi > max) throw new Error('bad range');
      continue;
    }
    const n = parseInt(part, 10);
    if (isNaN(n) || n < min || n > max) throw new Error('bad value');
  }
}

/**
 * Validate a schedule string (interval shorthand or 5-field cron expression).
 * Returns true if the schedule is well-formed and can be parsed by the daemon.
 *
 * @example isValidScheduleClient("6h")         // true
 * @example isValidScheduleClient("0 9 * * *")  // true
 * @example isValidScheduleClient("6 hours")    // false
 * @example isValidScheduleClient("abc")        // false
 */
export function isValidScheduleClient(schedule: string): boolean {
  if (!schedule || !schedule.trim()) return false;
  const s = schedule.trim();
  return INTERVAL_REGEX.test(s) || isValidCronExpr(s);
}

/**
 * Validate a cron name string.
 * Must be non-empty with no whitespace (letters, digits, _ and - only).
 */
export function isValidCronName(name: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(name) && name.length > 0;
}

/**
 * Format a schedule string as an example label.
 * Used to provide inline hints in the cron form.
 */
export function scheduleExamples(): Array<{ value: string; label: string }> {
  return [
    { value: '6h',          label: 'every 6 hours' },
    { value: '24h',         label: 'every 24 hours (daily)' },
    { value: '30m',         label: 'every 30 minutes' },
    { value: '1d',          label: 'every day' },
    { value: '0 9 * * *',   label: 'daily at 09:00 UTC' },
    { value: '0 13 * * *',  label: 'daily at 13:00 UTC (09:00 ET)' },
    { value: '0 16 * * 1',  label: 'every Monday at 16:00 UTC' },
    { value: '*/15 * * * *', label: 'every 15 minutes' },
  ];
}

/**
 * Format a timestamp as a relative string ("2 hours ago", "in 5 minutes").
 * Falls back to the ISO string if the input is null/undefined/unparseable.
 */
export function formatRelative(isoTs: string | null | undefined): string {
  if (!isoTs || isoTs === 'unknown') return isoTs ?? 'never';
  const now = Date.now();
  const ts = new Date(isoTs).getTime();
  if (isNaN(ts)) return isoTs;

  const diffMs = ts - now;
  const absDiff = Math.abs(diffMs);
  const past = diffMs < 0;

  let label: string;
  if (absDiff < 60_000) {
    label = 'just now';
    return label;
  } else if (absDiff < 3_600_000) {
    const mins = Math.round(absDiff / 60_000);
    label = `${mins} min${mins !== 1 ? 's' : ''}`;
  } else if (absDiff < 86_400_000) {
    const hrs = Math.round(absDiff / 3_600_000);
    label = `${hrs} hr${hrs !== 1 ? 's' : ''}`;
  } else {
    const days = Math.round(absDiff / 86_400_000);
    label = `${days} day${days !== 1 ? 's' : ''}`;
  }

  return past ? `${label} ago` : `in ${label}`;
}

// ---------------------------------------------------------------------------
// Next-fire computation (moved from app/api/workflows/crons/route.ts, GAP-0090).
// parseDurationMs lives in this module; nextFireFromCronExpr stays private.
// ---------------------------------------------------------------------------

export function computeNextFire(
  schedule: string,
  lastFiredAt: string | undefined,
  now: number,
): string {
  const referenceMs = lastFiredAt ? new Date(lastFiredAt).getTime() : now;

  const durationMs = parseDurationMs(schedule);
  if (!isNaN(durationMs)) {
    const next = referenceMs + durationMs;
    return new Date(next <= now ? now + durationMs : next).toISOString();
  }

  // Try as a 5-field cron expression
  const nextMs = nextFireFromCronExpr(schedule, now);
  if (!isNaN(nextMs)) {
    return new Date(nextMs).toISOString();
  }

  return 'unknown';
}

/**
 * Minimal 5-field cron expression evaluator (duplicate-free: references the
 * same algorithm as src/daemon/cron-scheduler.ts but runs in the Next.js
 * server process which cannot import daemon-side Node.js modules).
 *
 * Fields: minute hour dom month dow
 */
function nextFireFromCronExpr(expr: string, fromMs: number): number {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return NaN;

  const [minuteStr, hourStr, domStr, monthStr, dowStr] = parts;

  function expand(field: string, min: number, max: number): number[] {
    const result = new Set<number>();
    for (const part of field.split(',')) {
      if (part === '*') {
        for (let i = min; i <= max; i++) result.add(i);
      } else if (part.startsWith('*/')) {
        const step = parseInt(part.slice(2), 10);
        if (isNaN(step) || step <= 0) throw new Error(`Invalid step: ${part}`);
        for (let i = min; i <= max; i += step) result.add(i);
      } else if (part.includes('-')) {
        const [lo, hi] = part.split('-').map(s => parseInt(s, 10));
        if (isNaN(lo) || isNaN(hi) || lo > hi) throw new Error(`Invalid range: ${part}`);
        for (let i = lo; i <= hi; i++) result.add(i);
      } else {
        const n = parseInt(part, 10);
        if (isNaN(n)) throw new Error(`Invalid value: ${part}`);
        result.add(n);
      }
    }
    return [...result].sort((a, b) => a - b);
  }

  let minutes: number[], hours: number[], doms: number[], months: number[], dows: number[];
  try {
    minutes = expand(minuteStr, 0, 59);
    hours   = expand(hourStr, 0, 23);
    doms    = expand(domStr, 1, 31);
    months  = expand(monthStr, 1, 12);
    dows    = expand(dowStr, 0, 6);
  } catch {
    return NaN;
  }

  const startMs = Math.floor(fromMs / 60_000) * 60_000 + 60_000;
  const MAX_MINUTES = 366 * 24 * 60;
  let candidate = startMs;

  for (let i = 0; i < MAX_MINUTES; i++) {
    const d = new Date(candidate);
    if (
      months.includes(d.getMonth() + 1) &&
      doms.includes(d.getDate()) &&
      dows.includes(d.getDay()) &&
      hours.includes(d.getHours()) &&
      minutes.includes(d.getMinutes())
    ) {
      return candidate;
    }
    candidate += 60_000;
  }

  return NaN;
}
