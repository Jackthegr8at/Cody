/**
 * Human-facing model name only. It deliberately leaves the identifier that
 * routes requests untouched, while making GPT catalog slugs readable.
 */
function parseGptName(value: string): { version: string; variants: string[] } | null {
  const normalized = value.trim().split("/").at(-1)?.replace(/[ _]+/g, "-") ?? "";
  const match = /^gpt-(\d+(?:\.\d+)*)(?:-(.+))?$/i.exec(normalized);
  if (!match) return null;
  return {
    version: match[1],
    variants: match[2]?.split("-").filter(Boolean) ?? [],
  };
}

function formatGptName({ version, variants }: { version: string; variants: string[] }): string {
  const variantName = variants
    .map((variant) => variant === variant.toLowerCase()
      ? variant.charAt(0).toUpperCase() + variant.slice(1)
      : variant)
    .join(" ");
  return variantName ? "GPT-" + version + " " + variantName : "GPT-" + version;
}

function catalogPreservesModelIdentity(
  catalog: { version: string; variants: string[] },
  model: { version: string; variants: string[] },
): boolean {
  return catalog.version === model.version
    && model.variants
      .filter((variant) => /[a-z]/i.test(variant))
      .every((variant) => catalog.variants.some((candidate) => candidate.toLowerCase() === variant.toLowerCase()));
}

/**
 * Formats a model name at a display boundary. Catalog names remain authoritative
 * unless a GPT catalog label loses a version or variant present in its model id.
 */
export function formatModelDisplayName(modelId: string | null | undefined, catalogName?: string | null): string {
  const id = modelId?.trim() ?? "";
  const catalog = catalogName?.trim() ?? "";
  const idGpt = parseGptName(id);
  const catalogGpt = parseGptName(catalog);

  if (catalog && (!idGpt || !catalogGpt || catalogPreservesModelIdentity(catalogGpt, idGpt))) {
    return catalogGpt ? formatGptName(catalogGpt) : catalog;
  }
  return idGpt ? formatGptName(idGpt) : (catalog || id);
}
