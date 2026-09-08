import type { ReactNode } from "react";

/** Visual tone of a banner. Add a variant here and every caller can use it. */
export type BannerVariant = "success" | "error" | "warning" | "info";

/**
 * Tailwind classes per variant, kept in one lookup rather than inline
 * conditionals so the palette stays consistent as banners multiply.
 */
const VARIANT_STYLES: Record<
  BannerVariant,
  { container: string; title: string; body: string; icon: string; glyph: string }
> = {
  success: {
    container:
      "border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/40",
    title: "text-emerald-900 dark:text-emerald-200",
    body: "text-emerald-800 dark:text-emerald-300",
    icon: "text-emerald-600 dark:text-emerald-400",
    glyph: "\u2713",
  },
  error: {
    container: "border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/40",
    title: "text-red-900 dark:text-red-200",
    body: "text-red-800 dark:text-red-300",
    icon: "text-red-600 dark:text-red-400",
    glyph: "\u00d7",
  },
  warning: {
    container:
      "border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40",
    title: "text-amber-900 dark:text-amber-200",
    body: "text-amber-800 dark:text-amber-300",
    icon: "text-amber-600 dark:text-amber-400",
    glyph: "!",
  },
  info: {
    container:
      "border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-800/40",
    title: "text-zinc-900 dark:text-zinc-100",
    body: "text-zinc-700 dark:text-zinc-400",
    icon: "text-zinc-500 dark:text-zinc-400",
    glyph: "i",
  },
};

export interface BannerProps {
  variant: BannerVariant;
  title: string;
  children: ReactNode;
}

/**
 * Inline status message.
 *
 * Errors and warnings announce themselves as `alert` so screen readers do not
 * silently skip the one thing on the page that needs attention.
 */
export function Banner({ variant, title, children }: BannerProps) {
  const styles = VARIANT_STYLES[variant];
  const isUrgent = variant === "error" || variant === "warning";

  return (
    <div
      role={isUrgent ? "alert" : "status"}
      className={`flex gap-3 rounded-xl border p-4 text-left ${styles.container}`}
    >
      <span aria-hidden className={`mt-0.5 font-semibold ${styles.icon}`}>
        {styles.glyph}
      </span>
      <div className="space-y-1">
        <p className={`text-sm font-semibold ${styles.title}`}>{title}</p>
        <div className={`text-sm leading-6 ${styles.body}`}>{children}</div>
      </div>
    </div>
  );
}
