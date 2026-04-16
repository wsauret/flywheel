/**
 * Image reading tool. Reads an image file, validates size, and returns
 * base64-encoded content for inclusion in LLM messages.
 */

import { extname } from "node:path";
import { errorMessage } from "../../../../../infra/error-message.js";
import { Log } from "../../../../../infra/log.js";
import type { ToolDefinition, ToolResult, ToolContext } from "./types.js";

const log = Log.create({ service: "harness-image" });

const MIME_MAP: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export const readImageDefinition: ToolDefinition = {
  name: "read_image",
  description: "Read an image file and return its base64-encoded contents",
  input_schema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
};

export async function executeReadImage(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolResult> {
  if (typeof input.path !== "string") {
    return { content: "read_image requires a string 'path' parameter", isError: true };
  }
  const filePath = input.path;

  const ext = extname(filePath).toLowerCase();
  const mediaType = MIME_MAP[ext];
  if (!mediaType) {
    return {
      content: `Unsupported image format '${ext}'. Supported: ${Object.keys(MIME_MAP).join(", ")}`,
      isError: true,
    };
  }

  try {
    const file = Bun.file(filePath);
    const size = file.size;

    if (size > MAX_IMAGE_BYTES) {
      return {
        content: `Image too large (${size} bytes). Maximum is ${MAX_IMAGE_BYTES} bytes (20MB).`,
        isError: true,
      };
    }

    const buffer = await file.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");

    log.info("image read", { path: filePath, size, mediaType });
    return {
      content: `data:${mediaType};base64,${base64}`,
      isError: false,
    };
  } catch (err) {
    const msg = errorMessage(err);
    log.warn("failed to read image", { path: filePath, error: msg });
    return { content: `Failed to read image '${filePath}': ${msg}`, isError: true };
  }
}
