import type { Label } from "@soldock/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { navigate } from "../../lib/router.tsx";
import { useToast } from "../../lib/toast.tsx";
import { useOnChange } from "../../lib/useOnChange.ts";
import { INBOX_PATH, type MailView, viewPath } from "../../routes.ts";
import { useSession } from "../auth/session.tsx";
import type { SendResult } from "./Composer.tsx";
import { Composer, usePreloadComposer } from "./ComposerLoader.tsx";
import { type Draft, newDraft } from "./compose.ts";
import { useLabels, useProfilePoll } from "./data.ts";
import { DeleteLabelDialog, NewLabelDialog } from "./LabelDialogs.tsx";
import { MailPane } from "./MailPane.tsx";
import { ShortcutHelp } from "./ShortcutHelp.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { viewQuery, viewTitle } from "./views.ts";

type MailDialog = { type: "help" } | { type: "new-label" } | { type: "delete-label"; label: Label } | null;

interface MailAppProps {
	route: { view: MailView; threadId: string | null };
	navOpen: boolean;
	onCloseNav: () => void;
}

/**
 * The Mail product. It owns the data that each view shares: the profile poll, the labels, the
 * composer and the dialogs. The pane for the current view has a key, so a new view starts clean.
 */
export function MailApp({ route, navOpen, onCloseNav }: MailAppProps) {
	const { whoami } = useSession();
	const toast = useToast();
	const [refreshKey, setRefreshKey] = useState(0);
	const bump = useCallback(() => setRefreshKey((key) => key + 1), []);
	const { profile, sync } = useProfilePoll(bump);
	const { labels, error: labelsError, reload: reloadLabels } = useLabels();
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
	const myAddress = profile?.address ?? whoami.principal.address;
	const query = viewQuery(route.view, labels);
	const title = viewTitle(route.view, labels);
	const inboxUnread = labelsById.get("INBOX")?.threads_unread ?? profile?.inbox_unread ?? 0;

	useEffect(() => {
		document.title = `${title}${inboxUnread > 0 ? ` (${inboxUnread})` : ""} – Soldock`;
	}, [title, inboxUnread]);

	useEffect(() => {
		if (!navOpen) return;
		function onKeyDown(event: KeyboardEvent) {
			if (event.key === "Escape") closeNavRef.current();
		}
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [navOpen]);

	const compose = useCallback((next?: Draft) => {
		closeNavRef.current();
		setDraft(next ?? newDraft());
	}, []);

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
		<div className="mail-layout">
			<Sidebar
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
			{draft && (
				<Composer
					key={draft.key}
					draft={draft}
					mailDomains={profile?.mail_domains ?? null}
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
						if (route.view.kind === "label" && route.view.labelId === dialog.label.id) navigate(INBOX_PATH);
						toast({ message: `Label “${dialog.label.name}” deleted.` });
						onChanged();
					}}
				/>
			)}
		</div>
	);
}
