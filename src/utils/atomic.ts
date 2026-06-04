import { writeFileSync, renameSync, mkdirSync, existsSync, copyFileSync, openSync, fsyncSync, closeSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
import { randomBytes } from 'crypto';

/**
 * Atomically write data to a file by writing to a temp file first,
 * then renaming. Rename is atomic on the same filesystem.
 * Matches the bash pattern: printf > .tmp.file && mv .tmp.file file
 *
 * When `keepBak` is true (default: false), the CURRENT file is copied to
 * `<filePath>.bak` before the rename.  This gives callers a single-step
 * rollback point without the cost of maintaining a full backup chain.
 * The `.bak` write is best-effort — if it fails the main write still proceeds.
 */
export function atomicWriteSync(filePath: string, data: string, keepBak = false): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });

  // Best-effort backup of the current file before overwriting.
  if (keepBak && existsSync(filePath)) {
    try {
      copyFileSync(filePath, filePath + '.bak');
    } catch {
      // Ignore backup errors — do not block the main write.
    }
  }

  const tmpPath = join(dir, `.tmp.${randomBytes(6).toString('hex')}`);
  try {
    // GAP-0059: fsync the tmp file before the rename so a crash / power-loss can't
    // leave the rename pointing at truncated or zero-length data. tmp+rename alone
    // is atomic w.r.t. concurrent readers but NOT crash-durable without the flush.
    const fd = openSync(tmpPath, 'w', 0o600);
    try {
      writeFileSync(fd, data + '\n', { encoding: 'utf-8' });
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmpPath, filePath);
    // Also fsync the parent directory so the rename entry itself is durable.
    // Best-effort: directory fsync is not supported on all platforms (e.g. Windows).
    try {
      const dirFd = openSync(dir, 'r');
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch {
      // Directory fsync unsupported / not permitted — the file fsync above is the
      // primary durability guarantee.
    }
  } catch (err) {
    // Clean up temp file on failure (use the imported unlinkSync — the previous
    // require('fs') here was a CommonJS call in an ESM module).
    try {
      unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }
}

/**
 * Ensure a directory exists, creating it recursively if needed.
 */
export function ensureDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true });
}
