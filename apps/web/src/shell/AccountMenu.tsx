import { useEffect, useId, useRef, useState } from "react";
import { SIGN_OUT_FAILED } from "../features/auth/auth.ts";
import { useSession } from "../features/auth/session.tsx";
import { type Appearance, chooseAppearance, useAppearance } from "../lib/appearance.ts";
import { initials } from "../lib/format.ts";
import { Icon, type IconName } from "../lib/icons.tsx";
import { useToast } from "../lib/toast.tsx";

const ROLE_NAMES = { owner: "Owner", admin: "Admin", member: "Member" } as const;

const APPEARANCES: readonly { value: Appearance; label: string; icon: IconName }[] = [
	{ value: "light", label: "Light", icon: "sun" },
	{ value: "dark", label: "Dark", icon: "moon" },
	{ value: "system", label: "System", icon: "system" },
];

/** The account button at the bottom of the rail, and its panel: identity, Appearance and Sign out. */
export function AccountMenu() {
	const { whoami, signOut } = useSession();
	const toast = useToast();
	const principal = whoami.principal;
	const appearance = useAppearance();
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
					<div className="menu-separator" />
					{/* A choice applies at once. The panel stays open. */}
					<fieldset className="appearance">
						<legend>Appearance</legend>
						<div className="appearance-options">
							{APPEARANCES.map((option) => (
								<label key={option.value} className="appearance-option">
									<input
										type="radio"
										name="appearance"
										value={option.value}
										checked={appearance === option.value}
										onChange={() => chooseAppearance(option.value)}
									/>
									<Icon name={option.icon} size={16} />
									{option.label}
								</label>
							))}
						</div>
					</fieldset>
					<div className="menu-separator" />
					<button
						type="button"
						className="menu-item"
						onClick={() => void signOut().catch(() => toast({ message: SIGN_OUT_FAILED, tone: "error" }))}
					>
						<Icon name="signOut" size={16} />
						Sign out
					</button>
				</div>
			)}
		</div>
	);
}
