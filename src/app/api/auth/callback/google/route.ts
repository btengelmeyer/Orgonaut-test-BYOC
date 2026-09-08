import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";

import {
  createOrgonautsFolder,
  createTestJsonFile,
  getTokens,
  type OAuthTokens,
} from "@/lib/googleDrive";
import { OAUTH_STATE_COOKIE, type LinkErrorCode } from "@/lib/oauth";
import {
  SESSION_COOKIE,
  SESSION_COOKIE_OPTIONS,
  readDriveSession,
  serializeDriveSession,
} from "@/lib/session";

/** `googleapis` and `node:crypto` are Node APIs; keep this off the Edge runtime. */
export const runtime = "nodejs";

/**
 * Step 2 of the linking flow: Google redirects the user back here.
 *
 * Responsibilities, in order:
 *   1. Validate the callback (user consent, `code`, anti-CSRF `state`).
 *   2. Exchange the code for tokens.
 *   3. Provision `Orgonauts_Data` and upsert the roster document.
 *   4. Persist the tokens in an encrypted session cookie.
 *   5. Send the user home with a result the UI can render.
 *
 * The handler always ends in a redirect — a raw error page here would strand
 * the user on an `/api/...` URL with no way back.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const searchParams = request.nextUrl.searchParams;
  const origin = request.nextUrl.origin;
  const cookieStore = await cookies();

  /** Builds a redirect home and clears the now-spent `state` cookie. */
  const backHome = (query: string): NextResponse => {
    cookieStore.delete(OAUTH_STATE_COOKIE);

    return NextResponse.redirect(new URL(`/${query}`, origin));
  };

  const fail = (code: LinkErrorCode): NextResponse => backHome(`?error=${code}`);

  // Google reports a declined consent screen as `?error=access_denied`.
  const googleError = searchParams.get("error");
  if (googleError) {
    console.warn("[orgonauts] Google returned an OAuth error:", googleError);

    return fail("access_denied");
  }

  const code = searchParams.get("code");
  if (!code) {
    console.warn("[orgonauts] Callback hit without an authorization code.");

    return fail("missing_code");
  }

  // Reject callbacks we did not initiate. The cookie is HTTP-only, so an
  // attacker cannot forge a matching pair from another origin.
  const expectedState = cookieStore.get(OAUTH_STATE_COOKIE)?.value;
  const returnedState = searchParams.get("state");
  if (!expectedState || expectedState !== returnedState) {
    console.warn("[orgonauts] OAuth state mismatch; rejecting the callback.");

    return fail("state_mismatch");
  }

  // Carried over if Google declines to reissue a refresh token on re-consent.
  const previousSession = await readDriveSession();

  let tokens: OAuthTokens;

  try {
    tokens = await getTokens(code);
    const folderId = await createOrgonautsFolder(tokens);
    const fileId = await createTestJsonFile(tokens, folderId);

    console.info(
      `[orgonauts] Provisioned Drive storage (folder: ${folderId}, file: ${fileId}).`,
    );
  } catch (error) {
    console.error("[orgonauts] Drive provisioning failed:", error);

    return fail("drive_error");
  }

  let sessionCookieValue: string;

  try {
    sessionCookieValue = serializeDriveSession(
      tokens,
      previousSession?.refreshToken,
    );
  } catch (error) {
    // Realistically a missing or malformed TOKEN_ENCRYPTION_KEY. Reported
    // separately from Drive failures because the fix is completely different:
    // the user's Drive is fine, our configuration is not.
    console.error("[orgonauts] Could not encrypt the session:", error);

    return fail("session_error");
  }

  // Written outside the try/catch, alongside the redirect, so the session is
  // only ever established on a fully successful run.
  cookieStore.set(SESSION_COOKIE, sessionCookieValue, SESSION_COOKIE_OPTIONS);

  return backHome("?success=true");
}
