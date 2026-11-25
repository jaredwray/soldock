import {
	type AutoLabelSettings,
	MAIL_LIMITS,
	type Mailbox,
	type MailboxKind,
	type MailSettings,
	type Principal,
	type TeamMailbox,
} from "@asterra/contracts";
import { type FormEvent, type ReactNode, useCallback, useEffect, useId, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { Icon } from "../../lib/icons.tsx";
import { Link } from "../../lib/router.tsx";
import { useToast } from "../../lib/toast.tsx";
import { useOnChange } from "../../lib/useOnChange.ts";
import { usePrincipals } from "../../lib/usePrincipals.ts";
import { adminPath, viewPath } from "../../routes.ts";
import { SearchBox } from "../../shell/SearchBox.tsx";
import { memberScopes, scopesText } from "../admin/mailboxScopes.ts";
import { byName, MembersPart } from "../admin/SharedMailboxPanel.tsx";
import { isOrgAdmin, useSession } from "../auth/session.tsx";
import { unavailableText } from "./autoLabels.ts";
import type { MailboxSettings as MailboxSettingsData } from "./data.ts";
import { mailboxInput } from "./mailbox.tsx";
import type { MailboxRights } from "./mailboxNav.ts";

/** The mailbox of the settings view, as the person sees it. `id` is null for the own mailbox of the person. */
export interface SettingsMailbox {
	id: string | null;
	kind: MailboxKind;
	address: string;
	display_name: string;
}

export interface MailboxSettingsProps {
	mailbox: SettingsMailbox;
	/** The title of the view, with the name of a team mailbox or an agent mailbox in front. */
	title: string;
	rights: MailboxRights;
	/** The mailboxes that the person can use, to know if the saved default still opens. Null while they load. */
	mailboxes: readonly Mailbox[] | null;
	/** Grows when the mailbox changes, for example after a change in the dialog of the auto labels. */
	refreshKey: number;
	/** Called with the settings that a save returned, so the next draft has the new signature. */
	onSettingsSaved: (settings: MailboxSettingsData) => void;
	/** Opens the dialog of the auto labels. */
	onOpenAutoLabels: () => void;
	/** Called after a change that can change the labels of the mailbox. */
	onChanged: () => void;
}

/**
 * The settings view of the open mailbox (`/mail/settings`, or under the path of a team or agent mailbox),
 * from the gear in the header of Mail: AI, who can use the mailbox, the default address of the person, and
 * the signature. It replaces the list in the main pane, next to the sidebar. Each section saves on its own.
 */
export function MailboxSettings(props: MailboxSettingsProps) {
	const { mailbox } = props;
	const name = mailbox.id === null ? "your mailbox" : mailbox.display_name;
	const inbox = viewPath({ kind: "system", view: "inbox" }, mailbox.id);
	return (
		<main id="main" className="mail-main" tabIndex={-1}>
			<div className="toolbar">
				<Link to={inbox} className="icon-button" aria-label="Back to the inbox" title="Back to the inbox">
					<Icon name="back" />
				</Link>
				<div className="page-title">
					<Icon name="settings" />
					<h1 className="toolbar-title">{props.title}</h1>
				</div>
				<span className="toolbar-spacer" />
				<SearchBox product="mail" query="" mailboxId={mailbox.id} />
			</div>
			<div className="mail-scroll">
				<div className="page mailbox-settings">
					<p className="panel-intro">
						The settings of {name} ({mailbox.address}).
					</p>
					<AiSection {...props} />
					<AccessSection mailbox={mailbox} />
					<DefaultSection mailbox={mailbox} mailboxes={props.mailboxes} />
					<SignatureSection mailbox={mailbox} rights={props.rights} onSaved={props.onSettingsSaved} />
				</div>
			</div>
		</main>
	);
}

/** One section of the view: a title and a card. */
function Panel({ title, children }: { title: string; children: ReactNode }) {
	const headingId = useId();
	return (
		<section className="panel" aria-labelledby={headingId}>
			<h2 id={headingId} className="panel-title">
				{title}
			</h2>
			<div className="panel-card mailbox-settings-card">{children}</div>
		</section>
	);
}

/** The load state of one section: the data, or the error of its last load. */
function useLoad<T>(load: () => Promise<T>) {
	const [data, setData] = useState<T | null>(null);
	const [error, setError] = useState<string | null>(null);
	const reload = useCallback(async () => {
		setError(null);
		try {
			setData(await load());
		} catch (caught) {
			setError(errorMessage(caught));
		}
	}, [load]);
	useEffect(() => {
		void reload();
	}, [reload]);
	return { data, setData, error, setError, reload };
}

/** The text and the button of a section that did not load. */
function LoadError({ error, onRetry }: { error: string; onRetry: () => void }) {
	return (
		<div role="alert">
			<p className="form-error">{error}</p>
			<button type="button" className="button button-small" onClick={onRetry}>
				Try again
			</button>
		</div>
	);
}

/**
 * AI in the mailbox. Inbox auto labels are the only AI feature of Mail, so the switch is the switch of the
 * auto labels (`mail.update_auto_labels`). The organization must also turn on AI and the feature.
 */
function AiSection({ mailbox, rights, refreshKey, onOpenAutoLabels, onChanged }: MailboxSettingsProps) {
	const { whoami } = useSession();
	const toast = useToast();
	const load = useCallback(() => api.call("mail.get_auto_labels", mailboxInput(mailbox.id)), [mailbox.id]);
	const { data: settings, setData, error, setError, reload } = useLoad<AutoLabelSettings>(load);
	const [busy, setBusy] = useState(false);
	const unavailable = settings ? unavailableText(settings) : null;

	// A change in the dialog of the auto labels grows refreshKey, so the switch shows it.
	useOnChange(refreshKey, () => void reload());

	async function toggle(enabled: boolean) {
		setBusy(true);
		setError(null);
		try {
			setData(await api.call("mail.update_auto_labels", { ...mailboxInput(mailbox.id), enabled }));
			onChanged();
			toast({ message: enabled ? "AI is on in this mailbox." : "AI is off in this mailbox." });
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}

	return (
		<Panel title="AI features">
			{!settings && !error && <p className="field-hint">Loading…</p>}
			{!settings && error && <LoadError error={error} onRetry={() => void reload()} />}
			{settings && (
				<>
					{unavailable && (
						<p className="notice notice-warning" role="status">
							<Icon name="info" size={16} className="notice-icon" />
							<span>
								{unavailable} {isOrgAdmin(whoami.principal) && <Link to={adminPath("ai")}>Open Admin › AI</Link>}
							</span>
						</p>
					)}
					<label className="check-row">
						<input
							type="checkbox"
							className="checkbox"
							checked={settings.enabled}
							onChange={() => void toggle(!settings.enabled)}
							disabled={busy || !rights.modify}
						/>
						<span>
							Use AI in this mailbox
							<span className="check-hint">
								Inbox auto labels sort new mail with labels such as Needs reply, Newsletter and Receipt. A Workers AI
								model in the AI Gateway of your organization reads new mail to choose them.
								{mailbox.kind === "team" && " The members of this shared mailbox share this setting."}
							</span>
						</span>
					</label>
					{!rights.modify && (
						<p className="field-hint">
							{mailbox.kind === "agent"
								? "You can only read the mailbox of an agent."
								: "Your membership does not let you change this mailbox."}
						</p>
					)}
					{settings.enabled && rights.modify && (
						<button type="button" className="button button-small" onClick={onOpenAutoLabels}>
							<Icon name="tag" size={16} />
							Choose the auto labels
						</button>
					)}
					{error && (
						<p className="form-error" role="alert">
							{error}
						</p>
					)}
				</>
			)}
		</Panel>
	);
}

/**
 * Who can use the mailbox. Owners and admins change the members of a shared mailbox here, as in Admin ›
 * Shared mailboxes. A member sees the list. The own mailbox of a person and the mailbox of an agent have
 * no members.
 */
function AccessSection({ mailbox }: { mailbox: SettingsMailbox }) {
	const { whoami } = useSession();
	const admin = isOrgAdmin(whoami.principal);
	if (mailbox.kind === "team" && mailbox.id !== null) return <TeamAccess mailboxId={mailbox.id} admin={admin} />;
	return (
		<Panel title="Access">
			{mailbox.kind === "agent" ? (
				<p className="field-hint">
					The agent uses this mailbox. Owners and admins can read it, and they cannot change it or send from it.
				</p>
			) : (
				<p className="field-hint">
					Only you can use this mailbox. To share mail with other members, use a shared mailbox: each member reads it
					and sends from its address.{" "}
					{admin ? (
						<Link to={adminPath("shared-mailboxes")}>Open Admin › Shared mailboxes</Link>
					) : (
						"An owner or an admin creates one."
					)}
				</p>
			)}
		</Panel>
	);
}

function TeamAccess({ mailboxId, admin }: { mailboxId: string; admin: boolean }) {
	const principals = usePrincipals();
	const load = useCallback(async () => {
		const { team_mailboxes } = await api.call("directory.list_team_mailboxes");
		const found = team_mailboxes.find((item) => item.id === mailboxId);
		if (!found) throw new Error("This shared mailbox no longer exists.");
		return found;
	}, [mailboxId]);
	const { data: team, setData, error, reload } = useLoad<TeamMailbox>(load);

	// An owner or an admin gets the member editor of Admin › Shared mailboxes. It is a section with its own title.
	if (admin && team && principals) {
		return <MembersPart mailbox={team} principals={principals} onChanged={setData} heading="Access" />;
	}
	return (
		<Panel title="Access">
			{error ? (
				<LoadError error={error} onRetry={() => void reload()} />
			) : !team || !principals ? (
				<p className="field-hint">Loading the members…</p>
			) : (
				<MemberList team={team} principals={principals} />
			)}
		</Panel>
	);
}

/** The members of a shared mailbox and what each one can do, for a member who cannot change them. */
function MemberList({ team, principals }: { team: TeamMailbox; principals: readonly Principal[] }) {
	const members = team.members
		.flatMap((member) =>
			principals
				.filter((principal) => principal.id === member.principal_id)
				.map((principal) => ({ principal, scopes: memberScopes(member.scopes) })),
		)
		.sort((a, b) => byName(a.principal, b.principal));
	return (
		<>
			<p className="field-hint">An owner or an admin adds and removes members, and sets what each one can do.</p>
			<ul className="mailbox-member-list">
				{members.map(({ principal, scopes }) => (
					<li key={principal.id} className="mailbox-member">
						<span className="mailbox-member-name">
							{principal.display_name}
							<span className="row-note">{principal.address}</span>
						</span>
						<span className="row-note">Can {scopesText(scopes)}</span>
					</li>
				))}
			</ul>
		</>
	);
}

/**
 * The default address of the person: the mailbox that Mail opens first, and so the address that a new
 * message comes from. It is a setting of the person (`mail.update_settings`), not of the mailbox.
 */
function DefaultSection({ mailbox, mailboxes }: { mailbox: SettingsMailbox; mailboxes: readonly Mailbox[] | null }) {
	const toast = useToast();
	const load = useCallback(() => api.call("mail.get_settings"), []);
	const { data: settings, setData, error, setError, reload } = useLoad<MailSettings>(load);
	const [busy, setBusy] = useState(false);

	if (mailbox.kind === "agent") {
		return (
			<Panel title="Default address">
				<p className="field-hint">Nobody sends from the mailbox of an agent, so it cannot be your default address.</p>
			</Panel>
		);
	}

	// A saved team mailbox that the person can no longer read does not open: Mail opens the own mailbox.
	const saved = settings?.default_mailbox_id ?? null;
	const savedOpens = saved !== null && (mailboxes ?? []).some((item) => item.id === saved);
	const current = savedOpens ? saved : null;
	const isDefault = current === mailbox.id;

	async function makeDefault() {
		setBusy(true);
		setError(null);
		try {
			setData(await api.call("mail.update_settings", { default_mailbox_id: mailbox.id }));
			toast({ message: `${mailbox.address} is now your default address.` });
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}

	return (
		<Panel title="Default address">
			<p className="field-hint">
				Mail opens the mailbox of your default address first, so a new message comes from that address.
			</p>
			{!settings && !error && <p className="field-hint">Loading…</p>}
			{!settings && error && <LoadError error={error} onRetry={() => void reload()} />}
			{settings &&
				(isDefault ? (
					<p className="mailbox-default" role="status">
						<Icon name="check" size={16} />
						<span>
							<strong>{mailbox.address}</strong> is your default address.
						</span>
					</p>
				) : (
					<button type="button" className="button button-small" onClick={() => void makeDefault()} disabled={busy}>
						Make {mailbox.address} my default
					</button>
				))}
			{settings && error && (
				<p className="form-error" role="alert">
					{error}
				</p>
			)}
		</Panel>
	);
}

/**
 * The plain-text signature of the mailbox (`mail.update_mailbox_settings`). The composer adds it to each
 * new message, reply and forward. The members of a shared mailbox share it.
 */
function SignatureSection({
	mailbox,
	rights,
	onSaved,
}: {
	mailbox: SettingsMailbox;
	rights: MailboxRights;
	onSaved: (settings: MailboxSettingsData) => void;
}) {
	const toast = useToast();
	const ids = { field: useId(), hint: useId(), count: useId() };
	const load = useCallback(() => api.call("mail.get_mailbox_settings", mailboxInput(mailbox.id)), [mailbox.id]);
	const { data: settings, setData, error, setError, reload } = useLoad<MailboxSettingsData>(load);
	const [text, setText] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const value = text ?? settings?.signature ?? "";
	const unchanged = settings !== null && value === settings.signature;
	const tooLong = value.length > MAIL_LIMITS.signatureChars;

	async function save(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (unchanged || tooLong) return;
		setBusy(true);
		setError(null);
		try {
			const next = await api.call("mail.update_mailbox_settings", { ...mailboxInput(mailbox.id), signature: value });
			setData(next);
			setText(null);
			onSaved(next);
			toast({ message: next.signature ? "Signature saved." : "Signature removed." });
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}

	const hint =
		mailbox.kind === "agent"
			? "Only the agent changes its signature. It adds the signature to its mail itself."
			: `Plain text. The composer adds it to each new message, reply and forward. You can change it there.${mailbox.kind === "team" ? " The members of this shared mailbox share this signature." : ""}`;

	return (
		<Panel title="Signature">
			{!settings && !error && <p className="field-hint">Loading…</p>}
			{!settings && error && <LoadError error={error} onRetry={() => void reload()} />}
			{settings && (
				<form className="signature-form" onSubmit={save} noValidate>
					<label htmlFor={ids.field} className="visually-hidden">
						Signature
					</label>
					<textarea
						id={ids.field}
						className="input signature-input"
						rows={4}
						value={value}
						placeholder={rights.modify ? "Your name, role and phone number" : "No signature"}
						onChange={(event) => setText(event.target.value)}
						readOnly={!rights.modify}
						aria-describedby={`${ids.hint} ${ids.count}`}
						aria-invalid={tooLong || undefined}
						disabled={busy}
					/>
					<div className="signature-meta">
						<p id={ids.hint} className="field-hint signature-hint">
							{hint}
						</p>
						<p id={ids.count} className={`field-hint signature-count${tooLong ? " form-error" : ""}`}>
							{value.length.toLocaleString("en-US")} / {MAIL_LIMITS.signatureChars.toLocaleString("en-US")}
						</p>
					</div>
					{error && (
						<p className="form-error" role="alert">
							{error}
						</p>
					)}
					{rights.modify && (
						<button
							type="submit"
							className="button button-primary button-small"
							disabled={busy || unchanged || tooLong}
						>
							{busy ? "Saving…" : "Save signature"}
						</button>
					)}
				</form>
			)}
		</Panel>
	);
}
