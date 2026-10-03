/**
 * Information architecture: areas, their URL space, and the nav.
 * Shared by server.ts (which paths serve the SPA shell) and App.tsx (nav +
 * which page renders). Pure data — no React imports.
 *
 * An area owns every path under its `base` (base itself plus `base/*`) and
 * routes internally with <Routes> from router.tsx, so adding a detail page
 * never requires touching this file.
 */

export const AREA_KEYS = ["overview", "chat", "activity", "automations", "knowledge", "usage", "storage", "settings"] as const;
export type AreaKey = (typeof AREA_KEYS)[number];

export interface AreaDef {
  key: AreaKey;
  label: string;
  /** URL prefix. "/" (overview) owns only "/" itself. */
  base: string;
  /** The one question this area answers. */
  question: string;
}

export const AREAS: Record<AreaKey, AreaDef> = {
  overview: { key: "overview", label: "Overview", base: "/", question: "Is everything running, what is happening right now?" },
  chat: { key: "chat", label: "Chat", base: "/chat", question: "Talk to the agent" },
  activity: { key: "activity", label: "Activity", base: "/activity", question: "What happened and why?" },
  automations: { key: "automations", label: "Automations", base: "/automations", question: "What does Atlas do on its own?" },
  knowledge: { key: "knowledge", label: "Knowledge", base: "/knowledge", question: "What does Atlas know and remember?" },
  usage: { key: "usage", label: "Usage", base: "/usage", question: "What does it cost?" },
  storage: { key: "storage", label: "Storage", base: "/storage", question: "What is on disk, and how full is it?" },
  settings: { key: "settings", label: "Settings", base: "/settings", question: "How is Atlas set up?" },
};

export type NavItem = { label: string; href: string; area: AreaKey };

export const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: "Operate",
    items: [
      { label: "Overview", href: "/", area: "overview" },
      { label: "Chat", href: "/chat", area: "chat" },
      { label: "Activity", href: "/activity", area: "activity" },
    ],
  },
  {
    group: "Control",
    items: [
      { label: "Automations", href: "/automations", area: "automations" },
      { label: "Knowledge", href: "/knowledge", area: "knowledge" },
    ],
  },
  {
    group: "System",
    items: [
      { label: "Usage", href: "/usage", area: "usage" },
      { label: "Storage", href: "/storage", area: "storage" },
      { label: "Settings", href: "/settings", area: "settings" },
    ],
  },
];

/** Bun.serve route patterns that must serve the SPA shell. */
export function spaRoutePatterns(): string[] {
  return AREA_KEYS.flatMap((k) => {
    const base = AREAS[k].base;
    return base === "/" ? ["/"] : [base, `${base}/*`];
  });
}

/** Area owning a pathname, or null (404). */
export function areaForPath(pathname: string): AreaDef | null {
  for (const k of AREA_KEYS) {
    const base = AREAS[k].base;
    if (base === "/" ? pathname === "/" : pathname === base || pathname.startsWith(`${base}/`)) return AREAS[k];
  }
  return null;
}
