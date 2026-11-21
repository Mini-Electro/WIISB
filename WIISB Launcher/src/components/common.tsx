import type { ReactNode } from "react";
import { cx } from "./ui";

export function Logo({ size = 32, className }: { size?: number; className?: string }) {
  return <img src="/wiisb-mark.svg" alt="" width={size} height={size} draggable={false} className={cx("shrink-0 drop-shadow-[0_0_14px_var(--c-accent)]", className)} />;
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <div className={cx("display leading-none", className)}>
      <div className="text-[17px] font-bold tracking-[0.14em]">WIISB</div>
      <div className="mt-[3px] text-[10px] font-semibold tracking-[0.34em] text-accent2">LAUNCHER</div>
    </div>
  );
}

/** Original illustration used by empty states (a pad with orbiting stars). */
export function EmptyIllustration({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 220 150" className={className} fill="none" aria-hidden>
      <defs>
        <linearGradient id="eg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--c-accent-2)" />
          <stop offset="1" stopColor="var(--c-accent)" />
        </linearGradient>
        <radialGradient id="eglow" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="var(--c-accent)" stopOpacity="0.35" />
          <stop offset="1" stopColor="var(--c-accent)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <ellipse cx="110" cy="78" rx="100" ry="62" fill="url(#eglow)" />
      <path
        d="M62 58c-14 0-26 14-30 38-2 12 6 18 14 14 7-4 12-12 22-12h64c10 0 15 8 22 12 8 4 16-2 14-14-4-24-16-38-30-38H62z"
        fill="var(--c-elevated)"
        stroke="url(#eg)"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
      <path d="M78 74v16M70 82h16" stroke="url(#eg)" strokeWidth="3.5" strokeLinecap="round" />
      <circle cx="142" cy="76" r="4.5" fill="url(#eg)" />
      <circle cx="154" cy="86" r="4.5" fill="var(--c-accent)" opacity="0.7" />
      <path d="M30 28l3 7 7 3-7 3-3 7-3-7-7-3 7-3z" fill="var(--c-accent-2)" opacity="0.8" />
      <path d="M186 22l2.2 5 5 2.2-5 2.2-2.2 5-2.2-5-5-2.2 5-2.2z" fill="var(--c-accent)" opacity="0.8" />
      <circle cx="176" cy="122" r="2.5" fill="var(--c-accent-2)" opacity="0.6" />
      <circle cx="40" cy="116" r="2" fill="var(--c-accent)" opacity="0.6" />
    </svg>
  );
}

export function EmptyState({ title, children, action, compact }: { title: string; children?: ReactNode; action?: ReactNode; compact?: boolean }) {
  return (
    <div className={cx("flex flex-col items-center justify-center text-center", compact ? "py-8" : "py-16")}>
      <EmptyIllustration className={compact ? "h-24 w-auto" : "h-36 w-auto"} />
      <h3 className="display mt-3 text-lg font-semibold">{title}</h3>
      {children && <p className="mt-1 max-w-md text-[13px] leading-relaxed text-muted">{children}</p>}
      {action && <div className="mt-5 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}

export function StatTile({ icon, label, value, sub }: { icon: ReactNode; label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="panel flex items-start gap-3 p-4">
      <div className="grid h-10 w-10 shrink-0 place-items-center rounded-ctl bg-accent/15 text-accent2">{icon}</div>
      <div className="min-w-0">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</div>
        <div className="display mt-0.5 truncate text-xl font-semibold leading-tight">{value}</div>
        {sub && <div className="mt-0.5 truncate text-xs text-muted">{sub}</div>}
      </div>
    </div>
  );
}

export function PageHeader({ eyebrow, title, children }: { eyebrow?: string; title: string; children?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        {eyebrow && <div className="eyebrow mb-1">{eyebrow}</div>}
        <h1 className="display text-[28px] font-bold leading-none">{title}</h1>
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}
