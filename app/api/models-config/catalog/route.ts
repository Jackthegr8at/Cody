import { NextResponse } from "next/server";
import { recommendModelCatalogPreset, searchModelCatalog } from "@/lib/model-catalog";
import { loadModelsDevCatalog, MODELS_DEV_URL } from "@/lib/models-dev";

export const dynamic = "force-dynamic";

// GET /api/models-config/catalog?q=<query>[&provider=<id>][&baseUrl=<url>][&limit=N]
// Searches the models.dev catalog (1h TTL, in-flight dedup) and derives an
// "add model" preset recommendation for the query. Provider/base-url hints
// steer both search ranking and the recommendation's metadata/pricing source.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const query = (searchParams.get("q") ?? "").slice(0, 120);
  const provider = (searchParams.get("provider") ?? "").slice(0, 120);
  const baseUrl = (searchParams.get("baseUrl") ?? "").slice(0, 500);
  const parsedLimit = Number.parseInt(searchParams.get("limit") ?? "50", 10);
  const limit = Number.isFinite(parsedLimit) ? parsedLimit : 50;

  try {
    const entries = await loadModelsDevCatalog();
    const models = searchModelCatalog(entries, query, provider, limit);
    const recommendation = recommendModelCatalogPreset(entries, query, provider, baseUrl);
    return NextResponse.json({ models, recommendation, source: MODELS_DEV_URL });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}
