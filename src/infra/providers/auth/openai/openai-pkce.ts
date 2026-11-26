function base64UrlEncode(buffer: ArrayBuffer): string {
  return Buffer.from(buffer).toString("base64url");
}

function generateRandomString(length: number): string {
  const byteCount = Math.ceil((length * 6) / 8);
  const bytes = crypto.getRandomValues(new Uint8Array(byteCount));
  return base64UrlEncode(bytes.buffer).slice(0, length);
}

export async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const verifier = generateRandomString(43);
  const encoded = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  const challenge = base64UrlEncode(digest);
  return { verifier, challenge };
}

export function generateState(): string {
  return generateRandomString(32);
}
