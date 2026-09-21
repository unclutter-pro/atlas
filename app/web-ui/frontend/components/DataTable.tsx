import type { MouseEvent, ReactNode } from "react";
import { navigate } from "../router";

export interface Column<T> {
  key: string;
  header: ReactNode;
  /** Cell content; defaults to String(row[key]). */
  render?: (row: T) => ReactNode;
  /** Right-aligned, tabular figures. */
  numeric?: boolean;
  align?: "left" | "center" | "right";
  width?: number | string;
  className?: string;
}

/**
 * Table with optional whole-row links. Links/buttons inside cells keep
 * working; ctrl/cmd/middle-click on a row opens it in a new tab.
 */
export function DataTable<T>(props: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string | number;
  rowHref?: (row: T) => string | null | undefined;
  /** Shown instead of the table when there are no rows (use <EmptyState compact>). */
  empty?: ReactNode;
  dense?: boolean;
}) {
  if (props.rows.length === 0 && props.empty) return <>{props.empty}</>;

  const onRowClick = (e: MouseEvent<HTMLTableRowElement>, href: string) => {
    if ((e.target as HTMLElement).closest("a,button,input,select,textarea,label")) return;
    if (window.getSelection()?.toString()) return; // user is selecting text
    if (e.metaKey || e.ctrlKey || e.button === 1) window.open(href, "_blank");
    else navigate(href);
  };

  const cellClass = (c: Column<T>) => [c.numeric ? "num" : c.align ? `align-${c.align}` : "", c.className ?? ""].join(" ").trim() || undefined;

  return (
    <div className="table-wrap">
      <table className={`table${props.dense ? " table-dense" : ""}`}>
        <thead>
          <tr>
            {props.columns.map((c) => (
              <th key={c.key} className={cellClass(c)} style={c.width != null ? { width: c.width } : undefined}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row, i) => {
            const href = props.rowHref?.(row) ?? null;
            return (
              <tr
                key={props.rowKey(row, i)}
                className={href ? "is-link" : undefined}
                onClick={href ? (e) => onRowClick(e, href) : undefined}
                onAuxClick={href ? (e) => e.button === 1 && onRowClick(e, href) : undefined}
              >
                {props.columns.map((c) => (
                  <td key={c.key} className={cellClass(c)}>
                    {c.render ? c.render(row) : String((row as Record<string, unknown>)[c.key] ?? "")}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
