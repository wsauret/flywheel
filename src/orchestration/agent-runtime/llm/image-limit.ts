/**
 * The cut of the oldest replayed images that keeps a request within its model's image limit
 * (`maxImagesPerRequest`). Adapted from `boundImages` and `IMAGE_REMOVED` in opencode
 * `packages/core/src/session/model-request.ts` (commit 69269e4e), which bounds the bytes of the replayed images;
 * this cut counts images instead.
 */

/** The text that takes the place of a removed image. Copied verbatim from opencode `IMAGE_REMOVED` with one
 *  replacement: "to reduce the request size" became "to stay within the model's image limit", because this cut
 *  counts images and does not measure size. */
export const IMAGE_REMOVED =
  "[This image was removed to stay within the model's image limit and is no longer visible. Do not make claims about its contents from memory. If needed, retrieve it again with an available tool or ask the user to attach it again.]";

/**
 * How many of the oldest of `images` replayed images a request replaces, for a model that takes at most `limit`.
 * The walk adds the images oldest first, and each time the kept count passes `limit` it drops the oldest down to half
 * of `limit`. A new image therefore moves the cut only once every `limit - target` images, so the replaced prefix,
 * and with it the provider's prompt cache, stays the same between cuts. The result depends only on its inputs, so a
 * retry or a resumed run replaces the same images.
 */
export function imagesReplaced(images: number, limit: number): number {
  const target = Math.floor(limit / 2);
  let cut = 0;
  let kept = 0;
  for (let image = 0; image < images; image++) {
    kept += 1;
    if (kept <= limit) continue;
    cut += kept - target;
    kept = target;
  }
  return cut;
}
