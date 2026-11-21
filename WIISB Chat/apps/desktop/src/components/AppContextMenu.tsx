import { useEffect, useRef, useState } from "react";
import { Scissors, Copy, ClipboardPaste, TextSelect } from "lucide-react";

type Field = HTMLInputElement | HTMLTextAreaElement;
type Open = {
  x: number;
  y: number;
  field: Field | null;
  editable: boolean;
  secret: boolean;
  text: string;
};

const TEXT_INPUTS = ["", "text", "search", "email", "url", "tel", "number", "password"];

/**
 * Replaces the browser's right-click menu (Back, Reload, Print, Inspect, …) with a small app-style one that
 * only appears where it is useful: Cut / Copy / Paste / Select all for text boxes, and Copy for selected text.
 * Everywhere else right-click does nothing, like a normal desktop app. Left alone in development so the
 * browser tools stay reachable.
 */
export function AppContextMenu() {
  const [menu, setMenu] = useState<Open | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (import.meta.env.DEV) return;
    const open = (e: MouseEvent) => {
      e.preventDefault();
      const target = e.target instanceof Element ? e.target : null;
      const field = target?.closest("input,textarea") as Field | null;
      const textBox =
        field && !field.disabled && (field instanceof HTMLTextAreaElement || TEXT_INPUTS.includes(field.type));
      const editable = !!textBox && !field!.readOnly;
      const text = textBox
        ? field!.value.slice(field!.selectionStart ?? 0, field!.selectionEnd ?? 0)
        : (window.getSelection()?.toString() ?? "");
      if (!editable && !text) return setMenu(null);
      setMenu({
        x: e.clientX,
        y: e.clientY,
        field: textBox ? field : null,
        editable,
        secret: field?.type === "password",
        text,
      });
    };
    const close = () => setMenu(null);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("contextmenu", open);
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("contextmenu", open);
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", esc);
    };
  }, []);
  // A popover lives in the browser's top layer, so the menu also shows above open dialogs (Settings, Profile, …).
  useEffect(() => {
    const el = ref.current;
    if (menu && el?.isConnected) {
      try {
        el.showPopover();
      } catch {
        /* already open */
      }
    }
  }, [menu]);
  if (!menu) return null;
  const { field, editable, secret, text } = menu;
  const run = (fn: () => void | Promise<void>) => () => {
    setMenu(null);
    void Promise.resolve(fn()).catch(() => {});
  };
  const copy = () =>
    field
      ? (field.focus(), void document.execCommand("copy"))
      : navigator.clipboard.writeText(text);
  const items = [
    editable && !secret && text && { label: "Cut", icon: Scissors, act: () => (field!.focus(), void document.execCommand("cut")) },
    !secret && text && { label: "Copy", icon: Copy, act: copy },
    editable && {
      label: "Paste",
      icon: ClipboardPaste,
      act: async () => {
        const clip = await navigator.clipboard.readText();
        field!.focus();
        document.execCommand("insertText", false, clip);
      },
    },
    field && { label: "Select all", icon: TextSelect, act: () => (field.focus(), field.select()) },
  ].filter(Boolean) as { label: string; icon: typeof Copy; act: () => void | Promise<void> }[];
  if (!items.length) return null;
  // Keep the menu inside the window.
  const left = Math.min(menu.x, window.innerWidth - 180),
    top = Math.min(menu.y, window.innerHeight - items.length * 36 - 16);
  return (
    <div
      ref={ref}
      className="app-menu"
      popover="manual"
      role="menu"
      style={{ left: Math.max(4, left), top: Math.max(4, top) }}
      // Keep focus and the text selection where they are while the menu is used.
      onMouseDown={(e) => e.preventDefault()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map(({ label, icon: Icon, act }) => (
        <button key={label} role="menuitem" onClick={run(act)}>
          <Icon size={15} />
          {label}
        </button>
      ))}
    </div>
  );
}
