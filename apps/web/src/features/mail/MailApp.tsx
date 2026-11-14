import type { Label, Mailbox } from "@soldock/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { navigate } from "../../lib/router.tsx";
import { useToast } from "../../lib/toast.tsx";
import { useOnChange } from "../../lib/useOnChange.ts";
import { isAgentMailbox, type MailView, viewPath } from "../../routes.ts";
import { useSession } from "../auth/session.tsx";
import type { SendResult } from "./Composer.tsx";
import { Composer, usePreloadComposer } from "./ComposerLoader.tsx";
import { type Draft, newDraft } from "./compose.ts";
import { useLabels, useProfilePoll } from "./data.ts";
import { DeleteLabelDialog, NewLabelDialog } from "./LabelDialogs.tsx";
import { MailPane } from "./MailPane.tsx";
import { MailboxProvider } from "./mailbox.tsx";
import { ShortcutHelp } from "./ShortcutHelp.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { viewQuery, viewTitle } from "./views.ts";

type MailDialog = { type: "help" } | { type: "new-label" } | { type: "delete-label"; label: Label } | null;

interface MailAppProps {
	route: { mailboxId: string | null; view: MailView; threadId: string | null };
	/** The mailboxes that the person can use, from the shell: the list stays when the mailbox changes. */
	mailboxes: readonly Mailbox[] | null;
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
export function MailApp({ route, mailboxes, navOpen, onCloseNav }: MailAppProps) {
	const { whoami } = useSession();
	const toast = useToast();
	const [refreshKey, setRefreshKey] = useState(0);
	const bump = useCallback(() => setRefreshKey((key) => key + 1), []);
	const { mailboxId } = route;
	const { profile, sync } = useProfilePoll(mailboxId, bump);
	const { labels, error: labelsError, reload: reloadLabels } = useLabels(mailboxId);
	const listed = mailboxId ? (mailboxes?.find((mailbox) => mailbox.id === mailboxId) ?? null) : null;
	const readOnly = isAgentMailbox(mailboxId);
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
		? (profile?.display_name ?? listed?.display_name ?? (readOnly ? "Agent mailbox" : "Team mailbox"))
		: null;
	const query = viewQuery(route.view, labels);
	const title = viewTitle(route.view, labels);
	const inboxUnread = labelsById.get("INBOX")?.threads_unread ?? profile?.inbox_unread ?? 0;

	useEffect(() => {
		const mailbox = mailboxName ? ` – ${mailboxName}` : "";
		document.title = `${title}${inboxUnread > 0 ? ` (${inboxUnread})` : ""}${mailbox} – Soldock`;
	}, [title, inboxUnread, mailboxName]);

	useEffect(() => {
		if (!navOpen) return;
		function onKeyDown(event: KeyboardEvent) {
			if (event.key === "Escape") closeNavRef.current();
		}
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [navOpen]);

	const compose = useCallback(
		(next?: Draft) => {
			// Nobody sends from the mailbox of an agent except the agent.
			if (readOnly) return;
			closeNavRef.current();
			setDraft(next ?? newDraft());
		},
		[readOnly],
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
			<div className="mail-layout">
				<Sidebar
					mailboxId={mailboxId}
					mailboxes={mailboxes}
					readOnly={readOnly}
					view={route.view}
					labels={labels}
					labelsError={labelsError}
					open={navOpen}
					onCompose={() => compose()}
					onNewLabel={() => setDialog({ type: "new-label" })}
					onDeleteLabel={(label) => setDialog({ type: "delete-label", label })}
					onClose={onCloseNav}
				/>
				<MailPane
					key={viewPath(route.view)}
					mailboxName={mailboxName}
					view={route.view}
					threadId={route.threadId}
					query={query}
					title={title}
					labels={labels}
					labelsById={labelsById}
					myAddress={myAddress}
					refreshKey={refreshKey}
					onChanged={onChanged}
					onCompose={compose}
					onShowHelp={() => setDialog({ type: "help" })}
				/>
				{draft && !readOnly && (
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
							if (route.view.kind === "label" && route.view.labelId === dialog.label.id) {
								navigate(viewPath({ kind: "system", view: "inbox" }, mailboxId));
							}
							toast({ message: `Label “${dialog.label.name}” deleted.` });
							onChanged();
						}}
					/>
				)}
			</div>
		</MailboxProvider>
	);
}
