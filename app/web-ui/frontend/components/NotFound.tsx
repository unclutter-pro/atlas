import { Link } from "../router";
import { EmptyState, PageHeader } from "./layout";

/** 404 inside the shell — use as <Routes fallback={<NotFound />}>. */
export function NotFound(props: { what?: string }) {
  return (
    <>
      <PageHeader title="Not found" />
      <EmptyState title={props.what ? `${props.what} not found.` : "Nothing lives at this address."} action={<Link href="/">Go to Overview</Link>} />
    </>
  );
}
