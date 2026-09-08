import type { OrgonautsDocument, RosterMember } from "@/lib/googleDrive";

/** Badge colour per role. */
const ROLE_STYLES: Record<RosterMember["role"], string> = {
  owner:
    "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300",
  admin: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  member: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
};

/**
 * Renders an ISO timestamp as a short, unambiguous date.
 *
 * Pinned to `en-GB`/UTC rather than the runtime default: this is rendered on
 * the server, and a locale-dependent string would change with the machine.
 * Malformed dates fall back to the raw value — the file lives in the
 * customer's Drive and may have been hand-edited.
 */
function formatDate(isoDate: string): string {
  const date = new Date(isoDate);

  if (Number.isNaN(date.getTime())) {
    return isoDate;
  }

  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

export interface RosterTableProps {
  document: OrgonautsDocument<RosterMember>;
}

/**
 * The read-back view: roster records fetched live from the customer's Drive.
 *
 * Nothing here is cached or mirrored server-side. Every render is a round trip
 * to the customer's own storage, which is the entire point of BYOC.
 */
export function RosterTable({ document }: RosterTableProps) {
  if (document.records.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
        The roster document is valid but contains no records.
      </p>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800">
      <table className="w-full border-collapse text-left text-sm">
        <caption className="sr-only">
          Roster records read from {document.resource} in Google Drive
        </caption>
        <thead className="bg-zinc-50 dark:bg-zinc-800/60">
          <tr>
            <th
              scope="col"
              className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400"
            >
              Member
            </th>
            <th
              scope="col"
              className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400"
            >
              Role
            </th>
            <th
              scope="col"
              className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400"
            >
              Joined
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
          {document.records.map((member) => (
            <tr key={member.id}>
              <td className="px-4 py-3">
                <div className="font-medium text-zinc-900 dark:text-zinc-100">
                  {member.fullName}
                </div>
                <div className="text-xs text-zinc-500 dark:text-zinc-400">
                  {member.email}
                </div>
              </td>
              <td className="px-4 py-3">
                <span
                  className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium capitalize ${ROLE_STYLES[member.role]}`}
                >
                  {member.role}
                </span>
              </td>
              <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">
                {formatDate(member.joinedAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
