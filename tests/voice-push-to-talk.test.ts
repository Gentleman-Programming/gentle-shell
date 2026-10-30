import assert from "node:assert/strict";
import test from "node:test";
import { Editor, isKeyRelease } from "@earendil-works/pi-tui";
import { PUSH_TO_TALK_DEFAULTS, SpaceHoldDetector, type PushToTalkTimers } from "../lib/voice-push-to-talk.ts";

// Hold-Space detection on raw terminal input. Chunks go through the detector
// and then, as Pi's TUI does, to an editor: a real pi-tui Editor where the
// exact typing path matters, fake editors for Vim NORMAL mode and autocomplete.
// Timers are a manual clock; nothing here records audio.

const BACKSPACE = "\x7f";

// Deferred callbacks stand for setImmediate: they run after the input that is
// already queued. With `holdDeferred` a test types that input first.
function manualClock() {
	let now = 0;
	let nextId = 1;
	let holdDeferred = false;
	const pending = new Map<number, { at: number; callback: () => void }>();
	const deferred: Array<() => void> = [];
	const flush = () => {
		while (deferred.length > 0) deferred.shift()!();
	};
	const timers: PushToTalkTimers = {
		setTimeout: (callback, ms) => {
			const id = nextId++;
			pending.set(id, { at: now + ms, callback });
			return id;
		},
		clearTimeout: (handle) => { pending.delete(handle as number); },
		now: () => now,
		defer: (callback) => { deferred.push(callback); },
	};
	const advance = (ms: number) => {
		const target = now + ms;
		for (;;) {
			let due: [number, { at: number; callback: () => void }] | undefined;
			for (const entry of pending) if (entry[1].at <= target && (!due || entry[1].at < due[1].at)) due = entry;
			if (!due) break;
			pending.delete(due[0]);
			now = due[1].at;
			due[1].callback();
			if (!holdDeferred) flush();
		}
		now = target;
	};
	return {
		timers,
		advance,
		flush,
		deferred: () => deferred.length,
		holdDeferred: (value: boolean) => { holdDeferred = value; },
		pending: () => pending.size,
	};
}

interface Draft {
	text(): string;
	input(data: string): void;
}

function realEditor(text = ""): Draft {
	const editor = new Editor({ terminal: { rows: 24 }, requestRender() {} } as never, { borderColor: (s: string) => s } as never);
	editor.setText(text);
	return { text: () => editor.getText(), input: (data) => editor.handleInput(data) };
}

function setup(draft: Draft, onHold: () => boolean = () => true) {
	const clock = manualClock();
	const calls = { holds: 0, releases: 0 };
	const results: Array<ReturnType<SpaceHoldDetector["handleInput"]>> = [];
	const detector = new SpaceHoldDetector(
		{
			readDraft: () => draft.text(),
			onHold: () => { calls.holds++; return onHold(); },
			onRelease: () => { calls.releases++; },
		},
		{ timers: clock.timers },
	);
	// Mirrors TUI.handleTerminalInput: consume stops the chunk, data replaces
	// it, and key releases never reach the editor.
	const type = (data: string) => {
		const result = detector.handleInput(data);
		results.push(result);
		if (result?.consume) return;
		const forwarded = result?.data ?? data;
		if (!isKeyRelease(forwarded)) draft.input(forwarded);
	};
	// One press of Space held down: the first space, then OS auto-repeats.
	const hold = (repeats: number, delay = 400, interval = 40) => {
		type(" ");
		for (let index = 0; index < repeats; index++) {
			clock.advance(index === 0 ? delay : interval);
			type(" ");
		}
	};
	// Spaces typed at the given gaps after a first one.
	const spaces = (gaps: number[]) => {
		type(" ");
		for (const gap of gaps) {
			clock.advance(gap);
			type(" ");
		}
	};
	return { clock, calls, results, detector, type, hold, spaces };
}

test("defaults describe OS auto-repeat cadence", () => {
	assert.deepEqual({ ...PUSH_TO_TALK_DEFAULTS }, {
		firstRepeatWindowMs: 1000,
		minFirstGapMs: 180,
		maxRepeatGapMs: 250,
		maxRepeatSpread: 1.6,
		minDelayRatio: 1.5,
		holdRepeats: 3,
		releaseGapFactor: 2.5,
		minReleaseGapMs: 150,
		maxReleaseGapMs: 400,
	});
});

test("a tap types exactly one space through the editor's own path and never starts a hold", () => {
	const draft = realEditor("hello");
	const s = setup(draft);
	s.type(" ");
	assert.equal(draft.text(), "hello ", "the space is in the draft immediately");
	s.clock.advance(1_000);
	assert.equal(draft.text(), "hello ");
	assert.deepEqual(s.results, [undefined], "the chunk was passed through untouched");
	assert.equal(s.calls.holds, 0);
	assert.equal(s.clock.pending(), 0, "no timer left behind");
});

test("rollover keeps order: a space followed quickly by a letter yields ' a'", () => {
	const draft = realEditor("x");
	const s = setup(draft);
	s.type(" ");
	s.type("a");
	assert.equal(draft.text(), "x a");
	assert.deepEqual(s.results, [undefined, undefined]);
	assert.equal(s.calls.holds, 0);
});

test("pastes, escape sequences and multi-character chunks pass untouched and break a run", () => {
	const draft = realEditor("");
	const s = setup(draft);
	for (const chunk of ["\x1b[200~ \x1b[201~", "\x1b", "\x1b[A", "  ", "ab", " \r"]) {
		s.type(" ");
		s.clock.advance(40);
		s.type(chunk);
		s.clock.advance(40);
		s.type(" ");
		s.clock.advance(40);
	}
	assert.ok(s.results.every((result) => result === undefined), "nothing consumed or rewritten");
	assert.equal(s.calls.holds, 0);
});

test("a deliberate fast double space is not a hold", () => {
	const draft = realEditor("end.");
	const s = setup(draft);
	s.type(" ");
	s.clock.advance(120);
	s.type(" ");
	s.clock.advance(1_000);
	s.type("N");
	assert.equal(draft.text(), "end.  N");
	assert.equal(s.calls.holds, 0);
});

test("a hold is confirmed after the initial delay and three regular repeats, erases its spaces, then consumes repeats", () => {
	const draft = realEditor("");
	const s = setup(draft);
	s.hold(3);
	assert.equal(s.calls.holds, 0, "two short repeats are not enough");
	s.clock.advance(40);
	s.type(" ");
	assert.equal(s.calls.holds, 1);
	assert.ok(s.detector.holding);
	assert.deepEqual(s.results, [undefined, undefined, undefined, undefined, { data: BACKSPACE }], "the confirming repeat becomes a Backspace");
	for (let index = 0; index < 3; index++) {
		s.clock.advance(40);
		s.type(" ");
		assert.deepEqual(s.results.at(-1), { data: BACKSPACE });
	}
	assert.equal(draft.text(), "", "all four spaces typed by the hold are gone");
	s.clock.advance(40);
	s.type(" ");
	assert.deepEqual(s.results.at(-1), { consume: true });
	assert.equal(s.calls.releases, 0);
	s.clock.advance(PUSH_TO_TALK_DEFAULTS.minReleaseGapMs + 1);
	assert.equal(s.calls.releases, 1, "no repeat for the release gap means Space was released");
	assert.ok(!s.detector.holding);
	assert.equal(s.clock.pending(), 0);
});

test("erasing never removes spaces that were in the draft before the hold", () => {
	const draft = realEditor("hi   ");
	const s = setup(draft);
	s.hold(8);
	s.clock.advance(PUSH_TO_TALK_DEFAULTS.maxReleaseGapMs + 1);
	assert.equal(draft.text(), "hi   ");
	assert.equal(s.results.filter((result) => result?.data === BACKSPACE).length, 4);
});

test("a first repeat later than the first-repeat window does not count as a hold", () => {
	const draft = realEditor("");
	const s = setup(draft);
	s.hold(4, PUSH_TO_TALK_DEFAULTS.firstRepeatWindowMs + 1);
	assert.equal(s.calls.holds, 0);
	assert.ok(s.results.every((result) => result === undefined));
});

// --- cadence: deliberate typing never looks like auto-repeat (B1) -------------

test("three spaces typed at 120 ms then a letter stay exactly as typed and start nothing", () => {
	const draft = realEditor("x");
	const s = setup(draft);
	s.spaces([120, 120]);
	s.clock.advance(120);
	s.type("y");
	assert.equal(draft.text(), "x   y");
	assert.equal(s.calls.holds, 0);
	assert.ok(s.results.every((result) => result === undefined));
});

test("a four-space indent typed at 90 ms keeps all four spaces and starts nothing", () => {
	const draft = realEditor("if (x) {\n");
	const s = setup(draft);
	s.spaces([90, 90, 90]);
	s.clock.advance(90);
	s.type("r");
	assert.equal(draft.text(), "if (x) {\n    r");
	assert.equal(s.calls.holds, 0);
	assert.ok(s.results.every((result) => result === undefined));
});

test("two to four spaces at any human pace from 90 to 250 ms are typed unchanged", () => {
	for (const count of [2, 3, 4]) {
		for (const gap of [90, 120, 180, 200, 250]) {
			const draft = realEditor("a");
			const s = setup(draft);
			s.spaces(Array.from({ length: count - 1 }, () => gap));
			s.clock.advance(gap);
			s.type("b");
			assert.equal(draft.text(), `a${" ".repeat(count)}b`, `${count} spaces at ${gap} ms`);
			assert.equal(s.calls.holds, 0, `${count} spaces at ${gap} ms`);
		}
	}
});

test("words separated by single spaces and long evenly paced space runs are not holds", () => {
	const draft = realEditor("");
	const s = setup(draft);
	for (const chunk of ["a", " ", "b", " ", "c"]) {
		s.type(chunk);
		s.clock.advance(150);
	}
	assert.equal(draft.text(), "a b c");
	// Even pacing has no long initial delay before the repeats.
	s.spaces([200, 200, 200, 200, 200]);
	assert.equal(s.calls.holds, 0);
});

test("an irregular run is not confirmed until three regular repeats follow", () => {
	const draft = realEditor("");
	const s = setup(draft);
	s.spaces([400, 40, 200, 40]);
	assert.equal(s.calls.holds, 0, "a 200 ms gap among 40 ms repeats is not auto-repeat");
	s.clock.advance(40);
	s.type(" ");
	s.clock.advance(40);
	s.type(" ");
	assert.equal(s.calls.holds, 1, "40, 40, 40 is regular");
});

test("real-shaped auto-repeat confirms: macOS-like 400 ms delay with 33 ms or 90 ms repeats, X11-like 660 ms delay", () => {
	for (const [delay, interval] of [[400, 33], [400, 90], [660, 40], [225, 30]]) {
		const draft = realEditor("");
		const s = setup(draft);
		s.hold(3, delay, interval);
		assert.equal(s.calls.holds, 0, `${delay}/${interval}: not yet`);
		s.clock.advance(interval);
		s.type(" ");
		assert.equal(s.calls.holds, 1, `${delay}/${interval}`);
		assert.ok(s.detector.holding, `${delay}/${interval}`);
	}
});

test("the release gap adapts to the observed repeat interval within 150 to 400 ms", () => {
	for (const [interval, gap] of [[33, 150], [90, 225], [160, 400]]) {
		const draft = realEditor("");
		const s = setup(draft);
		s.hold(4, 400, interval);
		assert.ok(s.detector.holding, `${interval}`);
		s.clock.advance(gap - 1);
		assert.equal(s.calls.releases, 0, `${interval}: not before ${gap} ms`);
		s.clock.advance(2);
		assert.equal(s.calls.releases, 1, `${interval}: released after ${gap} ms`);
	}
});

test("a repeat queued while the release timer fires wins over the release (A2)", () => {
	const draft = realEditor("");
	const s = setup(draft);
	s.hold(4);
	s.clock.holdDeferred(true);
	s.clock.advance(PUSH_TO_TALK_DEFAULTS.minReleaseGapMs + 1);
	assert.equal(s.clock.deferred(), 1, "the release decision waits for queued input");
	assert.equal(s.calls.releases, 0);
	// Input that was queued during an event-loop block arrives first.
	s.type(" ");
	s.clock.flush();
	assert.equal(s.calls.releases, 0, "a repeat arrived, so Space is still held");
	assert.ok(s.detector.holding);
	s.clock.advance(PUSH_TO_TALK_DEFAULTS.minReleaseGapMs + 1);
	s.clock.flush();
	assert.equal(s.calls.releases, 1);
});

test("a hold right after a word keeps one space as the separator (A5)", () => {
	const draft = realEditor("hi");
	const s = setup(draft);
	s.hold(8);
	assert.equal(s.results.filter((result) => result?.data === BACKSPACE).length, 3, "four spaces typed, three erased");
	assert.equal(draft.text(), "hi ");
	s.clock.advance(PUSH_TO_TALK_DEFAULTS.maxReleaseGapMs + 1);
	draft.input("\x1b[200~there\x1b[201~");
	assert.equal(draft.text(), "hi there");
	for (const start of ["", "hi ", "line\n"]) {
		const other = realEditor(start);
		const t = setup(other);
		t.hold(8);
		assert.equal(other.text(), start, `after ${JSON.stringify(start)} every hold space is erased`);
	}
});

test("a refused hold keeps typing spaces, and a later start erases every space the hold added", () => {
	const draft = realEditor("ok");
	let allow = false;
	const s = setup(draft, () => allow);
	s.hold(5);
	assert.equal(draft.text(), "ok      ", "refused: six spaces typed normally");
	assert.equal(s.calls.holds, 2);
	allow = true;
	for (let index = 0; index < 6; index++) {
		s.clock.advance(40);
		s.type(" ");
	}
	// Six spaces landed before the start; one stays as the separator after "ok".
	assert.equal(draft.text(), "ok ");
	assert.equal(s.results.filter((result) => result?.data === BACKSPACE).length, 5);
	assert.deepEqual(s.results.at(-1), { consume: true });
});

test("Vim NORMAL mode: Space moves the cursor without growing the draft, so no hold and no rewrite", () => {
	// A NORMAL-mode editor treats Space and Backspace as motions: the text never changes.
	let cursor = 0;
	const text = "normal mode text";
	const draft: Draft = {
		text: () => text,
		input: (data) => {
			if (data === " ") cursor = Math.min(text.length, cursor + 1);
			else if (data === BACKSPACE) cursor = Math.max(0, cursor - 1);
		},
	};
	const s = setup(draft);
	s.hold(8);
	assert.equal(s.calls.holds, 0);
	assert.ok(s.results.every((result) => result === undefined), "every Space reached the editor unchanged");
	assert.equal(cursor, 9);
});

test("a draft change other than the hold's spaces aborts the run without erasing", () => {
	let text = "@fo";
	const draft: Draft = {
		text: () => text,
		input: (data) => {
			// Autocomplete accepts on the first repeat and rewrites the draft.
			if (data === " ") text = text === "@fo " ? "@foo.ts " : `${text} `;
			else if (data === BACKSPACE) text = text.slice(0, -1);
		},
	};
	const s = setup(draft);
	s.hold(4);
	assert.equal(s.calls.holds, 0);
	assert.ok(!s.results.some((result) => result?.data === BACKSPACE));
});

test("a draft change during erasing stops the erase and keeps the rest of the draft", () => {
	const draft = realEditor("abc ");
	const s = setup(draft);
	s.hold(4);
	assert.equal(draft.text(), "abc    ");
	draft.input("Z");
	s.clock.advance(40);
	s.type(" ");
	assert.deepEqual(s.results.at(-1), { consume: true }, "no Backspace once the draft moved on");
	assert.equal(draft.text(), "abc    Z");
});

test("other input during a hold passes through and stops erasing", () => {
	const draft = realEditor("");
	const s = setup(draft);
	s.hold(4);
	s.type("x");
	assert.equal(s.results.at(-1), undefined);
	s.clock.advance(40);
	s.type(" ");
	assert.deepEqual(s.results.at(-1), { consume: true });
	assert.equal(draft.text(), "   x");
});

test("key release reports are ignored and do not break a run", () => {
	const draft = realEditor("");
	const s = setup(draft);
	s.type(" ");
	s.clock.advance(400);
	s.type("\x1b[13;1:3u");
	s.type(" ");
	for (let index = 0; index < 3; index++) {
		s.clock.advance(40);
		s.type(" ");
	}
	assert.equal(s.calls.holds, 1);
});

test("end() leaves a hold without a release, and dispose() clears timers and stops listening", () => {
	const draft = realEditor("");
	const s = setup(draft);
	s.hold(5);
	s.detector.end();
	assert.ok(!s.detector.holding);
	s.clock.advance(1_000);
	assert.equal(s.calls.releases, 0);
	s.type(" ");
	s.detector.dispose();
	assert.equal(s.clock.pending(), 0);
	s.clock.advance(40);
	assert.equal(s.detector.handleInput(" "), undefined);
	s.clock.advance(40);
	assert.equal(s.detector.handleInput(" "), undefined);
	assert.equal(s.calls.holds, 1);
});
