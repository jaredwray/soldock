import { Dialog } from "../../lib/Dialog.tsx";

interface Shortcut {
	keys: readonly string[];
	action: string;
}

/** The shortcuts, in the groups that the help dialog shows. */
export const SHORTCUT_GROUPS: readonly { name: string; shortcuts: readonly Shortcut[] }[] = [
	{
		name: "Move",
		shortcuts: [
			{ keys: ["j"], action: "Next (older) conversation" },
			{ keys: ["k"], action: "Previous (newer) conversation" },
			{ keys: ["o", "Enter"], action: "Open the conversation" },
			{ keys: ["u"], action: "Back to the list" },
			{ keys: ["/"], action: "Search" },
		],
	},
	{
		name: "Conversations",
		shortcuts: [
			{ keys: ["x"], action: "Select the conversation" },
			{ keys: ["e"], action: "Archive" },
			{ keys: ["#"], action: "Move to Trash" },
			{ keys: ["s"], action: "Star or remove the star" },
			{ keys: ["l"], action: "Reply later, or Done in Reply later" },
		],
	},
	{
		name: "Messages",
		shortcuts: [
			{ keys: ["c"], action: "Compose" },
			{ keys: ["r"], action: "Reply" },
		],
	},
	{
		name: "Focus & Reply",
		shortcuts: [
			{ keys: ["j", "k"], action: "Next or previous conversation" },
			{ keys: ["r"], action: "Reply in the page" },
			{ keys: ["a"], action: "Reply all in the page" },
			{ keys: ["f"], action: "Forward the conversation" },
			{ keys: ["e"], action: "Done: take the conversation out of the view" },
			{ keys: ["l"], action: "Move to Reply later, or Done in Reply later" },
			{ keys: ["Ctrl+Enter"], action: "Send the message (Cmd+Enter on a Mac)" },
			{ keys: ["Esc"], action: "Close the reply" },
		],
	},
	{
		name: "Help",
		shortcuts: [{ keys: ["?"], action: "Show this help" }],
	},
];

export function ShortcutHelp({ onClose }: { onClose: () => void }) {
	return (
		<Dialog
			title="Keyboard shortcuts"
			description="Shortcuts work when the focus is not in a text field."
			onClose={onClose}
			className="dialog-small shortcut-dialog"
		>
			<div className="shortcut-groups">
				{SHORTCUT_GROUPS.map((group) => (
					<section key={group.name} aria-label={group.name} className="shortcut-group">
						<h3 className="shortcut-group-title">{group.name}</h3>
						<dl className="shortcut-list">
							{group.shortcuts.map((shortcut) => (
								<div key={shortcut.action} className="shortcut-row">
									<dt>{shortcut.action}</dt>
									<dd className="shortcut-keys">
										{shortcut.keys.map((key, index) => (
											<span key={key} className="shortcut-key">
												{index > 0 && <span className="shortcut-or">or</span>}
												<kbd>{key}</kbd>
											</span>
										))}
									</dd>
								</div>
							))}
						</dl>
					</section>
				))}
			</div>
			<div className="dialog-actions">
				<button type="button" className="button" onClick={onClose} data-autofocus>
					Close
				</button>
			</div>
		</Dialog>
	);
}
