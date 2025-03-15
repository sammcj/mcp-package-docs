import { logger } from '../logger.js';

interface RequestOptions {
	method?: string;
	params?: Record<string, string | number | boolean | undefined>;
	body?: unknown;
}

type FetchResponse =
	| {
			data: Record<string, unknown>;
			status: number;
			headers: Headers;
			contentType: "json";
	  }
	| {
			data: string;
			status: number;
			headers: Headers;
			contentType: "text";
	  };

// Base configurations for crates.io and docs.rs
const CRATES_IO_CONFIG = {
	baseURL: "https://crates.io/api/v1/",
	headers: {
		Accept: "application/json",
		"User-Agent": "mcp-package-docs/1.0.0 (Rust Docs)", // Use a descriptive user agent
	},
};

const DOCS_RS_CONFIG = {
	baseURL: "https://docs.rs",
	headers: {
		Accept: "text/html,application/xhtml+xml,application/json",
		"User-Agent": "mcp-package-docs/1.0.0 (Rust Docs)", // Use a descriptive user agent
	},
};

// Helper to build full URL with query params
function buildUrl(
	baseURL: string,
	path: string,
	params?: Record<string, string | number | boolean | undefined>,
): string {
	const url = new URL(path, baseURL);
	if (params) {
		for (const [key, value] of Object.entries(params)) {
			if (value !== undefined) {
				url.searchParams.append(key, String(value));
			}
		}
	}
	return url.toString();
}

// Create a configured fetch client
async function rustFetch(
	baseURL: string,
	path: string,
	options: RequestOptions = {},
): Promise<FetchResponse> {
	const { method = "GET", params, body } = options;
	const url = buildUrl(baseURL, path, params);

	try {
		logger.debug(`Making request to ${url}`, { method, params });

		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 10000); // 10-second timeout

		const response = await fetch(url, {
			method,
			headers: baseURL === CRATES_IO_CONFIG.baseURL ? CRATES_IO_CONFIG.headers : DOCS_RS_CONFIG.headers,
			body: body ? JSON.stringify(body) : undefined,
			signal: controller.signal,
		});

		clearTimeout(timeoutId);

		logger.debug(`Received response from ${url}`, {
			status: response.status,
			contentType: response.headers.get("content-type"),
		});

		if (!response.ok) {
			throw new Error(`HTTP error! status: ${response.status}`);
		}

		const contentType = response.headers.get("content-type");
		const isJson = contentType?.includes("application/json");
		const data = isJson ? await response.json() : await response.text();

		return {
			data,
			status: response.status,
			headers: response.headers,
			contentType: isJson ? "json" : "text",
		};
	} catch (error) {
		logger.error(`Error making request to ${url}`, { error });
		throw error;
	}
}

// Export a default instance with methods for crates.io and docs.rs
export default {
	cratesIoFetch: (path: string, options = {}) =>
		rustFetch(CRATES_IO_CONFIG.baseURL, path, { ...options, method: "GET" }),
	docsRsFetch: (path: string, options = {}) =>
		rustFetch(DOCS_RS_CONFIG.baseURL, path, { ...options, method: "GET" }),
};
