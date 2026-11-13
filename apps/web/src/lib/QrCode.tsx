import { useMemo } from "react";
import { encode } from "uqr";

/**
 * A QR code as an SVG. Each dark module is one square of a single path, so the code stays sharp at
 * each size. The colors stay black on white in both themes, because some scanners cannot read an
 * inverted code.
 */
export function QrCode({ value, label, size = 192 }: { value: string; label: string; size?: number }) {
	const { path, modules } = useMemo(() => {
		const qr = encode(value, { ecc: "M", border: 2 });
		let d = "";
		qr.data.forEach((row, y) => {
			row.forEach((dark, x) => {
				if (dark) d += `M${x} ${y}h1v1h-1z`;
			});
		});
		return { path: d, modules: qr.size };
	}, [value]);

	return (
		<svg
			className="qr-code"
			role="img"
			aria-label={label}
			width={size}
			height={size}
			viewBox={`0 0 ${modules} ${modules}`}
			shapeRendering="crispEdges"
		>
			<rect width={modules} height={modules} fill="#fff" />
			<path d={path} fill="#000" />
		</svg>
	);
}
