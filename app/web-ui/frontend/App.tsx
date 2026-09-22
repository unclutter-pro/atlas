import { useEffect, type ComponentType } from "react";
import { useApi } from "./api";
import { areaForPath, type AreaKey } from "./areas";
import { NotFound } from "./components";
import { setShellTitle, usePathname } from "./router";
import { Sidebar } from "./shell/Sidebar";
import { StatusProvider } from "./shell/status";
import { StatusStrip } from "./shell/StatusStrip";
import type { MetaResponse } from "../ui-api/core";

import OverviewPage from "./pages/overview";
import ChatPage from "./pages/chat";
import ActivityPage from "./pages/activity";
import AutomationsPage from "./pages/automations";
import KnowledgePage from "./pages/knowledge";
import UsagePage from "./pages/usage";
import StoragePage from "./pages/storage";
import SettingsPage from "./pages/settings";

/** Each area's root component; it routes its own sub-paths with <Routes>. */
const PAGES: Record<AreaKey, ComponentType> = {
  overview: OverviewPage,
  chat: ChatPage,
  activity: ActivityPage,
  automations: AutomationsPage,
  knowledge: KnowledgePage,
  usage: UsagePage,
  storage: StoragePage,
  settings: SettingsPage,
};

export function App() {
  const pathname = usePathname();
  const meta = useApi<MetaResponse>("/ui/api/meta");
  const agentName = meta.data?.agentName ?? "Atlas";
  const area = areaForPath(pathname);
  const Page = area ? PAGES[area.key] : null;

  useEffect(() => setShellTitle(area?.label ?? "Not found", agentName), [area, agentName]);

  return (
    <StatusProvider>
      <div className="app">
        <Sidebar agentName={agentName} current={area} />
        <div className="shell-main">
          <StatusStrip />
          <main className={`shell-content${area?.key === "chat" ? " is-flush" : ""}`}>{Page ? <Page /> : <NotFound />}</main>
        </div>
      </div>
    </StatusProvider>
  );
}
