import {
  useEffect,
  useRef,
  useState,
  useId,
  cloneElement,
  isValidElement,
  type CSSProperties,
  type ReactNode,
  type ReactElement,
} from "react";
import { X, LoaderCircle } from "lucide-react";
import { api } from "../api";
import type { User } from "../types";
/**
 * The WIISB Chat logo: two chat bubbles — a message carrying the "W" and a reply that is typing.
 * Same artwork as public/logo.svg (which also produces the app icon), drawn inline so it scales crisply.
 */
export function Mark({ small = false }: { small?: boolean }) {
  // Gradient ids must be unique per instance (the logo appears in several places at once).
  const id = useId().replace(/:/g, "");
  const ref = (name: string) => `url(#${name}-${id})`;
  return (
    <span className={"mark " + (small ? "small" : "")} aria-hidden="true">
      <svg viewBox="0 0 256 256" focusable="false">
        <defs>
          <linearGradient id={`bg-${id}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#2b1a62" />
            <stop offset="1" stopColor="#0b0a1c" />
          </linearGradient>
          <radialGradient id={`glow-${id}`} cx="0.26" cy="0.18" r="0.8">
            <stop offset="0" stopColor="#8b5cf6" stopOpacity="0.6" />
            <stop offset="1" stopColor="#8b5cf6" stopOpacity="0" />
          </radialGradient>
          <linearGradient
            id={`main-${id}`}
            gradientUnits="userSpaceOnUse"
            x1="52"
            y1="44"
            x2="170"
            y2="196"
          >
            <stop offset="0" stopColor="#ede9fe" />
            <stop offset="0.45" stopColor="#a78bfa" />
            <stop offset="1" stopColor="#6d28d9" />
          </linearGradient>
          <linearGradient
            id={`reply-${id}`}
            gradientUnits="userSpaceOnUse"
            x1="150"
            y1="136"
            x2="214"
            y2="228"
          >
            <stop offset="0" stopColor="#fda4af" />
            <stop offset="1" stopColor="#f43f5e" />
          </linearGradient>
        </defs>
        <rect x="8" y="8" width="240" height="240" rx="62" fill={ref("bg")} />
        <rect x="8" y="8" width="240" height="240" rx="62" fill={ref("glow")} />
        <rect
          x="11"
          y="11"
          width="234"
          height="234"
          rx="59"
          fill="none"
          stroke="#c4b5fd"
          strokeOpacity="0.28"
          strokeWidth="3"
        />
        <g transform="translate(0 -6)">
          <circle cx="112" cy="108" r="64" fill={ref("main")} />
          <path
            d="M60 148 42 192 94 170Z"
            fill={ref("main")}
            stroke={ref("main")}
            strokeWidth="10"
            strokeLinejoin="round"
          />
          <path
            d="M80 86 97 132 112 100 127 132 144 86"
            fill="none"
            stroke="#1b1038"
            strokeWidth="13"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx="178" cy="172" r="41" fill="#120b2b" />
          <path
            d="M200 196 214 228 180 208Z"
            fill="#120b2b"
            stroke="#120b2b"
            strokeWidth="10"
            strokeLinejoin="round"
          />
          <circle cx="178" cy="172" r="34" fill={ref("reply")} />
          <path
            d="M201 196 213 224 182 207Z"
            fill={ref("reply")}
            stroke={ref("reply")}
            strokeWidth="6"
            strokeLinejoin="round"
          />
          <circle cx="163" cy="172" r="6" fill="#fff" />
          <circle cx="178" cy="172" r="6" fill="#fff" />
          <circle cx="193" cy="172" r="6" fill="#fff" />
        </g>
      </svg>
    </span>
  );
}
/** Zoom and focal point for a cropped picture; the defaults are the plain centred "cover" fit. */
export function framing(zoom = 1, x = 50, y = 50): CSSProperties {
  return {
    objectPosition: `${x}% ${y}%`,
    transformOrigin: `${x}% ${y}%`,
    transform: zoom === 1 ? undefined : `scale(${zoom})`,
  };
}
/** The wide picture at the top of a profile, framed by the owner's zoom, position and height settings. */
export function ProfileBanner({
  user,
  height,
  bannerUrl,
}: {
  user: Partial<User>;
  /** Overrides the saved height (used for live previews while editing). */
  height?: number;
  /** Use this picture instead of loading the saved one (used for live previews). */
  bannerUrl?: string;
}) {
  const [loaded, setLoaded] = useState("");
  useEffect(() => {
    let alive = true,
      asset = "";
    setLoaded("");
    if (!bannerUrl && user.banner_id)
      void api
        .asset(user.banner_id)
        .then((u) => {
          asset = u;
          if (alive) setLoaded(u);
          else URL.revokeObjectURL(u);
        })
        .catch(() => {});
    return () => {
      alive = false;
      if (asset) URL.revokeObjectURL(asset);
    };
  }, [user.banner_id, bannerUrl]);
  const url = bannerUrl || loaded;
  return (
    <div
      className="profile-banner"
      style={{
        height: height ?? user.banner_height ?? 100,
        background: url ? undefined : user.accent,
      }}
    >
      {url && (
        <img
          src={url}
          alt=""
          style={framing(user.banner_zoom, user.banner_x, user.banner_y)}
        />
      )}
    </div>
  );
}
export function Avatar({
  user,
  size = 38,
  onClick,
}: {
  user: Partial<User>;
  size?: number;
  onClick?: () => void;
}) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    let alive = true,
      asset = "";
    setUrl("");
    if (user.avatar_id)
      void api
        .asset(
          user.avatar_id,
          document.documentElement.dataset.motion === "reduced" ||
            window.matchMedia("(prefers-reduced-motion: reduce)").matches,
        )
        .then((u) => {
          asset = u;
          if (alive) setUrl(u);
          else URL.revokeObjectURL(u);
        })
        .catch(() => {});
    return () => {
      alive = false;
      if (asset) URL.revokeObjectURL(asset);
    };
  }, [user.avatar_id]);
  const content = (
    <>
      <span
        className="avatar"
        style={{
          width: size,
          height: size,
          fontSize: size * 0.34,
          background: user.accent || undefined,
        }}
      >
        {url ? (
          <img
            src={url}
            alt=""
            style={framing(user.avatar_zoom, user.avatar_x, user.avatar_y)}
            onError={() => setUrl("")}
          />
        ) : (
          user.display_name?.slice(0, 2).toUpperCase() || "?"
        )}
      </span>
      {user.presence && (
        <i className={"presence " + user.presence} aria-label={user.presence} />
      )}
    </>
  );
  return onClick ? (
    <button
      className="avatar-wrap"
      onClick={onClick}
      aria-label={`View ${user.display_name}'s profile`}
    >
      {content}
    </button>
  ) : (
    <span className="avatar-wrap">{content}</span>
  );
}
export function IconButton({
  title,
  children,
  onClick,
  active = false,
  disabled = false,
}: {
  title: string;
  children: ReactNode;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={"icon-button " + (active ? "active" : "")}
      title={title}
      aria-label={title}
      aria-pressed={active}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    heading = useId();
  useEffect(() => {
    const element = ref.current!,
      previous = document.activeElement as HTMLElement;
    element.showModal();
    return () => {
      element.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={heading}
      className={"modal " + (wide ? "wide" : "")}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-inner">
        <header>
          <h2 id={heading}>{title}</h2>
          <IconButton title="Close dialog" onClick={onClose}>
            <X size={20} />
          </IconButton>
        </header>
        {children}
      </div>
    </dialog>
  );
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {isValidElement(children)
        ? cloneElement(children as ReactElement<any>, {
            id,
            "aria-describedby": hint ? id + "-hint" : undefined,
          })
        : children}
      {hint && <small id={id + "-hint"}>{hint}</small>}
    </div>
  );
}
export function ErrorText({ error }: { error?: string }) {
  return error ? (
    <div className="error" role="alert">
      {error}
    </div>
  ) : null;
}
export function Empty({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <h2>{title}</h2>
      <p>{children}</p>
    </div>
  );
}
export function Loading() {
  return (
    <div className="loading" role="status">
      <LoaderCircle className="spin" size={22} /> Loading…
    </div>
  );
}
export const errorMessage = (e: unknown) =>
  e instanceof Error ? e.message : "Something went wrong.";
export function useTask() {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return {
    busy,
    error,
    setError,
    run: async (fn: () => Promise<void>) => {
      setBusy(true);
      setError("");
      try {
        await fn();
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setBusy(false);
      }
    },
  };
}
