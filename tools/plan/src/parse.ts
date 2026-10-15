import {
	type Problem,
	STAGE_ID,
	STAGE_STATUSES,
	type Stage,
	type StageStatus,
	TASK_ID,
	TASK_KINDS,
	TASK_SIZES,
	TASK_STATUSES,
	type Task,
	type TaskKind,
	type TaskSize,
	type TaskStatus,
} from "./model.ts";

const TASK_HEADING = /^###\s+(S\d{2}\.T\d{2})\s*[·:—–-]\s*(.+?)\s*$/;
const LOOKS_LIKE_TASK_HEADING = /^###\s+S\d/;
const META_LINE = /^-\s+([a-z-]+):\s*(.*?)\s*$/;
const META_KEYS = new Set(["status", "kind", "size", "depends", "reason"]);

export interface ParseResult {
	stage?: Stage;
	problems: Problem[];
}

function includes<T extends string>(values: readonly T[], value: string): value is T {
	return (values as readonly string[]).includes(value);
}

function parseList(value: string): string[] {
	const trimmed = value.trim().replace(/^\[(.*)\]$/, "$1");
	if (trimmed === "" || trimmed === "—" || trimmed === "-" || trimmed.toLowerCase() === "none") {
		return [];
	}
	return trimmed
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
}

/** Parses one stage file. `file` is used only for error messages. */
export function parseStage(file: string, source: string): ParseResult {
	const problems: Problem[] = [];
	const lines = source.split(/\r?\n/);

	if (lines[0] !== "---") {
		return { problems: [{ file, line: 1, message: "stage file must start with a `---` frontmatter block" }] };
	}
	const end = lines.indexOf("---", 1);
	if (end === -1) {
		return { problems: [{ file, line: 1, message: "unterminated frontmatter block" }] };
	}

	const front = new Map<string, string>();
	for (let i = 1; i < end; i++) {
		const line = lines[i] ?? "";
		if (line.trim() === "") continue;
		const match = /^([a-z_]+):\s*(.*?)\s*$/.exec(line);
		if (!match?.[1]) {
			problems.push({ file, line: i + 1, message: `unparseable frontmatter line: ${line}` });
			continue;
		}
		front.set(match[1], match[2] ?? "");
	}

	const id = front.get("id") ?? "";
	const title = front.get("title") ?? "";
	const status = front.get("status") ?? "";
	if (!STAGE_ID.test(id)) problems.push({ file, line: 2, message: `frontmatter id must look like S00, got "${id}"` });
	if (title === "") problems.push({ file, line: 2, message: "frontmatter title is required" });
	if (!includes(STAGE_STATUSES, status)) {
		problems.push({
			file,
			line: 2,
			message: `stage status must be one of ${STAGE_STATUSES.join(", ")}, got "${status}"`,
		});
	}

	const tasks: Task[] = [];
	const headingLines: number[] = [];
	for (let i = end + 1; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (TASK_HEADING.test(line)) {
			headingLines.push(i);
		} else if (LOOKS_LIKE_TASK_HEADING.test(line)) {
			problems.push({ file, line: i + 1, message: `malformed task heading (expected "### S00.T00 · Title"): ${line}` });
		}
	}

	for (const [index, start] of headingLines.entries()) {
		const heading = TASK_HEADING.exec(lines[start] ?? "");
		if (!heading?.[1] || !heading[2]) continue;
		const taskId = heading[1];
		const lineNo = start + 1;

		// The section runs until the next task heading or the next `#`/`##` heading.
		let stop = headingLines[index + 1] ?? lines.length;
		for (let j = start + 1; j < stop; j++) {
			if (/^#{1,2}\s/.test(lines[j] ?? "")) {
				stop = j;
				break;
			}
		}

		const meta = new Map<string, string>();
		for (let j = start + 1; j < stop; j++) {
			const line = lines[j] ?? "";
			if (line.trim() === "" && meta.size === 0) continue;
			const match = META_LINE.exec(line);
			if (!match?.[1]) break;
			if (!META_KEYS.has(match[1])) {
				problems.push({
					file,
					line: j + 1,
					message: `${taskId}: unknown metadata key "${match[1]}" (expected ${[...META_KEYS].join(", ")})`,
				});
			} else if (meta.has(match[1])) {
				problems.push({ file, line: j + 1, message: `${taskId}: duplicate metadata key "${match[1]}"` });
			}
			meta.set(match[1], match[2] ?? "");
		}

		const taskStatus = meta.get("status") ?? "";
		const kind = meta.get("kind") ?? "";
		const size = meta.get("size") ?? "";
		if (!taskId.startsWith(`${id}.`)) {
			problems.push({ file, line: lineNo, message: `task ${taskId} does not belong to stage ${id}` });
		}
		if (!includes(TASK_STATUSES, taskStatus)) {
			problems.push({
				file,
				line: lineNo,
				message: `${taskId}: status must be one of ${TASK_STATUSES.join(", ")}, got "${taskStatus}"`,
			});
		}
		if (!includes(TASK_KINDS, kind)) {
			problems.push({
				file,
				line: lineNo,
				message: `${taskId}: kind must be one of ${TASK_KINDS.join(", ")}, got "${kind}"`,
			});
		}
		if (!includes(TASK_SIZES, size)) {
			problems.push({
				file,
				line: lineNo,
				message: `${taskId}: size must be one of ${TASK_SIZES.join(", ")}, got "${size}"`,
			});
		}
		const depends = parseList(meta.get("depends") ?? "");
		for (const dep of depends) {
			if (!TASK_ID.test(dep) && !STAGE_ID.test(dep)) {
				problems.push({
					file,
					line: lineNo,
					message: `${taskId}: dependency "${dep}" is neither a task (S00.T00) nor a stage (S00) id`,
				});
			}
		}

		const task: Task = {
			id: taskId,
			stageId: id,
			title: heading[2],
			status: taskStatus as TaskStatus,
			kind: kind as TaskKind,
			size: size as TaskSize,
			depends,
			body: lines.slice(start, stop).join("\n").trimEnd(),
			file,
			line: lineNo,
		};
		const reason = meta.get("reason");
		if (reason !== undefined && reason !== "") task.reason = reason;
		tasks.push(task);
	}

	const gateLog: string[] = [];
	const gateStart = lines.findIndex((line) => /^##\s+Gate log\s*$/.test(line));
	if (gateStart !== -1) {
		for (let i = gateStart + 1; i < lines.length; i++) {
			const line = lines[i] ?? "";
			if (/^#{1,2}\s/.test(line)) break;
			if (line.startsWith("- ")) gateLog.push(line);
		}
	}

	const stage: Stage = {
		id,
		title,
		status: status as StageStatus,
		depends: parseList(front.get("depends") ?? ""),
		file,
		tasks,
		gateLog,
	};
	return { stage, problems };
}
