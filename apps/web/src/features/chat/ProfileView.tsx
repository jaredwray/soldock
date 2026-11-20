import type { ChatRoom, DirectoryEntry, Principal } from "@asterra/contracts";
import { useEffect, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { initials } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { Link } from "../../lib/router.tsx";
import { useToast } from "../../lib/toast.tsx";
import { chatPath, profilePath } from "../../routes.ts";
import { useSession } from "../auth/session.tsx";
import type { MentionDirectory } from "./mentions.ts";
import { dayLabel } from "./model.ts";

const ROLE_NAMES = { owner: "Owner", admin: "Admin", member: "Member" } as const;

export interface ProfileViewProps {
	principalId: string;
	/** The people that the page asked for. A profile that a message already read shows at once. */
	directory: MentionDirectory<DirectoryEntry>;
	/** Shows the direct message room that the button opened. */
	onOpened: (room: ChatRoom) => Promise<void>;
}

/** The read of a profile: the principal (null when the directory does not have it) and the sponsor of an agent. */
type ProfileRead = { person: DirectoryEntry | null; sponsor: DirectoryEntry | null } | "failed" | null;

/**
 * The principal of a profile and the sponsor of an agent, from the server by their ids
 * (`directory.get_principals`), so a profile reads two principals at most, not the directory. Null
 * while the read runs.
 */
function useProfile(principalId: string): ProfileRead {
	const [read, setRead] = useState<ProfileRead>(null);
	useEffect(() => {
		let active = true;
		const one = async (id: string) => (await api.call("directory.get_principals", { ids: id })).principals[0] ?? null;
		(async () => {
			const person = await one(principalId);
			const sponsor = person?.sponsor_id ? await one(person.sponsor_id) : null;
			if (active) setRead({ person, sponsor });
		})().catch(() => {
			if (active) setRead("failed");
		});
		return () => {
			active = false;
		};
	}, [principalId]);
	return read;
}

/**
 * The profile of a person or an agent: the name, the handle for a mention, the address, the role or
 * the sponsor, and a button for a direct message. A mention in a message links here.
 */
export function ProfileView({ principalId, directory, onOpened }: ProfileViewProps) {
	const ownId = useSession().whoami.principal.id;
	const toast = useToast();
	const [opening, setOpening] = useState(false);
	const read = useProfile(principalId);
	// Until the read comes, and when it fails, the profile shows what a message of the page already read.
	const loaded = read !== null && read !== "failed" ? read : null;
	const person = loaded ? loaded.person : (directory.byId.get(principalId) ?? null);
	const sponsor = loaded ? loaded.sponsor : person?.sponsor_id ? (directory.byId.get(person.sponsor_id) ?? null) : null;
	const handle = person?.handle;
	const name = person?.display_name ?? null;

	useEffect(() => {
		document.title = `${name ?? "Profile"} – Asterra Chat`;
	}, [name]);

	async function message(target: Principal) {
		setOpening(true);
		try {
			const { room } = await api.call("chat.open_dm", { principal_id: target.id });
			await onOpened(room);
		} catch (caught) {
			toast({ message: errorMessage(caught), tone: "error" });
			setOpening(false);
		}
	}

	if (!person && read === null) {
		return (
			<p className="list-state" role="status">
				<span className="spinner" aria-hidden="true" />
				Loading…
			</p>
		);
	}
	if (!person) {
		return (
			<div className="list-state">
				<p role="alert">
					{read === "failed"
						? "The profile did not load. Reload the page to try again."
						: "This person or agent is not in the directory."}
				</p>
				<Link to={chatPath()} className="button">
					Go to your rooms
				</Link>
			</div>
		);
	}

	const agent = person.kind === "agent";
	return (
		<>
			<header className="chat-header">
				<Icon name="team" size={22} />
				<h1 className="chat-title">Profile</h1>
			</header>
			<div className="chat-profile">
				{/* The avatar of a person is a square with round corners. The avatar of an agent is a circle. */}
				<span className={agent ? "chat-profile-avatar chat-avatar-agent" : "chat-profile-avatar"} aria-hidden="true">
					{initials(person.display_name)}
				</span>
				<h2 className="chat-profile-name">
					{person.display_name}
					{agent && <span className="kind kind-agent">agent</span>}
				</h2>
				{handle && <p className="chat-profile-handle">@{handle}</p>}
				{person.archived_at !== null && (
					<p className="chat-profile-note">An owner or an admin archived this {agent ? "agent" : "person"}.</p>
				)}
				{person.id !== ownId && person.archived_at === null && (
					<p className="chat-start">
						<button
							type="button"
							className="button button-primary"
							disabled={opening}
							onClick={() => void message(person)}
						>
							<Icon name="chat" size={16} />
							{opening ? "Opening…" : "Send a direct message"}
						</button>
					</p>
				)}
				<dl className="panel-card setting-rows chat-profile-details">
					<div className="setting-row">
						<dt>Address</dt>
						<dd>{person.address}</dd>
					</div>
					{person.org_role && (
						<div className="setting-row">
							<dt>Role</dt>
							<dd>{ROLE_NAMES[person.org_role]}</dd>
						</div>
					)}
					{agent && (
						<div className="setting-row">
							<dt>Sponsor</dt>
							<dd>{sponsor ? <Link to={profilePath(sponsor.id)}>{sponsor.display_name}</Link> : "None"}</dd>
						</div>
					)}
					<div className="setting-row">
						<dt>In Asterra since</dt>
						<dd>
							<time dateTime={person.created_at}>{dayLabel(person.created_at)}</time>
						</dd>
					</div>
				</dl>
			</div>
		</>
	);
}
