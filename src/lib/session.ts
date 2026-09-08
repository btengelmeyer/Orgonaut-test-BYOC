/**
 * The Orgonauts "connection session".
 *
 * In this prototype, an encrypted cookie *is* the account record: it is the
 * only place we remember that a browser has linked a Google Drive. In the real
 * product this becomes a row in the hosted control-plane database — see
 * `docs/ARCHITECTURE.md`. The shape below is deliberately close to what that
 * row will look like, so the migration is a change of storage, not of model.
 *
 * Server-only: reads cookies via `next/headers` and decrypts with `node:crypto`.
 */

import { cookies } from "next/headers";

import { decryptToString, encryptToString } from "@/lib/encryption";
import type { OAuthTokens } from "@/lib/googleDrive";

/** Cookie holding the encrypted Google credentials. */
export const SESSION_COOKIE = "orgonauts_drive_session";

/** How long a link survives before the user must re-consent. */
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * Browsers reject cookies over ~4 KB. We warn well below that so the failure
 * is visible in logs rather than as a mysteriously absent session.
 */
const COOKIE_SIZE_WARNING_BYTES = 3_500;

/**
 * Cookie attributes for the session.
 *
 * - `httpOnly` keeps it away from `document.cookie`, so an XSS bug cannot
 *   exfiltrate Google tokens.
 * - `secure` in production means it never crosses a plaintext connection.
 * - `sameSite: "lax"` still sends the cookie on the top-level GET redirect
 *   back from Google, while blocking it on cross-site subrequests.
 */
export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
  path: "/",
  maxAge: SESSION_TTL_SECONDS,
} as const;

/**
 * What we persist about a linked Drive.
 *
 * An explicit shape rather than Google's raw `Credentials`: it documents each
 * field, and it keeps anything unexpected Google adds later out of the cookie.
 */
export interface DriveSession {
  /** Short-lived bearer token; typically expires one hour after issue. */
  accessToken: string;
  /**
   * Long-lived token used to mint new access tokens.
   *
   * Optional because Google only returns one on first consent (we force it
   * with `prompt: "consent"`). Without it, the link dies at `expiryDate`.
   */
  refreshToken?: string;
  /** Epoch milliseconds at which `accessToken` stops working. */
  expiryDate?: number;
  /** Scopes actually granted — may be narrower than what we asked for. */
  scope?: string;
  /** ISO timestamp of when this link was established, for display and audit. */
  linkedAt: string;
}

/**
 * Encrypts tokens into a cookie value.
 *
 * @param tokens Credentials fresh from the Google token exchange.
 * @param previousRefreshToken Refresh token from an existing session, kept as
 *   a fallback. Google omits `refresh_token` when it decides a grant is
 *   already active, and silently downgrading a durable link to a one-hour one
 *   is a bug that only shows up an hour later.
 */
export function serializeDriveSession(
  tokens: OAuthTokens,
  previousRefreshToken?: string,
): string {
  if (!tokens.access_token) {
    throw new Error("Google returned no access token; refusing to store a session.");
  }

  const session: DriveSession = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? previousRefreshToken,
    expiryDate: tokens.expiry_date ?? undefined,
    scope: tokens.scope ?? undefined,
    linkedAt: new Date().toISOString(),
  };

  const value = encryptToString(JSON.stringify(session));

  if (value.length > COOKIE_SIZE_WARNING_BYTES) {
    console.warn(
      `[orgonauts] Session cookie is ${value.length} bytes, approaching the ~4KB browser limit.`,
    );
  }

  return value;
}

/** Type guard for decrypted cookie contents, which are untrusted input. */
function isDriveSession(value: unknown): value is DriveSession {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.accessToken === "string" &&
    typeof candidate.linkedAt === "string"
  );
}

/**
 * Reads the current session, or `null` if this browser has not linked a Drive.
 *
 * Every failure mode — absent cookie, rotated key, tampered payload, payload
 * from an older schema — collapses to `null`, i.e. "disconnected". Callers
 * therefore only ever handle two cases.
 */
export async function readDriveSession(): Promise<DriveSession | null> {
  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;

  if (!raw) {
    return null;
  }

  const decrypted = decryptToString(raw);

  if (!decrypted) {
    console.warn("[orgonauts] Session cookie could not be decrypted; treating as disconnected.");

    return null;
  }

  try {
    const parsed: unknown = JSON.parse(decrypted);

    return isDriveSession(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Converts a stored session back into the credential shape `googleapis` wants.
 *
 * Passing `expiry_date` along matters: it is how the Google client knows the
 * access token is stale and that it should transparently spend the refresh
 * token instead of firing a doomed request.
 */
export function driveSessionToTokens(session: DriveSession): OAuthTokens {
  return {
    access_token: session.accessToken,
    refresh_token: session.refreshToken,
    expiry_date: session.expiryDate,
    scope: session.scope,
  };
}
