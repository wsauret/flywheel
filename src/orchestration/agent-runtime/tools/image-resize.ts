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

export interface ResizedImage {
  data: string;
  mimeType: string;
  originalWidth: number;
  originalHeight: number;
  width: number;
  height: number;
  wasResized: boolean;
}

const MAX_DIMENSION = 2000;
const MAX_BYTES = 4.5 * 1024 * 1024;
const QUALITY_STEPS = [85, 70, 55, 40] as const;
const SCALE_STEPS = [0.75, 0.5, 0.35, 0.25] as const;
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
 * Bytes in an accepted format within the limits pass through unchanged. Every
 * other readable image is re-encoded as PNG, or as JPEG when PNG is over the
 * byte budget. Returns null when sharp is unavailable, the bytes are not a
 * readable image, or no encoding fits the budget.
 */
export async function resizeImage(base64: string): Promise<ResizedImage | null> {
  const sharp = await loadSharp();
  if (!sharp) return null;

  const inputBuf = Buffer.from(base64, "base64");

  let origW = 0;
  let origH = 0;
  let format: string | undefined;
  try {
    const metadata = await sharp(inputBuf).metadata();
    origW = metadata.width ?? 0;
    origH = metadata.height ?? 0;
    format = metadata.format;
  } catch (err) {
    log.info("image metadata read failed", { byteLength: inputBuf.byteLength, error: errorMessage(err), errorDetail: errorDetail(err) });
    return null;
  }

  if (origW === 0 || origH === 0) return null;

  const passthroughType = format === undefined ? undefined : PROVIDER_MEDIA_TYPES.get(format);
  if (passthroughType && origW <= MAX_DIMENSION && origH <= MAX_DIMENSION && fitsInBudget(inputBuf)) {
    return {
      data: base64,
      mimeType: passthroughType,
      originalWidth: origW,
      originalHeight: origH,
      width: origW,
      height: origH,
      wasResized: false,
    };
  }

  const encoded = (buf: Buffer, info: { width: number; height: number }, mimeType: string): ResizedImage => ({
    data: buf.toString("base64"),
    mimeType,
    originalWidth: origW,
    originalHeight: origH,
    width: info.width,
    height: info.height,
    wasResized: info.width !== origW || info.height !== origH,
  });

  const fitW = Math.min(origW, MAX_DIMENSION);
  const fitH = Math.min(origH, MAX_DIMENSION);

  const { data: pngBuf, info: pngInfo } = await sharp(inputBuf)
    .resize(fitW, fitH, { fit: "inside" })
    .png()
    .toBuffer({ resolveWithObject: true });

  if (fitsInBudget(pngBuf)) return encoded(pngBuf, pngInfo, "image/png");

  for (const quality of QUALITY_STEPS) {
    const { data: jpegBuf, info: jpegInfo } = await sharp(inputBuf)
      .resize(fitW, fitH, { fit: "inside" })
      .jpeg({ quality })
      .toBuffer({ resolveWithObject: true });

    if (fitsInBudget(jpegBuf)) return encoded(jpegBuf, jpegInfo, "image/jpeg");
  }

  for (const scale of SCALE_STEPS) {
    const scaledW = Math.round(fitW * scale);
    const scaledH = Math.round(fitH * scale);

    for (const quality of QUALITY_STEPS) {
      const { data: scaledBuf, info: scaledInfo } = await sharp(inputBuf)
        .resize(scaledW, scaledH, { fit: "inside" })
        .jpeg({ quality })
        .toBuffer({ resolveWithObject: true });

      if (fitsInBudget(scaledBuf)) return encoded(scaledBuf, scaledInfo, "image/jpeg");
    }
  }

  return null;
}
