import type { Label, Mailbox } from "@asterra/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { lazyPage } from "../../lib/lazyPage.tsx";
import { setPageTitle } from "../../lib/pageTitle.ts";
import { navigate } from "../../lib/router.tsx";
import { useToast } from "../../lib/toast.tsx";
import { useOnChange } from "../../lib/useOnChange.ts";
import { isAgentMailbox, type MailView, viewPath } from "../../routes.ts";
import { useSession } from "../auth/session.tsx";
import { AutoLabelsDialog } from "./AutoLabelsDialog.tsx";
import type { SendResult } from "./Composer.tsx";
import { Composer, usePreloadComposer } from "./ComposerLoader.tsx";
import { type Draft, newDraft, withSignature } from "./compose.ts";
import { useLabels, useMailboxSettings, useProfilePoll } from "./data.ts";
import { DeleteLabelDialog, NewLabelDialog } from "./LabelDialogs.tsx";
import { MailPane } from "./MailPane.tsx";
import { MailboxProvider, MailboxRightsProvider } from "./mailbox.tsx";
import { mailboxRights } from "./mailboxNav.ts";
import { ShortcutHelp } from "./ShortcutHelp.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { viewQuery, viewTitle } from "./views.ts";

type MailDialog =
	| { type: "help" }
	| { type: "new-label" }
	| { type: "auto-labels" }
	| { type: "delete-label"; label: Label }
	| null;

// The settings view is a separate chunk: a person opens it seldom.
const MailboxSettings = lazyPage(() => import("./MailboxSettings.tsx").then((module) => module.MailboxSettings));

interface MailAppProps {
	/** `view` is null for the settings view of the mailbox. */
	route: { mailboxId: string | null; view: MailView | null; threadId: string | null };
	/** The mailboxes that the person can use, from the shell: the list stays when the mailbox changes. */
	mailboxes: readonly Mailbox[] | null;
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
export function MailApp({ route, mailboxes, expandedMailboxes, onSetExpanded, navOpen, onCloseNav }: MailAppProps) {
	const { whoami } = useSession();
	const toast = useToast();
	const [refreshKey, setRefreshKey] = useState(0);
	const bump = useCallback(() => setRefreshKey((key) => key + 1), []);
	const { mailboxId } = route;
	const { profile, sync } = useProfilePoll(mailboxId, bump);
	const { labels, error: labelsError, reload: reloadLabels } = useLabels(mailboxId);
	const { settings: mailboxSettings, set: setMailboxSettings } = useMailboxSettings(mailboxId);
	const listed = mailboxId ? (mailboxes?.find((mailbox) => mailbox.id === mailboxId) ?? null) : null;
	const rights = useMemo(() => mailboxRights(mailboxes, mailboxId), [mailboxes, mailboxId]);
	const [draft, setDraft] = useState<Draft | null>(null);
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
	const title = view ? viewTitle(view, labels) : "Settings";
	const inboxUnread = labelsById.get("INBOX")?.threads_unread ?? profile?.inbox_unread ?? 0;

	useEffect(() => {
		const mailbox = mailboxName ? ` – ${mailboxName}` : "";
		setPageTitle(`${title}${inboxUnread > 0 ? ` (${inboxUnread})` : ""}${mailbox} – Asterra`);
	}, [title, inboxUnread, mailboxName]);

	const signature = mailboxSettings?.signature ?? "";
	const compose = useCallback(
		(next?: Draft) => {
			// Nobody sends from the mailbox of an agent except the agent.
			if (!rights.send) return;
			closeNavRef.current();
			// The signature of the mailbox goes into each new message, reply and forward. The person can change it there.
			setDraft(withSignature(next ?? newDraft(), signature));
		},
		[rights.send, signature],
	);

	function sent(result: SendResult) {
		setDraft(null);
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
							refreshKey={refreshKey}
							onSettingsSaved={setMailboxSettings}
							onOpenAutoLabels={() => setDialog({ type: "auto-labels" })}
							onChanged={onChanged}
						/>
					)}
					{draft && rights.send && (
						<Composer
							key={draft.key}
							draft={draft}
							mailDomains={profile?.mail_domains ?? null}
							from={mailboxId ? { display_name: mailboxName ?? "", address: myAddress } : null}
							onClose={() => setDraft(null)}
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
