import { readImageInfo } from "./image.ts";

// The type of a file from its first bytes. The server never trusts the type that a client gives: a
// browser shows a file inline only when these bytes show a picture or a video.

/** The bytes that `sniffType` reads. The caller gives at most these bytes from the start of the file. */
export const SNIFF_BYTES = 4096;

/**
 * The types that a page can show inline from `/dl/`. Each one is a raster picture or a video, which
 * holds no script. SVG, HTML, XML, PDF and text are never inline: they are always an attachment.
 */
export const INLINE_TYPES: ReadonlySet<string> = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"video/mp4",
	"video/webm",
]);

function ascii(bytes: Uint8Array, start: number, text: string): boolean {
	if (start + text.length > bytes.length) return false;
	for (let i = 0; i < text.length; i++) if (bytes[start + i] !== text.charCodeAt(i)) return false;
	return true;
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
	return prefix.length <= bytes.length && prefix.every((byte, i) => bytes[i] === byte);
}

/** The type of an ISO media file (MP4, MOV, M4A, AVIF, HEIC) from the major brand of its `ftyp` box. */
function isoMedia(bytes: Uint8Array): string | null {
	if (!ascii(bytes, 4, "ftyp") || bytes.length < 12) return null;
	const brand = String.fromCharCode(...bytes.subarray(8, 12));
	if (brand === "avif" || brand === "avis") return "image/avif";
	if (["heic", "heix", "heim", "heis", "mif1", "msf1"].includes(brand)) return "image/heic";
	if (brand === "qt  ") return "video/quicktime";
	if (brand === "M4A " || brand === "M4B ") return "audio/mp4";
	return "video/mp4";
}

/** The type of a Matroska or WebM file, from the DocType in its EBML header. */
function matroska(bytes: Uint8Array): string | null {
	if (!startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return null;
	for (let at = 4; at + 4 <= Math.min(bytes.length, 64); at++) {
		if (ascii(bytes, at, "webm")) return "video/webm";
	}
	return "video/x-matroska";
}

/** True when the bytes are UTF-8 text without a NUL. The last character can be cut at the end. */
function isText(bytes: Uint8Array): boolean {
	if (bytes.length === 0 || bytes.includes(0)) return false;
	try {
		new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes, { stream: true });
		return true;
	} catch {
		return false;
	}
}

/**
 * The type of a file from its first bytes (at most `SNIFF_BYTES`), or null when the bytes show no known
 * type. Text gets `text/plain`, also when it is HTML or SVG: a browser never runs it from this origin.
 */
export function sniffType(head: Uint8Array): string | null {
	const bytes = head.subarray(0, SNIFF_BYTES);
	const image = readImageInfo(bytes);
	if (image) return image.type;
	const media = isoMedia(bytes) ?? matroska(bytes);
	if (media) return media;
	if (ascii(bytes, 0, "%PDF-")) return "application/pdf";
	if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return "application/zip";
	if (startsWith(bytes, [0x1f, 0x8b])) return "application/gzip";
	if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WAVE")) return "audio/wav";
	if (ascii(bytes, 0, "OggS")) return "audio/ogg";
	if (ascii(bytes, 0, "fLaC")) return "audio/flac";
	if (ascii(bytes, 0, "ID3") || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)) return "audio/mpeg";
	if (isText(bytes)) return "text/plain";
	return null;
}
