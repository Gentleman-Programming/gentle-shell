export type ReasoningEffort =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh"
	| "max";

export interface ModelProfileEntry {
	model: string;
	effort?: ReasoningEffort;
}

export interface Profile {
	name: string;
	description?: string;
	default_model?: string;
	default_effort?: ReasoningEffort;
	model_profiles: Record<string, ModelProfileEntry>;
	created_at?: string;
	updated_at?: string;
}

export type ProfileScope = "builtin" | "global" | "project";

export interface ProfileSummary {
	name: string;
	description?: string;
	default_model?: string;
	agent_count: number;
	scope: ProfileScope;
	is_active: boolean;
	path?: string;
}

export interface SubagentsConfigFile {
	default_model?: string;
	default_effort?: string;
	active_profile?: string;
	model_profiles?: Record<string, { model: string; effort?: string }>;
	[key: string]: unknown;
}

export interface AgentCategory {
	id: string;
	name: string;
	description: string;
	agents: string[];
}

export const SDD_AGENT_CATEGORIES: AgentCategory[] = [
	{
		id: "sdd-core",
		name: "SDD Core",
		description: "Spec-Driven Development phase executors",
		agents: [
			"sdd-explore",
			"sdd-proposal",
			"sdd-spec",
			"sdd-design",
			"sdd-tasks",
			"sdd-apply",
			"sdd-verify",
			"sdd-archive",
			"sdd-init",
			"sdd-onboard",
			"sdd-research",
			"sdd-status",
			"sdd-sync",
		],
	},
	{
		id: "judgment-day",
		name: "Judgment Day",
		description: "Blind dual review, judges, and fix",
		agents: ["jd-judge-a", "jd-judge-b", "jd-fix-agent"],
	},
	{
		id: "reviewers",
		name: "Reviewers and Auditors",
		description: "Quality, security, and architecture lenses",
		agents: [
			"security-auditor",
			"review-readability",
			"review-reliability",
			"review-resilience",
			"review-risk",
		],
	},
	{
		id: "general",
		name: "General Harness",
		description: "General subagents for exploration and coding tasks",
		agents: [
			"gentle-ai-explore",
			"gentle-ai-worker",
			"gentle-ai-verify",
			"ui-specialist",
			"task-tracker-manager",
		],
	},
];

export const ALL_KNOWN_AGENTS: string[] = SDD_AGENT_CATEGORIES.flatMap((c) => c.agents);

export const BUILTIN_PROFILES: Record<string, Profile> = {
	"gentle-default": {
		name: "gentle-default",
		description: "Quality/cost balance for Spec-Driven Development",
		default_model: "anthropic/claude-sonnet-5",
		default_effort: "medium",
		model_profiles: {
			"sdd-explore": { model: "openai/gpt-5-mini", effort: "low" },
			"sdd-verify": { model: "openai/gpt-5-mini", effort: "low" },
			"sdd-proposal": { model: "anthropic/claude-sonnet-5", effort: "high" },
			"sdd-spec": { model: "anthropic/claude-sonnet-5", effort: "high" },
			"sdd-design": { model: "anthropic/claude-sonnet-5", effort: "high" },
			"sdd-tasks": { model: "anthropic/claude-sonnet-5", effort: "high" },
			"sdd-apply": { model: "anthropic/claude-sonnet-5", effort: "medium" },
			"sdd-archive": { model: "openai/gpt-5-mini", effort: "low" },
			"jd-judge-a": { model: "anthropic/claude-sonnet-5", effort: "high" },
			"jd-judge-b": { model: "openai/gpt-5", effort: "high" },
			"jd-fix-agent": { model: "anthropic/claude-sonnet-5", effort: "high" },
			"gentle-ai-explore": { model: "openai/gpt-5-mini", effort: "low" },
			"gentle-ai-verify": { model: "openai/gpt-5-mini", effort: "low" },
			"gentle-ai-worker": { model: "anthropic/claude-sonnet-5", effort: "medium" },
		},
	},
	"gentle-economy": {
		name: "gentle-economy",
		description: "Speed and low cost for fast iterations and direct tasks",
		default_model: "openai/gpt-5-mini",
		default_effort: "low",
		model_profiles: {
			"sdd-explore": { model: "openai/gpt-5-mini", effort: "low" },
			"sdd-verify": { model: "openai/gpt-5-mini", effort: "low" },
			"sdd-proposal": { model: "anthropic/claude-sonnet-5", effort: "medium" },
			"sdd-spec": { model: "anthropic/claude-sonnet-5", effort: "medium" },
			"sdd-design": { model: "anthropic/claude-sonnet-5", effort: "medium" },
			"sdd-tasks": { model: "anthropic/claude-sonnet-5", effort: "medium" },
			"sdd-apply": { model: "anthropic/claude-sonnet-5", effort: "medium" },
			"sdd-archive": { model: "openai/gpt-5-mini", effort: "low" },
			"jd-judge-a": { model: "openai/gpt-5-mini", effort: "medium" },
			"jd-judge-b": { model: "openai/gpt-5-mini", effort: "medium" },
			"jd-fix-agent": { model: "anthropic/claude-sonnet-5", effort: "medium" },
		},
	},
	"gentle-reasoning": {
		name: "gentle-reasoning",
		description: "Maximum reasoning effort on critical design and review phases",
		default_model: "openai/gpt-5",
		default_effort: "high",
		model_profiles: {
			"sdd-explore": { model: "anthropic/claude-sonnet-5", effort: "medium" },
			"sdd-verify": { model: "anthropic/claude-sonnet-5", effort: "medium" },
			"sdd-proposal": { model: "openai/gpt-5", effort: "max" },
			"sdd-spec": { model: "openai/gpt-5", effort: "max" },
			"sdd-design": { model: "openai/gpt-5", effort: "max" },
			"sdd-tasks": { model: "openai/gpt-5", effort: "high" },
			"sdd-apply": { model: "anthropic/claude-sonnet-5", effort: "high" },
			"sdd-archive": { model: "openai/gpt-5-mini", effort: "low" },
			"jd-judge-a": { model: "openai/gpt-5", effort: "max" },
			"jd-judge-b": { model: "anthropic/claude-sonnet-5", effort: "high" },
			"jd-fix-agent": { model: "openai/gpt-5", effort: "max" },
		},
	},
};
