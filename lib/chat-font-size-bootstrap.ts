/** Pre-paint bootstrap script for chat font size preference. Runs before React,
 *  so the first paint has the correct font size applied, avoiding a flash of
 *  the default size. */

import { STORAGE_KEYS } from "./storage-keys";

/** Returns an inline script string that reads the saved font size from
 *  localStorage and sets the CSS var. Run this in a <script> tag before
 *  React mounts. */
export function chatFontSizeBootstrapScript(): string {
  return `
    (function() {
      try {
        const key = '${STORAGE_KEYS.chatFontSize}';
        const stored = localStorage.getItem(key);
        const size = stored && /^(13|14|15|16)$/.test(stored) ? stored : '14';
        document.documentElement.style.setProperty('--chat-font-size', size + 'px');
      } catch(e) {}
    })();
  `;
}
