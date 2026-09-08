<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Orgonauts project rules

This repository handles third-party cloud credentials. Before editing anything,
read **[docs/AI_SETUP.md](docs/AI_SETUP.md)** — it is mandatory, not advisory.

The short version, in priority order:

1. All Google access goes through `googleapis`, via `src/lib/googleDrive.ts`.
   Never add NextAuth or another auth framework.
2. The OAuth scope is `drive.file` and nothing else, ever.
3. Every Drive write checks for an existing resource first (Drive allows
   duplicate names; our read path does not).
4. Never share a mutable OAuth client across requests — build one per call.
5. No `any`, no `!`. Validate everything read from Drive: those files live in
   the customer's Drive and may have been hand-edited.
6. Failures become states in `DashboardState` / `LinkErrorCode`, never stack
   traces in the UI.

Architecture and rationale: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.
