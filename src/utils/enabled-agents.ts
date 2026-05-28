import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'fs';

export type EnabledAgentEntry = {
  enabled: boolean;
  status: string;
  org?: string;
};

export type EnabledAgentsMap = Record<string, EnabledAgentEntry>;

/**
 * Load enabled-agents.json with corruption protection (GAP-0031).
 *
 * If the file exists but does not parse as JSON, copies it to
 * `<path>.bak-<ts>` and throws. Caller MUST NOT overwrite the on-disk
 * file because that would silently destroy the existing roster — the
 * exact failure mode this helper exists to prevent.
 *
 * Returns `{}` when the file simply does not exist (the normal first-write
 * path on a fresh install).
 */
export function loadEnabledAgents(enabledPath: string): EnabledAgentsMap {
  if (!existsSync(enabledPath)) return {};
  let raw: string;
  try {
    raw = readFileSync(enabledPath, 'utf-8');
  } catch (err) {
    throw new Error(
      `Failed to read enabled-agents.json at ${enabledPath}: ${(err as Error).message}. ` +
      `Cannot proceed safely — overwriting would silently drop the existing roster.`,
    );
  }
  try {
    return JSON.parse(raw) as EnabledAgentsMap;
  } catch (err) {
    const backupPath = `${enabledPath}.bak-${Date.now()}`;
    try { copyFileSync(enabledPath, backupPath); } catch { /* best-effort */ }
    throw new Error(
      `enabled-agents.json is corrupt (${(err as Error).message}). ` +
      `Backed up to ${backupPath}. ` +
      `Fix the JSON syntax in ${enabledPath} (or restore from backup), then re-run. ` +
      `Refusing to overwrite to avoid silent roster wipe (GAP-0031).`,
    );
  }
}

export function saveEnabledAgents(enabledPath: string, map: EnabledAgentsMap): void {
  writeFileSync(enabledPath, JSON.stringify(map, null, 2) + '\n', 'utf-8');
}
