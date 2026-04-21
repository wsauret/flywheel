/**
 * Image resizing for the read tool.
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
import { dirname, join } from "node:path";

type SharpFactory = typeof import("sharp");

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
const SCALE_STEPS = [1.0, 0.75, 0.5, 0.35, 0.25] as const;
const VENDORED_SHARP_ENTRY = ["flywheel-runtime", "node_modules", "sharp", "lib", "index.js"] as const;

let sharpFactoryPromise: Promise<SharpFactory | null> | undefined;

function normalizeSharpModule(mod: unknown): SharpFactory | null {
  if (typeof mod === "function") return mod as SharpFactory;
  if (
    mod &&
    typeof mod === "object" &&
    "default" in mod &&
    typeof (mod as { default?: unknown }).default === "function"
  ) {
    return (mod as { default: SharpFactory }).default;
  }
  return null;
}

function loadVendoredSharp(): SharpFactory | null {
  const entryPath = join(dirname(process.execPath), ...VENDORED_SHARP_ENTRY);
  if (!existsSync(entryPath)) return null;

  try {
    const requireFromEntry = createRequire(entryPath);
    return normalizeSharpModule(requireFromEntry(entryPath) as unknown);
  } catch {
    return null;
  }
}

async function loadSharp(): Promise<SharpFactory | null> {
  if (!sharpFactoryPromise) {
    sharpFactoryPromise = import("sharp")
      .then((mod) => normalizeSharpModule(mod))
      .catch(() => loadVendoredSharp());
  }

  return sharpFactoryPromise;
}

function fitsInBudget(buf: Buffer): boolean {
  return Math.ceil(buf.byteLength / 3) * 4 <= MAX_BYTES;
}

export async function resizeImage(
  base64: string,
  mimeType: string,
): Promise<ResizedImage | null> {
  const sharp = await loadSharp();
  if (!sharp) return null;

  const inputBuf = Buffer.from(base64, "base64");

  let origW = 0;
  let origH = 0;
  try {
    const metadata = await sharp(inputBuf).metadata();
    origW = metadata.width ?? 0;
    origH = metadata.height ?? 0;
  } catch {
    return null;
  }

  if (origW === 0 || origH === 0) return null;

  if (origW <= MAX_DIMENSION && origH <= MAX_DIMENSION && fitsInBudget(inputBuf)) {
    return {
      data: base64,
      mimeType,
      originalWidth: origW,
      originalHeight: origH,
      width: origW,
      height: origH,
      wasResized: false,
    };
  }

  const fitW = Math.min(origW, MAX_DIMENSION);
  const fitH = Math.min(origH, MAX_DIMENSION);

  const { data: pngBuf, info: pngInfo } = await sharp(inputBuf)
    .resize(fitW, fitH, { fit: "inside" })
    .png()
    .toBuffer({ resolveWithObject: true });

  if (fitsInBudget(pngBuf)) {
    return {
      data: pngBuf.toString("base64"),
      mimeType: "image/png",
      originalWidth: origW,
      originalHeight: origH,
      width: pngInfo.width,
      height: pngInfo.height,
      wasResized: true,
    };
  }

  for (const quality of QUALITY_STEPS) {
    const { data: jpegBuf, info: jpegInfo } = await sharp(inputBuf)
      .resize(fitW, fitH, { fit: "inside" })
      .jpeg({ quality })
      .toBuffer({ resolveWithObject: true });

    if (fitsInBudget(jpegBuf)) {
      return {
        data: jpegBuf.toString("base64"),
        mimeType: "image/jpeg",
        originalWidth: origW,
        originalHeight: origH,
        width: jpegInfo.width,
        height: jpegInfo.height,
        wasResized: true,
      };
    }
  }

  for (const scale of SCALE_STEPS) {
    if (scale >= 1.0) continue;
    const scaledW = Math.round(fitW * scale);
    const scaledH = Math.round(fitH * scale);

    for (const quality of QUALITY_STEPS) {
      const { data: scaledBuf, info: scaledInfo } = await sharp(inputBuf)
        .resize(scaledW, scaledH, { fit: "inside" })
        .jpeg({ quality })
        .toBuffer({ resolveWithObject: true });

      if (fitsInBudget(scaledBuf)) {
        return {
          data: scaledBuf.toString("base64"),
          mimeType: "image/jpeg",
          originalWidth: origW,
          originalHeight: origH,
          width: scaledInfo.width,
          height: scaledInfo.height,
          wasResized: true,
        };
      }
    }
  }

  return null;
}
