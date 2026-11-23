export const REQUIRE_NATIVE_BINARY_ENV = "DRAKONC_PI_REQUIRE_NATIVE_BINARY";

export class NativeBinaryUnavailableError extends Error {
	constructor(reason: string) {
		super(reason);
		this.name = "NativeBinaryUnavailableError";
	}
}

interface RequireNativeBinaryInput {
	resolvedBinary: string | undefined;
	digestsPinned: boolean;
	env: Record<string, string | undefined>;
}

interface NativeBinaryRun {
	run: true;
}

interface NativeBinarySkip {
	run: false;
	reason: string;
}

type NativeBinaryGateResult = NativeBinaryRun | NativeBinarySkip;

// Two suites decide for themselves whether to run by skipping silently when
// the pinned native binary is unavailable. That is exactly how an earlier
// protocol-minor gap stayed hidden: the suite reported 0 fail while every
// test in it had skipped. This gate keeps the local convenience -- a
// developer without the binary still gets a printed skip reason -- but under
// `DRAKONC_PI_REQUIRE_NATIVE_BINARY=1` (set in CI) the same condition throws
// instead, so CI cannot silently report green with zero real coverage.
export function requireNativeBinary(input: RequireNativeBinaryInput): NativeBinaryGateResult {
	const armed = input.env[REQUIRE_NATIVE_BINARY_ENV] === "1";

	if (input.resolvedBinary === undefined) {
		const reason = `Native drakonc-ai binary is unresolved; set ${REQUIRE_NATIVE_BINARY_ENV}=1 to fail instead of skip.`;
		if (armed) throw new NativeBinaryUnavailableError(reason);
		return { run: false, reason };
	}

	if (!input.digestsPinned) {
		const reason = "Native drakonc-ai release digest is not pinned; skipping the binary-verified suite.";
		if (armed) throw new NativeBinaryUnavailableError(reason);
		return { run: false, reason };
	}

	return { run: true };
}

export const REQUIRE_DEV_BINARY_ENV = "DRAKONC_PI_REQUIRE_DEV_BINARY";

interface RequireDevBinaryInput {
	devBinaryPath: string | undefined;
	exists: boolean;
	env: Record<string, string | undefined>;
}

// A THIRD suite decided for itself whether to run, the same silent-skip
// pattern the other two had (Phase 4): `tests/devbinary/native-review-parity.devtest.ts`
// skipped every test whenever DRAKONC_AI_DEV_BINARY was unset, with no loud
// path back to a real failure. That silence is exactly how the v2.2.2
// terminology rot (Phase 13.12) went unnoticed: `pnpm run test:dev-binary`
// reported 5 tests / 0 pass / 0 fail for a long stretch. Gated on its OWN env
// var, distinct from DRAKONC_PI_REQUIRE_NATIVE_BINARY: ordinary CI has no dev
// binary and must keep skipping by default; only an environment that
// specifically provisions one (a maintainer's local pre-release run, or a
// dedicated CI job) opts in to failing loudly instead.
export function requireDevBinary(input: RequireDevBinaryInput): NativeBinaryGateResult {
	const armed = input.env[REQUIRE_DEV_BINARY_ENV] === "1";

	if (input.devBinaryPath === undefined || input.devBinaryPath.length === 0) {
		const reason = `DRAKONC_AI_DEV_BINARY is unset; set it to an existing absolute drakonc-ai binary path to run this journey, or set ${REQUIRE_DEV_BINARY_ENV}=1 to fail instead of skip.`;
		if (armed) throw new NativeBinaryUnavailableError(reason);
		return { run: false, reason };
	}

	if (!input.exists) {
		const reason = `DRAKONC_AI_DEV_BINARY names "${input.devBinaryPath}", which is not an existing absolute path; set ${REQUIRE_DEV_BINARY_ENV}=1 to fail instead of skip.`;
		if (armed) throw new NativeBinaryUnavailableError(reason);
		return { run: false, reason };
	}

	return { run: true };
}
