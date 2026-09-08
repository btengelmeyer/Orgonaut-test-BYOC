import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";

import { SESSION_COOKIE } from "@/lib/session";

export const runtime = "nodejs";

/**
 * The off switch.
 *
 * Destroys the encrypted session cookie, which is the only place Orgonauts
 * remembers a Drive link. After this call the server holds nothing about the
 * user, and their `Orgonauts_Data` folder is theirs alone — still in their
 * Drive, still readable by them, no longer reachable by us.
 *
 * `POST` only, deliberately. A `GET` off switch gets fired by link prefetchers,
 * crawlers, and antivirus scanners; a user would appear to be randomly
 * disconnected. The dashboard therefore submits a real form.
 *
 * Security note: there is no CSRF token here. A forged cross-site POST could
 * log a user out — annoying, not dangerous, and it grants the attacker
 * nothing. Production should still pair this with a CSRF token, as the same
 * form pattern will later carry destructive actions.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const cookieStore = await cookies();

  cookieStore.delete(SESSION_COOKIE);

  console.info("[orgonauts] Drive session disconnected.");

  return NextResponse.redirect(
    new URL("/?disconnected=true", request.nextUrl.origin),
    // 303 forces the browser to follow up with a GET. Without it the redirect
    // preserves the POST method and the dashboard would be re-submitted.
    { status: 303 },
  );
}
