import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalJsonV1, domainHashV1, parseCanonicalJsonV1 } from "./review-canonical.ts";
import { type ReviewEventEnvelopeV1, validateReviewEventV1 } from "./review-graph-schema.ts";
import { resolveRepositoryAuthorityV1 } from "./review-repository.ts";

const DIGEST = /^[0-9a-f]{64}$/;

export class ReviewObjectStoreError extends Error {
	constructor(message: string) { super(message); this.name = "ReviewObjectStoreError"; }
}

export interface ReviewRootSetBodyV1 {
	schema: "gentle-ai.review-root-set/v1";
	repository_id: string;
	authority_id: string;
	store_epoch?: string;
	authority_incarnation_id?: string;
	initialized_by_reset_id?: string | null;
	generation: number;
	predecessor_root_set_id: string | null;
	lineages: unknown[];
}

export interface ReviewStoreDescriptorV1 {
	schema: "gentle-ai.review-store/v1";
	graph_format: "graph-v1";
	repository_id: string;
	authority_id: string;
	store_epoch: string;
	authority_incarnation_id: string;
	initialization_kind: "destructive-reset";
	initialized_by_reset_id: string;
	reset_authorization_hash: string;
}
export interface ReviewRootSetEnvelopeV1 { body: ReviewRootSetBodyV1; root_set_id: string; }
interface CurrentPointerV1 { schema: "gentle-ai.review-current/v1"; repository_id: string; authority_id: string; generation: number; root_set_id: string; slot_epoch: number; pointer_hash: string; }
export type ReviewObjectStoreFaultPoint = "before-object-fsync" | "before-object-install" | "before-current-slot-0-replace" | "before-current-slot-1-replace" | "before-current-slot-2-replace";
export interface ReviewGraphObjectStoreOptionsV1 { faultInjector?: (point: ReviewObjectStoreFaultPoint) => void; }

export class ReviewGraphObjectStoreV1 {
	readonly root: string;
	readonly #repositoryId: string;
	readonly #authorityId: string;
	readonly #faultInjector?: (point: ReviewObjectStoreFaultPoint) => void;

	static forRepository(cwd: string, options: ReviewGraphObjectStoreOptionsV1 = {}): ReviewGraphObjectStoreV1 {
		const authority = resolveRepositoryAuthorityV1(cwd);
		return new ReviewGraphObjectStoreV1(join(authority.store_root, "graph-v1"), authority.repository_id, authority.authority_id, options);
	}

	constructor(root: string, repositoryId: string, authorityId: string, options: ReviewGraphObjectStoreOptionsV1 = {}) {
		this.root = root;
		this.#repositoryId = repositoryId;
		this.#authorityId = authorityId;
		this.#faultInjector = options.faultInjector;
		for (const path of [join(root, "objects", "events", "sha256"), join(root, "roots", "sha256")]) mkdirSync(path, { recursive: true, mode: 0o700 });
	}

	installEvent(event: ReviewEventEnvelopeV1): void {
		validateReviewEventV1(event);
		this.installCanonicalEventBytes(event.event_id, new TextEncoder().encode(canonicalJsonV1(event)));
	}

	installCanonicalEventBytes(eventId: string, bytes: Uint8Array): void {
		if (!DIGEST.test(eventId)) throw new ReviewObjectStoreError("Event identity is invalid");
		let parsed: ReviewEventEnvelopeV1;
		try { parsed = parseCanonicalJsonV1(bytes) as ReviewEventEnvelopeV1; validateReviewEventV1(parsed); } catch (error) { throw new ReviewObjectStoreError(`Event object bytes are invalid: ${error instanceof Error ? error.message : String(error)}`); }
		if (parsed.event_id !== eventId) throw new ReviewObjectStoreError("Event object identity conflicts with its path");
		this.installImmutable(this.eventPath(eventId), bytes);
	}

	readEvent(eventId: string): ReviewEventEnvelopeV1 {
		try { const event = parseCanonicalJsonV1(readFileSync(this.eventPath(eventId))) as ReviewEventEnvelopeV1; validateReviewEventV1(event); if (event.event_id !== eventId) throw new Error("identity mismatch"); return event; } catch (error) { throw new ReviewObjectStoreError(`Event object is missing or invalid: ${error instanceof Error ? error.message : String(error)}`); }
	}

	installRootSet(body: ReviewRootSetBodyV1): ReviewRootSetEnvelopeV1 {
		if (body.schema !== "gentle-ai.review-root-set/v1" || body.repository_id !== this.#repositoryId || body.authority_id !== this.#authorityId || !Number.isSafeInteger(body.generation) || body.generation < 0 || !Array.isArray(body.lineages) || (body.generation === 0 ? body.predecessor_root_set_id !== null : !DIGEST.test(body.predecessor_root_set_id ?? ""))) throw new ReviewObjectStoreError("Root set is invalid");
		const canonicalBody = JSON.parse(canonicalJsonV1(body)) as ReviewRootSetBodyV1;
		const envelope = { body: canonicalBody, root_set_id: domainHashV1("root-set", canonicalBody) };
		this.installImmutable(this.rootPath(envelope.root_set_id), new TextEncoder().encode(canonicalJsonV1(envelope)));
		return envelope;
	}

	publishRootSet(root: ReviewRootSetEnvelopeV1): void {
		const installed = this.readRootSet(root.root_set_id);
		if (canonicalJsonV1(installed) !== canonicalJsonV1(root)) throw new ReviewObjectStoreError("Root set identity conflict");
		const current = this.tryReadCurrent();
		if (current) {
			if (root.body.generation !== current.body.generation + 1 || root.body.predecessor_root_set_id !== current.root_set_id) throw new ReviewObjectStoreError("Root set is not a descendant of the current authority");
		} else if (root.body.generation !== 0 || root.body.predecessor_root_set_id !== null) {
			throw new ReviewObjectStoreError("Initial root set must be generation zero");
		}
		this.writePointer(0, root, root.body.generation * 3);
		this.writePointer(1, root, root.body.generation * 3 + 1);
		this.writePointer(2, root, root.body.generation * 3 + 2);
		if (this.readCurrent().root_set_id !== root.root_set_id) throw new ReviewObjectStoreError("Root publication did not produce a quorum");
	}

	readCurrent(): ReviewRootSetEnvelopeV1 {
		const quorum = this.readQuorum();
		return this.readRootSet(quorum.root_set_id);
	}

	readStoreDescriptor(): ReviewStoreDescriptorV1 {
		try {
			const value = parseCanonicalJsonV1(readFileSync(join(this.root, "STORE"))) as ReviewStoreDescriptorV1;
			if (value.schema !== "gentle-ai.review-store/v1" || value.graph_format !== "graph-v1" || value.repository_id !== this.#repositoryId || value.authority_id !== this.#authorityId || !DIGEST.test(value.store_epoch) || !DIGEST.test(value.authority_incarnation_id) || !DIGEST.test(value.reset_authorization_hash) || !DIGEST.test(value.initialized_by_reset_id)) throw new Error("invalid descriptor");
			return value;
		} catch (error) { throw new ReviewObjectStoreError(`Store descriptor is missing or invalid: ${error instanceof Error ? error.message : String(error)}`); }
	}

	initializeDestructiveReset(options: { store_epoch: string; authority_incarnation_id: string; reset_id: string; reset_authorization_hash: string }): ReviewStoreDescriptorV1 {
		if (![options.store_epoch, options.authority_incarnation_id, options.reset_id, options.reset_authorization_hash].every((value) => DIGEST.test(value))) throw new ReviewObjectStoreError("Reset descriptor identities are invalid");
		const descriptor: ReviewStoreDescriptorV1 = { schema: "gentle-ai.review-store/v1", graph_format: "graph-v1", repository_id: this.#repositoryId, authority_id: this.#authorityId, store_epoch: options.store_epoch, authority_incarnation_id: options.authority_incarnation_id, initialization_kind: "destructive-reset", initialized_by_reset_id: options.reset_id, reset_authorization_hash: options.reset_authorization_hash };
		const path = join(this.root, "STORE");
		if (existsSync(path)) { if (canonicalJsonV1(parseCanonicalJsonV1(readFileSync(path))) !== canonicalJsonV1(descriptor)) throw new ReviewObjectStoreError("Store descriptor already exists with a different authority incarnation"); }
		else { writeFileSync(path, canonicalJsonV1(descriptor), { flag: "wx", mode: 0o600 }); this.fsyncFile(path); this.fsyncDirectory(this.root); }
		const root = this.installRootSet({ schema: "gentle-ai.review-root-set/v1", repository_id: this.#repositoryId, authority_id: this.#authorityId, store_epoch: options.store_epoch, authority_incarnation_id: options.authority_incarnation_id, initialized_by_reset_id: options.reset_id, generation: 0, predecessor_root_set_id: null, lineages: [] });
		this.publishRootSet(root);
		return descriptor;
	}

	private tryReadCurrent(): ReviewRootSetEnvelopeV1 | undefined { try { return this.readCurrent(); } catch { return undefined; } }
	private readQuorum(): CurrentPointerV1 {
		const pointers = [0, 1, 2].flatMap((slot) => { try { return [this.readPointer(slot)]; } catch { return []; } });
		const quorum = pointers.find((pointer) => pointers.filter((candidate) => candidate.root_set_id === pointer.root_set_id && candidate.generation === pointer.generation).length >= 2);
		if (!quorum) throw new ReviewObjectStoreError("CURRENT pointer has no valid quorum");
		return quorum;
	}
	private eventPath(id: string): string { return join(this.root, "objects", "events", "sha256", id.slice(0, 2), id.slice(2)); }
	private rootPath(id: string): string { return join(this.root, "roots", "sha256", id.slice(0, 2), id.slice(2)); }
	private installImmutable(path: string, bytes: Uint8Array): void {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		if (existsSync(path)) { if (!Buffer.from(readFileSync(path)).equals(Buffer.from(bytes))) throw new ReviewObjectStoreError("Immutable object conflicts with existing bytes"); return; }
		const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
		try {
			writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" });
			this.#faultInjector?.("before-object-fsync");
			this.fsyncFile(temporary);
			this.#faultInjector?.("before-object-install");
			linkSync(temporary, path);
			this.fsyncDirectory(dirname(path));
		} catch (error) {
			if (existsSync(path) && Buffer.from(readFileSync(path)).equals(Buffer.from(bytes))) return;
			throw new ReviewObjectStoreError(`Immutable object installation failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally { try { unlinkSync(temporary); } catch {} }
	}
	private readRootSet(id: string): ReviewRootSetEnvelopeV1 {
		try { const value = parseCanonicalJsonV1(readFileSync(this.rootPath(id))) as ReviewRootSetEnvelopeV1; if (value.root_set_id !== id || domainHashV1("root-set", value.body) !== id) throw new Error("identity mismatch"); return value; } catch (error) { throw new ReviewObjectStoreError(`Root set is missing or invalid: ${error instanceof Error ? error.message : String(error)}`); }
	}
	private writePointer(slot: number, root: ReviewRootSetEnvelopeV1, epoch: number): void {
		const body = { schema: "gentle-ai.review-current/v1" as const, repository_id: this.#repositoryId, authority_id: this.#authorityId, generation: root.body.generation, root_set_id: root.root_set_id, slot_epoch: epoch };
		const pointer: CurrentPointerV1 = { ...body, pointer_hash: domainHashV1("current", body) };
		const path = join(this.root, `CURRENT.${slot}`); const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
		writeFileSync(temporary, canonicalJsonV1(pointer), { mode: 0o600, flag: "wx" });
		this.fsyncFile(temporary);
		this.#faultInjector?.(`before-current-slot-${slot}-replace` as ReviewObjectStoreFaultPoint);
		renameSync(temporary, path);
		this.fsyncDirectory(this.root);
	}
	private readPointer(slot: number): CurrentPointerV1 { const pointer = parseCanonicalJsonV1(readFileSync(join(this.root, `CURRENT.${slot}`))) as CurrentPointerV1; const { pointer_hash, ...body } = pointer; if (pointer.schema !== "gentle-ai.review-current/v1" || pointer.repository_id !== this.#repositoryId || pointer.authority_id !== this.#authorityId || !DIGEST.test(pointer.root_set_id) || pointer.pointer_hash !== domainHashV1("current", body)) throw new ReviewObjectStoreError("CURRENT pointer is invalid"); return pointer; }
	private fsyncFile(path: string): void { const descriptor = openSync(path, "r+"); try { fsyncSync(descriptor); } finally { closeSync(descriptor); } }
	private fsyncDirectory(path: string): void { if (!statSync(path).isDirectory()) throw new ReviewObjectStoreError("Expected a directory"); if (process.platform === "win32") return; const descriptor = openSync(path, "r"); try { fsyncSync(descriptor); } finally { closeSync(descriptor); } }
}
