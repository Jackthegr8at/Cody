import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/http";
import { resolveOpenRouterKey } from "@/lib/openrouter/key";

/**
 * GET /api/openrouter/providers — the slugs OpenRouter routes through, for the
 * routing fields' autocomplete.
 *
 * Proxied rather than fetched from the browser for two reasons: the key never
 * reaches the client, and the list is ~106 stable entries that would otherwise
 * be re-fetched cross-origin on every drawer open. Cached for an hour at the
 * edge of this route because a provider roster changes on the order of weeks.
 *
 * A failure is an empty list, never an error: the fields accept free text, so
 * losing the autocomplete degrades the control instead of breaking it.
 */
export const dynamic = "force-dynamic";

const CACHE_TTL_MS = 60 * 60_000;

declare global {
  var __codyOpenRouterProviders: { body: unknown; expiresAt: number } | undefined;
}

export async function GET(request: Request) {
  const resolved = requireUser(request);
  if ("response" in resolved) return resolved.response;

  const cached = globalThis.__codyOpenRouterProviders;
  if (cached && cached.expiresAt > Date.now()) {
    return NextResponse.json(cached.body, { headers: { "Cache-Control": "no-store" } });
  }

  const key = resolveOpenRouterKey();
  if (!key) return NextResponse.json({ data: [] }, { headers: { "Cache-Control": "no-store" } });

  try {
    const response = await fetch("https://openrouter.ai/api/v1/providers", {
      headers: { Authorization: `Bearer ${key.key}` },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return NextResponse.json({ data: [] }, { headers: { "Cache-Control": "no-store" } });
    const payload: unknown = await response.json();
    // Only the fields the picker needs; the rest (policy URLs, datacenters)
    // has no business crossing into the client.
    const rows = payload && typeof payload === "object" && "data" in payload && Array.isArray(payload.data)
      ? payload.data.flatMap((entry: unknown) => {
        if (!entry || typeof entry !== "object") return [];
        const slug = "slug" in entry && typeof entry.slug === "string" ? entry.slug : null;
        if (!slug) return [];
        const name = "name" in entry && typeof entry.name === "string" ? entry.name : slug;
        return [{ slug, name }];
      })
      : [];
    const body = { data: rows };
    globalThis.__codyOpenRouterProviders = { body, expiresAt: Date.now() + CACHE_TTL_MS };
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ data: [] }, { headers: { "Cache-Control": "no-store" } });
  }
}
