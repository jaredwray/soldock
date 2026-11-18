import { DOC_LIMITS, type DocImageType } from "@soldock/contracts";

// The type and the size in pixels of an image, from its bytes. The server never trusts the type that a
// client or a web server gives. Only these four raster formats go into a doc: a file of these types
// holds no script.

export interface ImageInfo {
	type: DocImageType;
	/** The pixels of the image as a browser shows it. For a JPEG file, the EXIF orientation is applied. */
	width: number;
	height: number;
}

function ascii(bytes: Uint8Array, start: number, text: string): boolean {
	if (start + text.length > bytes.length) return false;
	for (let i = 0; i < text.length; i++) if (bytes[start + i] !== text.charCodeAt(i)) return false;
	return true;
}

function view(bytes: Uint8Array): DataView {
	return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function png(bytes: Uint8Array): ImageInfo | null {
	if (bytes.length < 24 || !PNG_SIGNATURE.every((byte, i) => bytes[i] === byte) || !ascii(bytes, 12, "IHDR")) {
		return null;
	}
	const data = view(bytes);
	return { type: "image/png", width: data.getUint32(16), height: data.getUint32(20) };
}

function gif(bytes: Uint8Array): ImageInfo | null {
	if (bytes.length < 10 || !(ascii(bytes, 0, "GIF87a") || ascii(bytes, 0, "GIF89a"))) return null;
	const data = view(bytes);
	return { type: "image/gif", width: data.getUint16(6, true), height: data.getUint16(8, true) };
}

function webp(bytes: Uint8Array): ImageInfo | null {
	// The shortest header with a size is the lossless one: 25 bytes.
	if (bytes.length < 25 || !ascii(bytes, 0, "RIFF") || !ascii(bytes, 8, "WEBP")) return null;
	const data = view(bytes);
	if (ascii(bytes, 12, "VP8L")) {
		if (bytes[20] !== 0x2f) return null;
		const bits = data.getUint32(21, true);
		return { type: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
	}
	if (bytes.length < 30) return null;
	if (ascii(bytes, 12, "VP8 ")) {
		// The lossy format: a frame tag of 3 bytes, the start code, then 14 bits for each side.
		if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
		return {
			type: "image/webp",
			width: data.getUint16(26, true) & 0x3fff,
			height: data.getUint16(28, true) & 0x3fff,
		};
	}
	if (ascii(bytes, 12, "VP8X")) {
		const side = (at: number) =>
			((bytes[at] as number) | ((bytes[at + 1] as number) << 8) | ((bytes[at + 2] as number) << 16)) + 1;
		return { type: "image/webp", width: side(24), height: side(27) };
	}
	return null;
}

/** The EXIF orientation (1 to 8) of an APP1 segment, or 1 when the segment has none. */
function exifOrientation(bytes: Uint8Array, start: number, length: number): number {
	const end = Math.min(start + length, bytes.length);
	if (!ascii(bytes, start, "Exif\0\0")) return 1;
	const tiff = start + 6;
	if (tiff + 8 > end) return 1;
	const little = ascii(bytes, tiff, "II");
	if (!little && !ascii(bytes, tiff, "MM")) return 1;
	const data = view(bytes);
	const directory = tiff + data.getUint32(tiff + 4, little);
	if (directory + 2 > end) return 1;
	const entries = data.getUint16(directory, little);
	for (let i = 0; i < entries; i++) {
		const entry = directory + 2 + i * 12;
		if (entry + 12 > end) return 1;
		if (data.getUint16(entry, little) !== 0x0112) continue;
		const value = data.getUint16(entry + 8, little);
		return value >= 1 && value <= 8 ? value : 1;
	}
	return 1;
}

function jpeg(bytes: Uint8Array): ImageInfo | null {
	if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
	const data = view(bytes);
	let orientation = 1;
	let at = 2;
	while (at + 4 <= bytes.length) {
		if (bytes[at] !== 0xff) return null;
		const marker = bytes[at + 1] as number;
		// A fill byte before a marker.
		if (marker === 0xff) {
			at++;
			continue;
		}
		// The markers without a length: the restart markers, the start and the end of the image.
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
			at += 2;
			continue;
		}
		// The end of the image, or the start of the scan data: no frame header comes after it.
		if (marker === 0xd9 || marker === 0xda) return null;
		const length = data.getUint16(at + 2);
		if (length < 2) return null;
		if (marker === 0xe1) orientation = exifOrientation(bytes, at + 4, length - 2);
		// A frame header (SOF0 to SOF15). C4, C8 and CC are tables, not frames.
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
			if (at + 9 > bytes.length) return null;
			const height = data.getUint16(at + 5);
			const width = data.getUint16(at + 7);
			// The orientations 5 to 8 turn the image a quarter, so the browser shows the sides exchanged.
			return orientation >= 5
				? { type: "image/jpeg", width: height, height: width }
				: { type: "image/jpeg", width, height };
		}
		at += 2 + length;
	}
	return null;
}

/** The type and the size of a PNG, JPEG, GIF or WebP file, or null for each other file. */
export function readImageInfo(bytes: Uint8Array): ImageInfo | null {
	return png(bytes) ?? jpeg(bytes) ?? gif(bytes) ?? webp(bytes);
}

/** The reason that a doc cannot hold the image, or null. */
export function imageProblem(info: ImageInfo | null): string | null {
	if (info === null) return "The file is not a PNG, JPEG, GIF or WebP image.";
	if (info.width < 1 || info.height < 1) return "The image has no pixels.";
	if (info.width > DOC_LIMITS.imageSide || info.height > DOC_LIMITS.imageSide) {
		return `An image can have at most ${DOC_LIMITS.imageSide} pixels on each side.`;
	}
	if (info.width * info.height > DOC_LIMITS.imagePixels) {
		return `An image can have at most ${DOC_LIMITS.imagePixels / 1_000_000} million pixels.`;
	}
	return null;
}
