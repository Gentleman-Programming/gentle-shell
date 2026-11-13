// Accessibility checks and the panel's two tabs, Comments and Quality, each with its count.
// Each design artboard's own frame checks its page when the canvas asks (gd:run-checks, sent when
// that frame loads; never to an All sizes frame or the system board) and again after each resize
// (inspector.js gd:checks). Quality lists the findings of each design artboard as the artboard
// reported them, with Show (zoom in under 100%, center the element, a ring on the canvas that follows
// it as its page scrolls: inspector.js gd:located) and Ask the agent to fix (the comment box on that
// element, prefilled). The checks describe the artboard at the size it is shown,
// and they are heuristics, not a full audit: they miss keyboard, focus-order, motion and screen-reader
// problems, and each list is capped (20 problems and 10 advice items per check, with the full count reported
// for the page's first 3000 elements; docs/gentle-shell.md).
// board.checks is changed in place only by setChecks here; the tab lives in the store (setTab); the
// ring is this module's own view state, which other modules end through clearMark.
// Each finding comes with its English title and detail, and with a key and plain vars (inspector.js): the card shows
// findings[key] over those vars, in the canvas language, or the English it came with when they are missing or do not fit.
// What Ask the agent to fix prefills (TEXT.session) is English, with the English title and detail.

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
	// A finding by its key (inspector.js), over its vars: the same English the inspector sends.
	findings: {
		contrast: { title: "Low contrast", detail: (v) => `"${v.text}" is ${v.ratio} : 1 (${v.foreground} on ${v.background}); WCAG AA needs ${v.needed} : 1.` },
		contrastLarge: { title: "Low contrast", detail: (v) => `"${v.text}" is ${v.ratio} : 1 (${v.foreground} on ${v.background}); WCAG AA needs ${v.needed} : 1 for large text.` },
		targetSmall: { title: "Small touch target", detail: (v) => `${v.name ? `"${v.name}"` : v.element} is ${v.width} × ${v.height} px; WCAG 2.2 asks for ${v.min} × ${v.min} px, or enough space around it that a ${v.min} px circle on it touches no other target.` },
		targetAdvised: { title: "Touch target under 44 px", detail: (v) => `${v.name ? `"${v.name}"` : v.element} is ${v.width} × ${v.height} px; ${v.advised} × ${v.advised} px is recommended for touch.` },
		alt: { title: "Image without alt text", detail: (v) => `${v.source || "The image"} has no alt attribute. Describe it, or use alt="" if it is decorative.` },
		label: { title: "Form field without a label", detail: (v) => `The ${v.field === "select" ? "select" : v.field === "textarea" ? "text area" : `${v.type} field`}${v.hint ? ` "${v.hint}"` : ""} has no label. Add a <label for>, aria-label or aria-labelledby; a placeholder is not a label.` },
		heading: { title: "Heading level skipped", detail: (v) => `h${v.level} "${v.text}" follows h${v.previous}: ${v.missing} ${v.count === 1 ? "is" : "are"} missing.` },
	},
	// What Ask the agent to fix prefills: instructions for the session.
	session: {
		fail: (issue) => `Accessibility check on ${issue.selector}: ${issue.title}.\n${issue.detail}\nFix it so it meets WCAG 2.2 AA, keeping the design's tokens.`,
		advice: (issue) => `Accessibility advice on ${issue.selector}: ${issue.title}.\n${issue.detail}\nConsider fixing it, keeping the design's tokens.`,
	},
});

const TABS = ["comments", "quality"];
const CHECK_IDS = ["contrast", "target", "alt", "label", "heading"];
const SEVERITIES = ["fail", "advice"];
const LIMITS = { checks: 10, issues: 200, title: 80, detail: 400, selector: 500, label: 80, excerpt: 300, comment: 2000, variable: 120 };
// The vars of each finding key (inspector.js): exactly these, each a string or a finite number.
const FINDING_VARS = {
	contrast: ["text", "ratio", "foreground", "background", "needed"],
	contrastLarge: ["text", "ratio", "foreground", "background", "needed"],
	targetSmall: ["name", "element", "width", "height", "min"],
	targetAdvised: ["name", "element", "width", "height", "advised"],
	alt: ["source"],
	label: ["field", "type", "hint"],
	heading: ["level", "previous", "text", "missing", "count"],
};
// Under SHOW_ZOOM, Show zooms in to it, or less when the element would not fit in SHOW_ROOM of the view at that zoom.
const SHOW_ZOOM = 1;
const SHOW_ROOM = 0.8;
// A press that moves no further than this is a click (canvas-view.js uses the same).
const CLICK_SLOP = 4;

export function init(ctx) {
	const { doc, els, store, api, actions } = ctx;
	const { state } = store;
	const { isFiniteNumber } = api;
	const T = ctx.i18n.text("checks", TEXT);
	// The ring of Show: { board, issue, rect, ring, label, card, recenter } or null (rect: where the element is in its
	// frame, the checks' rect until the frame locates it); the press that may be a still click on the canvas.
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
			// The element's text, as a pick sends it (inspector.js excerptOf), for Ask the agent to fix.
			const excerpt = bounded(raw.excerpt, LIMITS.excerpt);
			const selector = typeof raw.selector === "string" ? raw.selector.trim() : "";
			const rect = readRect(raw.rect);
			if (!title || detail === null || label === null || excerpt === null || !selector || selector.length > LIMITS.selector || !rect) return null;
			// Only `hidden: true` means out of sight. A key whose vars do not fit is dropped: the card shows the English.
			const vars = readVars(raw.key, raw.vars);
			issues.push({ check: raw.check, severity: raw.severity, title, detail, selector, label, excerpt, rect, hidden: raw.hidden === true, ...(vars ? { key: raw.key, vars } : {}) });
		}
		return { checks, issues };
	}

	/** A finding's vars, copied, when its key is known and they are exactly that key's, each a bounded string or a finite number; else null. */
	function readVars(key, raw) {
		if (typeof key !== "string" || !Object.hasOwn(FINDING_VARS, key) || !raw || typeof raw !== "object" || Array.isArray(raw)) return null;
		const names = FINDING_VARS[key];
		if (Object.keys(raw).length !== names.length) return null;
		const vars = {};
		for (const name of names) {
			const value = raw[name];
			if (!(typeof value === "string" && value.length <= LIMITS.variable) && !isFiniteNumber(value)) return null;
			vars[name] = value;
		}
		return vars;
	}

	/** What a card shows for a finding: findings[key] over its vars in the canvas language, else the English it came with. */
	function shown(issue) {
		if (issue.vars === undefined) return { title: issue.title, detail: issue.detail };
		const finding = T.findings[issue.key];
		return { title: finding.title, detail: finding.detail(issue.vars) };
	}

	/** A box in a frame's CSS px, copied; null unless it has four finite numbers. */
	function readRect(value) {
		if (!value || typeof value !== "object" || !["x", "y", "width", "height"].every((key) => isFiniteNumber(value[key]))) return null;
		return { x: value.x, y: value.y, width: value.width, height: value.height };
	}

	/**
	 * A gd:checks from `surface` (canvas-messages.js): only a design artboard's own frame, of the design shown, speaks for
	 * it, and only about the size it has now: a scan made before its page heard of the latest size (gd:size, canvas-sizes.js
	 * resized) is dropped. The result keeps that size (viewport, null at the artboard's own), so Ask the agent to fix files
	 * a finding with the size it was found at even after the frame changes size and before its next scan arrives.
	 */
	function checksFrom(surface, data) {
		const board = actions.ownerOf(surface);
		if (surface !== board || board.system || !designBoards().includes(board)) return;
		if (data.generation !== surface.generation) return;
		const result = readChecks(data);
		if (result) setChecks(board, { ...result, viewport: actions.viewportOf(surface) });
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
		// No number until an artboard has reported: 0 would say nothing was found.
		els.countQuality.textContent = boards.some((board) => board.checks) ? String(boards.reduce((sum, board) => sum + failures(board), 0)) : "";
		if (state.tab !== "quality") return;
		// Keyboard focus on a card's button stays on the same button of the same finding across a re-render.
		const active = els.quality.contains(doc.activeElement) ? doc.activeElement : null;
		const keep = active && active.dataset && active.dataset.key ? { key: active.dataset.key, control: active.dataset.control } : null;
		const controls = [];
		els.quality.replaceChildren(...(boards.length === 0 ? [chip("gd-check-empty", T.noBoards)] : boards.map((board) => checkGroup(board, controls))));
		if (keep) (controls.find((control) => control.dataset.key === keep.key && control.dataset.control === keep.control) ?? els.tabQuality).focus();
	}

	function checkGroup(board, controls) {
		const name = T.boardName(state.boards.indexOf(board) + 1, board.artboard.title);
		const group = doc.createElement("section");
		group.className = "gd-check-group";
		group.setAttribute("aria-label", T.groupLabel(name));
		const head = doc.createElement("div");
		head.className = "gd-check-head";
		const heading = doc.createElement("h3");
		heading.className = "gd-check-heading";
		heading.textContent = name;
		const result = board.checks;
		const count = failures(board);
		const summary = !result ? chip("gd-check-summary", T.notChecked)
			: count === 0 ? chip("gd-check-summary gd-check-summary-ok", T.accessible)
			: chip("gd-check-summary gd-check-summary-fail", T.failing(count));
		head.append(heading, summary);
		group.append(head);
		if (!result) return group;
		group.append(...result.issues.map((issue) => checkCard(board, issue, name, controls)));
		const passed = result.checks.filter((check) => check.count === 0).map((check) => T.names[check.id]);
		if (passed.length > 0) group.append(chip("gd-check-passed", T.passed(passed)));
		return group;
	}

	function checkCard(board, issue, name, controls) {
		const fail = issue.severity === "fail";
		const card = doc.createElement("article");
		card.className = `gd-check ${fail ? "gd-check-fail" : "gd-check-advice"}`;
		const top = doc.createElement("div");
		top.className = "gd-check-top";
		const words = shown(issue);
		const title = doc.createElement("b");
		title.className = "gd-check-title";
		title.textContent = words.title;
		top.append(title, chip("gd-check-kind", T.kinds[issue.severity]));
		const detail = doc.createElement("small");
		detail.className = "gd-check-detail";
		detail.textContent = words.detail;
		card.append(top, detail);
		const key = [board.artboard.file, issue.check, issue.severity, issue.selector].join("\n");
		const show = doc.createElement("button");
		show.type = "button";
		show.className = "gd-check-show gd-small";
		show.setAttribute("aria-label", T.showLabel(words.title, issue.label, name));
		show.append(actions.icon("i-target", "gd-i gd-i-s"), chip("", T.show));
		show.addEventListener("click", () => showIssue(board, issue, card));
		const fix = doc.createElement("button");
		fix.type = "button";
		fix.className = "gd-check-fix gd-small";
		fix.textContent = T.fix;
		fix.setAttribute("aria-label", T.fixLabel(words.title, issue.label));
		fix.addEventListener("click", () => askAbout(board, issue));
		for (const [control, kind] of [[show, "show"], [fix, "fix"]]) {
			control.dataset.key = key;
			control.dataset.control = kind;
			controls.push(control);
		}
		// Show cannot point at what is out of sight: the card says why nothing is ringed.
		if (issue.hidden) {
			const note = chip("gd-check-hidden", T.hidden);
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

	/** The element highlighted in every frame of its artboard; with `locate`, the ring's frame also says where it is (gd:located). */
	function highlight(board, issue, locate) {
		const ringed = locate ? markSurface(board) : null;
		for (const surface of actions.surfacesOf(board)) surface.frame.contentWindow?.postMessage({ type: "gd:highlight", selector: issue.selector, ...(surface === ringed ? { locate: true } : {}) }, "*");
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
		highlight(board, issue, !issue.hidden);
	}

	/** Ask the agent to fix: the comment box on the element, prefilled and editable; in All sizes on the frame as designed. */
	function askAbout(board, issue) {
		if (!isCurrent(board, issue)) return;
		const marked = isMarked(board, issue);
		if (!marked) clearMark();
		reveal(board, issue.rect, false);
		// A ring it keeps goes on following the element.
		highlight(board, issue, marked);
		const sizes = board.sizeFrames;
		const pick = { selector: issue.selector, excerpt: issue.excerpt, rect: issue.rect };
		// On the artboard's own frame the comment records the size the finding was made at, not the size shown now.
		if (sizes.length > 0) actions.openPopover(sizes[sizes.length - 1], pick);
		else actions.openPopover(board, { ...pick, viewport: board.checks.viewport });
		// The English title and detail the finding came with: the request is for the session.
		els.text.value = T.session[issue.severity](issue).slice(0, LIMITS.comment);
	}

	// ---- the ring of Show
	// Drawn by the canvas, never by the artboard's page, beside the frame the checks ran in: in the world like the pins, so it
	// follows zoom and pan, or on the frame as designed in All sizes. That frame's page says where the element is once Show
	// scrolled it into view and after each scroll (gd:located), so the ring stays on it, and is not drawn while the element is
	// outside the frame. Esc, a still click on the canvas, another Show, a reload of its frame, another size, its frames or its
	// board going, or another design clear it, and the element's highlight in its page with it (gd:clear).

	/** The frame the checks ran in, which the ring is drawn on: the artboard's own, or in All sizes its frame as designed (the manifest size). */
	function markSurface(board) {
		const sizes = board.sizeFrames;
		return sizes.length > 0 ? sizes[sizes.length - 1] : board;
	}

	function markHost(board) {
		const surface = markSurface(board);
		return surface === board ? board.frame.parentElement : surface.stage;
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
		mark = { board, issue, rect: issue.rect, ring, label, card, recenter: true };
		renderMark();
		markHost(board).append(ring);
		setCardMarked(card, true);
	}

	/** The ring centered on its element's rect (artboard CSS px), labeled with the check's title; none while outside its frame. */
	function renderMark() {
		const { rect } = mark;
		const surface = markSurface(mark.board);
		mark.ring.hidden = rect.x + rect.width < 0 || rect.y + rect.height < 0 || rect.x > surface.viewWidth || rect.y > surface.viewHeight;
		mark.ring.style.left = `${rect.x + rect.width / 2}px`;
		mark.ring.style.top = `${rect.y + rect.height / 2}px`;
		mark.ring.style.setProperty("--gd-mark-w", `${rect.width}px`);
		mark.ring.style.setProperty("--gd-mark-h", `${rect.height}px`);
		mark.label.textContent = shown(mark.issue).title;
	}

	/**
	 * A new report of the ringed artboard: the ring moves to the same finding (check, kind, element), or goes. Its rect is in
	 * the report's frame, the artboard's own: in All sizes the ring is on the frame as designed, whose page keeps saying where
	 * the element is (gd:located), so the ring stays where that frame located it.
	 */
	function followMark() {
		const { board, issue } = mark;
		const same = board.checks ? board.checks.issues.find((entry) => entry.check === issue.check && entry.severity === issue.severity && entry.selector === issue.selector) : null;
		if (!same || same.hidden) {
			clearMark();
			return;
		}
		mark.issue = same;
		if (markSurface(board) === board) mark.rect = same.rect;
		renderMark();
	}

	/**
	 * A gd:located from `surface` (canvas-messages.js): where the ringed element is now, said only by the frame the ring is
	 * drawn on and only for its element. The ring moves there; the first report after Show also centers it, since Show
	 * centered where the checks saw it, before the page scrolled it into view.
	 */
	function locatedFrom(surface, data) {
		if (!mark || surface !== markSurface(mark.board) || data.selector !== mark.issue.selector) return;
		const rect = readRect(data.rect);
		if (!rect) return;
		mark.rect = rect;
		renderMark();
		if (!mark.recenter) return;
		mark.recenter = false;
		if (!state.focus || state.focus === mark.board) reveal(mark.board, rect, false);
	}

	/** Removes the ring (with `board`, only a ring on that artboard); true when there was one. */
	function clearMark(board) {
		if (!mark || (board && mark.board !== board)) return false;
		const { ring, card } = mark;
		const ringed = mark.board;
		mark = null;
		ring.remove();
		setCardMarked(card, false);
		// The element's highlight in its page goes too, and the page stops saying where it is; a board that went has no page.
		if (designBoards().includes(ringed)) for (const surface of actions.surfacesOf(ringed)) surface.frame.contentWindow?.postMessage({ type: "gd:clear" }, "*");
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

	/** A new language: Quality's cards (focus kept, as on any re-render) and the ring's label, in place. */
	function relabel() {
		renderChecks();
		if (mark) renderMark();
	}

	return { relabel, checksFrom, locatedFrom, setChecks, checksLoaded, refreshChecks, renderChecks, setTab, clearMark };
}
