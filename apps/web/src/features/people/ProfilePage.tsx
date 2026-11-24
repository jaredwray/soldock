import "./people.css";
import { ApiError, type DirectoryEntry, type Principal } from "@asterra/contracts";
import { useEffect, useState } from "react";
import { roomAccessText } from "../../lib/accessChange.ts";
import { api, errorMessage } from "../../lib/api.ts";
import { initials } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { setPageTitle } from "../../lib/pageTitle.ts";
import { isAutomated, kindTag } from "../../lib/principalKind.ts";
import { Link, navigate } from "../../lib/router.tsx";
import { useToast } from "../../lib/toast.tsx";
import { chatPath, INBOX_PATH, profilePath } from "../../routes.ts";
import { PageHeader } from "../../shell/PageHeader.tsx";
import { useSession } from "../auth/session.tsx";
import { Presence, PresenceProvider } from "../chat/Presence.tsx";

const ROLE_NAMES = { owner: "Owner", admin: "Admin", member: "Member" } as const;

/** The date of the account, for example "October 31, 2026". */
const sinceFormat = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "long", day: "numeric" });

export interface ProfilePageProps {
	principalId: string;
}

/**
 * The read of a profile: the principal (null when the directory does not have it) and the sponsor of an
 * agent. The sponsor is "failed" when only its read failed: the profile then still shows the principal.
 */
type ProfileRead = { person: DirectoryEntry | null; sponsor: DirectoryEntry | null | "failed" } | "failed" | null;

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
			const sponsor = person?.sponsor_id ? await one(person.sponsor_id).catch(() => "failed" as const) : null;
			if (active) setRead({ person, sponsor });
		})().catch((error: unknown) => {
			if (!active) return;
			// The path can hold a text that is no id. The server refuses it, and no principal has it.
			const noSuchId = error instanceof ApiError && error.code === "invalid";
			setRead(noSuchId ? { person: null, sponsor: null } : "failed");
		});
		return () => {
			active = false;
		};
	}, [principalId]);
	return read;
}

/**
 * The profile of a person or an agent, on its own page in the workspace: the name, the handle for a
 * mention, the address, the role or the sponsor, and a button for a direct message. The page has the
 * rail and no sidebar of a product. A mention in a message, the name of an author and the account menu
 * link here.
 */
export function ProfilePage({ principalId }: ProfilePageProps) {
	return (
		<PresenceProvider>
			<Profile principalId={principalId} />
		</PresenceProvider>
	);
}

function Profile({ principalId }: ProfilePageProps) {
	const ownId = useSession().whoami.principal.id;
	const toast = useToast();
	const [opening, setOpening] = useState(false);
	const read = useProfile(principalId);
	const loaded = read !== null && read !== "failed" ? read : null;
	const person = loaded?.person ?? null;
	const sponsor = loaded && loaded.sponsor !== "failed" ? loaded.sponsor : null;
	const name = person?.display_name ?? null;

	useEffect(() => {
		setPageTitle(`${name ?? "Profile"} – Asterra`);
	}, [name]);

	async function message(target: Principal) {
		setOpening(true);
		try {
			const result = await api.call("chat.open_dm", { principal_id: target.id });
			// The change is on the account of the agent, so the person who manages it must see it.
			const changed = roomAccessText(result, () => target.display_name).trim();
			if (changed) toast({ message: changed });
			navigate(chatPath(result.room.id));
		} catch (caught) {
			toast({ message: errorMessage(caught), tone: "error" });
			setOpening(false);
		}
	}

	return (
		<main id="main" className="page-main" tabIndex={-1}>
			<PageHeader title="Profile" icon="team" />
			{body()}
		</main>
	);

	function body() {
		if (read === null) {
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
					<Link to={INBOX_PATH} className="button">
						Go to the inbox
					</Link>
				</div>
			);
		}
		const agent = isAutomated(person.kind);
		return (
			<div className="profile">
				{/* The avatar of a person is a square with round corners. The avatar of an agent is a circle. */}
				<span className={agent ? "profile-avatar profile-avatar-agent" : "profile-avatar"} aria-hidden="true">
					{initials(person.display_name)}
				</span>
				<h2 className="profile-name">
					{person.display_name}
					{agent && <span className="kind kind-agent">{kindTag(person.kind)}</span>}
				</h2>
				{person.handle && <p className="profile-handle">@{person.handle}</p>}
				<div className="profile-status">
					<Presence id={person.id} agent={agent} editable={person.id === ownId} />
				</div>
				{person.archived_at !== null && (
					<p className="profile-note">An owner or an admin archived this {kindTag(person.kind) || "person"}.</p>
				)}
				{person.id !== ownId && person.archived_at === null && (
					<p className="profile-actions">
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
				<dl className="panel-card setting-rows profile-details">
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
							<dd>
								{sponsor ? (
									<Link to={profilePath(sponsor.id)}>{sponsor.display_name}</Link>
								) : loaded?.sponsor === "failed" ? (
									"The sponsor did not load."
								) : (
									"None"
								)}
							</dd>
						</div>
					)}
					<div className="setting-row">
						<dt>In Asterra since</dt>
						<dd>
							<time dateTime={person.created_at}>{sinceFormat.format(new Date(person.created_at))}</time>
						</dd>
					</div>
				</dl>
			</div>
		);
	}
}
