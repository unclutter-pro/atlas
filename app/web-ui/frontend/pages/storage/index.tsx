/**
 * Storage — "What is on disk, and how full is it?"
 * Volumes (how full) first, then the workspace breakdown (what needs
 * attention), then a read-only file browser rooted at HOME.
 * Owned by the storage area. Server side: ui-api/storage.ts.
 */

import { NotFound } from "../../components";
import { Routes } from "../../router";
import { Browse } from "./Browse";
import { StorageHome } from "./StorageHome";
import "./storage.css";

export default function StoragePage() {
  return (
    <Routes
      routes={[
        { path: "/storage", component: StorageHome },
        { path: "/storage/browse", component: Browse },
        { path: "/storage/browse/*", component: Browse },
      ]}
      fallback={<NotFound />}
    />
  );
}
