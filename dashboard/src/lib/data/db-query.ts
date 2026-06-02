// cortextOS Dashboard - shared SQLite query helpers (GAP-0089).
// Extracts the repeated "prepare -> all -> map rows -> on error log+return []"
// boilerplate that the data fetchers (events/tasks/approvals/analytics) all
// duplicated, into a single seam with one consistent error-handling policy.

import { db } from '@/lib/db';

export type SqlParam = string | number;

/**
 * Run a SELECT that returns multiple rows, map each row to T, and on any
 * failure log under [data/<tag>] and return an empty array (the same
 * fail-soft policy every fetcher used). `params` must already be in the
 * order the SQL placeholders expect.
 */
export function queryAll<T>(
  sql: string,
  params: SqlParam[],
  mapRow: (row: Record<string, unknown>) => T,
  tag: string,
): T[] {
  try {
    const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(mapRow);
  } catch (err) {
    console.error(`[data/${tag}] error:`, err);
    return [];
  }
}
