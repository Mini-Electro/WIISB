import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Loader2, X } from "lucide-react";
import { useMotionScale } from "@/hooks/hooks";

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

/* ------------------------------------------------------------------ Button */
type Variant = "primary" | "secondary" | "ghost" | "danger" | "success";
type Size = "sm" | "md" | "lg";

const VARIANT: Record<Variant, string> = {
  primary: "bg-accent text-onaccent hover:brightness-110 shadow-[0_8px_26px_-8px_var(--c-accent)]",
  secondary: "bg-elevated text-fg border border-line hover:border-line-strong hover:brightness-110",
  ghost: "text-muted hover:text-fg wash",
  danger: "bg-danger/15 text-danger border border-danger/30 hover:bg-danger/25",
  success: "bg-success/15 text-success border border-success/30",
};
const SIZE: Record<Size, string> = {
  sm: "h-8 px-3 text-[13px] gap-1.5",
  md: "h-10 px-4 text-sm gap-2",
  lg: "h-12 px-6 text-[15px] gap-2.5",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  loading?: boolean;
}

export function Button({ variant = "secondary", size = "md", icon, loading, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      className={cx(
        "inline-flex shrink-0 items-center justify-center rounded-ctl font-semibold t-transition select-none",
        "disabled:cursor-not-allowed disabled:opacity-50 grow",
        VARIANT[variant],
        SIZE[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 size={16} className="spin" /> : icon}
      {children}
    </button>
  );
}

/* -------------------------------------------------------------- IconButton */
export function IconButton({
  label,
  active,
  children,
  className,
  tooltipSide = "bottom",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean; tooltipSide?: "bottom" | "right" | "top" }) {
  return (
    <Tooltip label={label} side={tooltipSide}>
      <button
        type="button"
        aria-label={label}
        className={cx(
          "grid h-9 w-9 place-items-center rounded-ctl t-transition wash grow-lg",
          active ? "text-accent2" : "text-muted hover:text-fg",
          className,
        )}
        {...rest}
      >
        {children}
      </button>
    </Tooltip>
  );
}

/* ----------------------------------------------------------------- Tooltip */
export function Tooltip({ label, side = "bottom", children }: { label: string; side?: "bottom" | "right" | "top"; children: ReactNode }) {
  const pos = side === "right" ? "left-full top-1/2 ml-3 -translate-y-1/2" : side === "top" ? "bottom-full left-1/2 mb-2 -translate-x-1/2" : "top-full left-1/2 mt-2 -translate-x-1/2";
  return (
    <span className="group/tt relative inline-flex">
      {children}
      <span
        role="tooltip"
        className={cx(
          "pointer-events-none absolute z-[80] whitespace-nowrap rounded-md border border-line-strong bg-elevated px-2 py-1 text-xs font-medium text-fg opacity-0 shadow-xl",
          "t-transition group-hover/tt:opacity-100 group-hover/tt:delay-500",
          pos,
        )}
      >
        {label}
      </span>
    </span>
  );
}

/* ------------------------------------------------------------------ Toggle */
export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        "relative h-6 w-11 shrink-0 rounded-full border t-transition grow disabled:opacity-50",
        checked ? "border-transparent bg-accent" : "border-line-strong bg-elevated",
      )}
    >
      <span
        className={cx(
          "absolute top-0.5 h-[18px] w-[18px] rounded-full bg-white shadow t-transition",
          checked ? "left-[22px]" : "left-0.5",
        )}
      />
    </button>
  );
}

/* --------------------------------------------------------------- Segmented */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-ctl border border-line bg-elevated p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cx(
            "inline-flex h-8 items-center gap-1.5 rounded-[calc(var(--radius)*0.5)] px-3 text-[13px] font-semibold t-transition grow-sm",
            value === o.value ? "bg-accent text-onaccent" : "text-muted hover:text-fg",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ Select */
export function Select<T extends string>({
  value,
  options,
  onChange,
  label,
  className,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
  className?: string;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      className={cx(
        "h-10 cursor-pointer rounded-ctl border border-line bg-elevated px-3 pr-8 text-sm font-medium t-transition hover:border-line-strong",
        className,
      )}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/* ----------------------------------------------------------------- Inputs */
export function TextInput({ className, ...rest }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      type="text"
      spellCheck={false}
      className={cx(
        "h-10 w-full rounded-ctl border border-line bg-elevated px-3 text-sm placeholder:text-muted/70 t-transition",
        "hover:border-line-strong focus:border-accent focus:outline-none",
        className,
      )}
      {...rest}
    />
  );
}

/* --------------------------------------------------------------- Badge etc */
export function Badge({ tone = "neutral", children, className }: { tone?: "neutral" | "success" | "warning" | "danger" | "accent"; children: ReactNode; className?: string }) {
  const tones = {
    neutral: "bg-white/8 text-muted border-line",
    success: "bg-success/12 text-success border-success/25",
    warning: "bg-warning/12 text-warning border-warning/25",
    danger: "bg-danger/12 text-danger border-danger/25",
    accent: "bg-accent/15 text-accent2 border-accent/30",
  };
  return (
    <span data-tone={tone} className={cx("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold", tones[tone], className)}>
      {children}
    </span>
  );
}

export function SettingRow({ title, description, children, stack }: { title: string; description?: ReactNode; children?: ReactNode; stack?: boolean }) {
  return (
    <div className={cx("flex gap-6 border-b border-line py-4 last:border-b-0", stack ? "flex-col" : "items-center justify-between")}>
      <div className="min-w-0 max-w-xl">
        <div className="text-sm font-semibold">{title}</div>
        {description && <div className="mt-0.5 text-[13px] leading-snug text-muted">{description}</div>}
      </div>
      {children && <div className={cx("shrink-0", stack && "w-full")}>{children}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------- Modal */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = 520,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  const scale = useMotionScale();
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    ref.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  const d = 0.18 * scale;
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[100] grid place-items-center bg-black/60 p-6 backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: d }}
          onMouseDown={(e) => e.target === e.currentTarget && onClose()}
        >
          <motion.div
            ref={ref}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-labelledby={id}
            initial={{ opacity: 0, y: 14 * scale, scale: 1 - 0.03 * scale }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8 * scale }}
            transition={{ duration: d * 1.3, ease: [0.2, 0.7, 0.2, 1] }}
            style={{ width }}
            className="panel-elevated flex max-h-[88vh] max-w-full flex-col shadow-2xl outline-none"
          >
            <div className="flex items-start justify-between gap-4 border-b border-line px-6 pb-4 pt-5">
              <div>
                <h2 id={id} className="display text-xl font-semibold">
                  {title}
                </h2>
                {description && <div className="mt-1 text-[13px] leading-snug text-muted">{description}</div>}
              </div>
              <button aria-label="Close" onClick={onClose} className="-mr-2 -mt-1 grid h-8 w-8 place-items-center rounded-ctl text-muted wash hover:text-fg">
                <X size={18} />
              </button>
            </div>
            {children && <div className="overflow-y-auto px-6 py-5">{children}</div>}
            {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-6 py-4">{footer}</div>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
