/**
 * Settings — "How is Atlas set up?"
 * Sections: personality, integrations, configuration, secrets, extensions.
 * Server side: ui-api/settings.ts.
 */

import type { ComponentType } from "react";
import { NotFound, PageHeader, Tabs } from "../../components";
import { links, type SettingsSection } from "../../links";
import { Redirect, Routes, type Params } from "../../router";
import Configuration from "./Configuration";
import Extensions from "./Extensions";
import Integrations from "./Integrations";
import Personality from "./Personality";
import Secrets from "./Secrets";
import "./settings.css";

const SECTIONS: { key: SettingsSection; label: string; component: ComponentType }[] = [
  { key: "personality", label: "Personality", component: Personality },
  { key: "integrations", label: "Integrations", component: Integrations },
  { key: "configuration", label: "Configuration", component: Configuration },
  { key: "secrets", label: "Secrets", component: Secrets },
  { key: "extensions", label: "Extensions", component: Extensions },
];

export default function SettingsPage() {
  return (
    <Routes
      routes={[
        { path: "/settings", component: () => <Redirect to={links.settings("personality")} /> },
        { path: "/settings/:section", component: SettingsSectionPage },
      ]}
      fallback={<NotFound />}
    />
  );
}

function SettingsSectionPage(props: { params: Params }) {
  const section = SECTIONS.find((s) => s.key === props.params.section);
  if (!section) return <NotFound what="Settings section" />;
  const Body = section.component;
  return (
    <>
      <PageHeader title="Settings" documentTitle={section.label} />
      <Tabs items={SECTIONS.map((s) => ({ label: s.label, href: links.settings(s.key) }))} />
      {/* key: remount per section so editor drafts never leak between sections */}
      <Body key={section.key} />
    </>
  );
}
