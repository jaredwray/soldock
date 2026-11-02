import { useEffect, useRef } from "react";

/** Calls `callback` after a render in which `value` changed. It does not call it on the first render. */
export function useOnChange<T>(value: T, callback: () => void): void {
	const previous = useRef(value);
	const callbackRef = useRef(callback);

	useEffect(() => {
		callbackRef.current = callback;
	});

	useEffect(() => {
		if (Object.is(previous.current, value)) return;
		previous.current = value;
		callbackRef.current();
	}, [value]);
}
