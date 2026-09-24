/** A caller-supplied canonical identity for one file in one worktree. */
export interface BaselineKey {
	readonly repositoryIdentity: string;
	readonly worktreeRoot: string;
	readonly relativePath: string;
}

/**
 * A version is opaque: it may include any state a later caller compares, such
 * as content or mode, but this module never captures or interprets file data.
 */
export type FileState =
	| { readonly kind: "absent" }
	| { readonly kind: "available"; readonly version: string }
	| { readonly kind: "unavailable"; readonly reason: string };

export type BaselineComparison = "same" | "different" | "unavailable";

export interface BaselineRecord {
	readonly key: BaselineKey;
	readonly state: FileState;
}

/**
 * Holds first baselines for one caller-owned scope. It does not share state
 * between instances, access files, normalize paths, or consult Git.
 */
export class SessionFileBaseline {
	readonly #records = new Map<string, BaselineRecord>();

	recordFirst(key: BaselineKey, state: FileState): BaselineRecord {
		const encodedKey = encodeKey(key);
		let record = this.#records.get(encodedKey);

		if (record === undefined) {
			record = createFrozenRecord(key, state);
			this.#records.set(encodedKey, record);
		}

		return snapshotRecord(record);
	}

	compare(key: BaselineKey, current: FileState): BaselineComparison {
		const baseline = this.#records.get(encodeKey(key));
		if (baseline === undefined || baseline.state.kind === "unavailable" || current.kind === "unavailable") {
			return "unavailable";
		}

		if (baseline.state.kind === "absent" || current.kind === "absent") {
			return baseline.state.kind === current.kind ? "same" : "different";
		}

		return baseline.state.version === current.version ? "same" : "different";
	}
}

function encodeKey(key: BaselineKey): string {
	return JSON.stringify([key.repositoryIdentity, key.worktreeRoot, key.relativePath]);
}

function snapshotRecord(record: BaselineRecord): BaselineRecord {
	return createFrozenRecord(record.key, record.state);
}

function createFrozenRecord(key: BaselineKey, state: FileState): BaselineRecord {
	return Object.freeze({
		key: Object.freeze({
			repositoryIdentity: key.repositoryIdentity,
			worktreeRoot: key.worktreeRoot,
			relativePath: key.relativePath,
		}),
		state: freezeState(state),
	});
}

function freezeState(state: FileState): FileState {
	switch (state.kind) {
		case "absent":
			return Object.freeze({ kind: "absent" });
		case "available":
			return Object.freeze({ kind: "available", version: state.version });
		case "unavailable":
			return Object.freeze({ kind: "unavailable", reason: state.reason });
	}
}
