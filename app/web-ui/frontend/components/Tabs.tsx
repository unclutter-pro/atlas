import { Link, usePathname, useSearch } from "../router";

export interface TabItem {
  label: string;
  /** Path tabs: "/settings/secrets". Query tabs: "/knowledge?view=journal" (and "/knowledge" for the default). */
  href: string;
  count?: number;
  /** Path tabs: only active on the exact path (default: also on sub-paths). */
  exact?: boolean;
}

/**
 * URL-driven tabs. A tab is active when the path matches and every query
 * key used by any tab has the same value as in the tab's href (absent
 * counts as a value, so the default tab is simply the one without the key).
 */
export function Tabs(props: { items: TabItem[] }) {
  const pathname = usePathname();
  const current = new URLSearchParams(useSearch());
  const parsed = props.items.map((t) => {
    const url = new URL(t.href, "http://x");
    return { ...t, path: url.pathname, query: url.searchParams };
  });
  const keys = new Set(parsed.flatMap((t) => [...t.query.keys()]));

  const isActive = (t: (typeof parsed)[number]) => {
    const pathOk = t.exact || keys.size > 0 ? pathname === t.path : pathname === t.path || pathname.startsWith(`${t.path}/`);
    return pathOk && [...keys].every((k) => t.query.get(k) === current.get(k));
  };

  return (
    <nav className="tabs">
      {parsed.map((t) => (
        <Link key={t.href} href={t.href} className={`tab${isActive(t) ? " active" : ""}`}>
          {t.label}
          {t.count != null && <span className="tab-count">{t.count}</span>}
        </Link>
      ))}
    </nav>
  );
}
