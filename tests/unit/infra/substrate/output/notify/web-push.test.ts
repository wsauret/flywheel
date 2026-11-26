import { describe, expect, test } from "bun:test";
import { Redacted } from "effect";

import { sendWebPush, type PushPost } from "../../../../../../src/infra/substrate/output/notify/web-push.js";

const base64Url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
const bytesOf = (text: string): Uint8Array<ArrayBuffer> => new Uint8Array(Buffer.from(text, "base64url"));
const textOf = (text: string): string => Buffer.from(text, "base64url").toString("utf8");

async function hkdf(salt: Uint8Array<ArrayBuffer>, ikm: Uint8Array<ArrayBuffer>, info: string | Uint8Array<ArrayBuffer>, bytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const infoBytes = typeof info === "string" ? new TextEncoder().encode(info) : info;
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: infoBytes }, key, bytes * 8));
}

/** The browser's side of RFC 8291: opens one `aes128gcm` record with the
 *  subscription's private key and auth secret. */
async function decryptAsBrowser(body: Uint8Array<ArrayBuffer>, browser: { readonly privateKey: string; readonly p256dh: string; readonly auth: string }): Promise<string> {
  const salt = body.slice(0, 16);
  const keyLength = body[20]!;
  const serverPublic = body.slice(21, 21 + keyLength);
  const browserPublic = bytesOf(browser.p256dh);
  const jwk: JsonWebKey = { kty: "EC", crv: "P-256", x: base64Url(browserPublic.subarray(1, 33)), y: base64Url(browserPublic.subarray(33, 65)), d: browser.privateKey };
  const privateKey = await crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const serverKey = await crypto.subtle.importKey("raw", serverPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: serverKey }, privateKey, 256));
  const keyInfo = new Uint8Array([...new TextEncoder().encode("WebPush: info\0"), ...browserPublic, ...serverPublic]);
  const ikm = await hkdf(bytesOf(browser.auth), sharedSecret, keyInfo, 32);
  const contentKey = await crypto.subtle.importKey("raw", await hkdf(salt, ikm, "Content-Encoding: aes128gcm\0", 16), "AES-GCM", false, ["decrypt"]);
  const nonce = await hkdf(salt, ikm, "Content-Encoding: nonce\0", 12);
  const padded = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, contentKey, body.slice(21 + keyLength)));
  let end = padded.byteLength - 1;
  while (padded[end] === 0) end -= 1;
  expect(padded[end]).toBe(2);
  return new TextDecoder().decode(padded.subarray(0, end));
}

/** RFC 8291 Appendix A is the one published end-to-end example. Opening its
 *  ciphertext proves that the browser side above follows the RFC, so a payload
 *  it opens is one a real browser opens. */
const RFC_8291 = {
  plaintext: "When I grow up, I want to be a watermelon",
  subscription: {
    endpoint: "https://push.example.net/send/x",
    keys: {
      p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
      auth: "BTBZMqHH6r4Tts7J_aSIgg",
    },
  },
  browserPrivateKey: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  body: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};
const browser = { privateKey: RFC_8291.browserPrivateKey, ...RFC_8291.subscription.keys };

async function vapidKeys() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  if (!("privateKey" in pair)) throw new Error("expected a pair");
  return {
    keys: { publicKey: base64Url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))), privateKey: Redacted.make(base64Url(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)))) },
    verify: pair.publicKey,
  };
}

/** Sends one notification to the RFC subscription and keeps the request. */
async function captureSend(message: { title: string; body: string; url: string }) {
  const { keys, verify } = await vapidKeys();
  const posted: Array<{ authorization: string; body: Uint8Array<ArrayBuffer> }> = [];
  const post: PushPost = async (_url, init) => {
    posted.push({ authorization: init.headers["Authorization"]!, body: init.body });
    return new Response("", { status: 201 });
  };
  await sendWebPush({ subscription: RFC_8291.subscription, vapid: keys, subject: "https://flywl.sh", message, post });
  return { keys, verify, request: posted[0]! };
}

describe("web push encryption", () => {
  test("an encrypted payload decrypts with the subscription keys to the original message", async () => {
    expect(await decryptAsBrowser(bytesOf(RFC_8291.body), browser)).toBe(RFC_8291.plaintext);
    const message = { title: "Turn finished", body: RFC_8291.plaintext, url: "https://remote.flywl.sh/#session=abc" };
    const { request } = await captureSend(message);
    expect(JSON.parse(await decryptAsBrowser(request.body, browser))).toEqual(message);
  });

  test("refuses a payload the push service would refuse", async () => {
    const { keys } = await vapidKeys();
    let posts = 0;
    const post: PushPost = async () => { posts++; return new Response("", { status: 201 }); };
    const message = { title: "Turn finished", body: "x".repeat(4096), url: "https://remote.flywl.sh" };
    await expect(sendWebPush({ subscription: RFC_8291.subscription, vapid: keys, subject: "https://flywl.sh", message, post })).rejects.toThrow(/at most/);
    expect(posts).toBe(0);
  });
});

describe("VAPID authorization", () => {
  test("signs a JWT for the push service origin that verifies under the public key", async () => {
    const before = Math.floor(Date.now() / 1000);
    const { keys, verify, request } = await captureSend({ title: "Turn finished", body: "Done", url: "https://remote.flywl.sh" });
    const after = Math.floor(Date.now() / 1000);
    const match = /^vapid t=([^,]+), k=(.+)$/.exec(request.authorization);
    expect(match).not.toBeNull();
    const [, token, publicKey] = match!;
    expect(publicKey).toBe(keys.publicKey);
    const [encodedHeader, encodedClaims, encodedSignature] = token!.split(".");
    expect(JSON.parse(textOf(encodedHeader!))).toEqual({ typ: "JWT", alg: "ES256" });
    const claims = JSON.parse(textOf(encodedClaims!));
    expect(claims.aud).toBe("https://push.example.net");
    expect(claims.sub).toBe("https://flywl.sh");
    expect(claims.exp).toBeGreaterThanOrEqual(before + 12 * 3600);
    expect(claims.exp).toBeLessThanOrEqual(after + 12 * 3600);
    const verified = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, verify, bytesOf(encodedSignature!), new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`));
    expect(verified).toBe(true);
  });
});

describe("sending", () => {
  test("refuses pre-aborted delivery and carries cancellation through the HTTP boundary", async () => {
    const { keys } = await vapidKeys();
    const controller = new AbortController();
    const reason = new Error("delivery retired");
    const message = { title: "Turn finished", body: "Done", url: "https://remote.example.test" };
    let posts = 0;
    const post: PushPost = async (_url, init) => {
      posts++;
      expect(init.signal).toBe(controller.signal);
      controller.abort(reason);
      return new Response("", { status: 201 });
    };
    const input = { subscription: RFC_8291.subscription, vapid: keys, subject: "https://flywl.sh", message, post, signal: controller.signal };
    await expect(sendWebPush(input)).rejects.toBe(reason);
    expect(posts).toBe(1);
    await expect(sendWebPush(input)).rejects.toBe(reason);
    expect(posts).toBe(1);
  });

  test("posts an aes128gcm body with the VAPID header and classifies the answer", async () => {
    const { keys } = await vapidKeys();
    const requests: Array<{ url: string; headers: Headers; bytes: number }> = [];
    const respond = (status: number): PushPost => async (url, init) => {
      requests.push({ url, headers: new Headers(init.headers), bytes: init.body.byteLength });
      return new Response(status === 410 ? "gone" : "", { status });
    };
    const message = { title: "Turn finished", body: "Reply with exactly the word PHONE", url: "https://remote.flywl.sh/#session=abc" };
    expect(await sendWebPush({ subscription: RFC_8291.subscription, vapid: keys, subject: "https://flywl.sh", message, post: respond(201) })).toEqual({ kind: "delivered", status: 201 });
    expect(await sendWebPush({ subscription: RFC_8291.subscription, vapid: keys, subject: "https://flywl.sh", message, post: respond(410) })).toEqual({ kind: "gone", status: 410 });
    expect((await sendWebPush({ subscription: RFC_8291.subscription, vapid: keys, subject: "https://flywl.sh", message, post: respond(500) })).kind).toBe("failed");
    expect(requests[0]!.url).toBe(RFC_8291.subscription.endpoint);
    expect(requests[0]!.headers.get("content-encoding")).toBe("aes128gcm");
    expect(requests[0]!.headers.get("authorization")).toMatch(/^vapid t=/);
    expect(requests[0]!.bytes).toBeGreaterThan(86);
  });
});
