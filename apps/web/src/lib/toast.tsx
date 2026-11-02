import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";

export interface ToastInput {
	message: string;
	tone?: "info" | "error";
	action?: { label: string; run: () => void };
}

interface Toast extends ToastInput {
	id: number;
}

type ShowToast = (toast: ToastInput) => void;

const ToastContext = createContext<ShowToast>(() => undefined);

export function useToast(): ShowToast {
	return useContext(ToastContext);
}

const INFO_MS = 6000;
const ERROR_MS = 10000;

/** Shows short messages. Screen readers announce them through two aria-live regions. */
export function ToastProvider({ children }: { children: ReactNode }) {
	const [toasts, setToasts] = useState<Toast[]>([]);
	const nextId = useRef(1);
	const timers = useRef(new Map<number, number>());

	const dismiss = useCallback((id: number) => {
		setToasts((current) => current.filter((toast) => toast.id !== id));
		const timer = timers.current.get(id);
		if (timer !== undefined) window.clearTimeout(timer);
		timers.current.delete(id);
	}, []);

	const show = useCallback<ShowToast>(
		(input) => {
			const id = nextId.current++;
			setToasts((current) => [...current.slice(-3), { ...input, id }]);
			timers.current.set(
				id,
				window.setTimeout(() => dismiss(id), input.tone === "error" ? ERROR_MS : INFO_MS),
			);
		},
		[dismiss],
	);

	useEffect(() => {
		const pending = timers.current;
		return () => {
			for (const timer of pending.values()) window.clearTimeout(timer);
		};
	}, []);

	const render = (tone: "info" | "error") =>
		toasts
			.filter((toast) => (toast.tone ?? "info") === tone)
			.map((toast) => (
				<div key={toast.id} className={`toast toast-${tone}`}>
					<span className="toast-message">{toast.message}</span>
					{toast.action && (
						<button
							type="button"
							className="toast-action"
							onClick={() => {
								toast.action?.run();
								dismiss(toast.id);
							}}
						>
							{toast.action.label}
						</button>
					)}
					<button type="button" className="toast-close" aria-label="Dismiss" onClick={() => dismiss(toast.id)}>
						×
					</button>
				</div>
			));

	return (
		<ToastContext.Provider value={show}>
			{children}
			<div className="toasts">
				<div aria-live="polite" className="toast-region">
					{render("info")}
				</div>
				<div aria-live="assertive" className="toast-region">
					{render("error")}
				</div>
			</div>
		</ToastContext.Provider>
	);
}
