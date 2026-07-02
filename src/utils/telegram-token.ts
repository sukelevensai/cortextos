/**
 * Telegram bot-token shape validation for cortextOS.
 *
 * Fragility 6 (2026-07): token-shape validation was duplicated across three
 * call sites (src/daemon/agent-manager.ts, src/daemon/index.ts x2) with an
 * UNBOUNDED regex (`/^\d+:[A-Za-z0-9_-]+$/`) that accepts near-anything with
 * a colon in it, and a fourth path (the activity-channel poller in
 * agent-manager.ts) had ZERO shape validation at all. A placeholder-shaped
 * value (e.g. a stub, a truncated paste, or literal `PASTE_TOKEN_HERE`) that
 * slips past the loose regex, or past no check at all, starts a
 * TelegramPoller that hammers Telegram's getUpdates endpoint and 401-spams
 * indefinitely. This module is the single source of truth all four sites
 * import from.
 *
 * The regex is intentionally LOWER-BOUND ONLY on both segments:
 *   - `\d{6,}`            at least 6 digits for the numeric bot id
 *   - `[A-Za-z0-9_-]{30,}` at least 30 chars for the secret
 * A real Telegram bot token today is ~46 chars total (10-digit id + ':' +
 * 35-char secret), but there is no guarantee Telegram never issues a longer
 * id or secret in the future. DO NOT add an upper bound (e.g. `{10}` or
 * `{1,10}`) to either segment. That would silently reject a valid future
 * bot token instead of catching the placeholder-shape problem this module
 * exists to fix.
 */

const BOT_TOKEN_SHAPE = /^\d{6,}:[A-Za-z0-9_-]{30,}$/;

/**
 * Returns true if `token` has the shape of a real Telegram bot token:
 * `<digits>:<secret>` with the digits and secret segments both long enough
 * to rule out placeholders, truncated pastes, and stub values. This is a
 * SHAPE check only. It does not call Telegram's API and cannot confirm the
 * token is actually valid/live, only that it is plausible enough to attempt.
 */
export function isValidBotToken(token: string): boolean {
  return typeof token === 'string' && BOT_TOKEN_SHAPE.test(token);
}
