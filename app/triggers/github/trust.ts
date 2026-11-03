/**
 * Marks text whose author lacks a trusted relationship to the repository, so
 * neither the worker nor the classifier mistakes someone else's words for
 * instructions from the team. Anyone on GitHub can comment on a public repo
 * or open an issue; their text still has to reach the agent, just clearly
 * labeled.
 *
 * Trust follows GitHub's own `author_association` on the comment, review,
 * issue or PR object: OWNER, MEMBER and COLLABORATOR are trusted; everything
 * else (CONTRIBUTOR, FIRST_TIME_CONTRIBUTOR, FIRST_TIMER, NONE, MANNEQUIN, or
 * missing) is not. The bot's own login is always trusted, whatever
 * association GitHub reports for it.
 */
const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

const lower = (value: unknown) => (typeof value === "string" ? value.toLowerCase() : "");

/** Login and author_association of whoever wrote `obj` (a comment, review, issue or PR). */
export function authorOf(obj: any): { login: string; association: string } {
  const association = obj?.author_association;
  return {
    login: lower(obj?.user?.login),
    association: typeof association === "string" ? association.toUpperCase() : "",
  };
}

export function isTrustedAuthor(login: string, association: string, me: string): boolean {
  return lower(login) === me || TRUSTED_ASSOCIATIONS.has(association);
}

/**
 * Neutralizes any occurrence of the wrapper tag (open or close, any case)
 * already present in the text, so untrusted content can never close the tag
 * early or forge a nested one with a different author/association.
 */
function escapeContent(text: string): string {
  return text.replace(/<\/?untrusted-content/gi, (match) => match.replace("<", "&lt;"));
}

/** Escapes a value for use inside a double-quoted HTML-ish attribute. */
function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Wraps `text` in `<untrusted-content author="…" association="…">` when its
 * author is not trusted; returns it unchanged otherwise. Empty text is
 * returned as-is (nothing to mark).
 */
export function markIfUntrusted(text: string, login: string, association: string, me: string): string {
  if (!text || isTrustedAuthor(login, association, me)) return text;
  const author = escapeAttr(login || "unknown");
  const assoc = escapeAttr(association || "NONE");
  return `<untrusted-content author="${author}" association="${assoc}">${escapeContent(text)}</untrusted-content>`;
}
