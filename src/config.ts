// Configuration and the startup assertions that must hold before the process serves
// anything. A6: the two hosts are the security boundary, so a misconfiguration must be a
// refusal to start, never a silently collapsed one.

export interface Config {
	db: string;
	appHost: string;
	sandboxHost: string;
	scheme: "https" | "http";
	appOrigin: string;
	sandboxOrigin: string;
	/** Port this process listens on, behind the proxy. */
	port: number;
	bind: string;
	/** Port the world reaches us on. Differs from `port` in every real deployment, and
	 *  it is the one that belongs in an origin: a CSP host-source with no port means the
	 *  scheme's default, so `frame-ancestors https://host` silently fails to match a
	 *  page served anywhere else. */
	publicPort: number;
	/** Number of proxies in front of us. A13: the client IP is only trustworthy when we
	 *  know exactly how many hops to count back through. */
	trustedProxyHops: number;
}

function fatal(message: string): never {
	console.error(`FATAL: ${message}`);
	process.exit(2);
}

function required(name: string): string {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === "") {
		fatal(`${name} is not set. It has no default: guessing a hostname is how the two
       origins silently become one.`);
	}
	return raw.trim();
}

/**
 * Case-normalized, port-stripped, trailing-dot-stripped host.
 *
 * `Host` is attacker-controlled, so every comparison in the dispatcher runs on this
 * form and never on the raw header. `VAIVEN.Example.com:443`, `vaiven.example.com.`
 * and `vaiven.example.com` are the same host; anything else is not.
 */
export function normalizeHost(raw: string): string {
	let host = raw.trim().toLowerCase();

	if (host.startsWith("[")) {
		// IPv6 literal: [::1] or [::1]:8080 — the colons inside are part of the address.
		const close = host.indexOf("]");
		host = close === -1 ? host : host.slice(0, close + 1);
	} else {
		const colon = host.indexOf(":");
		if (colon !== -1) host = host.slice(0, colon);
	}

	// A single trailing dot is the fully-qualified form of the same name.
	while (host.endsWith(".")) host = host.slice(0, -1);

	return host;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
	const appHost = normalizeHost(required("VAIVEN_APP_HOST"));
	const sandboxHost = normalizeHost(required("VAIVEN_SANDBOX_HOST"));

	if (!appHost || !sandboxHost) {
		fatal("VAIVEN_APP_HOST and VAIVEN_SANDBOX_HOST must be non-empty after normalization.");
	}

	// The whole of §3 rests on these being different origins. If they are equal, content
	// authored by a model runs on the same origin as the page holding the write key.
	if (appHost === sandboxHost) {
		fatal(
			`VAIVEN_APP_HOST and VAIVEN_SANDBOX_HOST are both "${appHost}". They must be
       different hosts, or sandboxed content shares an origin with the shell that holds
       the write key. Refusing to start.`,
		);
	}

	const scheme = (env.VAIVEN_SCHEME ?? "https").trim() === "http" ? "http" : "https";

	// Local development uses http on distinct .localhost names, which browsers already
	// treat as separate origins and resolve to 127.0.0.1 with no hosts-file edit (A12).
	// BOTH hosts, not either. `&&` on the negatives meant one `.localhost` host paired with
	// a real one started happily over plaintext, which is the arrangement the check exists
	// to refuse: the shell reachable in the clear with a write key in its fragment.
	if (scheme === "http" && !(appHost.endsWith(".localhost") && sandboxHost.endsWith(".localhost"))) {
		fatal(
			`VAIVEN_SCHEME=http is only allowed for *.localhost development hosts. Serving
       the shell over plaintext puts the write key in the URL fragment of an
       interceptable page. Refusing to start.`,
		);
	}

	const port = Number(env.VAIVEN_PORT ?? 8080);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		fatal(`VAIVEN_PORT must be a port number, got ${env.VAIVEN_PORT}`);
	}

	// A6: bind loopback by default. Caddy terminates TLS and is the only thing that
	// should be able to reach this process; a 0.0.0.0 bind means the app is reachable
	// without TLS and with an attacker-chosen Host header.
	const bind = (env.VAIVEN_BIND ?? "127.0.0.1").trim();
	if ((bind === "0.0.0.0" || bind === "::") && env.VAIVEN_ALLOW_PUBLIC_BIND !== "1") {
		fatal(
			`VAIVEN_BIND=${bind} exposes this process directly to the network, where it can be
       reached without TLS and with an attacker-chosen Host header. Either bind
       127.0.0.1 and let Caddy terminate TLS (the supported setup), or set
       VAIVEN_ALLOW_PUBLIC_BIND=1 if you are deliberately fronting it another way.`,
		);
	}

	const hops = Number(env.VAIVEN_TRUSTED_PROXY_HOPS ?? 1);
	if (!Number.isInteger(hops) || hops < 0 || hops > 4) {
		fatal(`VAIVEN_TRUSTED_PROXY_HOPS must be 0-4, got ${env.VAIVEN_TRUSTED_PROXY_HOPS}`);
	}

	const defaultPublic = scheme === "https" ? 443 : 80;
	const publicPort = Number(env.VAIVEN_PUBLIC_PORT ?? defaultPublic);
	if (!Number.isInteger(publicPort) || publicPort < 1 || publicPort > 65535) {
		fatal(`VAIVEN_PUBLIC_PORT must be a port number, got ${env.VAIVEN_PUBLIC_PORT}`);
	}

	// Omit the port when it is the scheme's default, because that is the only form that
	// matches a browser's serialized origin.
	const suffix = publicPort === defaultPublic ? "" : `:${publicPort}`;

	return {
		db: (env.VAIVEN_DB ?? "/var/lib/vaiven/db.sqlite").trim(),
		appHost,
		sandboxHost,
		scheme,
		appOrigin: `${scheme}://${appHost}${suffix}`,
		sandboxOrigin: `${scheme}://${sandboxHost}${suffix}`,
		port,
		bind,
		publicPort,
		trustedProxyHops: hops,
	};
}
