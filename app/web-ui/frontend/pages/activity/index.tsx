/**
 * Activity — "What happened and why?"
 * One timeline: cause (message / cron / webhook / manual) → session → outcome.
 * Owned by the activity area. Server side: ui-api/activity.ts (event model documented there).
 */

import { NotFound } from "../../components";
import { Routes } from "../../router";
import { ActivityList } from "./ActivityList";
import { MessageDetail } from "./MessageDetail";
import { RunDetail } from "./RunDetail";
import { SessionDetail } from "./SessionDetail";
import "./activity.css";

export default function ActivityPage() {
  return (
    <Routes
      routes={[
        { path: "/activity", component: ActivityList },
        // Specific paths before /activity/:id
        { path: "/activity/session/:sessionId", component: SessionDetail },
        { path: "/activity/message/:id", component: MessageDetail },
        { path: "/activity/:id", component: RunDetail },
      ]}
      fallback={<NotFound />}
    />
  );
}
