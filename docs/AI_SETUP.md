# Rules for AI Agents

[← Back to README](../README.md) · [← Architecture](ARCHITECTURE.md)

**If you are an AI agent (Cursor, Claude, Copilot, or otherwise) editing this
repository, read this file completely before writing a single line.**

This codebase handles other people's cloud credentials. Several things that look
like harmless simplifications are security regressions. The rules below exist to
stop the specific mistakes that are easy to make here, and each one says *why*,
so you can reason about edge cases rather than pattern-match.

Humans reviewing agent output: the [Review checklist](#review-checklist) at the
bottom is the short version.

---

## Before you start

1. Read [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) — particularly the Control
   Plane / Data Plane split. Most bad changes here come from putting something
   in the wrong plane.
2. This repo runs **Next.js 16**, which differs from most training data. When
   unsure about a framework API, read the bundled docs in
   `node_modules/next/dist/docs/` rather than recalling. See
   [Next.js 16 specifics](#nextjs-16-specifics-in-this-repo).
3. Locate the seam: **`src/lib/googleDrive.ts` is the only file permitted to
   import `googleapis`.** If your change adds that import anywhere else, the
   change is wrong.

---

## The non-negotiable rules

### R1 — Use the official `googleapis` package. Never add an auth framework.

**MUST** perform all Google API access through `googleapis`, via the helpers in
`src/lib/googleDrive.ts`.

**MUST NOT** add NextAuth / Auth.js, Passport, Clerk, Supabase Auth, Firebase
Auth, or any other authentication framework. **MUST NOT** hand-roll calls to
Google's REST endpoints with `fetch`.

*Why:* the OAuth flow here is deliberately manual and auditable end to end. An
auth framework hides token handling behind configuration, which is exactly the
part a reviewer needs to see. Hand-rolled `fetch` calls lose automatic token
refresh, retries, and typed responses.

### R2 — The scope is `drive.file`. Only. Forever.

**MUST NOT** add, widen, or substitute OAuth scopes. The single permitted scope
is declared once:

```ts
export const DRIVE_SCOPES = [
  "https://www.googleapis.com/auth/drive.file",
] as const;
```

*Why:* `drive.file` restricts the app to files it created — enforced by Google,
not by our code. Widening to `drive` or `drive.readonly` would give Orgonauts
access to every document the user owns, trigger Google's restricted-scope
verification (a third-party security assessment costing five figures a year),
and scare users off the consent screen. This is
[ADR-002](ARCHITECTURE.md#adr-002--request-only-the-drivefile-scope); it is not
a preference.

If a task appears to require a broader scope, **stop and ask the human.** The
correct answer is usually the Google Picker, not a wider scope.

### R3 — Every write must be idempotent.

**MUST** check for an existing resource before creating one. Google Drive has no
unique constraints: calling `files.create` twice with the same name produces two
files with the same name, and the read path can no longer tell which is real.

The established patterns, both already in `googleDrive.ts`:

```ts
// Folders — find, then create only if absent.
const existingFolderId = await findFolderId(drive);
if (existingFolderId) {
  return existingFolderId;
}

// Files — upsert: update in place if present, create otherwise.
const existingFileId = await findRosterFileId(drive, folderId);
if (existingFileId) {
  return (await drive.files.update({ fileId: existingFileId, media, fields: "id" }))
    .data.id ?? existingFileId;
}
```

*Why:* users re-link. Sessions expire. Retries happen. A non-idempotent write
turns each of those into clutter in the customer's personal Drive, which is both
embarrassing and, under BYOC, happening in a space we do not own.

### R4 — Never share a mutable OAuth client between requests.

**MUST** construct a client per call:

```ts
// ✅ Correct — request-scoped.
function createDriveClient(tokens: OAuthTokens): drive_v3.Drive {
  const oauth2Client = createOAuthClient();
  oauth2Client.setCredentials(tokens);
  return google.drive({ version: "v3", auth: oauth2Client });
}
```

```ts
// ❌ Forbidden — module-level singleton.
const oauth2Client = new google.auth.OAuth2(/* ... */);

export async function getTokens(code: string) {
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens); // now shared by every concurrent request
}
```

*Why:* Node servers are long-lived and handle requests concurrently. A shared
client whose credentials are overwritten per callback will, under load, serve
one customer's request using another customer's tokens. This is the single worst
bug available in this codebase.

### R5 — Strict types. Validate everything read from Drive.

**MUST NOT** use `any`, non-null assertions (`!`), or `as` casts to silence the
compiler. The one sanctioned cast is the documented `files.get` + `alt: "media"`
workaround, and it is commented as such.

**MUST** validate any data read from Drive before using it, with a type guard
returning `null` on failure — see `parseRosterDocument()`.

*Why:* the files live in the **customer's** Drive. They can open them and edit
them by hand. Under BYOC, every read is untrusted input, even though it is
"our" data. A missing field must produce a friendly message, not a runtime
crash on a page the customer is looking at.

### R6 — Secrets stay on the server.

**MUST NOT** add the `NEXT_PUBLIC_` prefix to any credential, or import
`src/lib/encryption.ts`, `src/lib/session.ts`, or `src/lib/googleDrive.ts` into
a Client Component (any file with `"use client"`).

**MUST** keep Route Handlers touching these modules on `export const runtime =
"nodejs"` — `googleapis` and `node:crypto` are not Edge-compatible.

**MUST NOT** write real credentials into any committed file. `.env.example`
holds placeholders only.

### R7 — Respect the layering.

```
page.tsx / components/   ← presentation only, zero I/O
      ↑
lib/dashboard.ts         ← orchestration, error classification, view state
      ↑
lib/googleDrive.ts       ← the ONLY file importing googleapis
lib/session.ts           ← the ONLY file reading/writing the session cookie
lib/encryption.ts        ← the ONLY file doing crypto
```

**MUST NOT** call Drive from a component, decrypt a cookie in a route handler by
hand, or add `googleapis` imports outside `googleDrive.ts`.

*Why:* this seam is the entire migration plan. When the hosted database lands,
only `session.ts` changes. Every leak across a layer converts a one-file
migration into a repo-wide one.

### R8 — Fail into a state, never into a stack trace.

**MUST** map new failure modes onto the `DashboardState` union in
`src/lib/dashboard.ts` or the `LinkErrorCode` union in `src/lib/oauth.ts`. Both
are closed unions with user-facing copy attached.

**MUST NOT** let an exception escape into page rendering.

*Why:* under BYOC, the customer can delete the folder, corrupt the file, or
revoke access at any moment. These are ordinary conditions, not exceptions, and
each needs its own message because each has a different fix.

---

## Next.js 16 specifics in this repo

Common model errors, with the correct form for this version:

| Topic | ❌ Outdated | ✅ Correct here |
| :-- | :-- | :-- |
| Page props | `{ searchParams }: { searchParams: {...} }` | `props: PageProps<"/">`, then `await props.searchParams` |
| Search params | `searchParams.foo` | `const sp = await props.searchParams` — it is a **Promise** |
| Cookies | `cookies().get(...)` | `const store = await cookies()` — it is **async** |
| Route params | `params.id` | `await params` — also a Promise |
| Layout props | hand-written types | `LayoutProps<"/">` (globally generated) |
| API routes | `pages/api/*.ts` + `req`/`res` | App Router `route.ts` exporting `GET`/`POST` |

`PageProps`, `LayoutProps`, and `RouteContext` are generated by `next dev`,
`next build`, or `next typegen` and are globally available without import.

Setting cookies is only possible in **Route Handlers and Server Actions** — not
during page render. That constraint is why token refresh currently isn't
persisted (see [roadmap gap #2](ARCHITECTURE.md#known-gaps-and-roadmap)).

---

## Recipes

### Add a new document type (e.g. `projects.json`)

1. In `googleDrive.ts`: add the record interface, a `parseXDocument()` type
   guard, an upsert writer, and a reader. Follow the roster functions exactly.
2. Reuse the `OrgonautsDocument<T>` envelope and set
   `schemaVersion: CURRENT_SCHEMA_VERSION`. Never invent a bare-array format.
3. Extend `DashboardState` in `dashboard.ts` for the new failure modes.
4. Add a component under `src/components/`.
5. Handle the new states in `page.tsx` — TypeScript will tell you where.

### Add a Drive operation

Add it to `googleDrive.ts` as an exported function taking `tokens: OAuthTokens`
first. Build a client with `createDriveClient(tokens)`. Apply R3 (idempotency).
Return plain data — never a `googleapis` response object, which would leak the
dependency across the seam.

### Add a dashboard state

Add a variant to the `DashboardState` union, return it from
`loadDashboardState()`, then handle it in the `switch` in `page.tsx`. The
compiler enforces the last step.

---

## Definition of done

Every change must pass all three, with no new warnings:

```bash
npx tsc --noEmit    # types
npm run lint        # eslint
npm run build       # production build
```

For anything touching auth, session, or Drive, also verify manually against the
table in the [README](../README.md#verifying-it-works). At minimum: link, reload
the dashboard, click **Link Google Drive** a second time (confirm the folder ID
is unchanged and no duplicate file appears), then disconnect.

**Never claim a flow works if you have not run it.** The OAuth round trip needs
a real Google account; if you cannot complete it, say so plainly and state
exactly which parts you did verify.

---

## Review checklist

Copy this into a PR description:

- [ ] No new `googleapis` import outside `src/lib/googleDrive.ts`
- [ ] Scope still `drive.file` only, unchanged
- [ ] Every new write checks for an existing resource first
- [ ] No module-level OAuth client; clients built per request
- [ ] No `any`, no `!`, no unexplained `as`
- [ ] Data read from Drive is validated before use
- [ ] No secret gained a `NEXT_PUBLIC_` prefix; no server-only module imported into a Client Component
- [ ] New failure modes appear in `DashboardState` or `LinkErrorCode` with user-facing copy
- [ ] `tsc --noEmit`, `npm run lint`, and `npm run build` all pass
- [ ] Docs updated if behaviour or setup changed

---

[← Back to README](../README.md) · [← Architecture](ARCHITECTURE.md)
