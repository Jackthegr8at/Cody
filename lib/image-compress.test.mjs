import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";
import puppeteer from "puppeteer-core";
import ts from "typescript";

/**
 * The attachment policy, tested where it actually decides things.
 *
 * Everything here is the pure half of lib/image-compress.ts: what gets
 * compressed, how far down the ladder it walks, and whether the assembled
 * prompt can fit in the one RPC frame omp will accept. The canvas half cannot
 * run under node (no DOM, and faking one would mean a new dependency), so the
 * ladder is exercised through an injected encoder instead — which is the whole
 * reason the loop takes one.
 */

const jiti = createJiti(import.meta.url);
const {
  allocateAdaptiveImagePayloads,
  base64LengthForBytes,
  checkPromptFrameBudget,
  COMPRESSION_STEPS,
  estimatePromptFrameBytes,
  fitWithinEdge,
  formatAttachmentSize,
  IMAGE_MAX_EDGE_PX,
  IMAGE_MINIMUM_EDGE_PX,
  IMAGE_PASSTHROUGH_BASE64_BYTES,
  IMAGE_TARGET_BASE64_BYTES,
  planImageCompression,
  PROMPT_FRAME_BUDGET_BYTES,
  runCompressionLadder,
} = await jiti.import("./image-compress.ts");


/** Largest file whose base64 still fits the pass-through allowance. */
const PASSTHROUGH_MAX_FILE_BYTES = (IMAGE_PASSTHROUGH_BASE64_BYTES / 4) * 3;


test("base64 length accounts for padding", () => {
  assert.equal(base64LengthForBytes(0), 0);
  assert.equal(base64LengthForBytes(1), 4);
  assert.equal(base64LengthForBytes(3), 4);
  assert.equal(base64LengthForBytes(4), 8);
  assert.equal(base64LengthForBytes(3 * 1024), 4 * 1024);
});

test("screenshots pass through untouched; anything bigger gets the ladder", () => {
  const png = (byteLength) => planImageCompression({ byteLength, mimeType: "image/png" });

  assert.deepEqual(png(80 * 1024), { kind: "passthrough", reason: "within-budget" });
  // Exactly at the allowance is still pass-through: pixel-crisp screenshots.
  assert.deepEqual(png(PASSTHROUGH_MAX_FILE_BYTES), { kind: "passthrough", reason: "within-budget" });
  assert.equal(png(PASSTHROUGH_MAX_FILE_BYTES + 1).kind, "compress");

  const plan = png(6 * 1024 * 1024);
  assert.equal(plan.kind, "compress");
  assert.equal(plan.targetBase64Length, IMAGE_TARGET_BASE64_BYTES);
  assert.deepEqual(plan.steps, COMPRESSION_STEPS);

  // Vector art is never rasterized, at any size — the total budget catches an
  // oversized one instead.
  assert.deepEqual(
    planImageCompression({ byteLength: 4 * 1024 * 1024, mimeType: "image/svg+xml" }),
    { kind: "passthrough", reason: "vector" },
  );
  // Case is not the user's problem.
  assert.equal(planImageCompression({ byteLength: 9 * 1024 * 1024, mimeType: "IMAGE/JPEG" }).kind, "compress");
});


test("adaptive payloads preserve small originals and redistribute their share", () => {
  const targets = allocateAdaptiveImagePayloads({
    originalBase64Lengths: [16, 20, 500, 500],
    canReencode: [true, true, true, true],
    payloadBudget: 600,
  });
  assert.deepEqual(targets, [16, 20, 282, 282]);
  assert.equal(targets.reduce((total, target) => total + target, 0), 600);

  // A source which cannot be re-encoded reserves its real payload first.
  assert.deepEqual(
    allocateAdaptiveImagePayloads({
      originalBase64Lengths: [16, 500, 300],
      canReencode: [true, true, false],
      payloadBudget: 500,
    }),
    [16, 184, 300],
  );
});

test("fitting to the long edge never upscales and never rounds to zero", () => {
  assert.deepEqual(fitWithinEdge(4032, 3024, 2048), { width: 2048, height: 1536 });
  assert.deepEqual(fitWithinEdge(3024, 4032, 2048), { width: 1536, height: 2048 });
  assert.deepEqual(fitWithinEdge(4000, 4000, 1568), { width: 1568, height: 1568 });
  // Already small: left exactly as it is.
  assert.deepEqual(fitWithinEdge(800, 600, 2048), { width: 800, height: 600 });
  // A panorama's short edge still survives as a pixel.
  const strip = fitWithinEdge(20000, 3, 2048);
  assert.equal(strip.width, 2048);
  assert.ok(strip.height >= 1);
});

test("the ladder stops at the first rung that fits", async () => {
  const seen = [];
  const result = await runCompressionLadder(COMPRESSION_STEPS, IMAGE_TARGET_BASE64_BYTES, async (step) => {
    seen.push(step);
    // Small original: the very first, highest-quality rung is already under.
    return { data: "A".repeat(120 * 1024), mimeType: "image/jpeg", width: 2048, height: 1365 };
  });
  assert.equal(seen.length, 1);
  assert.equal(result.attempts, 1);
  assert.equal(result.withinTarget, true);
  assert.equal(result.step.quality, 0.9);
});

test("a big photo walks down until it fits, in order", async () => {
  const seen = [];
  // Synthetic sizes shrinking with quality: only 0.6 and below come in under.
  const sizeFor = (step) => Math.round(IMAGE_TARGET_BASE64_BYTES * (step.quality / 0.65) * (step.maxEdge / IMAGE_MAX_EDGE_PX));
  const result = await runCompressionLadder(COMPRESSION_STEPS, IMAGE_TARGET_BASE64_BYTES, async (step) => {
    seen.push(step);
    return { data: "A".repeat(sizeFor(step)), mimeType: "image/jpeg", width: step.maxEdge, height: step.maxEdge };
  });
  assert.deepEqual(seen, COMPRESSION_STEPS.slice(0, seen.length));
  assert.equal(result.withinTarget, true);
  assert.equal(result.step.quality, 0.6);
  assert.equal(result.attempts, 4);
  assert.ok(result.image.data.length <= IMAGE_TARGET_BASE64_BYTES);
});

test("when no rung fits, the smallest result comes back flagged", async () => {
  const result = await runCompressionLadder(COMPRESSION_STEPS, IMAGE_TARGET_BASE64_BYTES, async (step) => ({
    // Never under target, and smallest at the very bottom of the ladder.
    data: "A".repeat(IMAGE_TARGET_BASE64_BYTES * 4 + Math.round(step.quality * 1000) + step.maxEdge),
    mimeType: "image/jpeg",
    width: step.maxEdge,
    height: step.maxEdge,
  }));
  assert.equal(result.withinTarget, false);
  assert.equal(result.attempts, COMPRESSION_STEPS.length);
  assert.equal(result.step.maxEdge, IMAGE_MINIMUM_EDGE_PX);
  assert.equal(result.step.quality, 0.5);
  // The caller still gets an image — the budget check is what refuses the send.
  assert.ok(result.image.data.length > IMAGE_TARGET_BASE64_BYTES);
});

test("the frame estimate is never smaller than the frame that gets serialized", () => {
  const images = [
    { type: "image", mimeType: "image/jpeg", data: "A".repeat(400 * 1024) },
    { type: "image", mimeType: "image/png", data: "B".repeat(64 * 1024) },
  ];
  const message = "look at these two — “quoted”, multi-byte 日本語, and a\nnewline";
  const actual = Buffer.byteLength(JSON.stringify({ type: "prompt", id: "w17", message, images }), "utf8");
  const estimate = estimatePromptFrameBytes({ message, images });
  assert.ok(estimate >= actual, `estimate ${estimate} must not undercount ${actual}`);
  // ...and not so padded that it refuses messages that would have fit.
  assert.ok(estimate - actual < 1024);
});

test("an oversized message is refused in the composer, naming what to remove", () => {
  const small = { data: "A".repeat(200 * 1024), mimeType: "image/jpeg", name: "receipt.jpg" };
  const large = { data: "B".repeat(750 * 1024), mimeType: "image/jpeg", name: "IMG_4021.jpg" };

  const fits = checkPromptFrameBudget({ message: "hello", images: [small] });
  assert.equal(fits.ok, true);
  assert.equal(fits.largest, null);

  const over = checkPromptFrameBudget({ message: "hello", images: [small, large] });
  assert.equal(over.ok, false);
  assert.equal(over.limit, PROMPT_FRAME_BUDGET_BYTES);
  assert.ok(over.totalBytes > PROMPT_FRAME_BUDGET_BYTES);
  // The one worth removing is named, not just "something is too big".
  assert.equal(over.largest.index, 1);
  assert.equal(over.largest.name, "IMG_4021.jpg");
  // Reported in the decoded size a human recognizes, not base64 characters.
  assert.ok(over.largest.byteLength < large.data.length);

  // A text-only message over the budget has no attachment to blame.
  const textOnly = checkPromptFrameBudget({ message: "x".repeat(PROMPT_FRAME_BUDGET_BYTES + 1), images: [] });
  assert.equal(textOnly.ok, false);
  assert.equal(textOnly.largest, null);

  // Ten compressed images at the target still clear the budget only if the
  // per-image target is respected — pin the arithmetic that makes that true.
  const atTarget = { data: "C".repeat(IMAGE_TARGET_BASE64_BYTES), mimeType: "image/jpeg" };
  assert.equal(checkPromptFrameBudget({ message: "", images: [atTarget] }).ok, true);
  assert.equal(checkPromptFrameBudget({ message: "", images: [atTarget, atTarget] }).ok, false);
});

test("sizes read the way a file manager shows them", () => {
  assert.equal(formatAttachmentSize(0), "0 KB");
  assert.equal(formatAttachmentSize(900), "1 KB");
  assert.equal(formatAttachmentSize(820 * 1024), "820 KB");
  assert.equal(formatAttachmentSize(Math.round(1.44 * 1024 * 1024)), "1.4 MB");
});


const browserModuleSource = ts.transpileModule(
  await readFile(new URL("./image-compress.ts", import.meta.url), "utf8"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } },
).outputText;

/**
 * This is intentionally a Chromium fixture rather than a mock canvas: it
 * exercises FileReader, createImageBitmap, WebP encoding, base64 decode, and
 * the exact JSON frame that reaches the 900 KiB safety budget.
 */
test("ten text screenshots encode, decode, and serialize inside one prompt frame", { timeout: 30_000 }, async (t) => {
  const executablePath = process.env.CODY_CHROMIUM_BIN || (process.platform === "linux" ? "/usr/bin/chromium" : undefined);
  if (!executablePath || !existsSync(executablePath)) {
    t.skip("requires Chromium: set CODY_CHROMIUM_BIN or install /usr/bin/chromium");
    return;
  }
  const chromium = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const page = await chromium.newPage();
    const result = await page.evaluate(async ({ moduleSource, limit }) => {
      const moduleUrl = URL.createObjectURL(new Blob([moduleSource], { type: "text/javascript" }));
      const compression = await import(moduleUrl);
      URL.revokeObjectURL(moduleUrl);

      const asBlob = (canvas, type) => new Promise((resolve, reject) => {
        canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("canvas encode failed")), type);
      });
      const makeScreenshot = async (index) => {
        const compact = index === 0;
        const canvas = document.createElement("canvas");
        canvas.width = compact ? 320 : 1600;
        canvas.height = compact ? 220 : 1000;
        const context = canvas.getContext("2d");
        context.fillStyle = "#0f172a";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = "#1e293b";
        context.fillRect(0, 0, canvas.width, compact ? 28 : 46);
        context.fillStyle = "#e2e8f0";
        context.font = compact ? "12px ui-monospace, monospace" : "20px ui-monospace, monospace";
        context.fillText("Cody screenshot " + (index + 1) + "  —  active turn", compact ? 12 : 28, compact ? 19 : 31);
        const lineHeight = compact ? 13 : 24;
        const firstLine = compact ? 48 : 92;
        const lines = compact ? 12 : 36;
        for (let line = 0; line < lines; line++) {
          const y = firstLine + line * lineHeight;
          context.fillStyle = line % 5 === 0 ? "#7dd3fc" : line % 3 === 0 ? "#c4b5fd" : "#e2e8f0";
          const code = "const screenshot" + index + "Line" + line + " = await prepareImageBatchForAttachment({ files, message, limit });";
          context.fillText(code, compact ? 12 : 42, y);
          if (!compact) {
            context.fillStyle = "#334155";
            context.fillRect(1240, y - 15, 260 - (line % 7) * 20, 4);
          }
        }
        const blob = await asBlob(canvas, "image/png");
        return new File([blob], "text-screenshot-" + (index + 1) + ".png", { type: "image/png" });
      };

      const files = await Promise.all(Array.from({ length: 10 }, (_, index) => makeScreenshot(index)));
      const originals = await Promise.all(files.map((file) => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      })));
      const message = "Compare every attached editor screenshot; retain code and text detail. 日本語 ✓";
      const prepared = await compression.prepareImageBatchForAttachment({
        files,
        message,
        limit,
        unsupportedMessage: (fileName) => "Unsupported image: " + fileName,
      });
      const images = prepared.map(({ data, mimeType }) => ({ type: "image", data, mimeType }));
      const frame = JSON.stringify({ type: "prompt", id: "fixture-10", message, images });
      const decoded = await Promise.all(prepared.map(async (image) => {
        const response = await fetch("data:" + image.mimeType + ";base64," + image.data);
        const bitmap = await createImageBitmap(await response.blob());
        const dimensions = { width: bitmap.width, height: bitmap.height };
        bitmap.close();
        return dimensions;
      }));
      let invalidErrorName = null;
      try {
        await compression.prepareImageBatchForAttachment({
          files: [new File([new Uint8Array(32)], "broken.png", { type: "image/png" })],
          message: "validate this attachment",
          limit,
          unsupportedMessage: (fileName) => "Unsupported image: " + fileName,
        });
      } catch (error) {
        invalidErrorName = error instanceof Error ? error.name : String(error);
      }
      return {
        originalPayloadBytes: originals.reduce((total, data) => total + data.length, 0),
        frameBytes: new TextEncoder().encode(frame).byteLength,
        output: prepared.map((image) => ({
          compressed: image.compressed,
          mimeType: image.mimeType,
          width: image.width,
          height: image.height,
          dataLength: image.data.length,
        })),
        decoded,
        invalidErrorName,
      };
    }, { moduleSource: browserModuleSource, limit: PROMPT_FRAME_BUDGET_BYTES });

    assert.ok(result.originalPayloadBytes > PROMPT_FRAME_BUDGET_BYTES, "fixture must require adaptive compression");
    assert.ok(result.frameBytes <= PROMPT_FRAME_BUDGET_BYTES, "final JSON frame must fit the transport safety budget");
    assert.equal(result.output.length, 10);
    assert.equal(result.invalidErrorName, "UnsupportedImageError", "a corrupt image must reject rather than disappear");
    assert.equal(result.output[0].compressed, false, "the compact screenshot must retain its crisp original bytes");
    assert.ok(result.output.slice(1).every((image) => image.compressed && image.mimeType === "image/webp"));
    for (let index = 0; index < result.output.length; index++) {
      assert.equal(result.decoded[index].width, result.output[index].width ?? 320);
      assert.equal(result.decoded[index].height, result.output[index].height ?? 220);
    }
    assert.ok(result.decoded.slice(1).every((image) => image.width >= IMAGE_MINIMUM_EDGE_PX && image.height >= 560));
  } finally {
    await chromium.close();
  }
});
