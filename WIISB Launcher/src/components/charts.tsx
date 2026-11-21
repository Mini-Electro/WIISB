import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { DayBucket, HeatCell } from "@/utils/stats";
import { cx } from "./ui";

/* Tooltip anchored inside a relatively-positioned chart container. */
function Tip({ x, y, children, width }: { x: number; y: number; children: ReactNode; width: number }) {
  const flip = x > width - 190;
  return (
    <div
      className="panel-elevated pointer-events-none absolute z-20 whitespace-nowrap px-2.5 py-1.5 text-xs shadow-xl"
      style={{ left: flip ? x - 12 : x + 12, top: Math.max(0, y - 10), transform: flip ? "translateX(-100%)" : undefined }}
    >
      {children}
    </div>
  );
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(600);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(200, Math.floor(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/* ------------------------------------------------------------ Horizontal bars */
export interface BarItem {
  key: string;
  label: string;
  value: number;
  color: string;
  detail?: string;
}

export function HBarChart({ items, format, label }: { items: BarItem[]; format: (v: number) => string; label: string }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  const [hover, setHover] = useState<string | null>(null);
  return (
    <div role="img" aria-label={label} className="space-y-3">
      {items.map((i) => (
        <div key={i.key} onMouseEnter={() => setHover(i.key)} onMouseLeave={() => setHover(null)} className="group grid grid-cols-[minmax(110px,170px)_1fr_72px] items-center gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: i.color }} />
            <span className="truncate text-[13px] font-medium">{i.label}</span>
          </div>
          <div className="relative h-3.5 rounded-r-[5px] bg-line/60" title={i.detail}>
            <div
              className="h-full rounded-r-[5px] t-transition"
              style={{ width: `${(i.value / max) * 100}%`, minWidth: i.value > 0 ? 4 : 0, background: i.color, opacity: hover && hover !== i.key ? 0.45 : 1 }}
            />
          </div>
          <div className="text-right text-[13px] font-semibold tabular-nums">{format(i.value)}</div>
        </div>
      ))}
    </div>
  );
}

/* --------------------------------------------------------------- Column chart */
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

/** Merge daily buckets into weekly ones when there are too many to draw as thin columns. */
function compact(data: { date: string; value: number }[], maxCols: number): { label: string; value: number; sub: string }[] {
  const group = Math.ceil(data.length / maxCols);
  const out: { label: string; value: number; sub: string }[] = [];
  for (let i = 0; i < data.length; i += group) {
    const slice = data.slice(i, i + group);
    out.push({ label: slice[0].date, value: slice.reduce((a, b) => a + b.value, 0), sub: group > 1 ? `${slice[0].date} → ${slice[slice.length - 1].date}` : slice[0].date });
  }
  return out;
}

export function ColumnChart({
  data,
  color,
  height = 190,
  formatValue,
  formatAxis,
  label,
}: {
  data: (DayBucket & { value: number })[];
  color: string;
  height?: number;
  formatValue: (v: number) => string;
  formatAxis: (v: number) => string;
  label: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  const pad = { l: 44, r: 8, t: 10, b: 24 };
  const cols = useMemo(() => compact(data, Math.max(10, Math.floor((width - pad.l - pad.r) / 9))), [data, width]);
  const max = niceMax(Math.max(0, ...cols.map((c) => c.value)));
  const innerW = width - pad.l - pad.r;
  const innerH = height - pad.t - pad.b;
  const slot = cols.length ? innerW / cols.length : innerW;
  const barW = Math.max(2, Math.min(18, slot * 0.62));
  const ticks = [0, 0.5, 1].map((f) => f * max);
  const xTickEvery = Math.max(1, Math.ceil(cols.length / Math.max(2, Math.floor(innerW / 90))));

  return (
    <div ref={ref} className="relative" onMouseLeave={() => setHover(null)}>
      <svg width={width} height={height} role="img" aria-label={label} onMouseMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const x = e.clientX - r.left;
        const i = Math.floor((x - pad.l) / slot);
        setHover(i >= 0 && i < cols.length ? { i, x, y: e.clientY - r.top } : null);
      }}>
        {ticks.map((t) => {
          const y = pad.t + innerH - (t / max) * innerH;
          return (
            <g key={t}>
              <line x1={pad.l} x2={width - pad.r} y1={y} y2={y} stroke="var(--c-text)" strokeOpacity={t === 0 ? 0.22 : 0.08} />
              <text x={pad.l - 8} y={y + 4} textAnchor="end" fontSize="11" fill="var(--c-muted)">
                {formatAxis(t)}
              </text>
            </g>
          );
        })}
        {cols.map((c, i) => {
          const h = (c.value / max) * innerH;
          const x = pad.l + i * slot + (slot - barW) / 2;
          return (
            <g key={c.label}>
              {hover?.i === i && <rect x={pad.l + i * slot} y={pad.t} width={slot} height={innerH} fill="var(--c-text)" opacity={0.06} />}
              {c.value > 0 && <rect x={x} y={pad.t + innerH - h} width={barW} height={Math.max(2, h)} rx={Math.min(4, barW / 2)} fill={color} opacity={hover && hover.i !== i ? 0.55 : 1} />}
              {i % xTickEvery === 0 && (
                <text x={x + barW / 2} y={height - 6} textAnchor="middle" fontSize="11" fill="var(--c-muted)">
                  {c.label.slice(5).replace("-", "/")}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {hover && cols[hover.i] && (
        <Tip x={hover.x} y={hover.y} width={width}>
          <div className="font-semibold">{formatValue(cols[hover.i].value)}</div>
          <div className="text-muted">{cols[hover.i].sub}</div>
        </Tip>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------- Heatmap */
const LEVEL_MIX = [0, 28, 48, 72, 100];
const DOW = ["Sun", "", "Tue", "", "Thu", "", "Sat"];

export function Heatmap({ weeks, format }: { weeks: HeatCell[][]; format: (secs: number) => string }) {
  const [hover, setHover] = useState<{ cell: HeatCell; x: number; y: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const bg = (l: number) => (l === 0 ? "color-mix(in oklab, var(--c-text) 7%, transparent)" : `color-mix(in oklab, var(--c-accent) ${LEVEL_MIX[l]}%, var(--c-surface))`);
  return (
    <div ref={box} className="relative" onMouseLeave={() => setHover(null)}>
      <div className="flex gap-[3px] overflow-x-auto pb-1" role="img" aria-label="Daily activity heatmap">
        <div className="mr-1 grid shrink-0 grid-rows-7 gap-[3px] text-[10px] leading-none text-muted">
          {DOW.map((d, i) => (
            <div key={i} className="flex h-[14px] items-center">{d}</div>
          ))}
        </div>
        {weeks.map((col, w) => (
          <div key={w} className="grid shrink-0 grid-rows-7 gap-[3px]">
            {col.map((c) => (
              <div
                key={c.date}
                onMouseMove={(e) => {
                  const r = box.current!.getBoundingClientRect();
                  setHover({ cell: c, x: e.clientX - r.left, y: e.clientY - r.top });
                }}
                className={cx("h-[14px] w-[14px] rounded-[3px] border border-line/40", c.inFuture && "opacity-0")}
                style={{ background: bg(c.level) }}
              />
            ))}
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-end gap-1.5 text-[11px] text-muted">
        Less
        {[0, 1, 2, 3, 4].map((l) => (
          <span key={l} className="h-[11px] w-[11px] rounded-[3px] border border-line/40" style={{ background: bg(l) }} />
        ))}
        More
      </div>
      {hover && (
        <Tip x={hover.x} y={hover.y} width={box.current?.clientWidth ?? 600}>
          <div className="font-semibold">{hover.cell.secs > 0 ? format(hover.cell.secs) : "No play"}</div>
          <div className="text-muted">{hover.cell.date}</div>
        </Tip>
      )}
    </div>
  );
}
