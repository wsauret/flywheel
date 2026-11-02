import { describe, expect, it } from "bun:test";
import { resolveHttpProxyUrlForTarget } from "../../../../../../src/orchestration/agent-runtime/llm/chatgpt-adapter/proxy.js";

describe("resolveHttpProxyUrlForTarget", () => {
	it("uses lowercase protocol proxy before uppercase and ALL_PROXY", () => {
		const proxy = resolveHttpProxyUrlForTarget("https://api.example.com", {
			https_proxy: "lower.example:8443",
			HTTPS_PROXY: "http://upper.example:8080",
			ALL_PROXY: "http://all.example:8080",
		});
		expect(proxy?.toString()).toBe("https://lower.example:8443/");
	});

	it("uses ALL_PROXY when the protocol proxy is absent", () => {
		expect(resolveHttpProxyUrlForTarget("http://api.example.com", { ALL_PROXY: "proxy.example:8080" })?.toString())
			.toBe("http://proxy.example:8080/");
	});

	it("honors exact, suffix, port-specific, and wildcard NO_PROXY entries", () => {
		const env = { HTTPS_PROXY: "http://proxy.example", NO_PROXY: "exact.example,.internal.example,port.example:443" };
		expect(resolveHttpProxyUrlForTarget("https://exact.example", env)).toBeUndefined();
		expect(resolveHttpProxyUrlForTarget("https://service.internal.example", env)).toBeUndefined();
		expect(resolveHttpProxyUrlForTarget("https://port.example", env)).toBeUndefined();
		expect(resolveHttpProxyUrlForTarget("http://port.example", { HTTP_PROXY: "http://proxy.example", NO_PROXY: "port.example:443" })).toBeDefined();
		expect(resolveHttpProxyUrlForTarget("https://other.example", { HTTPS_PROXY: "http://proxy.example", NO_PROXY: "*" })).toBeUndefined();
	});

	it("rejects invalid and unsupported proxy URLs without exposing credentials", () => {
		expect(() => resolveHttpProxyUrlForTarget("https://api.example.com", { HTTPS_PROXY: "http://secret user:password@" }))
			.toThrow("Invalid proxy URL");
		try {
			resolveHttpProxyUrlForTarget("https://api.example.com", { HTTPS_PROXY: "http://secret user:password@" });
		} catch (error) {
			expect(String(error)).not.toContain("password");
		}
		expect(() => resolveHttpProxyUrlForTarget("https://api.example.com", { HTTPS_PROXY: "socks5://proxy.example" }))
			.toThrow("SOCKS and PAC");
		expect(() => resolveHttpProxyUrlForTarget("https://api.example.com", { HTTPS_PROXY: "pac+http://proxy.example" }))
			.toThrow("SOCKS and PAC");
	});
});
