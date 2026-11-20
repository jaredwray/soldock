import { CHAT_LIMITS, KEY_LIMITS } from "@asterra/contracts";
import { type ReactNode, useEffect, useId, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import type { LimitDraft } from "./keyLimits.ts";

interface Choice {
	/** The value in the draft: an entry key of Drive, a mailbox id or a room id. */
	value: string;
	label: string;
	hint?: string;
}

/** The choices of one product, from the lists of this session. Null while they load. */
function useChoices(
	enabled: boolean,
	load: () => Promise<Choice[]>,
): { choices: Choice[] | null; error: string | null } {
	const [choices, setChoices] = useState<Choice[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `load` is a new function on each render. The lists load one time, when the product gets a limit.
	useEffect(() => {
		if (!enabled || choices !== null) return;
		let stopped = false;
		load().then(
			(loaded) => {
				if (!stopped) setChoices(loaded);
			},
			(caught) => {
				if (!stopped) setError(errorMessage(caught));
			},
		);
		return () => {
			stopped = true;
		};
	}, [enabled]);
	return { choices, error };
}

function toggled(values: readonly string[], value: string): string[] {
	return values.includes(value) ? values.filter((entry) => entry !== value) : [...values, value];
}

function ChoiceList({
	state,
	selected,
	onToggle,
	disabled,
	empty,
}: {
	state: { choices: Choice[] | null; error: string | null };
	selected: readonly string[];
	onToggle: (value: string) => void;
	disabled: boolean;
	empty: string;
}) {
	if (state.error) {
		return (
			<p className="form-error" role="alert">
				The list did not load. {state.error}
			</p>
		);
	}
	if (state.choices === null) return <p className="field-hint">Loading…</p>;
	if (state.choices.length === 0) return <p className="field-hint">{empty}</p>;
	return (
		<div className="limit-choices">
			{state.choices.map((choice) => (
				<label key={choice.value} className="check-row">
					<input
						type="checkbox"
						className="checkbox"
						checked={selected.includes(choice.value)}
						onChange={() => onToggle(choice.value)}
						disabled={disabled}
					/>
					<span>
						{choice.label}
						{choice.hint && <span className="check-hint">{choice.hint}</span>}
					</span>
				</label>
			))}
		</div>
	);
}

function Product({
	title,
	hint,
	on,
	onToggle,
	disabled,
	children,
}: {
	title: string;
	hint: string;
	on: boolean;
	onToggle: () => void;
	disabled: boolean;
	children: ReactNode;
}) {
	return (
		<div className="limit-product">
			<label className="check-row">
				<input type="checkbox" className="checkbox" checked={on} onChange={onToggle} disabled={disabled} />
				<span>
					<strong>{title}</strong>
					<span className="check-hint">{hint}</span>
				</span>
			</label>
			{on && <div className="limit-group">{children}</div>}
		</div>
	);
}

/**
 * The resource limits of a new key. Scopes tell what the key can do. A limit tells where. The lists of
 * drives, mailboxes and rooms are those of this session, so they show only for a key of the person.
 * A key for a different principal, such as an agent, takes ids.
 */
export function KeyLimitFields({
	draft,
	onChange,
	ownerId,
	own,
	disabled,
}: {
	draft: LimitDraft;
	onChange: (draft: LimitDraft) => void;
	/** The principal that the key is for. Its id is also the id of its own drive and of its own mailbox. */
	ownerId: string;
	/** True when the key is for the person of this session. */
	own: boolean;
	disabled: boolean;
}) {
	const ids = { driveOther: useId(), query: useId(), recipients: useId(), chatOther: useId() };

	const driveChoices = useChoices(draft.drive.on, async () => {
		const whole: Choice = { value: ownerId, label: own ? "My whole drive" : "The whole drive of the key owner" };
		const shared = await api.call("drive.list_shared_drives", {});
		const drives = shared.shared_drives.map((drive) => ({
			value: drive.id,
			label: drive.name,
			hint: "A shared drive, with each item in it",
		}));
		if (!own) return [whole, ...drives];
		const top = await api.call("drive.list_items", { limit: 50 });
		return [
			whole,
			...drives,
			...top.items.map((item) => ({
				value: `${item.space_id}/${item.id}`,
				label: item.name,
				hint: item.kind === "folder" ? "A folder of my drive, with all that it holds" : `A ${item.kind} of my drive`,
			})),
		];
	});

	const mailboxChoices = useChoices(draft.mail.on, async () => {
		if (!own) return [{ value: ownerId, label: "The own mailbox of the key owner" }];
		const { mailboxes } = await api.call("mail.list_mailboxes");
		return mailboxes
			.filter((mailbox) => mailbox.kind !== "agent")
			.map((mailbox) => ({ value: mailbox.id, label: mailbox.display_name, hint: mailbox.address }));
	});

	const roomChoices = useChoices(draft.chat.on && own, async () => {
		const { rooms } = await api.call("chat.list_rooms", { limit: CHAT_LIMITS.pageSize });
		return rooms.map((room) => ({
			value: room.id,
			label:
				room.kind === "dm" ? `Direct message with ${room.peer?.display_name ?? "a member"}` : `#${room.name ?? "room"}`,
		}));
	});

	return (
		<fieldset className="limit-list">
			<legend className="field-label">Resource limits</legend>
			<p className="field-hint">
				Scopes tell what a key can do. A limit tells where. A product without a limit follows the scopes only. A key
				with a limit cannot hold account.keys or directory.write.
			</p>
			<Product
				title="Drive"
				hint="Only some drives, folders and documents"
				on={draft.drive.on}
				onToggle={() => onChange({ ...draft, drive: { ...draft.drive, on: !draft.drive.on } })}
				disabled={disabled}
			>
				<ChoiceList
					state={driveChoices}
					selected={draft.drive.picked}
					onToggle={(value) =>
						onChange({ ...draft, drive: { ...draft.drive, picked: toggled(draft.drive.picked, value) } })
					}
					disabled={disabled}
					empty="No drive to select."
				/>
				<div className="field">
					<label htmlFor={ids.driveOther} className="field-label">
						Other folders and documents
					</label>
					<textarea
						id={ids.driveOther}
						className="input textarea"
						rows={2}
						value={draft.drive.otherText}
						onChange={(event) => onChange({ ...draft, drive: { ...draft.drive, otherText: event.target.value } })}
						disabled={disabled}
						placeholder="A link to a folder or a document, or its id"
					/>
					<p className="field-hint">
						One on each line: the link of a folder, a doc or a sheet from the address bar, or the id of an item. A
						folder gives all that it holds. At most {KEY_LIMITS.driveItems} entries.
					</p>
				</div>
			</Product>
			<Product
				title="Mail"
				hint="Only some mailboxes, only the mail that a search finds, or only some recipients"
				on={draft.mail.on}
				onToggle={() => onChange({ ...draft, mail: { ...draft.mail, on: !draft.mail.on } })}
				disabled={disabled}
			>
				<ChoiceList
					state={mailboxChoices}
					selected={draft.mail.mailboxIds}
					onToggle={(value) =>
						onChange({ ...draft, mail: { ...draft.mail, mailboxIds: toggled(draft.mail.mailboxIds, value) } })
					}
					disabled={disabled}
					empty="No mailbox to select."
				/>
				<p className="field-hint">Select no mailbox to let the key use each mailbox of the key owner.</p>
				<div className="field">
					<label htmlFor={ids.query} className="field-label">
						Only the mail that this search finds
					</label>
					<input
						id={ids.query}
						className="input"
						value={draft.mail.query}
						maxLength={KEY_LIMITS.queryChars}
						onChange={(event) => onChange({ ...draft, mail: { ...draft.mail, query: event.target.value } })}
						disabled={disabled}
						placeholder="For example: label:invoices or from:billing@vendor.example"
					/>
					<p className="field-hint">
						The search syntax of Mail. The key reads and changes only the messages that the search finds. Leave it empty
						for each message.
					</p>
				</div>
				<div className="field">
					<label htmlFor={ids.recipients} className="field-label">
						Send only to
					</label>
					<textarea
						id={ids.recipients}
						className="input textarea"
						rows={2}
						value={draft.mail.recipientsText}
						onChange={(event) => onChange({ ...draft, mail: { ...draft.mail, recipientsText: event.target.value } })}
						disabled={disabled}
						placeholder={"example.com\nada@partner.org"}
					/>
					<p className="field-hint">
						One domain or address on each line. A domain allows each address in it. Leave it empty for each recipient.
					</p>
				</div>
			</Product>
			<Product
				title="Chat"
				hint="Only some rooms and direct messages"
				on={draft.chat.on}
				onToggle={() => onChange({ ...draft, chat: { ...draft.chat, on: !draft.chat.on } })}
				disabled={disabled}
			>
				{own ? (
					<ChoiceList
						state={roomChoices}
						selected={draft.chat.roomIds}
						onToggle={(value) =>
							onChange({ ...draft, chat: { ...draft.chat, roomIds: toggled(draft.chat.roomIds, value) } })
						}
						disabled={disabled}
						empty="You are in no room."
					/>
				) : (
					<div className="field">
						<label htmlFor={ids.chatOther} className="field-label">
							Rooms
						</label>
						<textarea
							id={ids.chatOther}
							className="input textarea"
							rows={2}
							value={draft.chat.otherText}
							onChange={(event) => onChange({ ...draft, chat: { ...draft.chat, otherText: event.target.value } })}
							disabled={disabled}
							placeholder="The link of a room, or its id"
						/>
						<p className="field-hint">
							One on each line: the link of a room from the address bar, or its id. At most {KEY_LIMITS.rooms} rooms.
						</p>
					</div>
				)}
			</Product>
		</fieldset>
	);
}
