/** Journal date view: one day, previous/next entry, month calendar of days with entries. Read-only. */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useApi } from "../../api";
import { ApiView, ButtonLink, Card, EmptyState, Loading, PageHeader, Section, Time, formatBytes } from "../../components";
import { links } from "../../links";
import { Link, Redirect, navigate, type Params } from "../../router";
import type { JournalDay, JournalDayResponse, JournalListResponse } from "../../../ui-api/knowledge";
import { API, KnowledgeNav, MemoryMarkdown, localDate, longDate } from "./common";

export function JournalPage(props: { params: Params }) {
  const date = props.params.date;
  const list = useApi<JournalListResponse>(`${API}/journal`);

  if (!date) {
    // /knowledge/journal → latest entry (or an empty state).
    if (!list.data) {
      return (
        <>
          <PageHeader title="Journal" />
          <KnowledgeNav />
          <ApiView state={list}>{() => null}</ApiView>
        </>
      );
    }
    const latest = list.data.days[0]?.date;
    if (latest) return <Redirect to={links.journal(latest)} />;
    return (
      <>
        <PageHeader title="Journal" />
        <KnowledgeNav />
        <EmptyState title="No journal entries yet.">
          Atlas keeps a daily log in ~/memory/journal/YYYY-MM-DD.md: what it did, what it learned, what is pending. Entries show up here by date.
        </EmptyState>
      </>
    );
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return (
      <>
        <PageHeader title="Journal" back={{ href: links.journal(), label: "Journal" }} />
        <EmptyState title={`"${date}" is not a date.`} action={<ButtonLink href={links.journal()}>Latest entry</ButtonLink>} />
      </>
    );
  }

  return <JournalDayView date={date} days={list.data?.days ?? null} />;
}

function JournalDayView(props: { date: string; days: JournalDay[] | null }) {
  const { date } = props;
  const day = useApi<JournalDayResponse>(`${API}/journal/${date}`);
  const d = day.data?.date === date ? day.data : null;
  const today = localDate();

  // Left/right arrow keys step through entries (outside of inputs).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable) return;
      if (e.key === "ArrowLeft" && d?.prev) navigate(links.journal(d.prev), { keepScroll: true });
      if (e.key === "ArrowRight" && d?.next) navigate(links.journal(d.next), { keepScroll: true });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [d?.prev, d?.next]);

  return (
    <>
      <PageHeader
        title={longDate(date)}
        documentTitle={`Journal ${date}`}
        badge={date === today ? <span className="tag">today</span> : undefined}
        subtitle={
          d?.entry ? (
            <>
              Last written <Time value={d.entry.modifiedAt} /> · {formatBytes(d.entry.size)} · <span className="faint">{d.entry.legacyLocation ? `memory/${d.entry.path} (legacy location)` : `memory/${d.entry.path}`}</span>
            </>
          ) : undefined
        }
        actions={
          <div className="knowledge-daynav">
            <ButtonLinkMaybe href={d?.prev ? links.journal(d.prev) : null} title={d?.prev ? `Previous entry: ${d.prev}` : "No earlier entry"}>
              ← Previous
            </ButtonLinkMaybe>
            <ButtonLinkMaybe href={d?.next ? links.journal(d.next) : null} title={d?.next ? `Next entry: ${d.next}` : "No later entry"}>
              Next →
            </ButtonLinkMaybe>
            {d?.latest && d.latest !== date && <ButtonLink href={links.journal(d.latest)} variant="ghost">Latest</ButtonLink>}
          </div>
        }
      />
      <KnowledgeNav />

      <div className="knowledge-journal">
        <div className="knowledge-journal-main">
          <ApiView state={day}>
            {() =>
              !d ? (
                <Loading />
              ) : d.entry ? (
                <Card className="knowledge-doc">
                  {d.entry.content.trim() ? <MemoryMarkdown text={d.entry.content} path={d.entry.path} /> : <EmptyState compact title="This entry is empty." />}
                </Card>
              ) : (
                <Card>
                  <EmptyState compact title={`No journal entry for ${date}.`}>
                    {d.prev || d.next ? "Use Previous/Next or the calendar to jump to a day with an entry." : undefined}
                  </EmptyState>
                </Card>
              )
            }
          </ApiView>
        </div>
        <aside className="knowledge-journal-side">
          <Calendar selected={date} days={props.days} />
          {props.days && props.days.length > 0 && (
            <Section title="Entries" count={props.days.length}>
              <ul className="knowledge-daylist knowledge-daylist-compact">
                {props.days.slice(0, 30).map((day) => (
                  <li key={day.date} className={day.date === date ? "is-selected" : undefined}>
                    <Link href={links.journal(day.date)}>
                      <span>{day.date}</span>
                      <span className="faint small">{weekday(day.date)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
              {props.days.length > 30 && <div className="faint small mt-2">Older entries: use the calendar.</div>}
            </Section>
          )}
        </aside>
      </div>
    </>
  );
}

function ButtonLinkMaybe(props: { href: string | null; title: string; children: ReactNode }) {
  if (!props.href) {
    return (
      <button type="button" className="btn btn-secondary" disabled title={props.title}>
        {props.children}
      </button>
    );
  }
  return (
    <Link href={props.href} className="btn btn-secondary" title={props.title}>
      {props.children}
    </Link>
  );
}

function weekday(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y!, m! - 1, d!).toLocaleDateString("en-US", { weekday: "short" });
}

const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

/** Month grid (Monday first). Days with an entry are links; the month is browsable without changing the selected day. */
function Calendar(props: { selected: string; days: JournalDay[] | null }) {
  const [month, setMonth] = useState(props.selected.slice(0, 7));
  useEffect(() => setMonth(props.selected.slice(0, 7)), [props.selected]);

  const withEntry = useMemo(() => new Set((props.days ?? []).map((d) => d.date)), [props.days]);
  const [y, m] = month.split("-").map(Number) as [number, number];
  const first = new Date(y, m - 1, 1);
  const daysInMonth = new Date(y, m, 0).getDate();
  const lead = (first.getDay() + 6) % 7;
  const today = localDate();
  const shift = (delta: number) => {
    const d = new Date(y, m - 1 + delta, 1);
    setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  };
  const monthCount = [...withEntry].filter((d) => d.startsWith(month)).length;

  const cells: ReactNode[] = [];
  for (let i = 0; i < lead; i++) cells.push(<span key={`pad${i}`} />);
  for (let day = 1; day <= daysInMonth; day++) {
    const date = `${month}-${String(day).padStart(2, "0")}`;
    const cls = ["knowledge-cal-day", withEntry.has(date) && "has-entry", date === props.selected && "is-selected", date === today && "is-today"].filter(Boolean).join(" ");
    cells.push(
      withEntry.has(date) ? (
        <Link key={date} href={links.journal(date)} className={cls} title={longDate(date)}>
          {day}
        </Link>
      ) : (
        <span key={date} className={cls}>
          {day}
        </span>
      ),
    );
  }

  return (
    <Card className="knowledge-cal">
      <div className="knowledge-cal-head">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => shift(-1)} aria-label="Previous month">
          ‹
        </button>
        <div className="knowledge-cal-title">
          {first.toLocaleDateString("en-US", { month: "long", year: "numeric" })}
          <span className="faint small"> · {monthCount} {monthCount === 1 ? "entry" : "entries"}</span>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => shift(1)} aria-label="Next month">
          ›
        </button>
      </div>
      <div className="knowledge-cal-grid">
        {WEEKDAYS.map((w) => (
          <span key={w} className="knowledge-cal-wd">
            {w}
          </span>
        ))}
        {cells}
      </div>
    </Card>
  );
}
