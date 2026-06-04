/**
 * dashboard/src/app/api/agents/__tests__/agents-route-validation.test.ts
 *
 * Input-validation tests for POST /api/agents (GAP-0009).
 *
 * botToken / chatId / allowedUser are written verbatim into the new agent's
 * .env file, so they must be format-validated to prevent newline/.env-injection
 * (e.g. a value like "token\nEXTRA_KEY=evil" smuggling an extra .env line).
 *
 * All cases here exercise the early-return rejection paths, which return a 400
 * BEFORE any filesystem or daemon side effect — so no mocking of fs/IPC is needed.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { POST } from '../route';

// CTX_ROOT is only touched after validation passes; set it to a throwaway dir
// so an accidental fall-through can never write into a real workspace.
beforeAll(() => {
  process.env.CTX_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-route-test-'));
});

function post(body: unknown): Promise<Response> {
  const req = new NextRequest('http://localhost/api/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return POST(req);
}

const VALID = {
  name: 'testbot',
  org: 'sitesmith-agency',
  template: 'agent',
  botToken: '123456:AAHdqTcvABC-_def',
  chatId: '123456789',
};

describe('POST /api/agents — input validation (GAP-0009)', () => {
  it('accepts a well-formed botToken at the validation stage (does not 400 on format)', async () => {
    // A valid token must not be rejected by the format guard. We only assert it is
    // NOT a format 400 — downstream it may fail for other reasons (dup/fs), which is fine.
    const res = await post({ ...VALID });
    if (res.status === 400) {
      const body = await res.json();
      expect(body.error).not.toMatch(/botToken must match|chatId must be|allowedUser must be/);
    }
  });

  describe('botToken', () => {
    it('rejects a newline-injection payload', async () => {
      const res = await post({ ...VALID, botToken: '123456:AAH\nEXTRA_KEY=evil' });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/botToken must match/);
    });

    it('rejects a malformed token with no colon', async () => {
      const res = await post({ ...VALID, botToken: 'notatoken' });
      expect(res.status).toBe(400);
    });

    it('rejects an empty botToken', async () => {
      const res = await post({ ...VALID, botToken: '' });
      expect(res.status).toBe(400);
    });
  });

  describe('chatId', () => {
    it('rejects a non-numeric chatId', async () => {
      const res = await post({ ...VALID, chatId: 'abc' });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/chatId must be/);
    });

    it('rejects a newline-injection payload', async () => {
      const res = await post({ ...VALID, chatId: '123\nEXTRA=evil' });
      expect(res.status).toBe(400);
    });

    it('accepts a negative group/channel id at the format stage', async () => {
      const res = await post({ ...VALID, chatId: '-1001234567890' });
      if (res.status === 400) {
        expect((await res.json()).error).not.toMatch(/chatId must be/);
      }
    });
  });

  describe('allowedUser (optional)', () => {
    it('rejects a non-numeric allowedUser', async () => {
      const res = await post({ ...VALID, allowedUser: 'root' });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/allowedUser must be/);
    });

    it('rejects a newline-injection payload', async () => {
      const res = await post({ ...VALID, allowedUser: '42\nEXTRA=evil' });
      expect(res.status).toBe(400);
    });
  });
});
