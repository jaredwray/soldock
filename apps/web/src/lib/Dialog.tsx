import { type ReactNode, useEffect, useId, useRef } from "react";
import { Icon } from "./icons.tsx";

const FOCUSABLE =
	'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface DialogProps {
	title: string;
	/** Called for Escape, for the close button, and when the browser closes the dialog. */
	onClose: () => void;
	children: ReactNode;
	className?: string;
	/** A short line under the title. */
	description?: string;
}

/**
 * A modal dialog on the native `<dialog>` element. `showModal()` makes the rest of the page inert.
 * Tab and Shift+Tab stay in the dialog. Escape calls `onClose`. When the dialog closes, the focus
 * goes back to the element that had it before. Put `data-autofocus` on the element that gets the
 * focus first.
 */
export function Dialog({ title, onClose, children, className, description }: DialogProps) {
	const ref = useRef<HTMLDialogElement>(null);
	const onCloseRef = useRef(onClose);
	const titleId = useId();
	const descriptionId = useId();

	useEffect(() => {
		onCloseRef.current = onClose;
	});

	useEffect(() => {
		const dialog = ref.current;
		if (!dialog) return;
		const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		if (!dialog.open) dialog.showModal();
		const first = dialog.querySelector<HTMLElement>("[data-autofocus]") ?? dialog.querySelector<HTMLElement>(FOCUSABLE);
		first?.focus();

		function onCancel(event: Event) {
			event.preventDefault();
			onCloseRef.current();
		}
		// The browser can close a modal dialog itself, for example after a second Escape. If the
		// parent keeps the dialog, open it again, so it never stays mounted but invisible.
		function onBrowserClose() {
			onCloseRef.current();
			window.setTimeout(() => {
				if (dialog?.isConnected && !dialog.open) dialog.showModal();
			}, 0);
		}
		function onKeyDown(event: KeyboardEvent) {
			if (event.key !== "Tab" || !dialog) return;
			const items = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((item) => item.offsetParent !== null);
			const firstItem = items[0];
			const lastItem = items[items.length - 1];
			if (!firstItem || !lastItem) return;
			if (event.shiftKey && document.activeElement === firstItem) {
				event.preventDefault();
				lastItem.focus();
			} else if (!event.shiftKey && document.activeElement === lastItem) {
				event.preventDefault();
				firstItem.focus();
			}
		}
		dialog.addEventListener("cancel", onCancel);
		dialog.addEventListener("close", onBrowserClose);
		dialog.addEventListener("keydown", onKeyDown);
		return () => {
			dialog.removeEventListener("cancel", onCancel);
			dialog.removeEventListener("close", onBrowserClose);
			dialog.removeEventListener("keydown", onKeyDown);
			if (dialog.open) dialog.close();
			if (previous?.isConnected) previous.focus();
		};
	}, []);

	return (
		<dialog
			ref={ref}
			className={`dialog ${className ?? ""}`}
			aria-labelledby={titleId}
			aria-describedby={description ? descriptionId : undefined}
		>
			<div className="dialog-header">
				<h2 id={titleId} className="dialog-title">
					{title}
				</h2>
				<button type="button" className="icon-button" aria-label="Close" title="Close" onClick={() => onClose()}>
					<Icon name="close" />
				</button>
			</div>
			{description && (
				<p id={descriptionId} className="dialog-description">
					{description}
				</p>
			)}
			{children}
		</dialog>
	);
}
