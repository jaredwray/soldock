import { MEET_LIMITS, type Meeting, meetPath, parseMeetingCode } from "@asterra/contracts";
import { type FormEvent, useEffect, useId, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { Icon } from "../../lib/icons.tsx";
import { setPageTitle } from "../../lib/pageTitle.ts";
import { useToast } from "../../lib/toast.tsx";
import { PageHeader } from "../../shell/PageHeader.tsx";
import "./meet.css";

/**
 * The Meet page of the app (`/meet`). A member creates a meeting link to share, and opens a link or a code. The
 * meeting itself opens on its own page (`/meet/<code>`), which a guest can open without an account.
 */
export function MeetHome() {
	const [title, setTitle] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [meeting, setMeeting] = useState<Meeting | null>(null);
	const [link, setLink] = useState("");
	const [linkError, setLinkError] = useState<string | null>(null);
	const ids = { title: useId(), link: useId() };
	const toast = useToast();

	useEffect(() => {
		setPageTitle("Meet – Asterra");
	}, []);

	async function create(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			const trimmed = title.trim();
			const result = await api.call("meet.create_meeting", trimmed ? { title: trimmed } : {});
			setMeeting(result.meeting);
			setTitle("");
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}

	async function copy(url: string) {
		try {
			await navigator.clipboard.writeText(url);
			toast({ message: "Link copied" });
		} catch {
			toast({ message: "The browser did not copy the link. Select it and copy it." });
		}
	}

	function open(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const code = parseMeetingCode(link);
		if (!code) return setLinkError("Enter a meeting link or a code, such as k7qm-2x9d-ptw4-hs6n.");
		setLinkError(null);
		window.location.assign(meetPath(code));
	}

	return (
		<main id="main" className="page-main meet-home" tabIndex={-1}>
			<PageHeader title="Meet" icon="video" />
			<div className="meet-home-body">
				<section className="meet-home-card" aria-labelledby={`${ids.title}-heading`}>
					<h2 id={`${ids.title}-heading`} className="meet-panel-title">
						New meeting
					</h2>
					<p className="meet-muted">
						Share the link with each person who joins. People of your organization join at once. A guest enters a name
						and waits until you let them in.
					</p>
					<form onSubmit={create} className="meet-home-form">
						<div className="field">
							<label htmlFor={ids.title} className="field-label">
								Title (optional)
							</label>
							<input
								id={ids.title}
								className="input"
								value={title}
								maxLength={MEET_LIMITS.titleChars}
								onChange={(event) => setTitle(event.target.value)}
								disabled={busy}
							/>
						</div>
						{error && (
							<p className="form-error" role="alert">
								{error}
							</p>
						)}
						<button type="submit" className="button button-primary" disabled={busy}>
							<Icon name="plus" />
							{busy ? "Creating…" : "Create meeting link"}
						</button>
					</form>
					{meeting && (
						<div className="meet-link" aria-live="polite">
							<p className="meet-link-label">{meeting.title || "Your meeting"} is ready:</p>
							<div className="meet-link-row">
								<input className="input input-mono" readOnly value={meeting.join_url} aria-label="Meeting link" />
								<button type="button" className="button" onClick={() => void copy(meeting.join_url)}>
									<Icon name="copy" />
									Copy
								</button>
								<a className="button button-primary" href={meetPath(meeting.code)}>
									Join now
								</a>
							</div>
						</div>
					)}
				</section>
				<section className="meet-home-card" aria-labelledby={`${ids.link}-heading`}>
					<h2 id={`${ids.link}-heading`} className="meet-panel-title">
						Join a meeting
					</h2>
					<form onSubmit={open} className="meet-home-form" noValidate>
						<div className="field">
							<label htmlFor={ids.link} className="field-label">
								Link or code
							</label>
							<input
								id={ids.link}
								className="input"
								value={link}
								onChange={(event) => setLink(event.target.value)}
								aria-invalid={linkError ? true : undefined}
							/>
						</div>
						{linkError && (
							<p className="form-error" role="alert">
								{linkError}
							</p>
						)}
						<button type="submit" className="button">
							Open
						</button>
					</form>
				</section>
			</div>
		</main>
	);
}
