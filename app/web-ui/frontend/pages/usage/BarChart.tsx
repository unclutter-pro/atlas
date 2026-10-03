/**
 * Small single-series SVG bar chart (no chart library). One bar per point,
 * baseline-anchored with rounded tops, recessive grid, hover tooltip, and an
 * optional href per bar.
 */

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { navigate } from "../../router";

export interface BarPoint {
  key: string;
  value: number;
  /** X-axis label (only a subset is drawn when bars are narrow). */
  label: string;
  tooltip: ReactNode;
  href?: string;
}

const HEIGHT = 200;
const PAD = { top: 12, right: 8, bottom: 24, left: 56 };
const GAP = 2;

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/** Round the max up to a 1/2/2.5/5 × 10^n step so ticks land on readable values. */
function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.999; v += step) ticks.push(Number(v.toPrecision(12)));
  return ticks;
}

/** Rect with only the top corners rounded. */
function barPath(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

export function BarChart(props: { points: BarPoint[]; formatValue: (v: number) => string; ariaLabel: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const { points } = props;
  const n = points.length;
  const max = Math.max(0, ...points.map((p) => p.value));
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1] || 1;

  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const slot = n ? plotW / n : 0;
  const barW = Math.max(1, slot - (slot > 4 ? GAP : 0.5));
  const y = (v: number) => PAD.top + plotH - (v / top) * plotH;
  // Roughly one label per 64px, always including the last day.
  const labelEvery = Math.max(1, Math.ceil(64 / Math.max(slot, 1)));
  const hovered = hover != null ? points[hover] : null;

  return (
    <div className="usage-chart" ref={ref}>
      {width > 0 && (
        <svg width={width} height={HEIGHT} role="img" aria-label={props.ariaLabel} onMouseLeave={() => setHover(null)}>
          {ticks.map((t) => (
            <g key={t}>
              <line className="usage-chart-grid" x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} />
              <text className="usage-chart-axis" x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end">
                {props.formatValue(t)}
              </text>
            </g>
          ))}
          {points.map((p, i) => {
            const x = PAD.left + i * slot + (slot - barW) / 2;
            const h = Math.max(0, y(0) - y(p.value));
            const showLabel = (n - 1 - i) % labelEvery === 0;
            return (
              <g
                key={p.key}
                className={`usage-chart-col${p.href ? " is-link" : ""}${hover === i ? " is-hover" : ""}`}
                onMouseEnter={() => setHover(i)}
                onClick={p.href ? () => navigate(p.href!) : undefined}
              >
                <rect className="usage-chart-hit" x={PAD.left + i * slot} y={PAD.top} width={slot} height={plotH} />
                {h > 0 && <path className="usage-chart-bar" d={barPath(x, y(p.value), barW, h, 4)} />}
                {showLabel && (
                  <text className="usage-chart-axis" x={x + barW / 2} y={HEIGHT - 6} textAnchor="middle">
                    {p.label}
                  </text>
                )}
              </g>
            );
          })}
          <line className="usage-chart-baseline" x1={PAD.left} x2={width - PAD.right} y1={y(0)} y2={y(0)} />
        </svg>
      )}
      {hovered && hover != null && (
        <div
          className="usage-chart-tooltip"
          style={{
            left: Math.min(Math.max(PAD.left + (hover + 0.5) * slot, 90), width - 90),
            top: Math.max(0, y(hovered.value) - 8),
          }}
        >
          {hovered.tooltip}
        </div>
      )}
    </div>
  );
}
