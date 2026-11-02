import { useEffect, useId, useRef, useState } from "react";
import { useAdminAccess } from "../features/admin/access.ts";
import { SIGN_OUT_FAILED } from "../features/auth/auth.ts";
import { useSession } from "../features/auth/session.tsx";
import { initials } from "../lib/format.ts";
import { Icon } from "../lib/icons.tsx";
import { Link } from "../lib/router.tsx";
import { useToast } from "../lib/toast.tsx";

const ROLE_NAMES = { owner: "Owner", admin: "Admin", member: "Member" } as const;

/** The account button and its panel: identity, Settings, Admin (when allowed) and Sign out. */
export function AccountMenu() {
	const { whoami, signOut } = useSession();
	const toast = useToast();
	const principal = whoami.principal;
	const showAdmin = useAdminAccess(principal);
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	const buttonRef = useRef<HTMLButtonElement>(null);
	const panelId = useId();

	useEffect(() => {
		if (!open) return;
		function onPointerDown(event: PointerEvent) {
			if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
		}
		function onKeyDown(event: KeyboardEvent) {
			if (event.key !== "Escape") return;
			setOpen(false);
			buttonRef.current?.focus();
		}
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);

	const close = () => setOpen(false);

	return (
		<div className="account" ref={rootRef}>
			<button
				ref={buttonRef}
				type="button"
				className="avatar-button"
				aria-label={`Account: ${principal.display_name}`}
				aria-expanded={open}
				aria-controls={open ? panelId : undefined}
				onClick={() => setOpen((value) => !value)}
			>
				<span className="avatar" aria-hidden="true">
					{initials(principal.display_name)}
				</span>
			</button>
			{open && (
				<div id={panelId} className="account-panel">
					<div className="account-identity">
						<span className="avatar avatar-large" aria-hidden="true">
							{initials(principal.display_name)}
						</span>
						<div className="account-text">
							<strong>{principal.display_name}</strong>
							<span>{principal.address}</span>
							{principal.org_role && <span className="muted">{ROLE_NAMES[principal.org_role]}</span>}
						</div>
					</div>
					<ul className="account-links">
						<li>
							<Link to="/settings" className="account-link" onClick={close}>
								<Icon name="settings" />
								Settings
							</Link>
						</li>
						{showAdmin && (
							<li>
								<Link to="/admin" className="account-link" onClick={close}>
									<Icon name="shield" />
									Admin
								</Link>
							</li>
						)}
						<li>
							<button
								type="button"
								className="account-link"
								onClick={() => void signOut().catch(() => toast({ message: SIGN_OUT_FAILED, tone: "error" }))}
							>
								<Icon name="signOut" />
								Sign out
							</button>
						</li>
					</ul>
				</div>
			)}
		</div>
	);
}
