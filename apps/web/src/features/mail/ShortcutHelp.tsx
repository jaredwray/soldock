import { Dialog } from "../../lib/Dialog.tsx";

export const SHORTCUTS: readonly { keys: readonly string[]; action: string }[] = [
	{ keys: ["j"], action: "Next (older) conversation" },
	{ keys: ["k"], action: "Previous (newer) conversation" },
	{ keys: ["o", "Enter"], action: "Open the conversation" },
	{ keys: ["u"], action: "Back to the list" },
	{ keys: ["e"], action: "Archive" },
	{ keys: ["#"], action: "Move to Trash" },
	{ keys: ["s"], action: "Star or remove the star" },
	{ keys: ["x"], action: "Select the conversation" },
	{ keys: ["c"], action: "Compose" },
	{ keys: ["r"], action: "Reply" },
	{ keys: ["/"], action: "Search" },
	{ keys: ["?"], action: "Show this help" },
];

export function ShortcutHelp({ onClose }: { onClose: () => void }) {
	return (
		<Dialog
			title="Keyboard shortcuts"
			description="Shortcuts work when the focus is not in a text field."
			onClose={onClose}
			className="dialog-small"
		>
			<table className="shortcut-table">
				<thead>
					<tr>
						<th scope="col">Key</th>
						<th scope="col">Action</th>
					</tr>
				</thead>
				<tbody>
					{SHORTCUTS.map((shortcut) => (
						<tr key={shortcut.action}>
							<td>
								{shortcut.keys.map((key, index) => (
									<span key={key}>
										{index > 0 && " or "}
										<kbd>{key}</kbd>
									</span>
								))}
							</td>
							<td>{shortcut.action}</td>
						</tr>
					))}
				</tbody>
			</table>
			<div className="dialog-actions">
				<button type="button" className="button button-primary" onClick={onClose} data-autofocus>
					Close
				</button>
			</div>
		</Dialog>
	);
}
