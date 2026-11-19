import { DOC_LIMITS } from "@asterra/contracts";
import { type ImageInfo, readImageInfo } from "../platform/index.ts";

// Only the four raster formats of `readImageInfo` go into a doc: a file of these types holds no script.

export { type ImageInfo, readImageInfo };

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
