import { getLatestDisplayRequest, publishDisplayRequest } from "./bus";
import { RasterWebProvider, providerState } from "./provider";
import type { DisplayRequestV1 } from "./types";

/**
 * A browser the agent drives and the human watches, at the same time.
 *
 * Cody already renders a URL in a server-side Chromium and streams it to the
 * Preview panel with real pointer/keyboard input (the streamed rung). This
 * module hands the agent the DevTools endpoint of THAT Chromium, so browser
 * automation acts on the exact surface on screen: every click, navigation and
 * form fill is visible as it happens, and the human can grab the mouse
 * mid-run because the input channel stays live throughout.
 *
 * The alternative — the agent launching its own headless browser and posting
 * screenshots afterwards — is what this replaces. Two browsers means the
 * human watches a copy that never moves.
 */
export interface SharedBrowserHandle {
  request: DisplayRequestV1;
  /** DevTools HTTP endpoint, e.g. `http://127.0.0.1:41337`. */
  endpoint: string;
}

/**
 * Publish the URL as a STREAMED preview and start its renderer now, returning
 * the endpoint automation should attach to.
 *
 * Two deliberate choices:
 *
 * - **Streamed, not auto.** The ladder's higher rungs frame the dev server in
 *   the human's OWN browser, which cannot show them a thing the agent's
 *   browser does. Sharing only means anything on the rung Cody renders.
 * - **Raster, never H.264.** The H.264 rung degrades into a *different*
 *   Chromium when a client turns out to have no decoder, which would
 *   silently strand automation on a browser nobody is watching any more. An
 *   agent's endpoint has to stay valid for the whole run, and JPEG stills are
 *   perfectly adequate for watching a test drive itself.
 */
export async function startSharedBrowser(sessionId: string, input: Record<string, unknown>): Promise<SharedBrowserHandle> {
  const request = await publishDisplayRequest(sessionId, { ...input, mode: "stream" });
  const state = providerState();
  const existing = state.providers.get(sessionId);
  // Reuse only a raster provider already serving this exact request: anything
  // else is either stale or the wrong renderer, and both must be replaced
  // before the endpoint is handed out.
  let provider = existing instanceof RasterWebProvider && existing.requestId === request.id ? existing : null;
  if (!provider) {
    if (existing) await existing.dispose().catch(() => { /* replacing it is the point */ });
    provider = new RasterWebProvider(sessionId, request);
    state.providers.set(sessionId, provider);
  }
  await provider.ensureStarted();
  const endpoint = provider.cdpEndpoint();
  if (!endpoint) throw new Error("The shared browser started but exposed no DevTools endpoint");
  return { request, endpoint };
}

/** The live shared browser for a session, or null when nothing is shared. */
export function sharedBrowserEndpoint(sessionId: string): string | null {
  const provider = providerState().providers.get(sessionId);
  if (!(provider instanceof RasterWebProvider)) return null;
  // A provider whose request has been superseded is about to be replaced by
  // the next attach; reporting its endpoint would hand out a dying browser.
  if (provider.requestId !== getLatestDisplayRequest(sessionId)?.id) return null;
  return provider.cdpEndpoint();
}
