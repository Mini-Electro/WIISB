// Click ripple: a soft circle that spreads from the pointer inside whatever you clicked.
// One delegated listener covers every button, link-like card, switch and option in the app.
// The circle is drawn in a fixed overlay clipped to the element, so layouts are never touched.

const TARGETS = "button, [role='button'], [role='link'], [role='radio'], [role='switch'], [role='tab'], a[href], summary, [data-ripple]";

/** Size of a circle that, centred on (x, y), is guaranteed to cover a w×h box. */
export function rippleSize(w: number, h: number, x: number, y: number): number {
  return Math.ceil(Math.hypot(Math.max(x, w - x), Math.max(y, h - y)) * 2);
}

/** Ripples on huge elements (whole-page areas) look wrong, so there is an upper size limit. */
export const MAX_RIPPLE_WIDTH = 900;

export function shouldRipple(el: HTMLElement, rect: { width: number; height: number }): boolean {
  if (el.matches(":disabled, [aria-disabled='true']") || el.closest("[data-no-ripple]")) return false;
  return rect.width >= 8 && rect.height >= 8 && rect.width <= MAX_RIPPLE_WIDTH;
}

export function installRipples(doc: Document = document): () => void {
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0 || doc.documentElement.dataset.motion === "none") return;
    const target = (e.target as HTMLElement | null)?.closest?.<HTMLElement>(TARGETS);
    if (!target) return;
    const rect = target.getBoundingClientRect();
    if (!shouldRipple(target, rect)) return;

    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const size = rippleSize(rect.width, rect.height, x, y);
    const style = getComputedStyle(target);

    const host = doc.createElement("span");
    host.className = "ripple-host";
    Object.assign(host.style, {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      borderRadius: style.borderRadius,
      color: style.color,
    });
    const dot = doc.createElement("span");
    dot.className = "ripple-dot";
    Object.assign(dot.style, { width: `${size}px`, height: `${size}px`, left: `${x - size / 2}px`, top: `${y - size / 2}px` });
    host.appendChild(dot);
    doc.body.appendChild(host);

    const remove = () => host.remove();
    dot.addEventListener("animationend", remove, { once: true });
    window.setTimeout(remove, 1500); // safety net if animations are throttled
  };
  doc.addEventListener("pointerdown", onDown, { capture: true, passive: true });
  return () => doc.removeEventListener("pointerdown", onDown, { capture: true });
}
