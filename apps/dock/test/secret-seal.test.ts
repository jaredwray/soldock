import { afterEach, describe, expect, it, vi } from "vitest";
import { openSecret, SEALED_PREFIX, sealSecret } from "../src/platform/index.ts";

// Encryption at rest of the secrets that the Worker reads back. The key comes from ENCRYPTION_KEY.

const KEY = "seal-test-key-0123456789abcdefgh";
const OTHER_KEY = "seal-test-key-zyxwvutsrqponmlkji";
const PURPOSE = "ai_settings.api_token";
const VALUE = "whsec_c2VjcmV0IHZhbHVlIMOpIOKCrA";
const sealed = { ENCRYPTION_KEY: KEY };

afterEach(() => vi.restoreAllMocks());

/** Each line that the Worker logs after this call. */
function logLines() {
	const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
	return () => spies.flatMap((spy) => spy.mock.calls.map((args) => args.map(String).join(" ")));
}

describe("sealSecret and openSecret", () => {
	it("seal a value with a random IV, and open it only with the same key and purpose", async () => {
		const lines = logLines();
		const first = await sealSecret(sealed, PURPOSE, VALUE);
		const second = await sealSecret(sealed, PURPOSE, VALUE);
		expect(first).toMatch(/^enc:v1:[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
		expect(first).not.toContain(VALUE);
		expect(second).not.toBe(first);
		expect(await openSecret(sealed, PURPOSE, first)).toEqual({ ok: true, value: VALUE });
		expect(await openSecret(sealed, PURPOSE, second)).toEqual({ ok: true, value: VALUE });
		expect(lines()).toEqual([]);

		// A different key, a different purpose and a changed value do not open. No call throws.
		expect(await openSecret({ ENCRYPTION_KEY: OTHER_KEY }, PURPOSE, first)).toEqual({
			ok: false,
			reason: "failed",
		});
		expect(await openSecret(sealed, "webhook_endpoints.secret", first)).toEqual({ ok: false, reason: "failed" });
		const changed = `${first.slice(0, -1)}${first.endsWith("A") ? "B" : "A"}`;
		expect(await openSecret(sealed, PURPOSE, changed)).toEqual({ ok: false, reason: "failed" });
		expect(await openSecret(sealed, PURPOSE, `${SEALED_PREFIX}not a sealed value`)).toEqual({
			ok: false,
			reason: "failed",
		});
		expect(await openSecret({}, PURPOSE, first)).toEqual({ ok: false, reason: "no_key" });
		expect(await openSecret({ ENCRYPTION_KEY: "short" }, PURPOSE, first)).toEqual({
			ok: false,
			reason: "bad_key",
		});

		// Each failure writes one error line with the purpose. No line has the value or a key.
		const errors = lines();
		expect(errors).toHaveLength(6);
		expect(errors.map((line) => JSON.parse(line) as Record<string, unknown>)).toContainEqual({
			level: "error",
			msg: "sealed secret cannot open",
			purpose: PURPOSE,
			reason: "no_key",
		});
		for (const secret of [VALUE, KEY, OTHER_KEY, first.slice(SEALED_PREFIX.length)]) {
			expect(errors.filter((line) => line.includes(secret))).toEqual([]);
		}
	});

	it("keep plaintext without the key, and read plaintext from before the key", async () => {
		expect(await sealSecret({}, PURPOSE, VALUE)).toBe(VALUE);
		expect(await sealSecret({ ENCRYPTION_KEY: "" }, PURPOSE, VALUE)).toBe(VALUE);
		// A row from before the key opens with the key, without the key and with a short key.
		for (const env of [sealed, {}, { ENCRYPTION_KEY: "short" }]) {
			expect(await openSecret(env, PURPOSE, VALUE)).toEqual({ ok: true, value: VALUE });
		}
	});

	it("write no secret with a key of fewer than 32 characters", async () => {
		const lines = logLines();
		const short = "x".repeat(31);
		await expect(sealSecret({ ENCRYPTION_KEY: short }, PURPOSE, VALUE)).rejects.toMatchObject({
			code: "unavailable",
			message: expect.stringContaining("ENCRYPTION_KEY Worker secret must have at least 32 characters"),
		});
		expect(lines().filter((line) => line.includes(short) || line.includes(VALUE))).toEqual([]);
		expect(await sealSecret({ ENCRYPTION_KEY: "x".repeat(32) }, PURPOSE, VALUE)).toMatch(/^enc:v1:/);
	});

	it("refuse a plaintext that a reader cannot tell from a sealed value", async () => {
		for (const env of [sealed, {}]) {
			await expect(sealSecret(env, PURPOSE, `${SEALED_PREFIX}abc`)).rejects.toMatchObject({ code: "invalid" });
		}
	});
});
