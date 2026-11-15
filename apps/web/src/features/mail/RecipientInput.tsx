import { type KeyboardEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "../../lib/api.ts";
import {
	type AddressToken,
	addressTokenAt,
	completeAddress,
	parseAddressList,
	recipientKeyAction,
	recipientOptions,
} from "./compose.ts";
import { mailboxInput, useMailboxId } from "./mailbox.tsx";

/** The suggestions that the list shows at most. */
const SUGGESTION_LIMIT = 8;
/** The time after the last key before the field asks the server. */
const QUERY_DELAY_MS = 120;

interface RecipientInputProps {
	id: string;
	value: string;
	onChange: (value: string) => void;
	/** The addresses of the other address fields. The list does not suggest them again. */
	otherAddresses: readonly string[];
	disabled: boolean;
	invalid: boolean;
	describedBy: string | undefined;
	autofocus: boolean;
}

/** The address with the part that matches the typed text in bold. */
function Match({ address, typed }: { address: string; typed: string }) {
	const at = address.toLowerCase().indexOf(typed.toLowerCase());
	if (typed === "" || at < 0) return <>{address}</>;
	return (
		<>
			{address.slice(0, at)}
			<strong>{address.slice(at, at + typed.length)}</strong>
			{address.slice(at + typed.length)}
		</>
	);
}

/**
 * An address field of the composer: comma-separated text with a list of the addresses that the mailbox
 * sent mail to (`mail.suggest_recipients`). The list opens while the person types an address. The arrow
 * keys move in the list, Enter and Tab take the selected address, and Escape closes the list.
 */
export function RecipientInput({
	id,
	value,
	onChange,
	otherAddresses,
	disabled,
	invalid,
	describedBy,
	autofocus,
}: RecipientInputProps) {
	const mailboxId = useMailboxId();
	const inputRef = useRef<HTMLInputElement>(null);
	// The address that the person types now. Null when the list is closed.
	const [token, setToken] = useState<AddressToken | null>(null);
	// The last answer of the server. Its key is the mailbox and the query in lowercase.
	const [answer, setAnswer] = useState<{ key: string; addresses: string[] } | null>(null);
	// The option that the person selected with the arrow keys or the pointer, for one list of options.
	const [selected, setSelected] = useState<{ list: string; index: number | null } | null>(null);
	const cache = useRef(new Map<string, string[]>());
	const pendingCaret = useRef<number | null>(null);
	const query = token?.text.toLowerCase() ?? "";
	const answerKey = `${mailboxId ?? ""}\n${query}`;

	useEffect(() => {
		if (query === "") return;
		const key = `${mailboxId ?? ""}\n${query}`;
		const cached = cache.current.get(key);
		if (cached) {
			setAnswer({ key, addresses: cached });
			return;
		}
		let current = true;
		const timer = window.setTimeout(() => {
			api.call("mail.suggest_recipients", { ...mailboxInput(mailboxId), query, limit: SUGGESTION_LIMIT }).then(
				({ recipients }) => {
					const addresses = recipients.map((recipient) => recipient.address);
					cache.current.set(key, addresses);
					if (current) setAnswer({ key, addresses });
				},
				() => {
					// A suggestion is only a help. After a failure the list closes, and the field works as before.
					if (current) setAnswer(null);
				},
			);
		}, QUERY_DELAY_MS);
		return () => {
			current = false;
			window.clearTimeout(timer);
		};
	}, [query, mailboxId]);

	// After a completion, the caret goes after the address, also when the address is not the last one.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the caret moves after React writes each new value to the input.
	useLayoutEffect(() => {
		if (pendingCaret.current === null) return;
		inputRef.current?.setSelectionRange(pendingCaret.current, pendingCaret.current);
		pendingCaret.current = null;
	}, [value]);

	const present = useMemo(
		() =>
			token
				? [...otherAddresses, ...parseAddressList(value.slice(0, token.start) + value.slice(token.end)).addresses]
				: otherAddresses,
		[otherAddresses, token, value],
	);
	// While the answer for the new text loads, the answer for the earlier text stays, without the addresses
	// that no longer match. So the list does not close and open again at each key. That list can be
	// incomplete, so no address is selected in it until the new answer arrives.
	const matching = query === "" || !answer ? [] : answer.addresses.filter((a) => a.toLowerCase().includes(query));
	const fresh = answer?.key === answerKey;
	const { options, active: firstActive } = recipientOptions(token?.text ?? "", matching, present);
	const list = options.join("\n");
	const active = selected?.list === list ? selected.index : fresh ? firstActive : null;
	const open = token !== null && !disabled && options.length > 0;
	const listId = `${id}-suggestions`;
	const optionId = (index: number) => `${id}-suggestion-${index}`;

	function choose(address: string) {
		if (!token) return;
		const next = completeAddress(value, token, address);
		setToken(null);
		if (next.value === value) {
			// The text stays the same, so React writes no new value and the layout effect does not run.
			inputRef.current?.setSelectionRange(next.caret, next.caret);
			return;
		}
		pendingCaret.current = next.caret;
		onChange(next.value);
	}

	function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
		const action = recipientKeyAction(event.key, event.shiftKey, { open, active, count: options.length });
		if (action.preventDefault) event.preventDefault();
		if (action.kind === "select") setSelected({ list, index: action.index });
		else if (action.kind === "take") choose(options[action.index] as string);
		else if (action.kind === "close") setToken(null);
	}

	return (
		<div className="recipient-field">
			<input
				ref={inputRef}
				id={id}
				className="compose-input"
				type="text"
				inputMode="email"
				autoComplete="off"
				spellCheck={false}
				role="combobox"
				aria-autocomplete="list"
				aria-expanded={open}
				aria-controls={open ? listId : undefined}
				aria-activedescendant={open && active !== null ? optionId(active) : undefined}
				value={value}
				onChange={(event) => {
					const input = event.currentTarget;
					setToken(addressTokenAt(input.value, input.selectionStart ?? input.value.length));
					onChange(input.value);
				}}
				onSelect={(event) => {
					// A caret that leaves the address closes the list. The next character that the person types opens it again.
					const caret = event.currentTarget.selectionStart ?? 0;
					if (token && (caret < token.start || caret > token.end)) setToken(null);
				}}
				onKeyDown={onKeyDown}
				onBlur={() => setToken(null)}
				aria-invalid={invalid ? true : undefined}
				aria-describedby={describedBy}
				disabled={disabled}
				data-autofocus={autofocus ? true : undefined}
			/>
			{open && (
				<div id={listId} role="listbox" className="recipient-suggestions" aria-label="Addresses that you sent mail to">
					{options.map((address, index) => (
						// The combobox has the focus and the keys. A pointer selects and takes an option.
						// biome-ignore lint/a11y/useKeyWithClickEvents: the keys go to the combobox, as the ARIA combobox pattern asks.
						<div
							key={address}
							id={optionId(index)}
							role="option"
							tabIndex={-1}
							aria-selected={index === active}
							className="recipient-option"
							onMouseDown={(event) => event.preventDefault()}
							onMouseMove={() => {
								if (index !== active) setSelected({ list, index });
							}}
							onClick={() => choose(address)}
						>
							<Match address={address} typed={token?.text ?? ""} />
						</div>
					))}
				</div>
			)}
		</div>
	);
}
