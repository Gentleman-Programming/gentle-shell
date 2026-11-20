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
	permission?: string;
	review?: "on" | "off";
	waiting?: true;
	notice?: { text: string; ok: boolean; at: number };
	said?: string;
	/** The latest visible conversation turns, oldest first (absent from older publishers). */
	chat?: TowerChatTurn[];
	models?: Array<{ model: string; cost: number; tokens: number }>;
	artifacts?: TowerArtifact[];
	/** Entries left out so the snapshot fits the hub limit. */
	omitted?: { todos?: number; subagents?: number; models?: number; artifacts?: number; chat?: number };
	updatedAt: number;
	/** A live Gentle Shell session without the tower extension: name, project and helpers only, no actions. */
	basic?: true;
}

export interface TowerChatTurn { role: "you" | "agent"; text: string; at: number }

export interface TowerArtifact { path: string; kind: "doc" | "diagram" | "image" }

export interface Project {
	id: string;
	cwd: string;
	sessions: TowerSnapshot[];
}

export type FloorState = "need" | "work" | "done";
