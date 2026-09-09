"use client";

/**
 * Settings › Code hosts. A thin wrapper around `ForgeSection`, which renders
 * the host cards, the add/edit form and Cody's own update source.
 *
 * Search: `SEARCH_ENTRIES` are the surfaces this hub renders that are not a
 * `<NativeSetting label>` — the roster and the Add button — plus the update
 * source card, whose `searchId` matches the one `ForgeSection` sets.
 */
import { ForgeSection } from "../ForgeSection";
import type { SearchEntry } from "../search-index";

export const FORGE_PANEL_ID = "forge";

const TRAIL: readonly string[] = ["Cody", "Code hosts"];

export const SEARCH_ENTRIES: readonly SearchEntry[] = [
  {
    id: "add-code-host",
    tab: "forge",
    label: "Add a code host",
    description: "Point Cody at GitHub or a self-hosted Gitea: base URL, default owner and an access token.",
    keywords: ["gitea", "github", "forge", "git", "token", "pat", "self-hosted", "repository", "code host"],
    breadcrumb: TRAIL,
    scope: "Cody only",
    action: "jump",
  },
  {
    id: "cody-update-source",
    tab: "forge",
    label: "Cody update source",
    description: "Which code host publishes this Cody's releases, and which container image an update pulls.",
    keywords: ["update", "release", "image", "ghcr", "registry", "upgrade", "channel"],
    breadcrumb: TRAIL,
    scope: "Cody only",
    action: "jump",
  },
];

export function ForgePanel() {
  return <ForgeSection />;
}
