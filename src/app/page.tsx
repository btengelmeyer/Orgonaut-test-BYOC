import { Banner } from "@/components/Banner";
import { RosterTable } from "@/components/RosterTable";
import { loadDashboardState, type DashboardState } from "@/lib/dashboard";
import {
  DRIVE_SCOPES,
  ORGONAUTS_FOLDER_NAME,
  ROSTER_FILE_NAME,
} from "@/lib/googleDrive";
import { LINK_ERROR_MESSAGES, parseLinkErrorCode } from "@/lib/oauth";
import type { DriveSession } from "@/lib/session";

const PRIMARY_BUTTON =
  "flex h-11 items-center justify-center gap-2 rounded-xl bg-zinc-900 px-5 text-sm font-medium text-white transition-colors hover:bg-zinc-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-300";

const SECONDARY_BUTTON =
  "flex h-11 items-center justify-center gap-2 rounded-xl border border-zinc-300 px-5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-400 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800";

/**
 * Starts the OAuth flow.
 *
 * A plain anchor, not `next/link`: the target is a Route Handler that 307s to
 * accounts.google.com. Client-side navigation cannot follow a cross-origin
 * redirect, and prefetching would burn a `state` nonce before the user clicks.
 */
function LinkDriveButton({ label }: { label: string }) {
  return (
    <a href="/api/auth/google" className={PRIMARY_BUTTON}>
      {label}
    </a>
  );
}

/**
 * The off switch.
 *
 * A real form POST rather than an onClick handler: no client-side JavaScript,
 * and the state-changing request cannot be triggered by a prefetcher.
 */
function DisconnectButton() {
  return (
    <form action="/api/auth/disconnect" method="post">
      <button type="submit" className={`w-full ${SECONDARY_BUTTON}`}>
        Disconnect Drive
      </button>
    </form>
  );
}

/** One label/value row in the connection summary. */
function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 py-1.5">
      <dt className="text-zinc-500 dark:text-zinc-400">{label}</dt>
      <dd className="truncate font-mono text-xs text-zinc-700 dark:text-zinc-300">
        {value}
      </dd>
    </div>
  );
}

/** Provenance panel: where this data came from, so the read is verifiable. */
function ConnectionDetails({
  session,
  folderId,
  fileId,
  generatedAt,
  schemaVersion,
}: {
  session: DriveSession;
  folderId: string;
  fileId?: string;
  generatedAt?: string;
  schemaVersion?: number;
}) {
  return (
    <dl className="divide-y divide-zinc-200 rounded-xl bg-zinc-50 px-4 py-2 text-sm dark:divide-zinc-800 dark:bg-zinc-800/40">
      <DetailRow label="Linked" value={session.linkedAt} />
      <DetailRow label="Folder ID" value={folderId} />
      {fileId ? <DetailRow label="File ID" value={fileId} /> : null}
      {generatedAt ? <DetailRow label="Document written" value={generatedAt} /> : null}
      {schemaVersion !== undefined ? (
        <DetailRow label="Schema version" value={`v${schemaVersion}`} />
      ) : null}
    </dl>
  );
}

/** Pre-connection explainer, shown when no session cookie is present. */
function ConnectPanel() {
  const shortScope = DRIVE_SCOPES[0].replace(
    "https://www.googleapis.com/auth/",
    "",
  );

  return (
    <>
      <p className="text-sm leading-6 text-zinc-600 dark:text-zinc-400">
        Orgonauts stores your organisation&rsquo;s data in infrastructure you
        own. Link a Google Drive account and we&rsquo;ll provision an{" "}
        <code className="font-mono text-xs">{ORGONAUTS_FOLDER_NAME}</code>{" "}
        folder, write a{" "}
        <code className="font-mono text-xs">{ROSTER_FILE_NAME}</code> document
        into it, and read it back here.
      </p>

      <LinkDriveButton label="Link Google Drive" />

      <footer className="space-y-3 border-t border-zinc-200 pt-5 dark:border-zinc-800">
        <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
          What we request
        </p>
        <ul className="space-y-2 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
          <li>
            A single scope,{" "}
            <code className="font-mono text-xs">{shortScope}</code>, which
            limits us to files Orgonauts creates.
          </li>
          <li>
            Your existing Drive files stay invisible to us &mdash; we cannot
            list, read, or modify them.
          </li>
          <li>
            Disconnecting deletes our copy of your credentials. Your folder and
            its contents stay in your Drive.
          </li>
        </ul>
      </footer>
    </>
  );
}

/**
 * Renders the state resolved by `loadDashboardState()`.
 *
 * The `switch` is exhaustive over `DashboardState`; adding a state to that
 * union without handling it here is a compile error, not a blank panel.
 */
function DashboardBody({ state }: { state: DashboardState }) {
  switch (state.status) {
    case "disconnected":
      return <ConnectPanel />;

    case "ready":
      return (
        <>
          <ConnectionDetails
            session={state.session}
            folderId={state.folderId}
            fileId={state.fileId}
            generatedAt={state.document.generatedAt}
            schemaVersion={state.document.schemaVersion}
          />
          <RosterTable document={state.document} />
          <p className="text-xs leading-5 text-zinc-500 dark:text-zinc-400">
            Read live from{" "}
            <code className="font-mono">{ORGONAUTS_FOLDER_NAME}</code>/
            <code className="font-mono">{ROSTER_FILE_NAME}</code> in your Google
            Drive. Orgonauts keeps no copy of these records.
          </p>
          <DisconnectButton />
        </>
      );

    case "missing_folder":
      return (
        <>
          <Banner variant="warning" title="Folder not found">
            Your Drive is linked, but the{" "}
            <code className="font-mono">{ORGONAUTS_FOLDER_NAME}</code> folder no
            longer exists &mdash; it was most likely deleted or moved to trash.
            Re-linking will provision a fresh one.
          </Banner>
          <LinkDriveButton label="Re-provision Drive storage" />
          <DisconnectButton />
        </>
      );

    case "missing_file":
      return (
        <>
          <Banner variant="warning" title="Roster document not found">
            The <code className="font-mono">{ORGONAUTS_FOLDER_NAME}</code> folder
            is there, but{" "}
            <code className="font-mono">{ROSTER_FILE_NAME}</code> is missing.
            Re-linking will write it again.
          </Banner>
          <ConnectionDetails
            session={state.session}
            folderId={state.folderId}
          />
          <LinkDriveButton label="Rewrite roster document" />
          <DisconnectButton />
        </>
      );

    case "malformed":
      return (
        <>
          <Banner variant="warning" title="Roster document is unreadable">
            <code className="font-mono">{ROSTER_FILE_NAME}</code> exists but does
            not match the expected schema. Because the file lives in your Drive,
            it may have been edited by hand. Re-linking overwrites it with a
            valid document.
          </Banner>
          <ConnectionDetails
            session={state.session}
            folderId={state.folderId}
            fileId={state.fileId}
          />
          <LinkDriveButton label="Overwrite with a valid document" />
          <DisconnectButton />
        </>
      );

    case "auth_expired":
      return (
        <>
          <Banner variant="warning" title="Google access has expired">
            Google rejected our stored credentials. This usually means access
            was revoked from your Google account settings. Re-link to continue.
          </Banner>
          <LinkDriveButton label="Re-link Google Drive" />
          <DisconnectButton />
        </>
      );

    case "drive_unavailable":
      return (
        <>
          <Banner variant="error" title="Could not reach Google Drive">
            Your link is intact, but the request failed: {state.message}
          </Banner>
          <DisconnectButton />
        </>
      );
  }
}

/**
 * The Orgonauts dashboard.
 *
 * A Server Component: it reads the session cookie and talks to Drive during
 * render, so the browser never sees a token and no client-side fetching is
 * needed. Reading `searchParams` opts the route into dynamic rendering, which
 * is correct for a page whose content is per-user by definition.
 */
export default async function Home(props: PageProps<"/">) {
  const [searchParams, state] = await Promise.all([
    props.searchParams,
    loadDashboardState(),
  ]);

  const justLinked = searchParams.success === "true";
  const justDisconnected = searchParams.disconnected === "true";
  const errorCode = parseLinkErrorCode(searchParams.error);

  return (
    <div className="flex flex-1 items-center justify-center bg-zinc-50 px-6 py-16 font-sans dark:bg-zinc-950">
      <main className="w-full max-w-2xl space-y-6 rounded-2xl border border-zinc-200 bg-white p-8 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <header className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500 dark:text-zinc-400">
            Orgonauts
          </p>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            {state.status === "disconnected"
              ? "Bring your own cloud"
              : "Your data plane"}
          </h1>
        </header>

        {justLinked && state.status === "ready" ? (
          <Banner variant="success" title="Google Drive linked">
            The <code className="font-mono">{ORGONAUTS_FOLDER_NAME}</code> folder
            and the <code className="font-mono">{ROSTER_FILE_NAME}</code> test
            file were successfully created in your Drive, and read back below.
          </Banner>
        ) : null}

        {justDisconnected ? (
          <Banner variant="info" title="Drive disconnected">
            Your credentials have been deleted from this browser. The{" "}
            <code className="font-mono">{ORGONAUTS_FOLDER_NAME}</code> folder and
            everything in it remain in your Google Drive.
          </Banner>
        ) : null}

        {errorCode ? (
          <Banner variant="error" title="Linking failed">
            {LINK_ERROR_MESSAGES[errorCode]}
          </Banner>
        ) : null}

        <DashboardBody state={state} />
      </main>
    </div>
  );
}
