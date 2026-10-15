export const STAGE_STATUSES = ["planned", "active", "done"] as const;
export const TASK_STATUSES = ["todo", "in-progress", "blocked", "done", "dropped"] as const;
export const TASK_KINDS = ["spike", "feature", "chore", "docs", "test", "ops"] as const;
export const TASK_SIZES = ["S", "M", "L"] as const;

export type StageStatus = (typeof STAGE_STATUSES)[number];
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskKind = (typeof TASK_KINDS)[number];
export type TaskSize = (typeof TASK_SIZES)[number];

export interface Task {
	id: string;
	stageId: string;
	title: string;
	status: TaskStatus;
	kind: TaskKind;
	size: TaskSize;
	depends: string[];
	reason?: string;
	/** Raw markdown of the task section, heading included. */
	body: string;
	file: string;
	line: number;
}

export interface Stage {
	id: string;
	title: string;
	status: StageStatus;
	depends: string[];
	file: string;
	tasks: Task[];
}

export interface Plan {
	stages: Stage[];
}

export interface Problem {
	file: string;
	line?: number;
	message: string;
}

export const STAGE_ID = /^S\d{2}$/;
export const TASK_ID = /^S\d{2}\.T\d{2}$/;

export function isSettled(status: TaskStatus): boolean {
	return status === "done" || status === "dropped";
}
