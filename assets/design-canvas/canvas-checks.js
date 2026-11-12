// Accessibility checks and the panel's two tabs, Comments and Quality, each with its count.
// Each design artboard's own frame checks its page when the canvas asks (gd:run-checks, sent when
// that frame loads; never to an All sizes frame or the system board) and again after each resize
// (inspector.js gd:checks). Quality lists the findings of each design artboard as the artboard
// reported them, with Show (zoom in under 100%, center the element, a ring on the canvas) and Ask
// the agent to fix (the comment box on that element, prefilled). The checks describe the artboard at
// the size it is shown, and they are heuristics, not a full audit: they miss keyboard, focus-order,
// motion and screen-reader problems, and each list is capped (20 problems and 10 advice items per
// check, with the full count reported; docs/gentle-shell.md).
// board.checks is changed in place only by setChecks here; the tab lives in the store (setTab); the
// ring is this module's own view state, which other modules end through clearMark.

const TEXT = Object.freeze({
	names: { contrast: "Text contrast", target: "Target size", alt: "Images have alt text", label: "Form fields have labels", heading: "Headings in order" },
	boardName: (number, title) => `${String(number).padStart(2, "0")} ${title}`,
	groupLabel: (name) => `Accessibility checks of ${name}`,
	notChecked: "Not checked yet",
	accessible: "Accessible ✓",
	failing: (count) => `${count} ${count === 1 ? "check" : "checks"}`,
	passed: (names) => `Passed: ${names.join(" · ")}`,
	noBoards: "No design artboards to check.",
	kinds: { fail: "Problem", advice: "Advice" },
	hidden: "Out of sight (hidden or off-screen), so Show centers its artboard without a ring.",
	show: "Show",
	showLabel: (title, label, name) => `Show ${title} on ${label} in ${name}`,
	fix: "Ask the agent to fix",
	fixLabel: (title, label) => `Ask the agent to fix ${title} on ${label}`,
	// What Ask the agent to fix prefills: instructions for the session.
	session: {
		fail: (issue) => `Accessibility check on ${issue.selector}: ${issue.title}.\n${issue.detail}\nFix it so it meets WCAG 2.2 AA, keeping the design's tokens.`,
		advice: (issue) => `Accessibility advice on ${issue.selector}: ${issue.title}.\n${issue.detail}\nConsider fixing it, keeping the design's tokens.`,
	},
});

const TABS = ["comments", "quality"];
const CHECK_IDS = ["contrast", "target", "alt", "label", "heading"];
const SEVERITIES = ["fail", "advice"];
const LIMITS = { checks: 10, issues: 200, title: 80, detail: 400, selector: 500, label: 80, comment: 2000 };
// Under SHOW_ZOOM, Show zooms in to it, or less when the element would not fit in SHOW_ROOM of the view at that zoom.
const SHOW_ZOOM = 1;
const SHOW_ROOM = 0.8;
// A press that moves no further than this is a click (canvas-view.js uses the same).
const CLICK_SLOP = 4;

export function init(ctx) {
	const { doc, els, store, api, actions } = ctx;
	const { state } = store;
	const { isFiniteNumber } = api;
	// The ring of Show: { board, issue, ring, label, card } or null; the press that may be a still click on the canvas.
	let mark = null;
	let press = null;
	let hiddenNotes = 0;

	const tabButtons = () => [els.tabComments, els.tabQuality];
	// The artboards of the design shown; a design switch empties it at once, before the new boards are built.
	const designBoards = () => state.boards.filter((board) => board.slug === state.slug);
	const failures = (board) => (board.checks ? board.checks.checks.reduce((sum, check) => sum + check.count, 0) : 0);
	const isCurrent = (board, issue) => designBoards().includes(board) && Boolean(board.checks) && board.checks.issues.includes(issue);
	const isMarked = (board, issue) => Boolean(mark) && mark.board === board && mark.issue === issue;

	function chip(className, text) {
		const span = doc.createElement("span");
		span.className = className;
		span.textContent = text;
		return span;
	}

	// ---- what an artboard reports (gd:checks)

	const wholeCount = (value) => Number.isInteger(value) && value >= 0;
	const bounded = (value, max) => (typeof value === "string" ? value.slice(0, max) : null);

	/** A report checked field by field (the page is the design's own code, not trusted); null when malformed. */
	function readChecks(data) {
		if (!Array.isArray(data.checks) || data.checks.length > LIMITS.checks || !Array.isArray(data.issues) || data.issues.length > LIMITS.issues) return null;
		const checks = [];
		for (const entry of data.checks) {
			if (!entry || typeof entry !== "object" || !CHECK_IDS.includes(entry.id) || checks.some((check) => check.id === entry.id) || !wholeCount(entry.count) || !wholeCount(entry.advice)) return null;
			checks.push({ id: entry.id, count: entry.count, advice: entry.advice });
		}
		const issues = [];
		for (const raw of data.issues) {
			if (!raw || typeof raw !== "object" || !CHECK_IDS.includes(raw.check) || !SEVERITIES.includes(raw.severity)) return null;
			const title = bounded(raw.title, LIMITS.title);
			const detail = bounded(raw.detail, LIMITS.detail);
			const label = bounded(raw.label, LIMITS.label);
			const selector = typeof raw.selector === "string" ? raw.selector.trim() : "";
			const rect = raw.rect && typeof raw.rect === "object" ? raw.rect : null;
			if (!title || detail === null || label === null || !selector || selector.length > LIMITS.selector) return null;
			if (!rect || !["x", "y", "width", "height"].every((key) => isFiniteNumber(rect[key]))) return null;
			// Only `hidden: true` means out of sight.
			issues.push({ check: raw.check, severity: raw.severity, title, detail, selector, label, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, hidden: raw.hidden === true });
		}
		return { checks, issues };
	}

	/** A gd:checks from `surface` (canvas-messages.js): only a design artboard's own frame, of the design shown, speaks for it. */
	function checksFrom(surface, data) {
		const board = actions.ownerOf(surface);
		if (surface !== board || board.system || !designBoards().includes(board)) return;
		const result = readChecks(data);
		if (result) setChecks(board, result);
	}

	/** The one way board.checks changes: a new result, or null when the artboard reloads. The ring and Quality follow. */
	function setChecks(board, result) {
		board.checks = result;
		if (mark && mark.board === board) followMark();
		renderChecks();
	}

	/**
	 * A frame finished loading (canvas-sizes.js surfaceLoaded): a ring on its artboard goes with the page it was drawn on,
	 * and an artboard's own frame is asked to check its new page, whose old result no longer describes it.
	 */
	function checksLoaded(surface) {
		const board = actions.ownerOf(surface);
		clearMark(board);
		if (surface !== board || board.system) return;
		board.frame.contentWindow?.postMessage({ type: "gd:run-checks" }, "*");
		if (board.checks) setChecks(board, null);
	}

	/** The boards changed (placed again, another design, none left): a ring of a board that went goes, and Quality shows what is left. */
	function refreshChecks() {
		if (mark && (!actions.allBoards().includes(mark.board) || mark.board.slug !== state.slug)) clearMark();
		renderChecks();
	}

	// ---- the tabs and Quality

	function setTab(name) {
		if (!TABS.includes(name)) return;
		store.setTab(name);
		tabButtons().forEach((tab, index) => {
			const selected = TABS[index] === name;
			tab.setAttribute("aria-selected", String(selected));
			tab.setAttribute("tabindex", selected ? "0" : "-1");
		});
		els.tabpanelComments.hidden = name !== "comments";
		els.quality.hidden = name !== "quality";
		renderChecks();
	}

	/** Quality's count (problems; advice does not count) and, while it shows, one group per design artboard. */
	function renderChecks() {
		const boards = designBoards();
		els.countQuality.textContent = String(boards.reduce((sum, board) => sum + failures(board), 0));
		if (state.tab !== "quality") return;
		// Keyboard focus on a card's button stays on the same button of the same finding across a re-render.
		const active = els.quality.contains(doc.activeElement) ? doc.activeElement : null;
		const keep = active && active.dataset && active.dataset.key ? { key: active.dataset.key, control: active.dataset.control } : null;
		const controls = [];
		els.quality.replaceChildren(...(boards.length === 0 ? [chip("gd-check-empty", TEXT.noBoards)] : boards.map((board) => checkGroup(board, controls))));
		if (keep) (controls.find((control) => control.dataset.key === keep.key && control.dataset.control === keep.control) ?? els.tabQuality).focus();
	}

	function checkGroup(board, controls) {
		const name = TEXT.boardName(state.boards.indexOf(board) + 1, board.artboard.title);
		const group = doc.createElement("section");
		group.className = "gd-check-group";
		group.setAttribute("aria-label", TEXT.groupLabel(name));
		const head = doc.createElement("div");
		head.className = "gd-check-head";
		const heading = doc.createElement("h3");
		heading.className = "gd-check-heading";
		heading.textContent = name;
		const result = board.checks;
		const count = failures(board);
		const summary = !result ? chip("gd-check-summary", TEXT.notChecked)
			: count === 0 ? chip("gd-check-summary gd-check-summary-ok", TEXT.accessible)
			: chip("gd-check-summary gd-check-summary-fail", TEXT.failing(count));
		head.append(heading, summary);
		group.append(head);
		if (!result) return group;
		group.append(...result.issues.map((issue) => checkCard(board, issue, name, controls)));
		const passed = result.checks.filter((check) => check.count === 0).map((check) => TEXT.names[check.id]);
		if (passed.length > 0) group.append(chip("gd-check-passed", TEXT.passed(passed)));
		return group;
	}

	function checkCard(board, issue, name, controls) {
		const fail = issue.severity === "fail";
		const card = doc.createElement("article");
		card.className = `gd-check ${fail ? "gd-check-fail" : "gd-check-advice"}`;
		const top = doc.createElement("div");
		top.className = "gd-check-top";
		const title = doc.createElement("b");
		title.className = "gd-check-title";
		title.textContent = issue.title;
		top.append(title, chip("gd-check-kind", TEXT.kinds[issue.severity]));
		const detail = doc.createElement("small");
		detail.className = "gd-check-detail";
		detail.textContent = issue.detail;
		card.append(top, detail);
		const key = [board.artboard.file, issue.check, issue.severity, issue.selector].join("\n");
		const show = doc.createElement("button");
		show.type = "button";
		show.className = "gd-check-show gd-small";
		show.setAttribute("aria-label", TEXT.showLabel(issue.title, issue.label, name));
		show.append(actions.icon("i-target", "gd-i gd-i-s"), chip("", TEXT.show));
		show.addEventListener("click", () => showIssue(board, issue, card));
		const fix = doc.createElement("button");
		fix.type = "button";
		fix.className = "gd-check-fix gd-small";
		fix.textContent = TEXT.fix;
		fix.setAttribute("aria-label", TEXT.fixLabel(issue.title, issue.label));
		fix.addEventListener("click", () => askAbout(board, issue));
		for (const [control, kind] of [[show, "show"], [fix, "fix"]]) {
			control.dataset.key = key;
			control.dataset.control = kind;
			controls.push(control);
		}
		// Show cannot point at what is out of sight: the card says why nothing is ringed.
		if (issue.hidden) {
			const note = chip("gd-check-hidden", TEXT.hidden);
			note.id = `gd-check-hidden-${++hiddenNotes}`;
			show.setAttribute("aria-describedby", note.id);
			card.append(note);
		}
		const buttons = doc.createElement("div");
		buttons.className = "gd-check-actions";
		buttons.append(show, fix);
		card.append(buttons);
		// A re-render keeps the card of the ring linked to it.
		if (isMarked(board, issue)) {
			mark.card = card;
			setCardMarked(card, true);
		}
		return card;
	}

	// ---- Show and Ask the agent to fix

	/**
	 * Brings a rect of an artboard (its CSS px) into view: another artboard's focus ends, and with none focused the canvas
	 * centers the rect (focus mode cannot pan). With zoomIn, a canvas under SHOW_ZOOM first zooms in about the rect; never out.
	 */
	function reveal(board, rect, zoomIn) {
		if (state.focus && state.focus !== board) actions.exitFocus();
		if (state.focus) return;
		const viewport = els.viewport.getBoundingClientRect();
		const frame = board.frame.getBoundingClientRect();
		const scale = frame.width / board.viewWidth || 1;
		const x = frame.left + (rect.x + rect.width / 2) * scale;
		const y = frame.top + (rect.y + rect.height / 2) * scale;
		if (zoomIn && state.zoom < SHOW_ZOOM) {
			const fits = Math.min(SHOW_ZOOM, (viewport.width * SHOW_ROOM) / rect.width, (viewport.height * SHOW_ROOM) / rect.height);
			// Zooming about the rect's center keeps it at (x, y), so the pan below still centers it.
			actions.zoomAt(Math.max(state.zoom, fits), x - viewport.left, y - viewport.top);
		}
		actions.panBy(viewport.left + viewport.width / 2 - x, viewport.top + viewport.height / 2 - y);
	}

	function highlight(board, issue) {
		for (const surface of actions.surfacesOf(board)) surface.frame.contentWindow?.postMessage({ type: "gd:highlight", selector: issue.selector }, "*");
	}

	/** Show: the element centered and ringed; one out of sight gets no ring, and its artboard is centered instead. */
	function showIssue(board, issue, card) {
		// A card of a board a reload replaced, or of an older report, points at nothing.
		if (!isCurrent(board, issue)) return;
		if (issue.hidden) {
			clearMark();
			reveal(board, { x: 0, y: 0, width: board.viewWidth, height: board.viewHeight }, false);
		} else {
			reveal(board, issue.rect, true);
			placeMark(board, issue, card);
		}
		highlight(board, issue);
	}

	/** Ask the agent to fix: the comment box on the element, prefilled and editable; in All sizes on the frame as designed. */
	function askAbout(board, issue) {
		if (!isCurrent(board, issue)) return;
		if (!isMarked(board, issue)) clearMark();
		reveal(board, issue.rect, false);
		highlight(board, issue);
		const sizes = board.sizeFrames;
		actions.openPopover(sizes.length > 0 ? sizes[sizes.length - 1] : board, { selector: issue.selector, excerpt: issue.label, rect: issue.rect });
		els.text.value = TEXT.session[issue.severity](issue).slice(0, LIMITS.comment);
	}

	// ---- the ring of Show
	// Drawn by the canvas, never by the artboard's page, beside the frame the checks ran in: in the world like the pins, so it
	// follows zoom and pan, or on the frame as designed in All sizes. Esc, a still click on the canvas, another Show, a reload of
	// its frame, another size, its frames or its board going, or another design clear it.

	/** The frame the checks ran in: the artboard's own, or in All sizes its frame as designed (the manifest size). */
	function markHost(board) {
		const sizes = board.sizeFrames;
		return sizes.length > 0 ? sizes[sizes.length - 1].stage : board.frame.parentElement;
	}

	function setCardMarked(card, marked) {
		if (!card) return;
		card.classList.toggle("gd-check-active", marked);
		if (marked) card.setAttribute("aria-current", "true");
		else card.removeAttribute("aria-current");
	}

	function placeMark(board, issue, card) {
		clearMark();
		const ring = doc.createElement("div");
		ring.className = `gd-check-mark ${issue.severity === "fail" ? "gd-check-mark-fail" : "gd-check-mark-advice"}`;
		// The card is the accessible path (aria-current); the ring is only drawn.
		ring.setAttribute("aria-hidden", "true");
		const label = chip("gd-check-mark-label", "");
		ring.append(label);
		mark = { board, issue, ring, label, card };
		renderMark();
		markHost(board).append(ring);
		setCardMarked(card, true);
	}

	/** The ring centered on its finding's rect (artboard CSS px), labeled with the check's title. */
	function renderMark() {
		const { rect } = mark.issue;
		mark.ring.style.left = `${rect.x + rect.width / 2}px`;
		mark.ring.style.top = `${rect.y + rect.height / 2}px`;
		mark.ring.style.setProperty("--gd-mark-w", `${rect.width}px`);
		mark.ring.style.setProperty("--gd-mark-h", `${rect.height}px`);
		mark.label.textContent = mark.issue.title;
	}

	/** A new report of the ringed artboard: the ring moves to the same finding (check, kind, element), or goes. */
	function followMark() {
		const { board, issue } = mark;
		const same = board.checks ? board.checks.issues.find((entry) => entry.check === issue.check && entry.severity === issue.severity && entry.selector === issue.selector) : null;
		if (!same || same.hidden) {
			clearMark();
			return;
		}
		mark.issue = same;
		renderMark();
	}

	/** Removes the ring (with `board`, only a ring on that artboard); true when there was one. */
	function clearMark(board) {
		if (!mark || (board && mark.board !== board)) return false;
		const { ring, card } = mark;
		mark = null;
		ring.remove();
		setCardMarked(card, false);
		return true;
	}

	// A still click on the canvas (its background, an artboard's shield or header) clears the ring; a drag pans and keeps it.
	els.viewport.addEventListener("pointerdown", (event) => {
		const target = event.target;
		const onCanvas = target === els.viewport || target === els.world || Boolean(target.closest(".gd-shield, .gd-artboard-label"));
		press = mark && event.button === 0 && onCanvas && !target.closest("button") ? { id: event.pointerId, x: event.clientX, y: event.clientY } : null;
	});
	els.viewport.addEventListener("pointerup", (event) => {
		const start = press;
		press = null;
		if (start && start.id === event.pointerId && Math.abs(event.clientX - start.x) <= CLICK_SLOP && Math.abs(event.clientY - start.y) <= CLICK_SLOP) clearMark();
	});

	// Esc clears the ring after what owns Esc already (the comment box, Compare, a menu, a dialog) and before the selected
	// artboard (canvas-layout.js, registered after this) and Comment mode (canvas-popover.js).
	doc.addEventListener("keydown", (event) => {
		if (event.defaultPrevented || event.key !== "Escape" || event.shiftKey || !mark) return;
		if (state.compare || state.menu || !els.popover.hidden || els.shortcuts.hasAttribute("open")) return;
		event.preventDefault();
		clearMark();
	});

	tabButtons().forEach((tab, index) => tab.addEventListener("click", () => setTab(TABS[index])));
	// The arrows (wrapping around), Home and End move between the tabs, focus with them.
	els.tabs.addEventListener("keydown", (event) => {
		const current = TABS.indexOf(state.tab);
		const next = { ArrowRight: (current + 1) % TABS.length, ArrowLeft: (current + TABS.length - 1) % TABS.length, Home: 0, End: TABS.length - 1 }[event.key];
		if (next === undefined) return;
		event.preventDefault();
		setTab(TABS[next]);
		tabButtons()[next].focus();
	});

	return { checksFrom, setChecks, checksLoaded, refreshChecks, renderChecks, setTab, clearMark };
}
