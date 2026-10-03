/** Page structure primitives: header, sections, cards, stats, empty states. */

import { Fragment, type ReactNode } from "react";
import type { ApiState } from "../api";
import { Link, useTitle } from "../router";

export function PageHeader(props: {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Right-aligned buttons. */
  actions?: ReactNode;
  /** Inline next to the title (e.g. a StatusBadge). */
  badge?: ReactNode;
  /** Breadcrumb-style back link above the title. */
  back?: { href: string; label: string };
  /** Document title; defaults to `title` when it is a string. */
  documentTitle?: string;
}) {
  useTitle(props.documentTitle ?? (typeof props.title === "string" ? props.title : null));
  return (
    <header className="page-header">
      <div className="page-header-text">
        {props.back && (
          <Link href={props.back.href} className="page-back">
            ← {props.back.label}
          </Link>
        )}
        <h1 className="page-title">
          {props.title}
          {props.badge}
        </h1>
        {props.subtitle && <div className="page-subtitle">{props.subtitle}</div>}
      </div>
      {props.actions && <div className="page-actions">{props.actions}</div>}
    </header>
  );
}

export function Section(props: {
  title?: ReactNode;
  /** Shown muted after the title. */
  count?: number;
  description?: ReactNode;
  actions?: ReactNode;
  id?: string;
  children: ReactNode;
}) {
  return (
    <section className="section" id={props.id}>
      {(props.title || props.actions) && (
        <div className="section-header">
          {props.title && (
            <h2 className="section-title">
              {props.title}
              {props.count != null && <span className="count">{props.count}</span>}
            </h2>
          )}
          {props.description && <span className="section-desc">{props.description}</span>}
          {props.actions && <div className="section-actions">{props.actions}</div>}
        </div>
      )}
      {props.children}
    </section>
  );
}

export function Card(props: {
  title?: ReactNode;
  actions?: ReactNode;
  /** No body padding — for tables and lists that run edge to edge. */
  flush?: boolean;
  tone?: "error" | "warn";
  className?: string;
  children: ReactNode;
}) {
  const cls = ["card", props.flush && "card-flush", props.tone && `tone-${props.tone}`, props.className].filter(Boolean).join(" ");
  return (
    <div className={cls}>
      {(props.title || props.actions) && (
        <div className="card-header">
          {props.title && <div className="card-title">{props.title}</div>}
          {props.actions && <div className="card-actions">{props.actions}</div>}
        </div>
      )}
      <div className="card-body">{props.children}</div>
    </div>
  );
}

export type Tone = "ok" | "warn" | "error" | "running" | "accent";

/** Headline number. With `href` the whole tile links (e.g. into Activity with a filter). */
export function Stat(props: { value: ReactNode; label: ReactNode; hint?: ReactNode; href?: string; tone?: Tone }) {
  const cls = `stat${props.tone ? ` tone-${props.tone}` : ""}`;
  const body = (
    <>
      <div className="stat-label">{props.label}</div>
      <div className="stat-value">{props.value}</div>
      {props.hint && <div className="stat-hint">{props.hint}</div>}
    </>
  );
  return props.href ? (
    <Link href={props.href} className={cls}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

export function StatGrid(props: { children: ReactNode }) {
  return <div className="stat-grid">{props.children}</div>;
}

/** The only place for explainer text: shown when a list/page has nothing yet. */
export function EmptyState(props: { title: ReactNode; children?: ReactNode; action?: ReactNode; compact?: boolean }) {
  return (
    <div className={`empty-state${props.compact ? " compact" : ""}`}>
      <div className="empty-state-title">{props.title}</div>
      {props.children && <div className="empty-state-body">{props.children}</div>}
      {props.action && <div className="empty-state-action">{props.action}</div>}
    </div>
  );
}

export function Alert(props: { tone?: "error" | "ok" | "warn" | "info"; children: ReactNode }) {
  return (
    <div className={`alert alert-${props.tone ?? "info"}`} role={props.tone === "error" ? "alert" : "status"}>
      {props.children}
    </div>
  );
}

type KVItem = { label: ReactNode; value: ReactNode; key?: string } | [ReactNode, ReactNode];

/** Definition list. Items whose value is undefined are skipped (null renders "—"). */
export function KeyValue(props: { items: KVItem[]; className?: string }) {
  return (
    <dl className={`kv ${props.className ?? ""}`}>
      {props.items.map((item, i) => {
        const [label, value] = Array.isArray(item) ? item : [item.label, item.value];
        if (value === undefined) return null;
        return (
          <Fragment key={i}>
            <dt>{label}</dt>
            <dd>{value ?? <span className="faint">—</span>}</dd>
          </Fragment>
        );
      })}
    </dl>
  );
}

export function Loading(props: { label?: string }) {
  return <div className="loading">{props.label ?? "Loading…"}</div>;
}

/**
 * Standard loading/error handling for a useApi() result:
 *   <ApiView state={runs}>{(data) => <DataTable rows={data.items} … />}</ApiView>
 * Keeps showing stale data (with an error banner) when a refetch fails.
 */
export function ApiView<T>(props: { state: ApiState<T>; children: (data: T) => ReactNode; loading?: ReactNode }) {
  const { data, error } = props.state;
  if (data == null) {
    if (error) return <Alert tone="error">Failed to load: {error}</Alert>;
    return <>{props.loading ?? <Loading />}</>;
  }
  return (
    <>
      {error && <Alert tone="error">Refresh failed: {error}</Alert>}
      {props.children(data)}
    </>
  );
}
