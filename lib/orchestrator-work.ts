export interface WorkRef {
	kind: "issue" | "pr" | "task";
	repository: string;
	id: string;
}
export interface WorkDescriptor {
	area?: string;
	topic?: string;
	tags?: string[];
	refs?: WorkRef[];
}
export interface PublishedWork extends WorkDescriptor {
	tasks?: Record<string, WorkDescriptor>;
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max: number): v is string => typeof v === "string" && !!v.trim()
	&& !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(v) && Buffer.byteLength(v) <= max;
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k));
// Explicit public host/owner/repo spelling only: no URLs, credentials, ports or inferred identity.
const repository = (v: unknown): v is string => text(v, 256)
	&& /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}\/[a-z0-9_-][a-z0-9_.-]*\/[a-z0-9_-][a-z0-9_.-]*$/i.test(v)
	&& v.split("/")[0].split(".").every(label => label.length <= 63);

/** Pure, detached validation. References are descriptive identifiers, never routing targets. */
function descriptor(value: unknown, allowEmpty = false): WorkDescriptor {
	const invalid = () => { throw new Error("invalid-published-state"); };
	if (!object(value) || !keys(value, ["area", "topic", "tags", "refs"])) return invalid();
	const result: WorkDescriptor = {};
	for (const key of ["area", "topic"] as const) {
		if (Object.hasOwn(value, key)) {
			if (!text(value[key], 64)) return invalid();
			result[key] = value[key];
		}
	}
	if (result.topic && !result.area) return invalid();
	if (Object.hasOwn(value, "tags")) {
		if (!Array.isArray(value.tags) || value.tags.length > 8 || !Array.from(value.tags).every(tag => text(tag, 64))
			|| new Set(value.tags).size !== value.tags.length) return invalid();
		result.tags = [...value.tags];
	}
	if (Object.hasOwn(value, "refs")) {
		if (!Array.isArray(value.refs) || value.refs.length > 8) return invalid();
		result.refs = [];
		const seen = new Set<string>();
		for (const ref of value.refs) {
			if (!object(ref) || Object.keys(ref).length !== 3 || !keys(ref, ["kind", "repository", "id"])
				|| !["issue", "pr", "task"].includes(ref.kind as string) || !repository(ref.repository)
				|| !text(ref.id, 256) || (ref.kind !== "task" && !/^[1-9][0-9]*$/.test(ref.id))) return invalid();
			const key = JSON.stringify([ref.kind, ref.repository, ref.id]);
			if (seen.has(key)) return invalid();
			seen.add(key);
			result.refs.push({ kind: ref.kind as WorkRef["kind"], repository: ref.repository, id: ref.id });
		}
	}
	if (!allowEmpty && !result.area && !result.tags?.length && !result.refs?.length) return invalid();
	return result;
}

export function decodeWorkDescriptor(value: unknown): WorkDescriptor {
	return descriptor(value);
}

/** Only the curated root accepts exact owner-declared task IDs. */
export function decodeWork(value: unknown): PublishedWork {
	if (!object(value) || !keys(value, ["area", "topic", "tags", "refs", "tasks"])) throw new Error("invalid-published-state");
	const { tasks, ...fields } = value;
	const result: PublishedWork = descriptor(fields, true);
	if (Object.hasOwn(value, "tasks")) {
		if (!object(tasks) || Object.keys(tasks).length > 8) throw new Error("invalid-published-state");
		result.tasks = {};
		for (const id of Object.keys(tasks)) {
			if (!text(id, 256) || ["__proto__", "prototype", "constructor"].includes(id)) throw new Error("invalid-published-state");
			result.tasks[id] = decodeWorkDescriptor(tasks[id]);
		}
	}
	if (!result.area && !result.tags?.length && !result.refs?.length && !Object.keys(result.tasks ?? {}).length)
		throw new Error("invalid-published-state");
	return result;
}
