/**
 * Shared vocabulary for the Google Drive linking flow.
 *
 * This module is deliberately dependency-free (no `googleapis`, no Node-only
 * APIs beyond `crypto`) so it can be imported by both Route Handlers and the
 * page that renders the result of the flow.
 */

/**
 * Name of the short-lived, HTTP-only cookie that holds the OAuth `state`
 * nonce while the user is away on Google's consent screen.
 */
export const OAUTH_STATE_COOKIE = "orgonauts_oauth_state";

/** How long the user has to complete the consent screen before `state` expires. */
const STATE_TTL_SECONDS = 10 * 60;

/**
 * Cookie attributes for the `state` nonce.
 *
 * `sameSite: "lax"` is load-bearing: Google returns the user via a top-level
 * GET navigation from an external origin, and `strict` would withhold the
 * cookie on that request, breaking every callback.
 */
export const STATE_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
  path: "/",
  maxAge: STATE_TTL_SECONDS,
} as const;

/**
 * Generates the anti-CSRF `state` value round-tripped through Google.
 *
 * Without this, any third party could hand a victim a crafted callback URL and
 * silently bind the victim's Orgonauts session to the attacker's Drive.
 */
export function createStateToken(): string {
  return crypto.randomUUID();
}

/**
 * Every way the linking flow can fail, expressed as a closed union so the UI
 * cannot render a message for a state the backend never produces.
 */
export type LinkErrorCode =
  | "access_denied"
  | "missing_code"
  | "state_mismatch"
  | "config"
  | "drive_error"
  | "session_error";

/** Human-readable copy for each failure mode, shown in the error banner. */
export const LINK_ERROR_MESSAGES: Record<LinkErrorCode, string> = {
  access_denied:
    "Google consent was cancelled. No files were created and no access was granted.",
  missing_code:
    "Google did not return an authorization code. Please start the linking flow again.",
  state_mismatch:
    "The security check on the callback failed. Start the flow again from this page.",
  config:
    "Google OAuth is not configured on this server. Check the GOOGLE_* variables in .env.local.",
  drive_error:
    "We authenticated with Google but could not provision the Orgonauts_Data folder. See the server logs for details.",
  session_error:
    "Your Drive was provisioned, but this server could not encrypt the session. Check TOKEN_ENCRYPTION_KEY in .env.local.",
};

/** Narrows an arbitrary query-string value to a known error code. */
export function parseLinkErrorCode(value: unknown): LinkErrorCode | null {
  return typeof value === "string" && value in LINK_ERROR_MESSAGES
    ? (value as LinkErrorCode)
    : null;
}
