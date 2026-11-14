// Mirror of lib/tower-snapshot.ts (the server contract). Keep in sync.
export type TowerTodoStatus = "pending" | "in_progress" | "blocked" | "done" | "dropped";

export interface TowerTodo {
	id: number;
	title: string;
	status: TowerTodoStatus;
	note?: string;
}

export interface TowerSubagent {
	id: string;
	role: string;
	name: string;
	status: string;
	lastStep?: string;
	cost: number;
	tokens: number;
}

export interface TowerSnapshot {
	version: 1;
	sessionId: string;
	name: string;
	project: { cwd: string; name: string };
	model: string;
	effort?: string;
	context: { percent: number | null; window: number };
	cost: { total: number; input: number; output: number };
	todos: TowerTodo[];
	subagents: TowerSubagent[];
	phase?: string;
	updatedAt: number;
}

export interface Project {
	id: string;
	cwd: string;
	sessions: TowerSnapshot[];
}

export type FloorState = "need" | "work" | "done";
