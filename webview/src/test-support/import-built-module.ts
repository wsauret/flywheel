/**
 * Import a JavaScript build artifact, propagating import failures.
 * Blob URLs avoid Bun's LCOV formatter crash on long data URLs.
 * Revoke the URL after settlement to release its retained artifact.
 */
export async function importBuiltModule(artifact: Bun.BuildArtifact) {
  const url = URL.createObjectURL(artifact)
  try {
    return await import(url)
  } finally {
    URL.revokeObjectURL(url)
  }
}
