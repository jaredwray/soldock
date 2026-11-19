import { useEffect, useRef, useState } from "react";

// Files that the person drags from the computer into a box of Chat. An element with
// `data-file-drop="<zone>"` takes the files of its zone. The listeners are on the window, as in Drive:
// a drop outside each zone then does nothing, and the browser does not open the file in place of the app.

/** The zone of the element under the pointer, or null. */
function zoneAt(target: EventTarget | null): string | null {
	const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
	return element?.closest<HTMLElement>("[data-file-drop]")?.dataset.fileDrop ?? null;
}

function hasFiles(event: DragEvent): boolean {
	return event.dataTransfer?.types.includes("Files") ?? false;
}

/** The files of a drop, and the names of its folders. A message takes only files. */
function droppedFiles(data: DataTransfer): { files: File[]; folders: string[] } {
	const files: File[] = [];
	const folders: string[] = [];
	for (const item of Array.from(data.items)) {
		if (item.kind !== "file") continue;
		const entry = item.webkitGetAsEntry();
		const file = item.getAsFile();
		if (entry?.isDirectory) folders.push(entry.name);
		else if (file) files.push(file);
	}
	// A browser without `items` gives only the list of files.
	if (files.length === 0 && folders.length === 0) files.push(...Array.from(data.files));
	return { files, folders };
}

/**
 * Takes the files that the person drops on the elements of `zone`, with the names of the folders of the
 * drop, which do not go in. Returns true while a drag of files is over the zone, so the zone can show
 * that it takes them. A drag over a different zone is for that zone: its own hook handles it.
 */
export function useFileDrop(zone: string, onFiles: (files: File[], folders: string[]) => void): boolean {
	const [over, setOver] = useState(false);
	const take = useRef(onFiles);
	take.current = onFiles;

	useEffect(() => {
		// The count of the elements that the drag is in. Safari gives no related target on dragleave.
		let depth = 0;
		// A browser sends dragover at least each 550 ms during a drag. After a longer time with no
		// dragover, the drag is gone.
		let idle = 0;
		function reset() {
			window.clearTimeout(idle);
			depth = 0;
			setOver(false);
		}
		function onDragOver(event: DragEvent) {
			if (!event.dataTransfer || !hasFiles(event)) return;
			const at = zoneAt(event.target);
			setOver(at === zone);
			if (at !== null && at !== zone) return;
			event.preventDefault();
			window.clearTimeout(idle);
			idle = window.setTimeout(reset, 1000);
			event.dataTransfer.dropEffect = at === zone ? "copy" : "none";
		}
		function onDragEnter(event: DragEvent) {
			if (!hasFiles(event)) return;
			depth += 1;
			onDragOver(event);
		}
		function onDragLeave(event: DragEvent) {
			if (!hasFiles(event)) return;
			depth = Math.max(0, depth - 1);
			if (depth === 0) reset();
		}
		function onDrop(event: DragEvent) {
			if (!event.dataTransfer || !hasFiles(event)) return;
			const at = zoneAt(event.target);
			reset();
			if (at !== null && at !== zone) return;
			event.preventDefault();
			if (at !== zone) return;
			const { files, folders } = droppedFiles(event.dataTransfer);
			take.current(files, folders);
		}
		window.addEventListener("dragenter", onDragEnter);
		window.addEventListener("dragover", onDragOver);
		window.addEventListener("dragleave", onDragLeave);
		window.addEventListener("drop", onDrop);
		return () => {
			window.clearTimeout(idle);
			window.removeEventListener("dragenter", onDragEnter);
			window.removeEventListener("dragover", onDragOver);
			window.removeEventListener("dragleave", onDragLeave);
			window.removeEventListener("drop", onDrop);
		};
	}, [zone]);

	return over;
}
