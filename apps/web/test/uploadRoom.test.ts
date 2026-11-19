import { ApiError } from "@asterra/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The calls that the upload of a file of a chat message sends to the server. The API client is the
// boundary: the test records each call, and ends the upload in parts at its first call.
const calls = vi.hoisted(() => [] as { name: string; input: Record<string, unknown> }[]);

vi.mock("../src/lib/api.ts", () => ({
	api: {
		call: async (name: string, input: Record<string, unknown>) => {
			calls.push({ name, input });
			if (name === "drive.upload_file") return { item: { id: "itm_01JD0000000000000000000001", name: "e.txt" } };
			throw new ApiError(400, { code: "invalid", detail: "The test stops the upload here." });
		},
	},
	noteStatus: () => undefined,
}));

const { uploadFile } = await import("../src/lib/upload.ts");

const ROOM = "rm_01JD0000000000000000000001";

beforeEach(() => {
	calls.length = 0;
});

// A file of a message goes into the folder Chat/<room name> only when each upload call names the room.
describe("the upload of a file of a chat message", () => {
	it("names the room in the start of an upload in parts", async () => {
		await expect(uploadFile(new File(["hello"], "a.txt", { type: "text/plain" }), { roomId: ROOM })).rejects.toThrow();
		expect(calls[0]).toMatchObject({ name: "drive.create_upload", input: { room_id: ROOM, size: 5 } });
		expect(calls[0]?.input).not.toHaveProperty("parent_id");
	});

	it("names the room in the upload of an empty file", async () => {
		await uploadFile(new File([], "e.txt"), { roomId: ROOM });
		expect(calls).toEqual([{ name: "drive.upload_file", input: expect.objectContaining({ room_id: ROOM }) }]);
	});
});
