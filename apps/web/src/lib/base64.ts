// Base64 helpers for attachments. The operations send file content as base64 in JSON.

const CHUNK = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let start = 0; start < bytes.length; start += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(start, start + CHUNK));
	}
	return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

export async function fileToBase64(file: Blob): Promise<string> {
	return bytesToBase64(new Uint8Array(await file.arrayBuffer()));
}

/**
 * Saves bytes as a file. The Blob type is always application/octet-stream, never the type that the
 * sender gave. Thus the browser downloads the file and never shows it as active content.
 */
export function saveBytes(bytes: Uint8Array<ArrayBuffer>, filename: string): void {
	const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = filename || "attachment";
	anchor.rel = "noopener";
	anchor.hidden = true;
	document.body.append(anchor);
	anchor.click();
	anchor.remove();
	window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
