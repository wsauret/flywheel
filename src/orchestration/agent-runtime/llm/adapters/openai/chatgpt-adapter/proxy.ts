interface DefaultPorts {
	[key: string]: number;
}

interface ProxyEnvironment {
	[key: string]: string | undefined;
}

const DEFAULT_PORTS: DefaultPorts = { http: 80, https: 443 };

function environmentValue(name: string, environment: ProxyEnvironment): string {
	return environment[name.toLowerCase()] || environment[name.toUpperCase()] || "";
}

function bypassesProxy(target: URL, environment: ProxyEnvironment): boolean {
	const noProxy = environmentValue("no_proxy", environment).toLowerCase();
	if (!noProxy) return false;
	if (noProxy.trim() === "*") return true;
	const protocol = target.protocol.slice(0, -1);
	const port = Number(target.port) || DEFAULT_PORTS[protocol] || 0;
	const hostname = target.hostname.toLowerCase();
	return noProxy.split(/[,\s]+/).some((entry) => {
		if (!entry) return false;
		const match = entry.match(/^(.+):(\d+)$/);
		const entryHostname = (match?.[1] ?? entry).replace(/^\*/, "");
		const entryPort = match?.[2] ? Number(match[2]) : 0;
		if (entryPort && entryPort !== port) return false;
		if (entryHostname.startsWith(".")) return hostname.endsWith(entryHostname) || hostname === entryHostname.slice(1);
		return hostname === entryHostname;
	});
}

const UNSUPPORTED_PROXY_PROTOCOL_MESSAGE =
	"Unsupported proxy protocol. SOCKS and PAC proxy URLs are not supported; use an HTTP or HTTPS proxy URL.";

/** Resolves the HTTP proxy for a target URL. Lowercase variables take precedence. NO_PROXY exclusions return undefined. */
export function resolveHttpProxyUrlForTarget(
	targetUrl: string | URL,
	environment: ProxyEnvironment = process.env,
): URL | undefined {
	let target: URL;
	try {
		target = targetUrl instanceof URL ? targetUrl : new URL(targetUrl);
	} catch {
		return undefined;
	}
	if (bypassesProxy(target, environment)) return undefined;
	const protocol = target.protocol.slice(0, -1);
	let proxy = environmentValue(`${protocol}_proxy`, environment) || environmentValue("all_proxy", environment);
	if (!proxy) return undefined;
	if (!proxy.includes("://")) proxy = `${protocol}://${proxy}`;
	let proxyUrl: URL;
	try {
		proxyUrl = new URL(proxy);
	} catch {
		throw new Error("Invalid proxy URL");
	}
	if (proxyUrl.protocol !== "http:" && proxyUrl.protocol !== "https:") {
		throw new Error(`${UNSUPPORTED_PROXY_PROTOCOL_MESSAGE} Got ${proxyUrl.protocol}`);
	}
	return proxyUrl;
}
