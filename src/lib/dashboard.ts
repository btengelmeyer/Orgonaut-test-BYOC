/**
 * View model for the dashboard.
 *
 * Everything the page needs to render is resolved here and handed over as one
 * discriminated union, so `page.tsx` contains zero I/O and zero error
 * handling — it switches on `status` and renders. That split is what keeps the
 * UI reviewable and this logic testable.
 */

import {
  findOrgonautsFolderId,
  readRosterDocument,
  type OrgonautsDocument,
  type RosterMember,
} from "@/lib/googleDrive";
import {
  driveSessionToTokens,
  readDriveSession,
  type DriveSession,
} from "@/lib/session";

/**
 * Every state the dashboard can be in.
 *
 * Exhaustive by construction: adding a case here makes TypeScript flag the
 * `switch` in the page until the new state is rendered.
 */
export type DashboardState =
  /** No session cookie: this browser has never linked a Drive, or disconnected. */
  | { status: "disconnected" }
  /** Happy path — we read a valid roster document. */
  | {
      status: "ready";
      session: DriveSession;
      document: OrgonautsDocument<RosterMember>;
      folderId: string;
      fileId: string;
    }
  /** Linked, but the customer deleted the `Orgonauts_Data` folder. */
  | { status: "missing_folder"; session: DriveSession }
  /** Folder is there, `roster-test.json` is not. */
  | { status: "missing_file"; session: DriveSession; folderId: string }
  /** File is there but is not a document we can understand. */
  | { status: "malformed"; session: DriveSession; folderId: string; fileId: string }
  /** Google rejected our credentials — typically access revoked by the user. */
  | { status: "auth_expired"; session: DriveSession }
  /** Anything else: network, quota, Drive outage. */
  | { status: "drive_unavailable"; session: DriveSession; message: string };

/** Extracts an HTTP status from a Gaxios-shaped error without trusting its type. */
function getHttpStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }

  const candidate = error as { status?: unknown; response?: { status?: unknown } };

  if (typeof candidate.status === "number") {
    return candidate.status;
  }

  if (typeof candidate.response?.status === "number") {
    return candidate.response.status;
  }

  return null;
}

/**
 * Distinguishes "your credentials are dead" from "Google is having a bad day".
 *
 * A revoked grant is a user action with a clear remedy (re-link); an outage is
 * not. Showing the same message for both trains people to ignore it.
 */
function isAuthError(error: unknown): boolean {
  const status = getHttpStatus(error);

  if (status === 401 || status === 403) {
    return true;
  }

  return error instanceof Error && error.message.includes("invalid_grant");
}

/**
 * Resolves the full dashboard state for the current request.
 *
 * Never throws: every failure is mapped onto a state the UI knows how to
 * render. A BYOC dashboard that 500s because the customer moved a folder is
 * not a dashboard anyone will trust.
 */
export async function loadDashboardState(): Promise<DashboardState> {
  const session = await readDriveSession();

  if (!session) {
    return { status: "disconnected" };
  }

  const tokens = driveSessionToTokens(session);

  try {
    const folderId = await findOrgonautsFolderId(tokens);

    if (!folderId) {
      return { status: "missing_folder", session };
    }

    const result = await readRosterDocument(tokens, folderId);

    switch (result.status) {
      case "ok":
        return {
          status: "ready",
          session,
          document: result.document,
          folderId,
          fileId: result.fileId,
        };
      case "missing_file":
        return { status: "missing_file", session, folderId };
      case "malformed":
        return {
          status: "malformed",
          session,
          folderId,
          fileId: result.fileId,
        };
    }
  } catch (error) {
    if (isAuthError(error)) {
      console.warn("[orgonauts] Google rejected the stored credentials:", error);

      return { status: "auth_expired", session };
    }

    console.error("[orgonauts] Could not read from Drive:", error);

    return {
      status: "drive_unavailable",
      session,
      message: error instanceof Error ? error.message : "Unknown Drive error.",
    };
  }
}
