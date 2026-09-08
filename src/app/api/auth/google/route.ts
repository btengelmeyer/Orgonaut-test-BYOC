import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";

import { getAuthUrl } from "@/lib/googleDrive";
import {
  OAUTH_STATE_COOKIE,
  STATE_COOKIE_OPTIONS,
  createStateToken,
} from "@/lib/oauth";

/** `googleapis` is a Node client; keep this handler off the Edge runtime. */
export const runtime = "nodejs";

/**
 * Step 1 of the linking flow: send the user to Google's consent screen.
 *
 * We mint a `state` nonce, park it in an HTTP-only cookie, and hand the same
 * value to Google. The callback only proceeds if the two still match.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const state = createStateToken();
    const cookieStore = await cookies();
    cookieStore.set(OAUTH_STATE_COOKIE, state, STATE_COOKIE_OPTIONS);

    return NextResponse.redirect(getAuthUrl(state));
  } catch (error) {
    // The realistic failure here is missing GOOGLE_* environment variables.
    console.error("[orgonauts] Failed to build the Google auth URL:", error);

    return NextResponse.redirect(
      new URL("/?error=config", request.nextUrl.origin),
    );
  }
}
