import { Redacted } from "effect";

/** Web Push from the runtime itself: RFC 8291 payload encryption and RFC 8292
 *  VAPID authorization over WebCrypto, posted straight to the browser's push
 *  service over outbound HTTPS. No relay is involved: the relay never learns
 *  that a notification exists, and the push service sees only ciphertext it
 *  cannot open, because the payload is sealed to the browser's own keys. */

/** The `PushSubscriptionJSON` a browser hands out. */
export interface WebPushSubscription {
  readonly endpoint: string;
  readonly keys: { readonly p256dh: string; readonly auth: string };
}

/** The application server key pair: raw P-256 public key and PKCS#8 private
 *  key, both base64url, the private half redacted until signing. */
export interface VapidKeys {
  readonly publicKey: string;
  readonly privateKey: Redacted.Redacted<string>;
}

export interface WebPushMessage {
  readonly title: string;
  readonly body: string;
  /** Where tapping the notification lands. */
  readonly url: string;
  readonly tag?: string;
}

const subtle = crypto.subtle;
const textEncoder = new TextEncoder();
/** RFC 8188 record size; one record carries any payload a notification needs. */
const RECORD_SIZE = 4096;
/** Push services cap payloads at 4 KiB; the header and tag take 16 + 4 + 1 + 65 + 16 bytes of it. */
const MAX_PLAINTEXT_BYTES = RECORD_SIZE - 16 - 4 - 1 - 65 - 16 - 1;
const VAPID_TTL_SECONDS = 12 * 60 * 60;
const PUSH_TTL_SECONDS = 24 * 60 * 60;

export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const decoded = Buffer.from(text, "base64url");
  const copy = new Uint8Array(decoded.byteLength);
  copy.set(decoded);
  return copy;
}

function owned(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await subtle.importKey("raw", owned(ikm), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: owned(salt), info: owned(info) }, key, bytes * 8));
}

/** The one-shot key material the encryption uses. Callers let it be generated;
 *  the known-answer test supplies the RFC's own values. */
export interface EncryptionMaterial {
  readonly serverKeyPair: CryptoKeyPair;
  readonly salt: Uint8Array;
}

async function generateEncryptionMaterial(): Promise<EncryptionMaterial> {
  const generated = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  if (!("privateKey" in generated)) throw new Error("expected an ECDH key pair");
  return { serverKeyPair: generated, salt: crypto.getRandomValues(new Uint8Array(16)) };
}

/** Imports an ECDH P-256 pair from its raw parts, for the RFC vector. */
export async function importEncryptionMaterial(input: { readonly privateKey: string; readonly publicKey: string; readonly salt: string }): Promise<EncryptionMaterial> {
  const publicBytes = fromBase64Url(input.publicKey);
  const jwk: JsonWebKey = { kty: "EC", crv: "P-256", x: toBase64Url(publicBytes.subarray(1, 33)), y: toBase64Url(publicBytes.subarray(33, 65)), d: input.privateKey };
  const privateKey = await subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const publicKey = await subtle.importKey("raw", owned(publicBytes), { name: "ECDH", namedCurve: "P-256" }, true, []);
  return { serverKeyPair: { privateKey, publicKey }, salt: fromBase64Url(input.salt) };
}

/** Seals `plaintext` to a subscription as one `aes128gcm` record: the RFC 8188
 *  header (salt, record size, the server's ephemeral public key) followed by
 *  the ciphertext of the plaintext and the final-record delimiter. */
export async function encryptWebPushPayload(subscription: WebPushSubscription, plaintext: Uint8Array, material: EncryptionMaterial): Promise<Uint8Array> {
  if (plaintext.byteLength > MAX_PLAINTEXT_BYTES) throw new Error(`a push payload may carry at most ${MAX_PLAINTEXT_BYTES} bytes`);
  const clientPublic = fromBase64Url(subscription.keys.p256dh);
  const authSecret = fromBase64Url(subscription.keys.auth);
  const serverPublic = new Uint8Array(await subtle.exportKey("raw", material.serverKeyPair.publicKey));
  const clientKey = await subtle.importKey("raw", owned(clientPublic), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const sharedSecret = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: clientKey }, material.serverKeyPair.privateKey, 256));
  // RFC 8291 section 3.3: the input keying material binds both public keys.
  const ikm = await hkdf(authSecret, sharedSecret, concat(textEncoder.encode("WebPush: info\0"), clientPublic, serverPublic), 32);
  // RFC 8188 section 2: the content encryption key and the nonce.
  const contentKey = await hkdf(material.salt, ikm, textEncoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(material.salt, ikm, textEncoder.encode("Content-Encoding: nonce\0"), 12);
  const aes = await subtle.importKey("raw", owned(contentKey), { name: "AES-GCM", length: 128 }, false, ["encrypt"]);
  // 0x02 marks the last record; a notification never needs a second one.
  const padded = concat(plaintext, Uint8Array.of(2));
  const ciphertext = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: owned(nonce) }, aes, owned(padded)));
  const header = new Uint8Array(16 + 4 + 1 + serverPublic.byteLength);
  header.set(material.salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = serverPublic.byteLength;
  header.set(serverPublic, 21);
  return concat(header, ciphertext);
}

/** The `Authorization: vapid` header for one push service origin (RFC 8292). */
export async function vapidAuthorization(keys: VapidKeys, endpoint: string, subject: string, now: number = Date.now()): Promise<string> {
  const audience = new URL(endpoint).origin;
  const header = toBase64Url(textEncoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = toBase64Url(textEncoder.encode(JSON.stringify({ aud: audience, exp: Math.floor(now / 1000) + VAPID_TTL_SECONDS, sub: subject })));
  const signingInput = `${header}.${claims}`;
  const privateKey = await subtle.importKey("pkcs8", owned(fromBase64Url(Redacted.value(keys.privateKey))), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  // WebCrypto ECDSA yields the raw r || s pair, which is exactly the JWS form.
  const signature = new Uint8Array(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, textEncoder.encode(signingInput)));
  return `vapid t=${signingInput}.${toBase64Url(signature)}, k=${keys.publicKey}`;
}

/** The one HTTP call this module makes, narrowed so a test can stand in. */
export type PushPost = (url: string, init: { method: string; headers: { [name: string]: string }; body: Uint8Array<ArrayBuffer>; signal?: AbortSignal }) => Promise<Response>

export type WebPushOutcome =
  | { readonly kind: "delivered"; readonly status: number }
  | { readonly kind: "gone"; readonly status: number }
  | { readonly kind: "failed"; readonly status: number; readonly detail: string };

/** Posts one sealed notification. `gone` means the push service says the
 *  subscription no longer exists, and the caller forgets it. */
export async function sendWebPush(input: {
  readonly subscription: WebPushSubscription;
  readonly vapid: VapidKeys;
  readonly subject: string;
  readonly message: WebPushMessage;
  readonly post?: PushPost;
  readonly signal?: AbortSignal;
}): Promise<WebPushOutcome> {
  input.signal?.throwIfAborted();
  const material = await generateEncryptionMaterial();
  input.signal?.throwIfAborted();
  const body = await encryptWebPushPayload(input.subscription, textEncoder.encode(JSON.stringify(input.message)), material);
  input.signal?.throwIfAborted();
  const authorization = await vapidAuthorization(input.vapid, input.subscription.endpoint, input.subject);
  input.signal?.throwIfAborted();
  const response = await (input.post ?? fetch)(input.subscription.endpoint, {
    method: "POST",
    headers: {
      "Authorization": authorization,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      "TTL": String(PUSH_TTL_SECONDS),
      "Urgency": "normal",
    },
    body: owned(body),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  input.signal?.throwIfAborted();
  if (response.status === 404 || response.status === 410) return { kind: "gone", status: response.status };
  if (response.ok) return { kind: "delivered", status: response.status };
  return { kind: "failed", status: response.status, detail: (await response.text()).slice(0, 200) };
}
