/**
 * Image resizing for the read tool.
 *
 * Uses sharp to resize images that exceed the LLM's size limits.
 * Strategy: fit within 2000x2000, then cascade JPEG quality and
 * progressive dimension reduction to stay under 4.5MB base64.
 */

import sharp from "sharp";

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

function fitsInBudget(buf: Buffer): boolean {
  return Math.ceil(buf.byteLength / 3) * 4 <= MAX_BYTES;
}

export async function resizeImage(
  base64: string,
  mimeType: string,
): Promise<ResizedImage | null> {
  const inputBuf = Buffer.from(base64, "base64");

  let img: sharp.Sharp;
  let meta: sharp.Metadata;
  try {
    img = sharp(inputBuf);
    meta = await img.metadata();
  } catch {
    return null;
  }

  const origW = meta.width ?? 0;
  const origH = meta.height ?? 0;
  if (origW === 0 || origH === 0) return null;

  // If already within limits, return as-is
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

  // Fit within MAX_DIMENSION, try PNG first
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

  // JPEG quality cascade at fitted dimensions
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

  // Progressive dimension reduction with JPEG quality cascade
  for (const scale of SCALE_STEPS) {
    if (scale >= 1.0) continue; // already tried full size above
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

  // Could not fit within budget even at smallest scale
  return null;
}
