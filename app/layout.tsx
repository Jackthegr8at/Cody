import type { Metadata, Viewport } from "next";
import { Noto_Sans_Mono, Noto_Serif_SC, Source_Serif_4 } from "next/font/google";
import { cookies } from "next/headers";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth/session";
import { DEFAULT_DARK_THEME_ID, DEFAULT_THEME_ID, getTheme, isThemeId } from "@/lib/theme-catalog";
import { themeBootstrapScript } from "@/lib/theme-bootstrap";
import { LEGACY_STORAGE_KEYS, STORAGE_KEYS } from "@/lib/storage-keys";
import "./globals.css";

const notoSansMono = Noto_Sans_Mono({
  subsets: ["latin", "cyrillic"],
  variable: "--font-noto-mono",
  display: "swap",
});

// Display serif pair for the warm-humanistic heading voice: Source Serif 4
// covers latin, Noto Serif SC covers CJK. Both expose CSS variables consumed
// by --font-serif in globals.css.
const sourceSerif = Source_Serif_4({
  subsets: ["latin"],
  variable: "--font-source-serif",
  display: "swap",
});

const notoSerifSC = Noto_Serif_SC({
  // CJK glyphs are served via unicode-range slices regardless of subset;
  // "latin" satisfies next/font's preloading requirement.
  subsets: ["latin"],
  weight: ["600", "700"],
  variable: "--font-noto-serif",
  display: "swap",
});
const legacyStorageKeys = JSON.stringify(LEGACY_STORAGE_KEYS);

/**
 * The signed-in account's saved theme, or null when signed out or never
 * chosen. Read here, on the server, so the FIRST paint on any device is the
 * user's own choice: theme selection used to live only in one browser's
 * localStorage, so a theme picked on the desktop never reached the phone, and
 * the phone (and the home-screen app, which has storage of its own) stayed on
 * the default. A bad cookie or an unreadable account store simply means "no
 * preference" — the bootstrap below falls back to the browser's choice.
 */
async function accountTheme(): Promise<string | null> {
  try {
    const store = await cookies();
    const user = verifySessionToken(store.get(SESSION_COOKIE_NAME)?.value);
    const theme = user?.preferences?.theme ?? null;
    return isThemeId(theme) ? theme : null;
  } catch {
    return null;
  }
}

export const metadata: Metadata = {
  title: "Cody",
  description: "A self-hosted web workspace for coding agents.",
  manifest: "/manifest.webmanifest",
  // PWA-like behavior on iOS: standalone chrome, no telephone autodetect.
  // "black-translucent" is what makes an installed Cody use the WHOLE screen:
  // the web view extends under the status bar instead of being letterboxed by
  // an opaque strip the app cannot colour. Every viewport-anchored top edge
  // pays for it by padding `var(--safe-top)` (app/globals.css) — the top bar
  // then paints --bg-panel behind the clock and puts its controls below it.
  appleWebApp: {
    capable: true,
    title: "Cody",
    statusBarStyle: "black-translucent",
  },
  formatDetection: {
    telephone: false,
  },
};

// theme-color adapts to light/dark so the browser chrome / iOS status bar
// matches the active theme. It is the theme's --bg-panel, not its --bg: the
// chrome sits against the TOP BAR, and a --bg-coloured status bar read as a
// band above it. `viewportFit: cover` exposes the real insets to the
// `--safe-*` variables every edge pads with.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  // Light/dark pair so first paint matches before the theme bootstrap script
  // rewrites the meta tag; an installed window reads the manifest instead.
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: getTheme(DEFAULT_DARK_THEME_ID).preview.surface },
    { media: "(prefers-color-scheme: light)", color: getTheme(DEFAULT_THEME_ID).preview.surface },
  ],
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const savedTheme = await accountTheme();
  // Rendered straight onto <html> so the server's HTML already carries the
  // right palette; the bootstrap script then only confirms it.
  const savedMode = savedTheme ? getTheme(savedTheme).mode : null;
  return (
    <html
      lang="en"
      translate="no"
      data-theme={savedTheme ?? undefined}
      className={`${notoSansMono.variable} ${sourceSerif.variable} ${notoSerifSC.variable} notranslate${savedMode === "dark" ? " dark" : ""}`}
      suppressHydrationWarning
    >
      <head>
        <meta name="google" content="notranslate" />
        {/* Move any pre-fork ompweb keys into the `cody:` namespace FIRST, so the
            theme and language bootstraps below (and every component after them)
            only ever read the current keys. Mirrors migrateLegacyStorage(). */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var m=${legacyStorageKeys};for(var i=0;i<m.length;i++){try{var o=m[i][0],n=m[i][1];if(localStorage.getItem(n)!==null){localStorage.removeItem(o);continue}var v=localStorage.getItem(o);if(v===null)continue;localStorage.setItem(n,v);localStorage.removeItem(o)}catch(e){}}}catch(e){}})();`,
          }}
        />
        {/* Apply the theme before first paint so neither the UI nor the browser
            chrome flashes the wrong palette: the account's saved theme, then
            this browser's, then the device's colour scheme (lib/theme-bootstrap.ts). */}
        <script dangerouslySetInnerHTML={{ __html: themeBootstrapScript(savedTheme) }} />
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var l=localStorage.getItem(${JSON.stringify(STORAGE_KEYS.lang)});if(l!=="en"&&l!=="zh-CN"&&l!=="ja"){var n=(navigator.language||"").toLowerCase();l=n.indexOf("zh")===0?"zh-CN":n.indexOf("ja")===0?"ja":"en"}document.documentElement.lang=l}catch(e){}})();`,
          }}
        />
      </head>
      {/* --app-height is set only while a phone's soft keyboard is up
          (hooks/useVisualViewportHeight.ts); otherwise the dynamic viewport
          unit already tracks the browser chrome. */}
      <body translate="no" className="notranslate" style={{ height: "var(--app-height, 100dvh)", display: "flex", flexDirection: "column" }}>
        {children}
        {/* Register the no-op service worker after load: Chromium's PWA
            install prompt requires one; it caches nothing (see public/sw.js). */}
        <script
          dangerouslySetInnerHTML={{
            __html: `if("serviceWorker" in navigator){window.addEventListener("load",function(){navigator.serviceWorker.register("/sw.js").catch(function(){})})}`,
          }}
        />
      </body>
    </html>
  );
}
