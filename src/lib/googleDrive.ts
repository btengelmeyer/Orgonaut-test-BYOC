/**
 * Google Drive integration for the Orgonauts BYOC prototype.
 *
 * This is the *entire* storage adapter for V1: the customer's own Drive is the
 * database, and this module is the only place that knows it. Every function
 * here is pure I/O against Google — no Next.js types leak in, so the same code
 * can later be called from a worker, a CLI, or a test harness.
 *
 * Two rules this file exists to enforce (see `docs/AI_SETUP.md`):
 *
 *   1. **Never share a mutable OAuth client.** A module-level client whose
 *      credentials are overwritten per request is a cross-tenant data leak in
 *      a long-lived Node process. Each call builds its own client.
 *   2. **Every write is idempotent.** Drive has no unique constraints and will
 *      happily create five folders with the same name. We look before we leap.
 */

import { google, type Auth, type drive_v3 } from "googleapis";

/**
 * The only scope we ever request.
 *
 * `drive.file` is per-file consent: the app can see and touch *files it
 * created* and nothing else. The user's existing documents remain invisible to
 * Orgonauts even after linking.
 */
export const DRIVE_SCOPES = [
  "https://www.googleapis.com/auth/drive.file",
] as const;

/** Root folder Orgonauts provisions inside the customer's Drive. */
export const ORGONAUTS_FOLDER_NAME = "Orgonauts_Data";

/** The document backing the roster resource. */
export const ROSTER_FILE_NAME = "roster-test.json";

/** Schema version written into every document we create. */
export const CURRENT_SCHEMA_VERSION = 1;

const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const JSON_MIME_TYPE = "application/json";

/**
 * OAuth credentials as returned by Google (access token, optional refresh
 * token, expiry, granted scope). Aliased so callers never depend on the
 * `googleapis` import path directly.
 */
export type OAuthTokens = Auth.Credentials;

/** One row of the roster stored in the customer's Drive. */
export interface RosterMember {
  id: string;
  fullName: string;
  email: string;
  role: "owner" | "admin" | "member";
  joinedAt: string;
}

/**
 * Envelope wrapping every document Orgonauts writes.
 *
 * `schemaVersion` is what makes the eventual SQLite/Postgres migration a
 * mechanical job instead of an archaeology project: a reader can tell which
 * shape it is looking at without inspecting the payload.
 */
export interface OrgonautsDocument<T> {
  schemaVersion: number;
  resource: string;
  generatedAt: string;
  records: T[];
}

/**
 * Reads a required environment variable.
 *
 * Deliberately evaluated lazily (inside the factory rather than at module
 * load) so a missing secret surfaces as a handled request error instead of
 * crashing `next build`.
 */
function requireEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(
      `Missing required environment variable "${name}". Add it to .env.local.`,
    );
  }

  return value;
}

/** Builds a request-scoped OAuth2 client from the configured credentials. */
function createOAuthClient(): Auth.OAuth2Client {
  return new google.auth.OAuth2(
    requireEnv("GOOGLE_CLIENT_ID"),
    requireEnv("GOOGLE_CLIENT_SECRET"),
    requireEnv("GOOGLE_REDIRECT_URI"),
  );
}

/**
 * Builds a Drive v3 client authenticated as the customer.
 *
 * When the supplied credentials carry a refresh token and an expired
 * `expiry_date`, the client silently obtains a new access token before the
 * request. That refreshed token lives only for this request — persisting it
 * requires a Route Handler, since a rendering page cannot set cookies.
 */
function createDriveClient(tokens: OAuthTokens): drive_v3.Drive {
  const oauth2Client = createOAuthClient();
  oauth2Client.setCredentials(tokens);

  return google.drive({ version: "v3", auth: oauth2Client });
}

/**
 * Escapes a literal for a Drive query string.
 *
 * Our names are constants today, so this is belt-and-braces — but the moment
 * a name becomes user-supplied, an unescaped quote turns a lookup into a
 * query-injection bug.
 */
function escapeQueryValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * Builds the Google consent URL the user is redirected to.
 *
 * @param state Anti-CSRF nonce echoed back to our callback. Optional only so
 *   the function stays usable in isolation (tests, scripts); production
 *   callers should always pass one.
 */
export function getAuthUrl(state?: string): string {
  return createOAuthClient().generateAuthUrl({
    // `offline` is what makes Google issue a refresh token, which is the
    // difference between "Orgonauts can sync tonight" and "Orgonauts works
    // until the access token expires in an hour".
    access_type: "offline",
    // Google only returns a refresh token on the *first* consent unless we
    // force the screen. Re-linking an already-approved account would
    // otherwise silently hand us an un-renewable session.
    prompt: "consent",
    scope: [...DRIVE_SCOPES],
    state,
  });
}

/**
 * Exchanges a one-time authorization code for tokens.
 *
 * The credentials are set on the request-scoped client used for the exchange
 * and then returned to the caller; we intentionally do not stash them on a
 * shared singleton (see the rules at the top of this file).
 */
export async function getTokens(code: string): Promise<OAuthTokens> {
  const oauth2Client = createOAuthClient();
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);

  return tokens;
}

/**
 * Looks up the `Orgonauts_Data` folder without creating it.
 *
 * Safe under `drive.file`: that scope restricts `files.list` to files this app
 * created, so this can never enumerate the customer's own documents.
 *
 * @returns The folder ID, or `null` if the customer deleted it.
 */
async function findFolderId(drive: drive_v3.Drive): Promise<string | null> {
  const response = await drive.files.list({
    q: `name = '${escapeQueryValue(ORGONAUTS_FOLDER_NAME)}' and mimeType = '${FOLDER_MIME_TYPE}' and trashed = false`,
    fields: "files(id, name)",
    pageSize: 1,
    spaces: "drive",
  });

  return response.data.files?.[0]?.id ?? null;
}

/** Locates `roster-test.json` inside a known folder. */
async function findRosterFileId(
  drive: drive_v3.Drive,
  folderId: string,
): Promise<string | null> {
  const response = await drive.files.list({
    q: `name = '${escapeQueryValue(ROSTER_FILE_NAME)}' and '${escapeQueryValue(folderId)}' in parents and trashed = false`,
    fields: "files(id, name)",
    pageSize: 1,
    spaces: "drive",
  });

  return response.data.files?.[0]?.id ?? null;
}

/** Public read-only lookup used by the dashboard. */
export async function findOrgonautsFolderId(
  tokens: OAuthTokens,
): Promise<string | null> {
  return findFolderId(createDriveClient(tokens));
}

/**
 * Provisions the `Orgonauts_Data` folder and returns its ID.
 *
 * Idempotent: re-linking an account reuses the existing folder instead of
 * littering the customer's Drive with duplicates.
 */
export async function createOrgonautsFolder(
  tokens: OAuthTokens,
): Promise<string> {
  const drive = createDriveClient(tokens);

  const existingFolderId = await findFolderId(drive);
  if (existingFolderId) {
    return existingFolderId;
  }

  const created = await drive.files.create({
    requestBody: {
      name: ORGONAUTS_FOLDER_NAME,
      mimeType: FOLDER_MIME_TYPE,
    },
    fields: "id",
  });

  if (!created.data.id) {
    throw new Error("Drive created the folder but returned no folder ID.");
  }

  return created.data.id;
}

/** Fixed sample roster; stands in for data a real tenant would sync. */
function buildSampleRoster(): RosterMember[] {
  return [
    {
      id: "usr_01",
      fullName: "Ada Lovelace",
      email: "ada@orgonauts.test",
      role: "owner",
      joinedAt: "2026-01-14T09:00:00.000Z",
    },
    {
      id: "usr_02",
      fullName: "Grace Hopper",
      email: "grace@orgonauts.test",
      role: "admin",
      joinedAt: "2026-02-02T13:30:00.000Z",
    },
    {
      id: "usr_03",
      fullName: "Alan Turing",
      email: "alan@orgonauts.test",
      role: "member",
      joinedAt: "2026-03-21T17:45:00.000Z",
    },
  ];
}

/**
 * Writes `roster-test.json` into the Orgonauts folder and returns its file ID.
 *
 * An **upsert**: if the document already exists we replace its contents rather
 * than adding a second file with the same name. Drive permits duplicate names,
 * and duplicates would make the read path ambiguous — "which roster is the
 * real one?" is not a question we want to answer at runtime.
 *
 * @param folderId ID returned by {@link createOrgonautsFolder}.
 */
export async function createTestJsonFile(
  tokens: OAuthTokens,
  folderId: string,
): Promise<string> {
  const drive = createDriveClient(tokens);

  const document: OrgonautsDocument<RosterMember> = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    resource: "roster",
    generatedAt: new Date().toISOString(),
    records: buildSampleRoster(),
  };

  const media = {
    mimeType: JSON_MIME_TYPE,
    body: JSON.stringify(document, null, 2),
  };

  const existingFileId = await findRosterFileId(drive, folderId);

  if (existingFileId) {
    const updated = await drive.files.update({
      fileId: existingFileId,
      media,
      fields: "id",
    });

    return updated.data.id ?? existingFileId;
  }

  const created = await drive.files.create({
    requestBody: {
      name: ROSTER_FILE_NAME,
      // `parents` is what nests the file; omitting it drops the file in the
      // Drive root where the customer will never find it.
      parents: [folderId],
      mimeType: JSON_MIME_TYPE,
    },
    media,
    fields: "id",
  });

  if (!created.data.id) {
    throw new Error("Drive created the file but returned no file ID.");
  }

  return created.data.id;
}

/** Narrows one untrusted record into a {@link RosterMember}. */
function parseRosterMember(value: unknown): RosterMember | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const role = candidate.role;

  if (
    typeof candidate.id !== "string" ||
    typeof candidate.fullName !== "string" ||
    typeof candidate.email !== "string" ||
    typeof candidate.joinedAt !== "string" ||
    (role !== "owner" && role !== "admin" && role !== "member")
  ) {
    return null;
  }

  return {
    id: candidate.id,
    fullName: candidate.fullName,
    email: candidate.email,
    role,
    joinedAt: candidate.joinedAt,
  };
}

/**
 * Validates a decoded document.
 *
 * This matters more here than in a conventional app: the file lives in the
 * *customer's* Drive, where they can open it and edit it by hand. Under BYOC,
 * every read is untrusted input. Returns `null` rather than throwing so the
 * dashboard can render "this document is malformed" instead of a stack trace.
 */
export function parseRosterDocument(
  value: unknown,
): OrgonautsDocument<RosterMember> | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const candidate = value as Record<string, unknown>;

  if (
    typeof candidate.schemaVersion !== "number" ||
    typeof candidate.resource !== "string" ||
    typeof candidate.generatedAt !== "string" ||
    !Array.isArray(candidate.records)
  ) {
    return null;
  }

  const records: RosterMember[] = [];

  for (const record of candidate.records) {
    const member = parseRosterMember(record);

    if (!member) {
      return null;
    }

    records.push(member);
  }

  return {
    schemaVersion: candidate.schemaVersion,
    resource: candidate.resource,
    generatedAt: candidate.generatedAt,
    records,
  };
}

/** Outcome of trying to read the roster document back out of Drive. */
export type RosterReadResult =
  | { status: "ok"; document: OrgonautsDocument<RosterMember>; fileId: string }
  | { status: "missing_file" }
  | { status: "malformed"; fileId: string };

/**
 * Reads and validates `roster-test.json` from the customer's Drive.
 *
 * Distinguishes "no file" from "unreadable file" because the two need
 * different fixes: one is a re-provision, the other is a human looking at a
 * document they probably edited.
 *
 * @throws Propagates Drive/auth failures (revoked token, network, quota) for
 *   the caller to classify.
 */
export async function readRosterDocument(
  tokens: OAuthTokens,
  folderId: string,
): Promise<RosterReadResult> {
  const drive = createDriveClient(tokens);
  const fileId = await findRosterFileId(drive, folderId);

  if (!fileId) {
    return { status: "missing_file" };
  }

  const response = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "text" },
  );

  // `files.get` is typed as returning file *metadata*; with `alt: "media"` it
  // returns the file body instead. The double cast is the standard workaround
  // for that long-standing gap in the googleapis typings.
  const raw = response.data as unknown as string;

  try {
    const document = parseRosterDocument(JSON.parse(raw));

    return document
      ? { status: "ok", document, fileId }
      : { status: "malformed", fileId };
  } catch {
    return { status: "malformed", fileId };
  }
}
