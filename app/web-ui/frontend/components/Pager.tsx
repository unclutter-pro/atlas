import { useQueryParam } from "../router";
import { Button } from "./Button";

/** Current page from ?page= (1-based). */
export function usePage(): [number, (page: number) => void] {
  const [raw, set] = useQueryParam("page");
  const page = Math.max(1, Number.parseInt(raw, 10) || 1);
  return [page, (p: number) => set(p <= 1 ? null : p, { replace: false })];
}

/** Prev/next driven by ?page=. Pass `total` when known, else `hasMore`. */
export function Pager(props: { pageSize: number; total?: number; hasMore?: boolean; itemLabel?: string }) {
  const [page, setPage] = usePage();
  const pages = props.total != null ? Math.max(1, Math.ceil(props.total / props.pageSize)) : null;
  const hasNext = pages != null ? page < pages : !!props.hasMore;
  if (page === 1 && !hasNext) return null;
  return (
    <div className="pager">
      <span>
        Page {page}
        {pages != null && ` of ${pages}`}
        {props.total != null && ` · ${props.total.toLocaleString("en-US")} ${props.itemLabel ?? "items"}`}
      </span>
      <span className="row">
        <Button size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
          ← Prev
        </Button>
        <Button size="sm" disabled={!hasNext} onClick={() => setPage(page + 1)}>
          Next →
        </Button>
      </span>
    </div>
  );
}
