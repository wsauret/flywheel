/**
 * Image resizing for the read tool and for images the terminal attaches to a
 * message, so both cost the model the same.
 *
 * Uses sharp to resize images that exceed the LLM size limits.
 * Strategy: fit within 2000x2000, then cascade JPEG quality and
 * progressive dimension reduction to stay under 4.5MB base64.
 *
 * sharp is loaded lazily so compiled binaries can start even when Bun cannot
 * load the native module from the standalone bundle. Compiled installs ship a
 * vendored sharp runtime next to the executable, which we load on demand when
 * the bundled import path is unavailable.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { errorDetail, errorMessage } from "../../../infra/error-message.js";
import { Log } from "../../../infra/log.js";
import { nativeAssetDir } from "../../../infra/native-assets.js";

type SharpFactory = typeof import("sharp").default;

/** An image whose bytes the decoder read, fitted within the provider limits. */
interface ResizedImage {
  readonly kind: "decoded";
  readonly data: string;
  readonly mimeType: string;
  readonly originalWidth: number;
  readonly originalHeight: number;
  readonly width: number;
  readonly height: number;
  readonly wasResized: boolean;
}

/** Bytes that the decoder rejected. `reason` is the decoder's first message line. */
interface UnreadableImage {
  readonly kind: "unreadable";
  readonly reason: string;
}

/** The answer of `resizeImage`. `unavailable` means sharp could not load, so nothing is known about the bytes. */
export type ImageResizeResult = ResizedImage | UnreadableImage | { readonly kind: "unavailable" };

const MAX_DIMENSION = 2000;
const MAX_BYTES = 4.5 * 1024 * 1024;
const QUALITY_STEPS = [85, 70, 55, 40] as const;
const SCALE_STEPS = [0.75, 0.5, 0.35, 0.25] as const;
interface EncodingStep { readonly scale: number; readonly quality: number | undefined }
/** Every encoding to try, largest first: PNG at the fitted size, then JPEG at falling quality and scale. */
const ENCODING_STEPS: readonly EncodingStep[] = [
  { scale: 1, quality: undefined },
  ...[1, ...SCALE_STEPS].flatMap((scale) => QUALITY_STEPS.map((quality) => ({ scale, quality }))),
];
const VENDORED_SHARP_ENTRY = ["node_modules", "sharp", "dist", "index.cjs"] as const;
const log = Log.create({ service: "image-resize" });

// Process-global because sharp's native bindings are dlopen'd once per process.
// Cached as a promise so concurrent callers await the single load in flight.
let sharpFactoryPromise: Promise<SharpFactory | null> | undefined;

function normalizeSharpModule(mod: unknown): SharpFactory | null {
  // External boundary: the lazily-loaded sharp module is `unknown`. sharp's
  // entry is the factory callable itself (CJS) or under `.default` (ESM
  // interop). We verify it is callable, then assert SharpFactory - TypeScript
  // narrows a function to `Function`, not to sharp's specific call signature,
  // and we accept the runtime contract that sharp's export IS that signature.
  if (typeof mod === "function") {
    // SAFETY: sharp's CJS export is the factory callable; verified callable above.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: sharp exposes an opaque CommonJS callable export
    return mod as typeof mod & SharpFactory;
  }
  if (mod && typeof mod === "object" && "default" in mod && typeof mod.default === "function") {
    // SAFETY: sharp's ESM-interop export puts the factory callable on `.default`; verified callable above.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: sharp exposes an opaque ESM default callable export
    return mod.default as typeof mod.default & SharpFactory;
  }
  return null;
}

function loadVendoredSharp(): SharpFactory | null {
  const entryPath = join(nativeAssetDir(), ...VENDORED_SHARP_ENTRY);
  if (!existsSync(entryPath)) return null;

  try {
    const requireFromEntry = createRequire(entryPath);
    const mod: unknown = requireFromEntry(entryPath);
    return normalizeSharpModule(mod);
  } catch (err) {
    log.info("vendored sharp load failed", { entryPath, error: errorMessage(err), errorDetail: errorDetail(err) });
    return null;
  }
}

async function loadSharp(): Promise<SharpFactory | null> {
  if (!sharpFactoryPromise) {
    const vendored = loadVendoredSharp();
    sharpFactoryPromise = vendored
      ? Promise.resolve(vendored)
      : import("sharp")
        .then((mod) => normalizeSharpModule(mod))
        .catch((err) => {
          log.info("sharp import failed", { error: errorMessage(err), errorDetail: errorDetail(err) });
          return null;
        });
  }

  return sharpFactoryPromise;
}

function fitsInBudget(buf: Buffer): boolean {
  return Math.ceil(buf.byteLength / 3) * 4 <= MAX_BYTES;
}

/** The image formats every provider accepts, keyed by sharp's format name. */
const PROVIDER_MEDIA_TYPES: ReadonlyMap<string, string> = new Map([
  ["png", "image/png"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
]);

/**
 * Fits an image within the provider limits and labels it with the media type
 * of its bytes. The file name or extension that brought the bytes in plays no
 * part: a WebP image saved as `.png` returns `image/webp`, because a provider
 * refuses a request whose stated type disagrees with the bytes.
 *
 * Bytes in an accepted format within the limits pass through unchanged after a
 * full decode, so a truncated file that has a valid header is not sent. Every
 * other readable image is re-encoded as PNG, or as JPEG when PNG is over the
 * byte budget. Returns `unreadable` when the decoder rejects the bytes or reads
 * a zero dimension, and `unavailable` when sharp cannot load.
 */
export async function resizeImage(base64: string): Promise<ImageResizeResult> {
  const sharp = await loadSharp();
  if (!sharp) return { kind: "unavailable" };

  const inputBuf = Buffer.from(base64, "base64");
  try {
    return await fitImage(sharp, inputBuf, base64);
  } catch (err) {
    // The decoder's text can quote the input bytes, so it goes to the tool output and never to the log.
    const reason = errorMessage(err).split("\n", 1)[0] ?? "";
    log.info("image decode failed", { byteLength: inputBuf.byteLength, kind: "decode-failed" });
    return { kind: "unreadable", reason };
  }
}

async function fitImage(sharp: SharpFactory, inputBuf: Buffer, base64: string): Promise<ResizedImage | UnreadableImage> {
  const metadata = await sharp(inputBuf).metadata();
  const origW = metadata.width ?? 0;
  const origH = metadata.height ?? 0;
  if (origW === 0 || origH === 0) return { kind: "unreadable", reason: "the image has no width or height" };

  const passthroughType = metadata.format === undefined ? undefined : PROVIDER_MEDIA_TYPES.get(metadata.format);
  if (passthroughType && origW <= MAX_DIMENSION && origH <= MAX_DIMENSION && fitsInBudget(inputBuf)) {
    // A header can be valid while the pixel data is cut short; only a full decode proves the provider can read it.
    await sharp(inputBuf).stats();
    return { kind: "decoded", data: base64, mimeType: passthroughType, originalWidth: origW, originalHeight: origH, width: origW, height: origH, wasResized: false };
  }

  const fitW = Math.min(origW, MAX_DIMENSION);
  const fitH = Math.min(origH, MAX_DIMENSION);
  const encode = async ({ scale, quality }: EncodingStep) => {
    const pipeline = sharp(inputBuf).resize(Math.round(fitW * scale), Math.round(fitH * scale), { fit: "inside" });
    const { data, info } = await (quality === undefined ? pipeline.png() : pipeline.jpeg({ quality })).toBuffer({ resolveWithObject: true });
    const image: ResizedImage = {
      kind: "decoded",
      data: data.toString("base64"),
      mimeType: quality === undefined ? "image/png" : "image/jpeg",
      originalWidth: origW,
      originalHeight: origH,
      width: info.width,
      height: info.height,
      wasResized: info.width !== origW || info.height !== origH,
    };
    return { image, fits: fitsInBudget(data) };
  };

  for (const step of ENCODING_STEPS.slice(0, -1)) {
    const { image, fits } = await encode(step);
    if (fits) return image;
  }
  // SAFETY: ENCODING_STEPS is a non-empty literal list. Its last step, a JPEG at quality 40 within 500x500 pixels,
  // is far under the budget, so it ends the cascade without the check.
  return (await encode(ENCODING_STEPS.at(-1)!)).image;
}
