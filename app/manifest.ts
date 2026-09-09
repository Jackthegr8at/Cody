import type { MetadataRoute } from "next";
import { DEFAULT_DARK_THEME_ID, getTheme } from "@/lib/theme-catalog";

// Served as /manifest.webmanifest (already on the auth proxy's public list —
// installability probes run signed-out). Colors are the dark theme's, because
// that is where an install lands by default, and they are split the way the
// surfaces are: the splash paints the page ground (--bg), while theme_color
// dresses the OS chrome, which touches the TOP BAR (--bg-panel).
export default function manifest(): MetadataRoute.Manifest {
  const dark = getTheme(DEFAULT_DARK_THEME_ID);
  return {
    name: "Cody",
    short_name: "Cody",
    description: "A self-hosted web workspace for coding agents.",
    id: "/",
    start_url: "/",
    display: "standalone",
    background_color: dark.preview.background,
    theme_color: dark.preview.surface,
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
