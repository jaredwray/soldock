// A GET that sends the headers as given. `fetch` replaces `Sec-Fetch-Mode` with `cors`, and the assets
// router of the Worker decides on that header, so the smoke check cannot use `fetch` for a navigation.
import http from "node:http";
import https from "node:https";

export interface HttpResponse {
	status: number;
	contentType: string;
	body: string;
}

export type HttpGet = (url: string, headers?: Record<string, string>) => Promise<HttpResponse>;

const MAX_BODY_BYTES = 1024 * 1024;
const TIMEOUT_MS = 10_000;

export const httpGet: HttpGet = (url, headers = {}) =>
	new Promise((resolve, reject) => {
		const client = url.startsWith("https:") ? https : http;
		const request = client.request(url, { method: "GET", headers, timeout: TIMEOUT_MS }, (response) => {
			const chunks: Buffer[] = [];
			let size = 0;
			response.on("data", (chunk: Buffer) => {
				size += chunk.length;
				if (size <= MAX_BODY_BYTES) chunks.push(chunk);
			});
			response.on("end", () =>
				resolve({
					status: response.statusCode ?? 0,
					contentType: String(response.headers["content-type"] ?? ""),
					body: Buffer.concat(chunks).toString("utf8"),
				}),
			);
			response.on("error", reject);
		});
		request.on("timeout", () => request.destroy(new Error(`no answer in ${TIMEOUT_MS / 1000} seconds`)));
		request.on("error", reject);
		request.end();
	});
