/**
 * Client-side image compression for chat attachments, plus the byte budget that
 * decides whether a composed prompt can physically reach the engine.
 *
 * Why this exists: an attached image travels to omp as base64 INSIDE the prompt
 * command, which has a deliberately conservative 900 KiB safety budget. A phone
 * photo is 3–8 MB, i.e. 4–11 MB once base64'd, so without this module "attach a
 * photo" could never be delivered at all.
 *
 * The decision half — pass-through policy, the quality/dimension ladder, the
 * budget arithmetic — is pure and unit-tested. The browser half at the bottom
 * is the only part that needs `createImageBitmap` and a canvas.
 */

/** Base64 payload at or under this is sent untouched: screenshots stay crisp. */
export const IMAGE_PASSTHROUGH_BASE64_BYTES = 600 * 1024;
/** What the ladder aims for once an image does have to be re-encoded. */
export const IMAGE_TARGET_BASE64_BYTES = 600 * 1024;
/**
 * Ceiling for the whole assembled prompt frame (message + every attachment +
 * JSON overhead). Deliberately under MAX_RPC_FRAME_BYTES (1 MiB) so a send is
 * refused in the composer, with something the user can act on, rather than by
 * the transport with a protocol error.
 */
export const PROMPT_FRAME_BUDGET_BYTES = 900 * 1024;
/** WebP retains sharp screenshot glyph edges better than JPEG at this budget. */
export const COMPRESSED_IMAGE_MIME_TYPE = "image/webp";
/** Long-edge caps, in ladder order. 1568px is the second, harder step. */
export const IMAGE_MAX_EDGE_PX = 2048;
export const IMAGE_FALLBACK_EDGE_PX = 1568;
/** The last-resort screen-sized edge when a ten-image batch needs it. */
export const IMAGE_MINIMUM_EDGE_PX = 768;

/** Types a browser canvas can re-encode. Anything else is either passed
 *  through untouched (vector) or reported as undecodable. */
export const COMPRESSIBLE_IMAGE_MIME_TYPES: readonly string[] = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/bmp",
  "image/avif",
];

/** Rasterizing these would destroy them; they ride through at any size and the
 *  total budget is what catches an oversized one. */
export const PASSTHROUGH_ONLY_MIME_TYPES: readonly string[] = ["image/svg+xml"];

/** Named in the per-file error when a browser cannot decode an attachment. */
export const SUPPORTED_IMAGE_FORMAT_LABEL = "JPEG, PNG, WebP, GIF";

export interface CompressionStep {
  /** Longest edge the image is scaled down to (never scaled up). */
  maxEdge: number;
  /** Quality passed to the browser canvas encoder. */
  quality: number;
}

/**
 * The first eight rungs protect single-image quality. The final four preserve
 * readable text when a whole screenshot batch needs a much smaller share. Every
 * rung is encoded from the source bitmap, never from an earlier lossy result.
 */
export const COMPRESSION_STEPS: readonly CompressionStep[] = [
  { maxEdge: IMAGE_MAX_EDGE_PX, quality: 0.9 },
  { maxEdge: IMAGE_MAX_EDGE_PX, quality: 0.8 },
  { maxEdge: IMAGE_MAX_EDGE_PX, quality: 0.7 },
  { maxEdge: IMAGE_MAX_EDGE_PX, quality: 0.6 },
  { maxEdge: IMAGE_MAX_EDGE_PX, quality: 0.5 },
  { maxEdge: IMAGE_FALLBACK_EDGE_PX, quality: 0.5 },
  { maxEdge: IMAGE_FALLBACK_EDGE_PX, quality: 0.45 },
  { maxEdge: IMAGE_FALLBACK_EDGE_PX, quality: 0.4 },
  { maxEdge: 1280, quality: 0.55 },
  { maxEdge: 1280, quality: 0.45 },
  { maxEdge: 896, quality: 0.6 },
  { maxEdge: 896, quality: 0.5 },
  { maxEdge: IMAGE_MINIMUM_EDGE_PX, quality: 0.6 },
  { maxEdge: IMAGE_MINIMUM_EDGE_PX, quality: 0.5 },
];

function compressionStepsForTarget(targetBase64Length: number): readonly CompressionStep[] {
  // A 5–10 screenshot batch grants roughly 90–180 KiB per large image. Avoid
  // encoding obviously oversized 2048px rungs before taking the text-friendly
  // compact branch; every attempted rung still starts from the original bitmap.
  return targetBase64Length <= 192 * 1024 ? COMPRESSION_STEPS.slice(8) : COMPRESSION_STEPS;
}

export type ImageCompressionPlan =
  | { kind: "passthrough"; reason: "within-budget" | "vector" }
  | { kind: "compress"; steps: readonly CompressionStep[]; targetBase64Length: number };

/** Length of the base64 text for `byteLength` raw bytes (padding included). */
export function base64LengthForBytes(byteLength: number): number {
  if (!Number.isFinite(byteLength) || byteLength <= 0) return 0;
  return Math.ceil(byteLength / 3) * 4;
}

/** Scale to fit `maxEdge` on the long side. Never upscales; never returns 0. */
export function fitWithinEdge(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number } {
  const safeWidth = Math.max(1, Math.round(width));
  const safeHeight = Math.max(1, Math.round(height));
  const longest = Math.max(safeWidth, safeHeight);
  if (!Number.isFinite(maxEdge) || maxEdge <= 0 || longest <= maxEdge) {
    return { width: safeWidth, height: safeHeight };
  }
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(safeWidth * scale)),
    height: Math.max(1, Math.round(safeHeight * scale)),
  };
}

/**
 * What to do with a file the user just attached, decided from its size and type
 * alone — no decoding, so the common case (a screenshot) never touches a canvas.
 */
export function planImageCompression(input: { byteLength: number; mimeType: string }): ImageCompressionPlan {
  const mimeType = input.mimeType.toLowerCase();
  if (PASSTHROUGH_ONLY_MIME_TYPES.includes(mimeType)) return { kind: "passthrough", reason: "vector" };
  if (base64LengthForBytes(input.byteLength) <= IMAGE_PASSTHROUGH_BASE64_BYTES) {
    return { kind: "passthrough", reason: "within-budget" };
  }
  return {
    kind: "compress",
    steps: COMPRESSION_STEPS,
    targetBase64Length: IMAGE_TARGET_BASE64_BYTES,
  };
}

export interface EncodedImage {
  /** base64 payload, no `data:` prefix. */
  data: string;
  mimeType: string;
  width: number;
  height: number;
}

export interface LadderResult {
  image: EncodedImage;
  step: CompressionStep;
  /** How many rungs were actually encoded (1 when the first one fit). */
  attempts: number;
  /** False means every rung was over target — the smallest one is returned so
   *  the caller can still show it, and the total budget check has the last word. */
  withinTarget: boolean;
}

/**
 * Walk the ladder with an injected encoder and return the first result within
 * target, or the smallest one if none fits. Pure control flow: the encoder is
 * the only thing that needs a browser, which is what makes the policy testable.
 */
export async function runCompressionLadder(
  steps: readonly CompressionStep[],
  targetBase64Length: number,
  encode: (step: CompressionStep) => Promise<EncodedImage>,
): Promise<LadderResult> {
  if (steps.length === 0) throw new Error("compression ladder has no steps");
  let smallest: LadderResult | null = null;
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    const image = await encode(step);
    const attempts = index + 1;
    if (image.data.length <= targetBase64Length) {
      return { image, step, attempts, withinTarget: true };
    }
    if (!smallest || image.data.length < smallest.image.data.length) {
      smallest = { image, step, attempts, withinTarget: false };
    }
  }
  // Every rung overshot: hand back the smallest, flagged honestly.
  return { ...smallest!, attempts: steps.length };
}

export interface BudgetImage {
  data: string;
  mimeType: string;
  /** Original file name, when the attachment came from one. */
  name?: string;
}

/** Bytes a JSON string literal costs on the wire, escaping included. */
function jsonStringBytes(value: string): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/** `{"type":"prompt","id":"w12","message":…,"images":[…]}` minus the payloads. */
const PROMPT_FRAME_ENVELOPE_BYTES = 128;
/** `{"type":"image","data":"…","mimeType":"…"}` minus the payloads. */
const IMAGE_ENVELOPE_BYTES = 48;

/**
 * Size of the prompt frame this message + these attachments would serialize to.
 * base64 is ASCII, so its character count is its byte count; the message is
 * measured through JSON.stringify so escapes and multi-byte text are counted
 * the way the transport will actually count them.
 */
export function estimatePromptFrameBytes(input: {
  message: string;
  images: readonly BudgetImage[];
}): number {
  let total = PROMPT_FRAME_ENVELOPE_BYTES + jsonStringBytes(input.message);
  for (const image of input.images) {
    total += IMAGE_ENVELOPE_BYTES + image.data.length + jsonStringBytes(image.mimeType);
  }
  return total;
}

export interface BudgetVerdict {
  ok: boolean;
  totalBytes: number;
  limit: number;
  /** The attachment worth removing first (largest), when over budget. */
  largest: { index: number; name?: string; byteLength: number } | null;
}

/**
 * Can this composed message be delivered at all? Called before every send so a
 * prompt that cannot fit is refused where the user can still fix it.
 */
export function checkPromptFrameBudget(input: {
  message: string;
  images: readonly BudgetImage[];
  limit?: number;
}): BudgetVerdict {
  const limit = input.limit ?? PROMPT_FRAME_BUDGET_BYTES;
  const totalBytes = estimatePromptFrameBytes(input);
  if (totalBytes <= limit) return { ok: true, totalBytes, limit, largest: null };
  let largestIndex = 0;
  for (let index = 1; index < input.images.length; index++) {
    if (input.images[index].data.length > input.images[largestIndex].data.length) largestIndex = index;
  }
  const largest = input.images[largestIndex];
  return {
    ok: false,
    totalBytes,
    limit,
    largest: largest
      ? {
        index: largestIndex,
        ...(largest.name ? { name: largest.name } : {}),
        // base64 → the decoded size a human recognizes from their file manager.
        byteLength: Math.floor((largest.data.length / 4) * 3),
      }
      : null,
  };
}

/** "820 KB" / "1.4 MB" — the sizes in attachment errors. */
export function formatAttachmentSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}


/**
 * Split the available base64 payload capacity fairly across re-encodable images.
 * Originals that already fit their fair share retain every byte; their unused
 * share flows to larger images instead of becoming a per-image cap.
 */
export function allocateAdaptiveImagePayloads(input: {
  originalBase64Lengths: readonly number[];
  canReencode: readonly boolean[];
  payloadBudget: number;
}): readonly number[] {
  const { originalBase64Lengths, canReencode } = input;
  if (originalBase64Lengths.length !== canReencode.length) {
    throw new TypeError("image payload lengths and re-encode flags must align");
  }
  if (!Number.isFinite(input.payloadBudget)) throw new TypeError("image payload budget must be finite");

  const targets = originalBase64Lengths.map((length) => {
    if (!Number.isFinite(length) || length < 0) throw new TypeError("image payload length must be non-negative");
    return Math.floor(length);
  });
  let available = Math.max(0, Math.floor(input.payloadBudget));
  const pending: { index: number; length: number }[] = [];
  for (let index = 0; index < targets.length; index++) {
    if (canReencode[index]) pending.push({ index, length: targets[index] });
    else available -= targets[index];
  }
  available = Math.max(0, available);
  pending.sort((left, right) => left.length - right.length || left.index - right.index);

  while (pending.length > 0) {
    const fairShare = Math.floor(available / pending.length);
    const smallest = pending[0];
    if (smallest.length <= fairShare) {
      // This source is already small enough to stay crisp; redistribute its
      // entire fair share before considering the larger images.
      available -= smallest.length;
      pending.shift();
      continue;
    }
    const remainder = available % pending.length;
    for (let index = 0; index < pending.length; index++) {
      targets[pending[index].index] = fairShare + (index < remainder ? 1 : 0);
    }
    break;
  }
  return targets;
}

// ── Browser half ─────────────────────────────────────────────────────────────
// Everything below needs a DOM. It is deliberately thin: read source bytes,
// decode only images which need re-encoding, then hand exact payloads back to
// the pure budget arithmetic above.

/** A file no browser decoder here could open (HEIC/HEIF on most platforms). */
export class UnsupportedImageError extends Error {
  readonly fileName: string;

  constructor(fileName: string, message: string) {
    super(message);
    this.name = "UnsupportedImageError";
    this.fileName = fileName;
  }
}

/** The batch reached the frame limit even after every viable re-encode. */
export class PromptFrameBudgetError extends Error {
  readonly verdict: BudgetVerdict;

  constructor(verdict: BudgetVerdict) {
    const subject = verdict.largest?.name ?? "image attachments";
    super("The prompt frame is too large after compressing " + subject);
    this.name = "PromptFrameBudgetError";
    this.verdict = verdict;
  }
}

export interface PreparedImage {
  data: string;
  mimeType: string;
  /** False when the original bytes were sent through untouched. */
  compressed: boolean;
  width: number | null;
  height: number | null;
}

export interface PrepareImageBatchInput {
  /** Keep these original Files in composer state until send/steer completes. */
  files: readonly File[];
  /** The fully composed text, including text-file attachments, sent with images. */
  message: string;
  /** Defaults to the single-frame safety limit; injectable for another transport. */
  limit?: number;
  unsupportedMessage: (fileName: string) => string;
}

interface ImageSource {
  file: File;
  data: string;
  mimeType: string;
  canReencode: boolean;
}

function readFileAsBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const base64 = result.slice(result.indexOf(",") + 1);
      if (!base64) reject(new Error("empty image data"));
      else resolve(base64);
    };
    reader.onerror = () => reject(reader.error ?? new Error("image read failed"));
    reader.readAsDataURL(file);
  });
}

function normalizedImageMimeType(file: File, unsupportedMessage: (fileName: string) => string): string {
  const mimeType = file.type.toLowerCase();
  if (COMPRESSIBLE_IMAGE_MIME_TYPES.includes(mimeType) || PASSTHROUGH_ONLY_MIME_TYPES.includes(mimeType)) {
    return mimeType;
  }
  throw new UnsupportedImageError(file.name, unsupportedMessage(file.name));
}

async function readImageSource(file: File, unsupportedMessage: (fileName: string) => string): Promise<ImageSource> {
  const mimeType = normalizedImageMimeType(file, unsupportedMessage);
  let data: string;
  try {
    data = await readFileAsBase64(file);
  } catch {
    throw new UnsupportedImageError(file.name, unsupportedMessage(file.name));
  }
  return {
    file,
    data,
    mimeType,
    canReencode: COMPRESSIBLE_IMAGE_MIME_TYPES.includes(mimeType),
  };
}

function sourceAsPreparedImage(source: ImageSource): PreparedImage {
  return { data: source.data, mimeType: source.mimeType, compressed: false, width: null, height: null };
}

async function decodeImageSource(source: ImageSource, unsupportedMessage: (fileName: string) => string): Promise<ImageBitmap> {
  if (typeof createImageBitmap !== "function") {
    throw new UnsupportedImageError(source.file.name, unsupportedMessage(source.file.name));
  }
  try {
    const bitmap = await createImageBitmap(source.file);
    if (!Number.isFinite(bitmap.width) || !Number.isFinite(bitmap.height) || bitmap.width < 1 || bitmap.height < 1) {
      bitmap.close?.();
      throw new UnsupportedImageError(source.file.name, unsupportedMessage(source.file.name));
    }
    return bitmap;
  } catch (error) {
    if (error instanceof UnsupportedImageError) throw error;
    throw new UnsupportedImageError(source.file.name, unsupportedMessage(source.file.name));
  }
}

async function validateImageSource(source: ImageSource, unsupportedMessage: (fileName: string) => string): Promise<void> {
  const bitmap = await decodeImageSource(source, unsupportedMessage);
  bitmap.close?.();
}

function encodeCanvas(
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
  quality: number,
  fileName: string,
  unsupportedMessage: (fileName: string) => string,
): Pick<PreparedImage, "data" | "mimeType"> {
  const webp = canvas.toDataURL(COMPRESSED_IMAGE_MIME_TYPE, quality);
  const webpData = webp.slice(webp.indexOf(",") + 1);
  if (webpData && webp.startsWith("data:" + COMPRESSED_IMAGE_MIME_TYPE)) {
    return { data: webpData, mimeType: COMPRESSED_IMAGE_MIME_TYPE };
  }

  // Canvas implementations without WebP fall back to JPEG. Paint behind alpha
  // only on this fallback so WebP screenshots retain their original alpha.
  context.save();
  context.globalCompositeOperation = "destination-over";
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  const jpeg = canvas.toDataURL("image/jpeg", quality);
  context.restore();
  const jpegData = jpeg.slice(jpeg.indexOf(",") + 1);
  if (!jpegData || !jpeg.startsWith("data:image/jpeg")) {
    throw new UnsupportedImageError(fileName, unsupportedMessage(fileName));
  }
  return { data: jpegData, mimeType: "image/jpeg" };
}

/** Encode one source File from its decoded original bitmap until it meets target. */
async function encodeImageSource(
  source: ImageSource,
  targetBase64Length: number,
  unsupportedMessage: (fileName: string) => string,
): Promise<PreparedImage> {
  const bitmap = await decodeImageSource(source, unsupportedMessage);
  try {
    const { image } = await runCompressionLadder(compressionStepsForTarget(targetBase64Length), targetBase64Length, async (step) => {
      const size = fitWithinEdge(bitmap.width, bitmap.height, step.maxEdge);
      const canvas = document.createElement("canvas");
      canvas.width = size.width;
      canvas.height = size.height;
      const context = canvas.getContext("2d");
      if (!context) throw new UnsupportedImageError(source.file.name, unsupportedMessage(source.file.name));
      context.drawImage(bitmap, 0, 0, size.width, size.height);
      const encoded = encodeCanvas(canvas, context, step.quality, source.file.name, unsupportedMessage);
      return { ...encoded, width: size.width, height: size.height };
    });
    return { data: image.data, mimeType: image.mimeType, compressed: true, width: image.width, height: image.height };
  } finally {
    bitmap.close?.();
  }
}

/**
 * Prepare every image for one outgoing prompt, steer, or follow-up frame.
 *
 * It first reads all original payloads and keeps them untouched when the final
 * serialized frame fits. Otherwise, it water-fills the payload allowance: small
 * screenshots retain their originals and only larger sources are re-encoded
 * from their File bytes. A failed decode or an impossible aggregate budget
 * rejects the whole batch; no attachment is silently omitted.
 */
export async function prepareImageBatchForAttachment(input: PrepareImageBatchInput): Promise<readonly PreparedImage[]> {
  const limit = input.limit ?? PROMPT_FRAME_BUDGET_BYTES;
  const sources = await Promise.all(input.files.map((file) => readImageSource(file, input.unsupportedMessage)));
  const originals = sources.map(sourceAsPreparedImage);
  const originalBudget = checkPromptFrameBudget({
    message: input.message,
    images: originals.map((image, index) => ({ ...image, name: sources[index].file.name })),
    limit,
  });
  if (originalBudget.ok) {
    await Promise.all(sources.filter((source) => source.canReencode).map((source) => validateImageSource(source, input.unsupportedMessage)));
    return originals;
  }

  const frameOverhead = estimatePromptFrameBytes({
    message: input.message,
    images: originals.map((image) => ({ ...image, data: "" })),
  });
  const targets = allocateAdaptiveImagePayloads({
    originalBase64Lengths: originals.map((image) => image.data.length),
    canReencode: sources.map((source) => source.canReencode),
    payloadBudget: limit - frameOverhead,
  });
  const prepared: PreparedImage[] = [];
  for (let index = 0; index < sources.length; index++) {
    const source = sources[index];
    if (!source.canReencode || source.data.length <= targets[index]) {
      if (source.canReencode) await validateImageSource(source, input.unsupportedMessage);
      prepared.push(sourceAsPreparedImage(source));
    } else {
      prepared.push(await encodeImageSource(source, targets[index], input.unsupportedMessage));
    }
  }

  const finalBudget = checkPromptFrameBudget({
    message: input.message,
    images: prepared.map((image, index) => ({ ...image, name: sources[index].file.name })),
    limit,
  });
  if (!finalBudget.ok) throw new PromptFrameBudgetError(finalBudget);
  return prepared;
}

/**
 * Decode, downscale and re-encode a single source only when it exceeds the
 * single-image allowance. Kept for callers that do not have a batch context.
 */
export async function prepareImageForAttachment(
  file: File,
  unsupportedMessage: (fileName: string) => string,
): Promise<PreparedImage> {
  const source = await readImageSource(file, unsupportedMessage);
  const plan = planImageCompression({ byteLength: file.size, mimeType: source.mimeType });
  if (plan.kind === "passthrough") {
    if (source.canReencode) await validateImageSource(source, unsupportedMessage);
    return sourceAsPreparedImage(source);
  }
  return encodeImageSource(source, plan.targetBase64Length, unsupportedMessage);
}
