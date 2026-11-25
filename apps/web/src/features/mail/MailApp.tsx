import type { Label, Mailbox } from "@asterra/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { lazyPage } from "../../lib/lazyPage.tsx";
import { setPageTitle } from "../../lib/pageTitle.ts";
import { navigate } from "../../lib/router.tsx";
import { useToast } from "../../lib/toast.tsx";
import { useOnChange } from "../../lib/useOnChange.ts";
import { isAgentMailbox, type MailView, type ScreenerTab, viewPath } from "../../routes.ts";
import { SEARCH_INPUT_ID } from "../../shell/nav.ts";
import { useSession } from "../auth/session.tsx";
import { AutoLabelsDialog } from "./AutoLabelsDialog.tsx";
import type { SendResult } from "./Composer.tsx";
import { Composer, usePreloadComposer } from "./ComposerLoader.tsx";
import { type Draft, newDraft } from "./compose.ts";
import { useLabels, useMailboxSettings, useMailSettings, useProfilePoll } from "./data.ts";
import { DeleteLabelDialog, NewLabelDialog } from "./LabelDialogs.tsx";
import { MailPane } from "./MailPane.tsx";
import { MailboxProvider, MailboxRightsProvider } from "./mailbox.tsx";
import { defaultFromId, fromOptions, mailboxRights } from "./mailboxNav.ts";
import { ShortcutHelp } from "./ShortcutHelp.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { showScreener } from "./screener.ts";
import { useShortcuts } from "./useShortcuts.ts";
import { viewQuery, viewTitle } from "./views.ts";

type MailDialog =
	| { type: "help" }
	| { type: "new-label" }
	| { type: "auto-labels" }
	| { type: "delete-label"; label: Label }
	| null;

/** The open composer: its draft, the mailbox that sends it at first, and the signature of that mailbox. */
interface Composing {
	draft: Draft;
	from: string | null;
	signature: string;
}

// The settings view and the Screener view are separate chunks: a person opens them seldom.
const MailboxSettings = lazyPage(() => import("./MailboxSettings.tsx").then((module) => module.MailboxSettings));
const Screener = lazyPage(() => import("./Screener.tsx").then((module) => module.Screener));

interface MailAppProps {
	/**
	 * `view` is null for the settings view and the Screener view of the mailbox. `screener` is set for the
	 * Screener view.
	 */
	route: { mailboxId: string | null; view: MailView | null; threadId: string | null; screener?: ScreenerTab };
	/** The mailboxes that the person can use, from the shell: the list stays when the mailbox changes. */
	mailboxes: readonly Mailbox[] | null;
	/** Loads the mailboxes again, after a change of the members of a team mailbox in its settings view. */
	onMailboxesChanged: () => void;
	/** The mailboxes of the sidebar that the person expanded or collapsed, from the shell: the state stays when the mailbox changes. */
	expandedMailboxes: Readonly<Record<string, boolean>>;
	/** Expands or collapses a mailbox in the sidebar. Null goes back to the default. */
	onSetExpanded: (key: string, expanded: boolean | null) => void;
	navOpen: boolean;
	onCloseNav: () => void;
}

/**
 * The Mail product, for one mailbox: the own mailbox of the person, a team mailbox, or the mailbox of
 * an agent, which an owner or an admin can only read. It owns the
 * data that each view shares: the profile poll, the labels, the composer and the dialogs. The pane
 * for the current view has a key, so a new view starts clean. The shell gives this component a key
 * for each mailbox, so no data of one mailbox shows in a different one.
 */
export function MailApp({
	route,
	mailboxes,
	onMailboxesChanged,
	expandedMailboxes,
	onSetExpanded,
	navOpen,
	onCloseNav,
}: MailAppProps) {
	const { whoami } = useSession();
	const toast = useToast();
	const [refreshKey, setRefreshKey] = useState(0);
	const bump = useCallback(() => setRefreshKey((key) => key + 1), []);
	const { mailboxId } = route;
	const { profile, sync } = useProfilePoll(mailboxId, bump);
	const { labels, error: labelsError, reload: reloadLabels } = useLabels(mailboxId);
	const { settings: mailboxSettings, set: setMailboxSettings } = useMailboxSettings(mailboxId);
	const { settings: mailSettings, set: setMailSettings } = useMailSettings();
	const listed = mailboxId ? (mailboxes?.find((mailbox) => mailbox.id === mailboxId) ?? null) : null;
	const rights = useMemo(() => mailboxRights(mailboxes, mailboxId), [mailboxes, mailboxId]);
	const [composing, setComposing] = useState<Composing | null>(null);
	const [dialog, setDialog] = useState<MailDialog>(null);
	const closeNavRef = useRef(onCloseNav);
	usePreloadComposer();

	useEffect(() => {
		closeNavRef.current = onCloseNav;
	});

	useOnChange(refreshKey, () => void reloadLabels());

	/** After a change in this tab: get the labels, the list and the thread again. */
	const onChanged = useCallback(() => {
		bump();
		void sync();
	}, [bump, sync]);

	const labelsById = useMemo(() => new Map((labels ?? []).map((label) => [label.id, label])), [labels]);
	// The address of the mailbox. A reply from a team mailbox leaves out the team address, not the person's.
	const myAddress = profile?.address ?? (mailboxId ? (listed?.address ?? "") : whoami.principal.address);
	const mailboxName = mailboxId
		? (profile?.display_name ?? listed?.display_name ?? (isAgentMailbox(mailboxId) ? "Agent mailbox" : "Team mailbox"))
		: null;
	const { view } = route;
	const title = view ? viewTitle(view, labels) : route.screener ? "Screener" : "Settings";
	const screenerEnabled = mailboxSettings?.screener.enabled ?? false;
	const screenerPending = profile?.screener_pending ?? 0;
	const inboxUnread = labelsById.get("INBOX")?.threads_unread ?? profile?.inbox_unread ?? 0;

	useEffect(() => {
		const mailbox = mailboxName ? ` – ${mailboxName}` : "";
		setPageTitle(`${title}${inboxUnread > 0 ? ` (${inboxUnread})` : ""}${mailbox} – Asterra`);
	}, [title, inboxUnread, mailboxName]);

	// The addresses that the person can send from, and the one that a new message in this mailbox comes from.
	const senders = useMemo(
		() =>
			fromOptions(
				mailboxes,
				whoami.principal,
				mailboxId && rights.send ? { id: mailboxId, display_name: mailboxName ?? "", address: myAddress } : null,
			),
		[mailboxes, whoami.principal, mailboxId, rights.send, mailboxName, myAddress],
	);
	const defaultFrom = defaultFromId(mailboxId, mailSettings?.default_from ?? {}, senders, whoami.principal.id);
	// The signature of the default From, when it is not this mailbox.
	const { settings: fromSettings } = useMailboxSettings(defaultFrom, defaultFrom !== mailboxId);
	const signature = mailboxSettings?.signature ?? "";
	const fromSignature = defaultFrom === mailboxId ? signature : (fromSettings?.signature ?? "");
	const compose = useCallback(
		(next?: Draft) => {
			// Nobody sends from the mailbox of an agent except the agent.
			if (!rights.send) return;
			closeNavRef.current();
			// A reply comes from the mailbox of its conversation. A new message and a forward come from the default
			// From of this mailbox. The signature of the mailbox that sends goes into the draft. The person can
			// change it there.
			const draft = next ?? newDraft();
			setComposing(
				draft.replyToMessageId === null
					? { draft, from: defaultFrom, signature: fromSignature }
					: { draft, from: mailboxId, signature },
			);
		},
		[rights.send, defaultFrom, fromSignature, mailboxId, signature],
	);

	// The list has the shortcuts of Mail. The settings view keeps the ones that do not need a list.
	useShortcuts((event) => {
		if (view) return;
		switch (event.key) {
			case "c":
				compose();
				break;
			case "u":
				navigate(viewPath({ kind: "system", view: "inbox" }, mailboxId));
				break;
			case "/":
				document.getElementById(SEARCH_INPUT_ID)?.focus();
				break;
			case "?":
				setDialog({ type: "help" });
				break;
			default:
				return;
		}
		event.preventDefault();
	});

	function sent(result: SendResult) {
		setComposing(null);
		const failed = result.recipients.filter((recipient) => recipient.status === "failed");
		toast(
			failed.length > 0
				? {
						message: `Message sent, but delivery failed for ${failed.map((r) => r.address).join(", ")}.`,
						tone: "error",
					}
				: { message: "Message sent." },
		);
		onChanged();
	}

	return (
		<MailboxProvider value={mailboxId}>
			<MailboxRightsProvider value={rights}>
				<div className="mail-layout">
					<Sidebar
						mailboxId={mailboxId}
						mailboxName={mailboxName}
						address={myAddress}
						mailboxes={mailboxes}
						expanded={expandedMailboxes}
						onSetExpanded={onSetExpanded}
						canModify={rights.modify}
						canSend={rights.send}
						view={view}
						screener={
							showScreener(screenerEnabled, screenerPending)
								? { pending: screenerPending, active: route.screener !== undefined }
								: null
						}
						labels={labels}
						labelsError={labelsError}
						open={navOpen}
						onCompose={() => compose()}
						onNewLabel={() => setDialog({ type: "new-label" })}
						onAutoLabels={() => setDialog({ type: "auto-labels" })}
						onDeleteLabel={(label) => setDialog({ type: "delete-label", label })}
						onClose={onCloseNav}
					/>
					{view ? (
						<MailPane
							key={viewPath(view)}
							mailboxName={mailboxName}
							view={view}
							threadId={route.threadId}
							query={viewQuery(view, labels)}
							title={title}
							labels={labels}
							labelsById={labelsById}
							myAddress={myAddress}
							refreshKey={refreshKey}
							onChanged={onChanged}
							onCompose={compose}
							onShowHelp={() => setDialog({ type: "help" })}
						/>
					) : route.screener ? (
						<Screener
							mailboxId={mailboxId}
							tab={route.screener}
							title={mailboxName ? `${mailboxName}: Screener` : "Screener"}
							enabled={screenerEnabled}
							rights={rights}
							refreshKey={refreshKey}
							onChanged={onChanged}
						/>
					) : (
						<MailboxSettings
							mailbox={{
								id: mailboxId,
								kind: mailboxId === null ? "personal" : isAgentMailbox(mailboxId) ? "agent" : "team",
								address: myAddress,
								display_name: mailboxName ?? whoami.principal.display_name,
							}}
							title={mailboxName ? `${mailboxName}: Settings` : "Settings"}
							rights={rights}
							mailboxes={mailboxes}
							senders={senders}
							refreshKey={refreshKey}
							onSettingsSaved={setMailboxSettings}
							onMailSettingsSaved={setMailSettings}
							onMembersChanged={onMailboxesChanged}
							onOpenAutoLabels={() => setDialog({ type: "auto-labels" })}
							onChanged={onChanged}
						/>
					)}
					{composing && rights.send && (
						<Composer
							key={composing.draft.key}
							draft={composing.draft}
							mailDomains={profile?.mail_domains ?? null}
							fromOptions={senders}
							initialFrom={composing.from}
							signature={composing.signature}
							onClose={() => setComposing(null)}
							onSent={sent}
						/>
					)}
					{dialog?.type === "help" && <ShortcutHelp onClose={() => setDialog(null)} />}
					{dialog?.type === "auto-labels" && (
						<AutoLabelsDialog team={mailboxId !== null} onClose={() => setDialog(null)} onChanged={onChanged} />
					)}
					{dialog?.type === "new-label" && (
						<NewLabelDialog
							onClose={() => setDialog(null)}
							onCreated={(label) => {
								setDialog(null);
								toast({ message: `Label “${label.name}” created.` });
								onChanged();
							}}
						/>
					)}
					{dialog?.type === "delete-label" && (
						<DeleteLabelDialog
							label={dialog.label}
							onClose={() => setDialog(null)}
							onDeleted={() => {
								if (view?.kind === "label" && view.labelId === dialog.label.id) {
									navigate(viewPath({ kind: "system", view: "inbox" }, mailboxId));
								}
								toast({ message: `Label “${dialog.label.name}” deleted.` });
								onChanged();
							}}
						/>
					)}
				</div>
			</MailboxRightsProvider>
		</MailboxProvider>
	);
}
