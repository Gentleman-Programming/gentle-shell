// Gentle Design canvas: artboards in a row, a column, a grid or wherever they were dragged by their title
// (design/<slug>/layout.json), with pan, zoom, live reload, and comments persisted in
// design/<slug>/comments.json (pins, list, send modes).
// design/system.html, when present, is the first board of every design; it is
// kept out of state.boards so comments never apply to it.
// Artboards run in iframes sandboxed with scripts only, so each one has an opaque
// origin; messages are trusted only by matching event.source to a known artboard.
// Navigation mode (the default) covers every artboard with a shield, so the wheel,
// drags and clicks always reach the canvas; a click on a shield enters focus mode,
// which shows that artboard at 100% and lets it own the pointer and the keyboard
// until "Back to canvas" or Shift+Esc restores the previous view. Comment mode does the same in
// the overview (comparing), so elements are picked only inside a direction, at full size (reviewing).
// A minimap in the viewport's bottom right (M) shows every board and the visible area; clicking or dragging in it pans.
// Every word it shows is in one catalog (English and Spanish, below); the language starts from the browser's and
// Settings > Appearance switches it live, with the theme (Gentle or Neutral). Messages sent to the session are not text
// of the canvas and stay English.
// A left tool rail of labeled tools (Move, Comment, Overview, and Settings: appearance, design system, shortcuts, help) and the
// single-key shortcuts behind it; the mode chip in the viewport names the active mode. The top bar shows the chosen
// direction's status and whether a Pi session is connected.
// Handoffs (design/<slug>/handoffs.json) show live on each artboard's header: the
// handoff state, the chosen artboard and its alternatives, and, once implemented
// with a loopback previewUrl, a Compare view of the artboard next to the running app.
(() => {
	"use strict";

	const config = JSON.parse(document.getElementById("gd-config").textContent);
	const base = String(config.base);
	const MIN_ZOOM = 0.05;
	const MAX_ZOOM = 4;
	const FIT_PADDING = 48;
	// canvas-layout S5: an open artboard keeps 8 px from the viewport's edges, and 48 px below it for the floating
	// "Back to canvas" button (32 px high, 8 px from the bottom) and the mode chip beside it.
	const FOCUS_MARGIN = 8;
	const BACK_SPACE = 48;
	const CLICK_SLOP = 4;
	// canvas-layout: the room between boards in every arrangement (today's row), and the key of the system board in
	// design/<slug>/layout.json, where every artboard is keyed by its file (which ends in .html, so the two never meet).
	const BOARD_GAP = 80;
	const LAYOUT_SYSTEM_KEY = "system";
	const ARRANGEMENTS = ["row", "column", "grid"];
	// Controls keep their own press: one on a button, link or field in an artboard header neither pans nor moves the artboard.
	// The minimap: its map box in CSS px (canvas.css gives .gd-minimap-map the same size) and the pad kept free around the blocks.
	const MINIMAP = { width: 204, height: 96, pad: 6, minBlock: 2 };
	const LIMITS = { selector: 500, excerpt: 300, comment: 2000, variant: 2000, pins: 500, tokens: 500, screenshotBytes: 5 * 1024 * 1024 };
	const SCREENSHOT_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
	const MODE_KEY = "gentle-design:send-mode";
	// "on" shows the CSS selectors on cards and the token inspector; anything else (or nothing) is off.
	const TECHNICAL_KEY = "gentle-design:technical";
	// "on" while the step-by-step help is turned on in this browser (from the rail's Settings); anything else (or nothing) is off.
	const HELP_KEY = "gentle-design:help";
	// The keys a person gave the single-key shortcuts in this browser, for every design: a JSON object, action id -> key (canvas-layout S11).
	const SHORTCUTS_KEY = "gentle-design:shortcuts";
	// The canvas's theme in this browser (canvas-layout S15): "neutral" is Neutral; "gentle", anything else or nothing is Gentle.
	const THEME_KEY = "gentle-design:theme";
	const THEMES = ["gentle", "neutral"];
	const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
	const MAX_PREVIEW_URL = 2048;
	// The running app is another loopback origin (previewTarget refuses this server's own
	// port), so the same-origin flag below gives the app its own origin, never the canvas's: it cannot
	// reach this page, its token or its API, and its scripts, storage and forms work as in
	// production. No top-navigation flag is granted, so it can never navigate the canvas away.
	const PREVIEW_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups";
	const PREVIEW_TIMEOUT_MS = 6000;
	// CSP host sources have no IPv6 literal form, so Chromium drops the [::1] source from frame-src (the hint compare.hintIpv6 says so).
	// Below this on-screen artboard width, the screen-size handoff row and Implement this would
	// overlap the next artboard: they collapse, and the top-bar status and the timeline carry the state.
	const COMPACT_BOARD_WIDTH = 360;
	const COMPARE_GAP = 24;
	const COMPARE_PADDING = 24;
	// Screen sizes in focus mode. Desktop is the artboard's own manifest size; the custom width is whole
	// CSS px in this range with the manifest height; All sizes leaves a gap between frames and a band for each label.
	const SIZE_PRESETS = [
		{ kind: "phone", name: "size.phone", icon: "i-phone", width: 390, height: 844 },
		{ kind: "tablet", name: "size.tablet", icon: "i-tablet", width: 820, height: 1180 },
		{ kind: "desktop", name: "size.desktop", icon: "i-monitor", manifest: true },
	];
	const CUSTOM_WIDTH = { min: 240, max: 2560 };
	// The top bar's device button wears the icon of the size it shows (canvas-layout S6).
	const SIZE_ICONS = { phone: "i-phone", tablet: "i-tablet", desktop: "i-monitor", all: "i-devices", custom: "i-width" };
	// What comments.json accepts for the size a comment was made at (lib/design-comments.ts).
	const VIEWPORT_LIMITS = { minWidth: 240, maxWidth: 4096, minHeight: 1, maxHeight: 20000 };
	const SIZES_GAP = 20;
	const SIZES_HEAD = 28;
	const MIN_SIZES_SCALE = 0.05;
	const TOAST_MS = 5000;
	// What the server can deliver; an older page config without it means everything.
	const DELIVERY = { comment: true, batch: true, implement: true, variant: true, part: true, ...(config.delivery && typeof config.delivery === "object" ? config.delivery : {}) };
	// Suggestions in the "another direction" dialog: each fills the field with its own label.
	const VARIANT_SUGGESTIONS = ["variant.compact", "variant.bolder", "variant.mobile", "variant.calmer"];
	// The review panel's tabs.
	const TAB_NAMES = ["comments", "checks"];

	/* catalog:start */
	// S4: every word the canvas shows, once per language, one entry per line. A key missing from `es` shows the English text.
	// {name} marks a value filled in at run time; a key pair .one / .other is a plural (see tn).
	const CATALOG = {
		en: {
			"common.cancel": "Cancel",
			"common.close": "Close",
			"common.copy": "Copy",
			"common.dismiss": "Dismiss",
			"common.remove": "Remove",
			"common.send": "Send",
			"common.save": "Save",
			"change.prompt": "What should change?",
			"session.notConnected": "Canvas not connected to a Pi session.",
			"lang.es": "Español",
			"lang.en": "English",
			"lang.auto": "Match the browser",
			"lang.note": "Saved in this browser. Comments you write stay in the language you type; messages to the agent stay in English.",
			"rail.label": "Tools",
			"rail.navigate": "Move",
			"rail.navigate.title": "Move around the canvas ({key})",
			"rail.comment": "Comment",
			"rail.comment.title": "Comment on an element ({key})",
			"rail.overview": "Overview",
			"rail.overview.title": "See all the directions ({key})",
			"rail.settings": "Settings",
			"rail.settings.title": "Settings: appearance, design system, keyboard shortcuts and step-by-step help",
			"rail.appearance": "Appearance",
			"appearance.theme": "Theme",
			"appearance.language": "Language",
			"theme.gentle": "Gentle",
			"theme.gentle.hint": "Gentleman style",
			"theme.neutral": "Neutral",
			"theme.neutral.hint": "Dark gray with a light-gray accent",
			"theme.note": "The theme changes the canvas only; the directions keep their own design. Saved in this browser.",
			"rail.system": "Design system board",
			"rail.keys": "Keyboard shortcuts",
			"rail.help": "Step-by-step help",
			"guide.eyebrow": "Step-by-step help · {n} of {total}",
			"guide.steps": "Steps",
			"guide.step.compare": "Compare",
			"guide.step.review": "Review",
			"guide.step.choose": "Choose",
			"guide.step.implement": "Implement",
			"guide.compare.title": "These are your directions",
			"guide.compare.text": "Under each title you see what each one does better and what it gives up. Press “Open” on the one you want to review.",
			"guide.review.title": "Review this direction",
			"guide.review.text": "Press “Comment” and click whatever you want to change. When it convinces you, press “Implement this”.",
			"guide.building.title": "The agent is building it",
			"guide.building.text": "Its header shows how it is going. You can keep commenting meanwhile.",
			"guide.done.title": "It is implemented",
			"guide.done.text": "If your app is running, “Compare with app” at the top shows the design next to it.",
			"guide.off": "Turn off help",
			"guide.dismiss": "Got it",
			"connection.on": "Connected",
			"connection.onTitle": "Connected to the Pi session: your comments and requests reach the agent.",
			"connection.off": "Not connected",
			"connection.offTitle": "This canvas is not connected to a Pi session, so it cannot send comments or hand anything off. Open the canvas from your session with /gentle:design open {slug}.",
			"bar.label": "Design canvas controls",
			"bar.design": "Design",
			"bar.feature": "Feature document",
			"bar.compareApp": "Compare with app",
			"technical.label": "Technical details",
			"technical.title": "Selectors and the token inspector",
			"zoom.group": "Zoom",
			"zoom.out": "Zoom out",
			"zoom.out.title": "Zoom out (-)",
			"zoom.level": "Zoom level",
			"zoom.in": "Zoom in",
			"zoom.in.title": "Zoom in (+)",
			"zoom.fit": "Fit all",
			"zoom.fit.title": "Fit all (0)",
			"layout.group": "Arrange the directions",
			"layout.row": "Row",
			"layout.row.title": "Arrange in a row",
			"layout.column": "Column",
			"layout.column.title": "Arrange in a column",
			"layout.grid": "Grid",
			"layout.grid.title": "Arrange in a grid",
			"a11y.ok": "Accessible ✓",
			"a11y.fails.one": "{count} check",
			"a11y.fails.other": "{count} checks",
			"viewport.label": "Directions",
			"mode.navigating": "Moving around the canvas · wheel to zoom",
			"mode.commenting": "Click a direction to open it and comment · Esc",
			"mode.using": "Using: {title} · Shift+Esc to exit",
			"back": "Back to canvas",
			"back.title": "Back to canvas (Shift+Esc)",
			"minimap.title": "Minimap",
			"minimap.aria": "Position of the visible area among the directions. Click or drag to move the view; with the keyboard, use the Open button on each direction.",
			"minimap.aria.one": "Position of the visible area among {count} direction. Click or drag to move the view; with the keyboard, use the Open button on each direction.",
			"minimap.aria.other": "Position of the visible area among {count} directions. Click or drag to move the view; with the keyboard, use the Open button on each direction.",
			"panel.label": "Review",
			"panel.toggleTitle": "Review panel ({key})",
			"tab.comments": "Comments",
			"tab.checks": "Quality",
			"tabs.prev": "Earlier tabs",
			"tabs.next": "More tabs",
			"panel.comments": "Comments",
			"panel.empty.none": "No comments yet",
			"panel.empty.hint": "Open a direction and press “Comment” on whatever you want to change.",
			"panel.empty.open": "No open comments.",
			"panel.empty.resolved": "No resolved comments.",
			"filter.label": "Show comments",
			"filter.open": "Open · {count}",
			"filter.resolved": "Resolved · {count}",
			"filter.all": "All",
			"panel.sendMode": "When a comment is sent to the session",
			"panel.sendNow": "Send now",
			"panel.collect": "Save to send later",
			"panel.footIntro": "Your comments go to the agent so it changes the design",
			"panel.pending.one": "{count} waiting to be sent",
			"panel.pending.other": "{count} waiting to be sent",
			"panel.sendAll": "Send all ({count})",
			"panel.sent.one": "Sent {count} comment to the session",
			"panel.sent.other": "Sent {count} comments to the session",
			"panel.noUnsent": "No unsent comments",
			"comment.sent": "Sent",
			"comment.waiting": "Waiting",
			"comment.detached": "Detached",
			"comment.show": "Show comment {number} on {file}",
			"comment.madeAt": "Made at {label}",
			"comment.shot": "Screenshot of comment {number}",
			"comment.resolve": "Resolve",
			"comment.reopen": "Reopen",
			"comment.resolveAria": "Resolve comment {number}",
			"comment.reopenAria": "Reopen comment {number}",
			"comment.agent": "Agent:",
			"comment.resolved": "Comment resolved",
			"comment.reopened": "Comment reopened",
			"comment.edit": "Edit",
			"comment.editAria": "Edit comment {number}",
			"comment.editLabel": "Text of comment {number}",
			"comment.updated": "Comment updated",
			"comment.updatedSent": "Comment updated and sent to the session",
			"comment.status.open": "open",
			"comment.status.resolved": "resolved",
			"pin.aria": "Comment {number} ({status}): {text}",
			"popover.title": "Comment on",
			"popover.label": "Comment",
			"popover.attach": "Attach screenshot",
			"popover.attachTitle": "Or paste an image, or drop one here (PNG, JPEG, WebP or GIF, up to 5 MB)",
			"popover.shotAlt": "Attached screenshot",
			"popover.sending": "Sending…",
			"popover.tooLong": "Write a comment of 1 to {max} characters.",
			"popover.saved": "Saved; use Send all to send it",
			"popover.sentDone": "Sent to the session",
			"popover.savedOnly": "Saved, but not sent to the session. Use Send all to try again.",
			"shot.type": "Attach a PNG, JPEG, WebP or GIF image.",
			"shot.size": "The screenshot must be at most 5 MB.",
			"shot.read": "The screenshot could not be read.",
			"designs.invalid": "{slug} (invalid design.json)",
			"empty.noDesigns": "No designs yet. Run /gentle:design with a brief to create one.",
			"empty.cannotShow": "Design \"{slug}\" cannot be shown: {message}",
			"empty.noArtboards": "This design has no directions yet.",
			"empty.cannotList": "Designs cannot be listed: {message}",
			"status.invalidManifest": "design.json for {slug} is invalid",
			"status.warnings": "design.json: {warnings}",
			"status.handoffs": "handoffs.json for {slug} cannot be read: {message}",
			"status.comments": "comments.json for {slug} cannot be read: {message}",
			"status.disconnected": "Live reload disconnected, retrying…",
			"status.layout": "The layout of {slug} could not be saved: {message}",
			"board.use": "Use {title}",
			"board.hintUse": "Click to use this design",
			"board.hintSystem": "Click to view the design system",
			"board.hintComment": "Click to open and comment",
			"board.comment": "Open {title} to comment",
			"board.frameTitle": "{title} artboard",
			"board.menuButton": "More actions for {title}",
			"board.open": "Open",
			"board.openAria": "Open direction {number}, {title}",
			"system.title": "Design system",
			"system.tradeoff": "Project tokens (design/system.md)",
			"system.note": "Comments apply to design artboards only. To change the system, update the project's design sources and run /gentle:design sync.",
			"system.commentsOff": "Comments off on this board",
			"system.view": "View Design system (read-only)",
			"system.frameTitle": "Design system artboard",
			"overflow.label": "Overflows",
			"overflow.note": "Content is wider than {width} px, so part of it is cut off or needs sideways scrolling at this size.",
			"size.group": "Preview size",
			"size.phone": "Phone",
			"size.tablet": "Tablet",
			"size.desktop": "Desktop",
			"size.preset.title": "{name} {width} × {height}",
			"size.all": "All sizes",
			"size.all.title": "All sizes: Phone, Tablet and Desktop side by side",
			"size.custom": "Custom",
			"size.customAria": "Custom width in pixels",
			"size.error": "Enter a whole number from {min} to {max} (px).",
			"size.frameAria": "{name} {width} by {height}",
			"size.frameTitle": "{title} artboard at {name} {width} × {height}",
			"device.button": "Preview size: {size}",
			"device.title": "Preview size of the open artboard",
			"device.off": "Open an artboard to choose its preview size",
			"implement.start": "Implement this",
			"implement.startAria": "Implement {title} in the project",
			"implement.confirmAria": "Confirm implementing {title}",
			"implement.question": "Send it to the session to implement?",
			"implement.switch": "Switch to this…",
			"implement.switchAria": "Switch the implementation to {title}",
			"implement.switchQuestion": "Move the implementation to this direction? The session gets it as a new handoff.",
			"implement.queued": "Queued: the session will implement {title} after its current task.",
			"implement.sent": "Sent: the session is implementing {title} now.",
			"menu.aria": "{title} actions",
			"menu.variant": "Try another direction from this…",
			"menu.compare": "Compare with app",
			"menu.exportPng": "Export as PNG",
			"menu.exportPng2x": "Export as PNG at 2×",
			"menu.exportPdf": "Export as PDF",
			"menu.downloadHtml": "Download HTML",
			"download.failed": "Could not download the artboard. Open it from design/ in your project instead.",
			"menu.implement": "Implement this",
			"menu.switch": "Switch to this…",
			"export.failed": "Could not export the artboard. Use your browser's screenshot tool instead.",
			"export.unavailable": "Tab capture is not available in this browser.",
			"export.confirm": "Choose this canvas tab in the browser's capture selector. Choosing another tab or screen may export the wrong content.",
			"export.sharedScreen": "You shared a screen, not this tab, so the artboard cannot be cropped from it.",
			"export.sharedOther": "You shared a {surface}, not this tab, so the artboard cannot be cropped from it.",
			"export.window": "The artboard needs a browser window of at least {width} × {height} px. Make the window bigger or use full screen (F11), then try again.",
			"export.noFrame": "The captured frame has no dimensions.",
			"export.noPng": "PNG export is not available.",
			"export.encode": "Could not encode the PNG.",
			"export.denied": "Capture was denied or failed.",
			"export.done": "Exported PNG.",
			"export.doneUpscaled": "Exported PNG at 2× (upscaled).",
			"variant.title": "Another direction from",
			"variant.note": "The session writes a new artboard, {number}, and keeps the others.",
			"variant.hint": "1 to 2000 characters",
			"variant.suggestions": "Suggestions",
			"variant.send": "Send to the session",
			"variant.problem": "Write 1 to {max} characters about what should change.",
			"variant.queued": "Queued: the session will add a new direction based on {title} after its current task.",
			"variant.sent": "Sent: the session is adding a new direction based on {title} now.",
			"variant.compact": "More compact",
			"variant.bolder": "Bolder",
			"variant.mobile": "Mobile first",
			"variant.calmer": "Calmer colors",
			"part.add": "Implement only this",
			"part.addTitle": "Build only this element in your app, without choosing this direction",
			"part.noteTooLong": "The note can have at most {max} characters.",
			"part.sent": "Sent: the session is building only this part of {title} now.",
			"part.queued": "Queued: the session will build only this part of {title} after its current task.",
			"parts.title": "Partial implementations · {count}",
			"part.state.sent": "Sent",
			"part.state.queued": "Queued",
			"part.state.in_progress": "In progress",
			"part.state.implemented": "Implemented ✓",
			"part.time.sent": "Sent at {time}",
			"part.time.queued": "Queued since {time}",
			"part.time.in_progress": "In progress since {time}",
			"part.time.implemented": "Implemented at {time}",
			"part.show": "Show",
			"part.showAria": "Show part {n} in {file}",
			"placeholder.title": "New direction",
			"placeholder.aria": "{number} · New direction",
			"placeholder.state": "Designing…",
			"placeholder.status": "Designing the new direction…",
			"handoff.queued": "Queued",
			"handoff.sent": "Implementing…",
			"handoff.in_progress": "In progress",
			"handoff.implemented": "Implemented ✓",
			"choice.chosen": "Chosen",
			"choice.discarded": "Discarded",
			"handoff.featureTitle": "Tracked in this ODD feature document",
			"handoff.compare": "Compare",
			"handoff.compareAria": "Compare {title} with the running app",
			"timeline.title": "Handoff · {title}",
			"timeline.sent": "Sent to the session",
			"timeline.implemented": "Implemented",
			"timeline.queued": "Queued · {time}",
			"timeline.useImplement": "Use Implement this to send it",
			"timeline.compareWhenReady": "Compare with the running app when ready",
			"timeline.done": "(done)",
			"timeline.current": "(current)",
			"timeline.pending": "(not yet)",
			"stepper.sent": "Sent",
			"stepper.position": "Step {n} of {total}: {step}",
			"time.today": "Today {clock}",
			"compare.title": "Compare",
			"compare.titleFor": "Compare: {title}",
			"compare.fit": "Scale to fit",
			"compare.open": "Open in new tab",
			"compare.designCaption": "Design: {file}",
			"compare.appCaption": "Implementation: {url}",
			"compare.appFrame": "Running app at {url}",
			"compare.hint": "If the app pane stays empty, the app may not be running at {url} or may refuse to be framed: start it, or use Open in new tab.",
			"compare.hintIpv6": "Browsers do not frame [::1] under the canvas policy (CSP has no IPv6 sources): use Open in new tab, or report the preview on localhost.",
			"compare.errorFrame": "The app at {url} could not be loaded in the frame. Use Open in new tab.",
			"compare.errorTimeout": "The app at {url} has not loaded; it may be down or refuse to be framed. Use Open in new tab.",
			"inspector.color": "Color",
			"inspector.background": "Background",
			"inspector.contrast": "Contrast",
			"inspector.font": "Font",
			"inspector.size": "Size",
			"inspector.lineHeight": "Line height",
			"inspector.spacing": "Spacing",
			"inspector.radius": "Radius",
			"inspector.unreadable": "unreadable",
			"inspector.imageBackground": "image or gradient",
			"inspector.unknownBackground": "unknown background",
			"inspector.aaLarge": "AA large text (3 : 1)",
			"inspector.aa": "AA (4.5 : 1)",
			"inspector.needs": "needs {needed} : 1",
			"inspector.needsLarge": "needs {needed} : 1 (large text)",
			"inspector.noToken": "no token",
			"inspector.nearest": "Nearest {name}",
			"inspector.weight": "weight {value}",
			"inspector.normal": "normal",
			"inspector.margin": "margin {sides}",
			"inspector.padding": "padding {sides}",
			"inspector.onScale": "on scale",
			"inspector.offScale": "{value} px off scale",
			"inspector.radiusNoToken": "{value} px no token",
			"inspector.noTokens": "No design/system.md tokens found, so values and contrast are shown without a comparison.",
			"inspector.nothingToFix": "Nothing is off the design system, so there is nothing to fix.",
			"inspector.copied": "Copied",
			"inspector.copyFailed": "Could not copy. Use Ask the agent to fix and copy the text from the comment box.",
			"checks.empty": "Checks run when an artboard loads.",
			"checks.groupAria": "Checks for {name}",
			"checks.passed": "Passed: {list}",
			"checks.kind.fail": "Problem",
			"checks.kind.advice": "Advice",
			"checks.show": "Show",
			"checks.showAria": "Show {title} on {label} in {name}",
			"checks.fix": "Ask the agent to fix",
			"checks.fixAria": "Ask the agent to fix {title} on {label}",
			"checks.hidden": "This element is hidden or off-screen; it appears when it receives focus",
			"check.name.contrast": "Text contrast",
			"check.name.target": "Target size",
			"check.name.alt": "Images have alt text",
			"check.name.label": "Form fields have labels",
			"check.name.heading": "Headings in order",
			"check.contrast.title": "Low contrast",
			"check.contrast.detail": "\"{text}\" is {ratio} : 1 ({fg} on {bg}); WCAG AA needs {needed} : 1.",
			"check.contrast.detailLarge": "\"{text}\" is {ratio} : 1 ({fg} on {bg}); WCAG AA needs {needed} : 1 for large text.",
			"check.target.title": "Small touch target",
			"check.target.detail": "{subject} is {width} × {height} px; WCAG 2.2 needs at least {min} × {min} px.",
			"check.targetAdvice.title": "Touch target under 44 px",
			"check.targetAdvice.detail": "{subject} is {width} × {height} px; {advised} × {advised} px is recommended for touch.",
			"check.alt.title": "Image without alt text",
			"check.alt.detail": "{subject} has no alt attribute. Describe it, or use alt=\"\" if it is decorative.",
			"check.alt.detailImage": "The image has no alt attribute. Describe it, or use alt=\"\" if it is decorative.",
			"check.label.title": "Form field without a label",
			"check.label.detail": "The {kind}{hint} has no label. Add a <label for>, aria-label or aria-labelledby; a placeholder is not a label.",
			"check.field.select": "select",
			"check.field.textarea": "text area",
			"check.field.text": "text field",
			"check.field.email": "email field",
			"check.field.password": "password field",
			"check.field.number": "number field",
			"check.field.tel": "tel field",
			"check.field.search": "search field",
			"check.field.url": "url field",
			"check.field.generic": "{type} field",
			"check.heading.title": "Heading level skipped",
			"check.heading.detail.one": "h{level} \"{text}\" follows h{previous}: {missing} is missing.",
			"check.heading.detail.other": "h{level} \"{text}\" follows h{previous}: {missing} are missing.",
			"keys.navigate": "Move around the canvas",
			"keys.comment": "Comment on an element",
			"keys.fit": "Fit all directions",
			"keys.zoom": "Zoom in and out",
			"keys.pan": "Pan (Shift for larger steps)",
			"keys.spaceKey": "Space",
			"keys.drag": "drag",
			"keys.space": "Pan from anywhere, even over an artboard",
			"keys.minimap": "Show or hide the minimap",
			"keys.panel": "Show or hide the review panel",
			"keys.esc": "Leave Comment mode or close the comment box",
			"keys.shiftEsc": "Back to canvas from an artboard or Compare",
			"keys.help": "This list",
			"keys.note": "Single keys are off while you type, while the comment box is open and while an artboard is in use.",
			"keys.customLabel": "Shortcuts you can change",
			"keys.customNote": "Change gives an action another single key; your keys are saved in this browser, for every design.",
			"keys.change": "Change",
			"keys.changeAria": "Change the key for “{action}” ({key})",
			"keys.reset": "Reset",
			"keys.resetAria": "Reset “{action}” to {key}",
			"keys.restore": "Restore defaults",
			"keys.waiting": "Press a key…",
			"keys.waitingMessage": "Press the new key for “{action}”, or Esc to cancel.",
			"keys.assigned": "“{action}” is now {key}.",
			"keys.kept": "“{action}” keeps {key}.",
			"keys.taken": "{key} is already used by “{action}”. Nothing changed.",
			"keys.fixed": "{key} is a fixed key and can’t be assigned. Nothing changed.",
			"keys.invalid": "Use a single letter, digit or punctuation key, without Ctrl, Alt or Cmd. Nothing changed.",
			"keys.resetDone": "“{action}” is back to {key}.",
			"keys.restored": "All shortcuts are back to their defaults.",
			"reason.batch-delivery-unavailable": "This canvas is not connected to a Pi session, so comments cannot be sent. They stay saved; open the canvas from your session with /gentle:design open, then use Send all.",
			"reason.implement-unavailable": "This canvas is not connected to a Pi session, so it cannot hand the artboard off. Open the canvas from your session with /gentle:design open.",
			"reason.variant-unavailable": "This canvas is not connected to a Pi session, so it cannot ask for another direction. Open the canvas from your session with /gentle:design open.",
			"reason.implement-part-unavailable": "This canvas is not connected to a Pi session, so it cannot hand off a part. Open the canvas from your session with /gentle:design open.",
			"reason.invalid-parts": "design/{slug}/parts.json cannot be read, so the part was not sent. Fix the file by hand; it is never overwritten.",
			"reason.too-many-parts": "This design already keeps the most parts it can hold.",
			"reason.invalid-instruction": "This request was rejected by the server. Write 1 to {max} characters and try again.",
			"reason.delivery-failed": "The session did not accept the message. Your comments stay saved and unsent; check that the session is running, then try again.",
			"reason.too-many-comments": "This design has too many comments. Resolve or delete some in comments.json, then try again.",
			"reason.too-many-handoffs": "This design has too many handoffs recorded. Remove old ones from handoffs.json, then try again.",
			"reason.invalid-comments": "comments.json for this design is not valid, so it cannot be changed. Fix or remove the file, then try again.",
			"reason.invalid-handoffs": "handoffs.json for this design is not valid, so it cannot be changed. Fix or remove the file, then try again.",
			"reason.invalid-comment": "This comment was rejected by the server. Write 1 to 2000 characters and try again.",
			"reason.invalid-handoff": "This handoff was rejected by the server. Reload the canvas and try again.",
			"reason.invalid-screenshot": "The screenshot was rejected. Attach a PNG, JPEG, WebP or GIF image of at most 5 MB, or remove it.",
			"reason.body-too-large": "The request was too large. Remove the screenshot or shorten the comment, then try again with something smaller.",
			"reason.file-too-large": "That file is too large for the canvas to show. Make the artboard or asset smaller.",
			"reason.not-found": "That item no longer exists. Reload the canvas to see the current state.",
			"reason.comment-resolved": "This comment is resolved, so its text can no longer change. Reopen it to edit it.",
			"reason.edit-not-delivered": "The new text is saved, but the session did not receive the change. Check that the session is running, then save again.",
			"reason.too-many-streams": "Too many canvas tabs are open. Close the ones you do not use, then reload this one.",
			"reason.internal": "An unexpected error happened in the canvas server. Try again; if it keeps failing, reopen it: open the canvas from your session with /gentle:design open.",
			"reason.forbidden": "The server refused this request. Reload the canvas page, or reopen it with /gentle:design open.",
			"reason.misdirected": "The server refused this request. Reload the canvas page, or reopen it with /gentle:design open.",
			"reason.network": "The canvas could not reach its server; it may have been stopped. Reopen it: open the canvas from your session with /gentle:design open.",
			"reason.invalid": "The server rejected the request as invalid. Reload the canvas and try again.",
			"reason.unknown": "Something went wrong. Try again; if it keeps failing, reopen the canvas: open the canvas from your session with /gentle:design open.",
			"reason.implement.delivery-failed": "The session did not accept the handoff, so it was not recorded. Check that the session is running, then use Implement this again.",
			"reason.variant.delivery-failed": "The session did not accept the request, so nothing was sent. Check that the session is running, then use Send to the session again.",
		},
		es: {
			"common.cancel": "Cancelar",
			"common.close": "Cerrar",
			"common.copy": "Copiar",
			"common.dismiss": "Descartar",
			"common.remove": "Quitar",
			"common.send": "Enviar",
			"common.save": "Guardar",
			"change.prompt": "¿Qué debería cambiar?",
			"session.notConnected": "El canvas no está conectado a una sesión de Pi.",
			"lang.es": "Español",
			"lang.en": "English",
			"lang.auto": "Igual que el navegador",
			"lang.note": "Se guarda en este navegador. Los comentarios se quedan en el idioma en que los escribes; los mensajes al agente siguen en inglés.",
			"rail.label": "Herramientas",
			"rail.navigate": "Mover",
			"rail.navigate.title": "Mover por el lienzo ({key})",
			"rail.comment": "Comentar",
			"rail.comment.title": "Comentar un elemento ({key})",
			"rail.overview": "Ver todo",
			"rail.overview.title": "Ver todas las propuestas ({key})",
			"rail.settings": "Ajustes",
			"rail.settings.title": "Configuración: apariencia, sistema de diseño, atajos de teclado y ayuda paso a paso",
			"rail.appearance": "Apariencia",
			"appearance.theme": "Tema",
			"appearance.language": "Idioma",
			"theme.gentle": "Gentle",
			"theme.gentle.hint": "Estilo Gentleman",
			"theme.neutral": "Neutro",
			"theme.neutral.hint": "Gris oscuro con un acento gris claro",
			"theme.note": "El tema cambia solo el canvas; las propuestas conservan su propio diseño. Se guarda en este navegador.",
			"rail.system": "Sistema de diseño",
			"rail.keys": "Atajos de teclado",
			"rail.help": "Ayuda paso a paso",
			"guide.eyebrow": "Ayuda paso a paso · {n} de {total}",
			"guide.steps": "Pasos",
			"guide.step.compare": "Comparar",
			"guide.step.review": "Revisar",
			"guide.step.choose": "Elegir",
			"guide.step.implement": "Implementar",
			"guide.compare.title": "Estas son tus propuestas",
			"guide.compare.text": "Debajo de cada título verás en qué gana y en qué cede. Pulsa «Abrir» en la que quieras revisar.",
			"guide.review.title": "Revisa esta propuesta",
			"guide.review.text": "Pulsa «Comentar» y haz clic en lo que quieras cambiar. Cuando te convenza, pulsa «Implementar esto».",
			"guide.building.title": "El agente la está construyendo",
			"guide.building.text": "Su cabecera te dice cómo va. Mientras tanto puedes seguir comentando.",
			"guide.done.title": "Ya está implementada",
			"guide.done.text": "Si tu app está en marcha, «Comparar con la app» arriba te enseña el diseño a su lado.",
			"guide.off": "Apagar la ayuda",
			"guide.dismiss": "Entendido",
			"connection.on": "Conectado",
			"connection.onTitle": "Conectado a la sesión de Pi: tus comentarios y peticiones llegan al agente.",
			"connection.off": "Sin conexión",
			"connection.offTitle": "Este canvas no está conectado a una sesión de Pi, así que no puede enviar comentarios ni entregar nada. Abre el canvas desde tu sesión con /gentle:design open {slug}.",
			"bar.label": "Controles del canvas de diseño",
			"bar.design": "Diseño",
			"bar.feature": "Documento de la funcionalidad",
			"bar.compareApp": "Comparar con la app",
			"technical.label": "Detalles técnicos",
			"technical.title": "Selectores e inspector de tokens",
			"zoom.group": "Zoom",
			"zoom.out": "Alejar",
			"zoom.out.title": "Alejar (-)",
			"zoom.level": "Nivel de zoom",
			"zoom.in": "Acercar",
			"zoom.in.title": "Acercar (+)",
			"zoom.fit": "Ajustar todo",
			"zoom.fit.title": "Ajustar todo (0)",
			"layout.group": "Organizar las direcciones",
			"layout.row": "Fila",
			"layout.row.title": "Organizar en fila",
			"layout.column": "Columna",
			"layout.column.title": "Organizar en columna",
			"layout.grid": "Cuadrícula",
			"layout.grid.title": "Organizar en cuadrícula",
			"a11y.ok": "Accesible ✓",
			"a11y.fails.one": "{count} comprobación",
			"a11y.fails.other": "{count} comprobaciones",
			"viewport.label": "Propuestas",
			"mode.navigating": "Moviéndote por el lienzo · rueda para acercar",
			"mode.commenting": "Haz clic en una propuesta para abrirla y comentar · Esc",
			"mode.using": "Usando: {title} · Shift+Esc para salir",
			"back": "Volver al canvas",
			"back.title": "Volver al canvas (Shift+Esc)",
			"minimap.title": "Minimapa",
			"minimap.aria": "Posición del área visible entre las propuestas. Haz clic o arrastra para mover la vista; con el teclado, usa el botón Abrir de cada propuesta.",
			"minimap.aria.one": "Posición del área visible entre {count} propuesta. Haz clic o arrastra para mover la vista; con el teclado, usa el botón Abrir de cada propuesta.",
			"minimap.aria.other": "Posición del área visible entre {count} propuestas. Haz clic o arrastra para mover la vista; con el teclado, usa el botón Abrir de cada propuesta.",
			"panel.label": "Revisión",
			"panel.toggleTitle": "Panel de revisión ({key})",
			"tab.comments": "Comentarios",
			"tab.checks": "Calidad",
			"tabs.prev": "Pestañas anteriores",
			"tabs.next": "Más pestañas",
			"panel.comments": "Comentarios",
			"panel.empty.none": "Aún no hay comentarios",
			"panel.empty.hint": "Abre una propuesta y pulsa «Comentar» sobre lo que quieras cambiar.",
			"panel.empty.open": "No hay comentarios abiertos.",
			"panel.empty.resolved": "No hay comentarios resueltos.",
			"filter.label": "Mostrar comentarios",
			"filter.open": "Abiertos · {count}",
			"filter.resolved": "Resueltos · {count}",
			"filter.all": "Todos",
			"panel.sendMode": "Cuándo se envía un comentario a la sesión",
			"panel.sendNow": "Enviar al momento",
			"panel.collect": "Guardar para enviar luego",
			"panel.footIntro": "Tus comentarios se envían al agente para que cambie el diseño",
			"panel.pending.one": "{count} pendiente de enviar",
			"panel.pending.other": "{count} pendientes de enviar",
			"panel.sendAll": "Enviar todo ({count})",
			"panel.sent.one": "Se envió {count} comentario a la sesión",
			"panel.sent.other": "Se enviaron {count} comentarios a la sesión",
			"panel.noUnsent": "No hay comentarios sin enviar",
			"comment.sent": "Enviado",
			"comment.waiting": "Esperando",
			"comment.detached": "Desvinculado",
			"comment.show": "Mostrar el comentario {number} en {file}",
			"comment.madeAt": "Hecho en {label}",
			"comment.shot": "Captura del comentario {number}",
			"comment.resolve": "Resolver",
			"comment.reopen": "Reabrir",
			"comment.resolveAria": "Resolver comentario {number}",
			"comment.reopenAria": "Reabrir comentario {number}",
			"comment.agent": "Agente:",
			"comment.resolved": "Comentario resuelto",
			"comment.reopened": "Comentario reabierto",
			"comment.edit": "Editar",
			"comment.editAria": "Editar comentario {number}",
			"comment.editLabel": "Texto del comentario {number}",
			"comment.updated": "Comentario actualizado",
			"comment.updatedSent": "Comentario actualizado y enviado a la sesión",
			"comment.status.open": "abierto",
			"comment.status.resolved": "resuelto",
			"pin.aria": "Comentario {number} ({status}): {text}",
			"popover.title": "Comentar en",
			"popover.label": "Comentario",
			"popover.attach": "Adjuntar captura",
			"popover.attachTitle": "O pega una imagen, o suelta una aquí (PNG, JPEG, WebP o GIF, hasta 5 MB)",
			"popover.shotAlt": "Captura adjunta",
			"popover.sending": "Enviando…",
			"popover.tooLong": "Escribe un comentario de 1 a {max} caracteres.",
			"popover.saved": "Guardado; usa Enviar todo para enviarlo",
			"popover.sentDone": "Enviado a la sesión",
			"popover.savedOnly": "Guardado, pero no enviado a la sesión. Usa Enviar todo para volver a intentarlo.",
			"shot.type": "Adjunta una imagen PNG, JPEG, WebP o GIF.",
			"shot.size": "La captura debe pesar 5 MB como máximo.",
			"shot.read": "No se pudo leer la captura.",
			"designs.invalid": "{slug} (design.json no válido)",
			"empty.noDesigns": "Aún no hay diseños. Ejecuta /gentle:design con una petición para crear uno.",
			"empty.cannotShow": "No se puede mostrar el diseño «{slug}»: {message}",
			"empty.noArtboards": "Este diseño aún no tiene propuestas.",
			"empty.cannotList": "No se pueden listar los diseños: {message}",
			"status.invalidManifest": "design.json de {slug} no es válido",
			"status.warnings": "design.json: {warnings}",
			"status.handoffs": "No se puede leer handoffs.json de {slug}: {message}",
			"status.comments": "No se puede leer comments.json de {slug}: {message}",
			"status.disconnected": "Recarga en vivo desconectada, reintentando…",
			"status.layout": "No se pudo guardar la disposición de {slug}: {message}",
			"board.use": "Usar {title}",
			"board.hintUse": "Haz clic para usar este diseño",
			"board.hintSystem": "Haz clic para ver el design system",
			"board.hintComment": "Haz clic para abrirla y comentar",
			"board.comment": "Abrir {title} para comentar",
			"board.frameTitle": "Artboard {title}",
			"board.menuButton": "Más acciones de {title}",
			"board.open": "Abrir",
			"board.openAria": "Abrir la propuesta {number}, {title}",
			"system.title": "Design system",
			"system.tradeoff": "Tokens del proyecto (design/system.md)",
			"system.note": "Los comentarios solo se aplican a los artboards de diseño. Para cambiar el sistema, actualiza las fuentes de diseño del proyecto y ejecuta /gentle:design sync.",
			"system.commentsOff": "Comentarios desactivados en este tablero",
			"system.view": "Ver el design system (solo lectura)",
			"system.frameTitle": "Artboard del design system",
			"overflow.label": "Desborda",
			"overflow.note": "El contenido es más ancho que {width} px, así que parte se corta o requiere desplazamiento lateral con este tamaño.",
			"size.group": "Tamaño de la vista previa",
			"size.phone": "Móvil",
			"size.tablet": "Tablet",
			"size.desktop": "Escritorio",
			"size.preset.title": "{name} {width} × {height}",
			"size.all": "Todos los tamaños",
			"size.all.title": "Todos los tamaños: móvil, tablet y escritorio, lado a lado",
			"size.custom": "Personalizado",
			"size.customAria": "Ancho personalizado en píxeles",
			"size.error": "Introduce un número entero de {min} a {max} (px).",
			"size.frameAria": "{name} {width} por {height}",
			"size.frameTitle": "Artboard {title} en {name} {width} × {height}",
			"device.button": "Tamaño de la vista previa: {size}",
			"device.title": "Tamaño de la vista previa de la propuesta abierta",
			"device.off": "Abre una propuesta para elegir su tamaño de vista previa",
			"implement.start": "Implementar esto",
			"implement.startAria": "Implementar {title} en el proyecto",
			"implement.confirmAria": "Confirmar la implementación de {title}",
			"implement.question": "¿Enviarlo a la sesión para implementarlo?",
			"implement.switch": "Cambiar a esta…",
			"implement.switchAria": "Cambiar la implementación a {title}",
			"implement.switchQuestion": "¿Mover la implementación a esta dirección? La sesión la recibirá como un handoff nuevo.",
			"implement.queued": "En cola: la sesión implementará {title} cuando termine su tarea actual.",
			"implement.sent": "Enviado: la sesión está implementando {title} ahora.",
			"menu.aria": "Acciones de {title}",
			"menu.variant": "Probar otra dirección a partir de esta…",
			"menu.compare": "Comparar con la app",
			"menu.exportPng": "Exportar como PNG",
			"menu.exportPng2x": "Exportar como PNG a 2×",
			"menu.exportPdf": "Exportar como PDF",
			"menu.downloadHtml": "Descargar HTML",
			"download.failed": "No se pudo descargar el artboard. Ábrelo desde design/ en tu proyecto.",
			"menu.implement": "Implementar esto",
			"menu.switch": "Cambiar a esta…",
			"export.failed": "No se pudo exportar el artboard. Usa en su lugar la herramienta de capturas de tu navegador.",
			"export.unavailable": "La captura de pestañas no está disponible en este navegador.",
			"export.confirm": "Elige esta pestaña del canvas en el selector de captura del navegador. Si eliges otra pestaña o pantalla, puede exportarse un contenido equivocado.",
			"export.sharedScreen": "Has compartido una pantalla, no esta pestaña, así que no se puede recortar el artboard de ahí.",
			"export.sharedOther": "Has compartido «{surface}», no esta pestaña, así que no se puede recortar el artboard de ahí.",
			"export.window": "El artboard necesita una ventana del navegador de al menos {width} × {height} px. Agranda la ventana o usa la pantalla completa (F11) y vuelve a intentarlo.",
			"export.noFrame": "El fotograma capturado no tiene dimensiones.",
			"export.noPng": "La exportación a PNG no está disponible.",
			"export.encode": "No se pudo codificar el PNG.",
			"export.denied": "Se denegó la captura o falló.",
			"export.done": "PNG exportado.",
			"export.doneUpscaled": "PNG exportado a 2× (ampliado).",
			"variant.title": "Otra dirección a partir de",
			"variant.note": "La sesión escribe un nuevo artboard, {number}, y conserva los demás.",
			"variant.hint": "De 1 a 2000 caracteres",
			"variant.suggestions": "Sugerencias",
			"variant.send": "Enviar a la sesión",
			"variant.problem": "Escribe de 1 a {max} caracteres sobre lo que debería cambiar.",
			"variant.queued": "En cola: la sesión añadirá una nueva dirección basada en {title} cuando termine su tarea actual.",
			"variant.sent": "Enviado: la sesión está añadiendo una nueva dirección basada en {title} ahora.",
			"variant.compact": "Más compacto",
			"variant.bolder": "Más atrevido",
			"variant.mobile": "Primero móvil",
			"variant.calmer": "Colores más calmados",
			"part.add": "Implementar solo esto",
			"part.addTitle": "Construye solo este elemento en tu app, sin elegir esta propuesta",
			"part.noteTooLong": "La nota puede tener como máximo {max} caracteres.",
			"part.sent": "Enviado: la sesión está construyendo solo esta parte de {title} ahora.",
			"part.queued": "En cola: la sesión construirá solo esta parte de {title} cuando termine su tarea actual.",
			"parts.title": "Implementaciones parciales · {count}",
			"part.state.sent": "Enviado",
			"part.state.queued": "En cola",
			"part.state.in_progress": "En curso",
			"part.state.implemented": "Implementado ✓",
			"part.time.sent": "Enviado a las {time}",
			"part.time.queued": "En cola desde las {time}",
			"part.time.in_progress": "En curso desde las {time}",
			"part.time.implemented": "Implementado a las {time}",
			"part.show": "Mostrar",
			"part.showAria": "Mostrar la parte {n} en {file}",
			"placeholder.title": "Nueva dirección",
			"placeholder.aria": "{number} · Nueva dirección",
			"placeholder.state": "Diseñando…",
			"placeholder.status": "Diseñando la nueva dirección…",
			"handoff.queued": "En cola",
			"handoff.sent": "Implementando…",
			"handoff.in_progress": "En curso",
			"handoff.implemented": "Implementado ✓",
			"choice.chosen": "Elegido",
			"choice.discarded": "Descartada",
			"handoff.featureTitle": "Seguimiento en este documento de funcionalidad ODD",
			"handoff.compare": "Comparar",
			"handoff.compareAria": "Comparar {title} con la app en ejecución",
			"timeline.title": "Handoff · {title}",
			"timeline.sent": "Enviado a la sesión",
			"timeline.implemented": "Implementado",
			"timeline.queued": "En cola · {time}",
			"timeline.useImplement": "Usa Implementar esto para enviarlo",
			"timeline.compareWhenReady": "Compara con la app en ejecución cuando esté lista",
			"timeline.done": "(hecho)",
			"timeline.current": "(actual)",
			"timeline.pending": "(pendiente)",
			"stepper.sent": "Enviado",
			"stepper.position": "Paso {n} de {total}: {step}",
			"time.today": "Hoy {clock}",
			"compare.title": "Comparar",
			"compare.titleFor": "Comparar: {title}",
			"compare.fit": "Ajustar a la ventana",
			"compare.open": "Abrir en una pestaña nueva",
			"compare.designCaption": "Diseño: {file}",
			"compare.appCaption": "Implementación: {url}",
			"compare.appFrame": "App en ejecución en {url}",
			"compare.hint": "Si el panel de la app se queda vacío, puede que la app no esté en marcha en {url} o que no permita mostrarse en un marco: arráncala o usa Abrir en una pestaña nueva.",
			"compare.hintIpv6": "Los navegadores no muestran [::1] en un marco con la política del canvas (CSP no admite fuentes IPv6): usa Abrir en una pestaña nueva, o indica la vista previa en localhost.",
			"compare.errorFrame": "No se pudo cargar la app de {url} en el marco. Usa Abrir en una pestaña nueva.",
			"compare.errorTimeout": "La app de {url} no se ha cargado; puede estar caída o no permitir mostrarse en un marco. Usa Abrir en una pestaña nueva.",
			"inspector.color": "Color",
			"inspector.background": "Fondo",
			"inspector.contrast": "Contraste",
			"inspector.font": "Fuente",
			"inspector.size": "Tamaño",
			"inspector.lineHeight": "Interlineado",
			"inspector.spacing": "Espaciado",
			"inspector.radius": "Radio",
			"inspector.unreadable": "ilegible",
			"inspector.imageBackground": "imagen o degradado",
			"inspector.unknownBackground": "fondo desconocido",
			"inspector.aaLarge": "AA texto grande (3 : 1)",
			"inspector.aa": "AA (4.5 : 1)",
			"inspector.needs": "requiere {needed} : 1",
			"inspector.needsLarge": "requiere {needed} : 1 (texto grande)",
			"inspector.noToken": "sin token",
			"inspector.nearest": "Más cercano: {name}",
			"inspector.weight": "peso {value}",
			"inspector.normal": "normal",
			"inspector.margin": "margen {sides}",
			"inspector.padding": "relleno {sides}",
			"inspector.onScale": "en la escala",
			"inspector.offScale": "{value} px fuera de la escala",
			"inspector.radiusNoToken": "{value} px sin token",
			"inspector.noTokens": "No se encontraron tokens de design/system.md, así que se muestran los valores y el contraste sin comparación.",
			"inspector.nothingToFix": "Nada se sale del design system, así que no hay nada que corregir.",
			"inspector.copied": "Copiado",
			"inspector.copyFailed": "No se pudo copiar. Usa Pedir al agente que lo corrija y copia el texto del cuadro de comentario.",
			"checks.empty": "Las comprobaciones se ejecutan al cargar un artboard.",
			"checks.groupAria": "Comprobaciones de {name}",
			"checks.passed": "Superadas: {list}",
			"checks.kind.fail": "Problema",
			"checks.kind.advice": "Consejo",
			"checks.show": "Mostrar",
			"checks.showAria": "Mostrar {title} en {label} de {name}",
			"checks.fix": "Pedir al agente que lo corrija",
			"checks.fixAria": "Pedir al agente que corrija {title} en {label}",
			"checks.hidden": "Este elemento está oculto o fuera de pantalla; aparece al recibir foco",
			"check.name.contrast": "Contraste del texto",
			"check.name.target": "Tamaño de los objetivos táctiles",
			"check.name.alt": "Imágenes con texto alternativo",
			"check.name.label": "Campos de formulario con etiqueta",
			"check.name.heading": "Encabezados en orden",
			"check.contrast.title": "Contraste bajo",
			"check.contrast.detail": "\"{text}\" tiene {ratio} : 1 ({fg} sobre {bg}); WCAG AA exige {needed} : 1.",
			"check.contrast.detailLarge": "\"{text}\" tiene {ratio} : 1 ({fg} sobre {bg}); WCAG AA exige {needed} : 1 para texto grande.",
			"check.target.title": "Objetivo táctil pequeño",
			"check.target.detail": "{subject} mide {width} × {height} px; WCAG 2.2 exige al menos {min} × {min} px.",
			"check.targetAdvice.title": "Objetivo táctil de menos de 44 px",
			"check.targetAdvice.detail": "{subject} mide {width} × {height} px; se recomiendan {advised} × {advised} px para uso táctil.",
			"check.alt.title": "Imagen sin texto alternativo",
			"check.alt.detail": "{subject} no tiene atributo alt. Descríbela o usa alt=\"\" si es decorativa.",
			"check.alt.detailImage": "La imagen no tiene atributo alt. Descríbela o usa alt=\"\" si es decorativa.",
			"check.label.title": "Campo de formulario sin etiqueta",
			"check.label.detail": "Falta etiqueta en {kind}{hint}. Añade un <label for>, aria-label o aria-labelledby; un placeholder no es una etiqueta.",
			"check.field.select": "lista desplegable",
			"check.field.textarea": "área de texto",
			"check.field.text": "campo de texto",
			"check.field.email": "campo de correo electrónico",
			"check.field.password": "campo de contraseña",
			"check.field.number": "campo numérico",
			"check.field.tel": "campo de teléfono",
			"check.field.search": "campo de búsqueda",
			"check.field.url": "campo de URL",
			"check.field.generic": "campo {type}",
			"check.heading.title": "Nivel de encabezado omitido",
			"check.heading.detail.one": "h{level} \"{text}\" sigue a h{previous}: falta {missing}.",
			"check.heading.detail.other": "h{level} \"{text}\" sigue a h{previous}: faltan {missing}.",
			"keys.navigate": "Moverte por el lienzo",
			"keys.comment": "Comentar un elemento",
			"keys.fit": "Ajustar todas las propuestas",
			"keys.zoom": "Acercar y alejar",
			"keys.pan": "Desplazar (Shift para pasos más grandes)",
			"keys.spaceKey": "Espacio",
			"keys.drag": "arrastrar",
			"keys.space": "Desplázate desde cualquier punto, también sobre una propuesta",
			"keys.minimap": "Mostrar u ocultar el minimapa",
			"keys.panel": "Mostrar u ocultar el panel de revisión",
			"keys.esc": "Salir del modo Comentar o cerrar el cuadro de comentario",
			"keys.shiftEsc": "Volver al canvas desde un artboard o Comparar",
			"keys.help": "Esta lista",
			"keys.note": "Las teclas sueltas se desactivan mientras escribes, mientras el cuadro de comentario está abierto y mientras usas un artboard.",
			"keys.customLabel": "Atajos que puedes cambiar",
			"keys.customNote": "Cambiar da a una acción otra tecla; tus teclas se guardan en este navegador, para todos los diseños.",
			"keys.change": "Cambiar",
			"keys.changeAria": "Cambiar la tecla de «{action}» ({key})",
			"keys.reset": "Restablecer",
			"keys.resetAria": "Restablecer «{action}» a {key}",
			"keys.restore": "Restaurar los predeterminados",
			"keys.waiting": "Pulsa una tecla…",
			"keys.waitingMessage": "Pulsa la nueva tecla de «{action}», o Esc para cancelar.",
			"keys.assigned": "«{action}» ahora es {key}.",
			"keys.kept": "«{action}» sigue con {key}.",
			"keys.taken": "La {key} ya la usa «{action}». No ha cambiado nada.",
			"keys.fixed": "{key} es una tecla fija y no se puede asignar. No ha cambiado nada.",
			"keys.invalid": "Usa una sola letra, cifra o signo, sin Ctrl, Alt ni Cmd. No ha cambiado nada.",
			"keys.resetDone": "«{action}» vuelve a {key}.",
			"keys.restored": "Todos los atajos vuelven a sus valores predeterminados.",
			"reason.batch-delivery-unavailable": "Este canvas no está conectado a una sesión de Pi, así que no se pueden enviar los comentarios. Se quedan guardados; abre el canvas desde tu sesión con /gentle:design open y usa Enviar todo.",
			"reason.implement-unavailable": "Este canvas no está conectado a una sesión de Pi, así que no puede entregar el artboard. Abre el canvas desde tu sesión con /gentle:design open.",
			"reason.variant-unavailable": "Este canvas no está conectado a una sesión de Pi, así que no puede pedir otra dirección. Abre el canvas desde tu sesión con /gentle:design open.",
			"reason.implement-part-unavailable": "Este canvas no está conectado a una sesión de Pi, así que no puede enviar una parte. Abre el canvas desde tu sesión con /gentle:design open.",
			"reason.invalid-parts": "No se puede leer design/{slug}/parts.json, así que la parte no se envió. Corrige el archivo a mano; nunca se sobrescribe.",
			"reason.too-many-parts": "Este diseño ya guarda el máximo de partes que admite.",
			"reason.invalid-instruction": "El servidor rechazó esta solicitud. Escribe de 1 a {max} caracteres y vuelve a intentarlo.",
			"reason.delivery-failed": "La sesión no aceptó el mensaje. Tus comentarios quedan guardados y sin enviar; comprueba que la sesión esté en marcha y vuelve a intentarlo.",
			"reason.too-many-comments": "Este diseño tiene demasiados comentarios. Resuelve o elimina algunos en comments.json y vuelve a intentarlo.",
			"reason.too-many-handoffs": "Este diseño tiene demasiados handoffs registrados. Elimina los antiguos de handoffs.json y vuelve a intentarlo.",
			"reason.invalid-comments": "comments.json de este diseño no es válido, así que no se puede modificar. Corrige o elimina el archivo y vuelve a intentarlo.",
			"reason.invalid-handoffs": "handoffs.json de este diseño no es válido, así que no se puede modificar. Corrige o elimina el archivo y vuelve a intentarlo.",
			"reason.invalid-comment": "El servidor rechazó este comentario. Escribe de 1 a 2000 caracteres y vuelve a intentarlo.",
			"reason.invalid-handoff": "El servidor rechazó este handoff. Recarga el canvas y vuelve a intentarlo.",
			"reason.invalid-screenshot": "Se rechazó la captura. Adjunta una imagen PNG, JPEG, WebP o GIF de 5 MB como máximo, o quítala.",
			"reason.body-too-large": "La solicitud era demasiado grande. Quita la captura o acorta el comentario y vuelve a intentarlo con algo más pequeño.",
			"reason.file-too-large": "Ese archivo es demasiado grande para que el canvas lo muestre. Reduce el tamaño del artboard o del recurso.",
			"reason.not-found": "Ese elemento ya no existe. Recarga el canvas para ver el estado actual.",
			"reason.comment-resolved": "Este comentario está resuelto, así que su texto ya no puede cambiar. Reábrelo para editarlo.",
			"reason.edit-not-delivered": "El texto nuevo está guardado, pero la sesión no recibió el cambio. Comprueba que la sesión esté en marcha y vuelve a guardar.",
			"reason.too-many-streams": "Hay demasiadas pestañas del canvas abiertas. Cierra las que no uses y recarga esta.",
			"reason.internal": "Ocurrió un error inesperado en el servidor del canvas. Inténtalo de nuevo; si sigue fallando, vuelve a abrirlo: abre el canvas desde tu sesión con /gentle:design open.",
			"reason.forbidden": "El servidor rechazó esta solicitud. Recarga la página del canvas o vuelve a abrirla con /gentle:design open.",
			"reason.misdirected": "El servidor rechazó esta solicitud. Recarga la página del canvas o vuelve a abrirla con /gentle:design open.",
			"reason.network": "El canvas no pudo conectar con su servidor; es posible que se haya detenido. Vuelve a abrirlo: abre el canvas desde tu sesión con /gentle:design open.",
			"reason.invalid": "El servidor rechazó la solicitud por no ser válida. Recarga el canvas y vuelve a intentarlo.",
			"reason.unknown": "Algo salió mal. Inténtalo de nuevo; si sigue fallando, vuelve a abrir el canvas: abre el canvas desde tu sesión con /gentle:design open.",
			"reason.implement.delivery-failed": "La sesión no aceptó el handoff, así que no se registró. Comprueba que la sesión esté en marcha y usa Implementar esto de nuevo.",
			"reason.variant.delivery-failed": "La sesión no aceptó la solicitud, así que no se envió nada. Comprueba que la sesión esté en marcha y usa Enviar a la sesión de nuevo.",
		},
	};
	/* catalog:end */

	// ---- language (S1, S2, S4) ---------------------------------------------------
	// The language is a stored choice (es, en or auto = the browser's); `language` is what it resolves to.
	// Text is written through t / tn; text that stays on screen after it is written is also marked with
	// data-i18n attributes (see loc), so a switch rewrites it in place and nothing reloads.

	const LANG_KEY = "gentle-design:language";
	const LANG_CHOICES = ["es", "en", "auto"];
	// Where each kind of localized text goes, and the attribute that names its key (its arguments are in "<attribute>-args").
	const LOC_TARGETS = [
		["text", "data-i18n"],
		["title", "data-i18n-title"],
		["aria-label", "data-i18n-aria-label"],
		["aria-valuetext", "data-i18n-aria-valuetext"],
		["placeholder", "data-i18n-placeholder"],
		["alt", "data-i18n-alt"],
	];

	/** The browser's language: es, es-MX... is Spanish; anything else, or nothing, is English. */
	function browserLanguage() {
		try {
			const agent = typeof navigator === "object" && navigator ? navigator : null;
			const first = agent && Array.isArray(agent.languages) && typeof agent.languages[0] === "string" && agent.languages[0] ? agent.languages[0] : agent && typeof agent.language === "string" ? agent.language : "";
			return /^es([-_]|$)/i.test(first) ? "es" : "en";
		} catch {
			return "en";
		}
	}

	function storedLanguage() {
		try {
			const value = localStorage.getItem(LANG_KEY);
			return LANG_CHOICES.includes(value) ? value : "auto";
		} catch {
			return "auto";
		}
	}

	const resolveLanguage = (choice) => (choice === "es" || choice === "en" ? choice : browserLanguage());
	let languageChoice = storedLanguage();
	let language = resolveLanguage(languageChoice);

	// ---- theme (canvas-layout S15) -------------------------------------------------
	// Gentle is :root's tokens; Neutral is data-theme="neutral" on <html>, which canvas.css gives its own tokens.

	function storedTheme() {
		try {
			return localStorage.getItem(THEME_KEY) === "neutral" ? "neutral" : "gentle";
		} catch {
			return "gentle";
		}
	}

	let theme = storedTheme();

	function applyTheme() {
		if (theme === "neutral") document.documentElement.setAttribute("data-theme", "neutral");
		else document.documentElement.removeAttribute("data-theme");
	}

	// Before anything is drawn, so a Neutral page never shows the pink first.
	applyTheme();

	const hasKey = (key) => Object.prototype.hasOwnProperty.call(CATALOG.en, key);

	/** The text of `key` in the current language, or in English when the Spanish entry is missing; {name} takes `params`. */
	function t(key, params) {
		const own = Object.prototype.hasOwnProperty.call(CATALOG[language], key);
		const text = own ? CATALOG[language][key] : hasKey(key) ? CATALOG.en[key] : key;
		return text.replace(/\{(\w+)\}/g, (match, name) => {
			if (!params || !Object.prototype.hasOwnProperty.call(params, name)) return match;
			const value = params[name];
			return value && typeof value === "object" && typeof value.ref === "string" ? t(value.ref) : String(value);
		});
	}

	/** The key for a count: key.one for 1, key.other otherwise (English and Spanish agree). */
	const plural = (key, count) => `${key}.${count === 1 ? "one" : "other"}`;
	const tn = (key, count, params) => t(plural(key, count), { count, ...params });
	/** A parameter that is itself a catalog key, so the sentence that holds it follows a switch of language. */
	const ref = (key) => ({ ref: key });
	/** Text for the agent, not for the person: S3 keeps it English whatever the language. */
	const toSession = (text) => text;

	function writeLoc(element, target, value) {
		if (target === "text") element.textContent = value;
		else if (target === "title") element.title = value;
		else if (value === null) element.removeAttribute(target);
		else element.setAttribute(target, value);
	}

	/**
	 * Writes the text of `key` into `target` of `element` (text, title or an attribute) and remembers the key
	 * and its arguments on the element, so the next switch of language rewrites it. No key clears it.
	 */
	function loc(element, target, key, params, pad) {
		const attribute = LOC_TARGETS.find((entry) => entry[0] === target)[1];
		if (!key) {
			element.removeAttribute(attribute);
			element.removeAttribute(`${attribute}-args`);
			element.removeAttribute(`${attribute}-pad`);
			writeLoc(element, target, target === "text" || target === "title" ? "" : null);
			return;
		}
		element.setAttribute(attribute, key);
		if (params) element.setAttribute(`${attribute}-args`, JSON.stringify(params));
		else element.removeAttribute(`${attribute}-args`);
		// A space ahead of text that follows other text (visually hidden sentences).
		if (pad) element.setAttribute(`${attribute}-pad`, "1");
		else element.removeAttribute(`${attribute}-pad`);
		writeLoc(element, target, (pad ? " " : "") + t(key, params));
	}

	/** Rewrites everything marked with a key: the static text of index.html and what loc remembered. */
	function refreshLoc() {
		for (const [target, attribute] of LOC_TARGETS) {
			for (const element of document.querySelectorAll(`[${attribute}]`)) {
				let params;
				const raw = element.getAttribute(`${attribute}-args`);
				if (raw) {
					try { params = JSON.parse(raw); } catch { params = undefined; }
				}
				writeLoc(element, target, (element.getAttribute(`${attribute}-pad`) ? " " : "") + t(element.getAttribute(attribute), params));
			}
		}
	}

	/** Intl locale for dates. */
	const dateLocale = () => (language === "es" ? "es" : "en-US");

	const $ = (id) => document.getElementById(id);
	const els = {
		design: $("gd-design"),
		designField: $("gd-design-field"),
		feature: $("gd-feature"),
		zoomOut: $("gd-zoom-out"),
		zoomIn: $("gd-zoom-in"),
		zoomLevel: $("gd-zoom-level"),
		fit: $("gd-fit"),
		navMode: $("gd-nav-mode"),
		toolNavigate: $("gd-tool-navigate"),
		railFit: $("gd-rail-fit"),
		railSettings: $("gd-rail-settings"),
		connection: $("gd-connection"),
		guide: $("gd-guide"),
		guideSpot: $("gd-guide-spot"),
		guideEyebrow: $("gd-guide-eyebrow"),
		guideTitle: $("gd-guide-title"),
		guideText: $("gd-guide-text"),
		guideSteps: $("gd-guide-steps"),
		guideSkip: $("gd-guide-skip"),
		guideNext: $("gd-guide-next"),
		guideNextLabel: $("gd-guide-next-label"),
		shortcuts: $("gd-shortcuts"),
		shortcutsClose: $("gd-shortcuts-close"),
		appearance: $("gd-appearance"),
		appearanceClose: $("gd-appearance-close"),
		themeInputs: Object.fromEntries(THEMES.map((name) => [name, $(`gd-theme-${name}`)])),
		languageInputs: Object.fromEntries(LANG_CHOICES.map((choice) => [choice, $(`gd-language-${choice}`)])),
		keysCustom: $("gd-keys-custom"),
		keysMessage: $("gd-keys-message"),
		keysRestore: $("gd-keys-restore"),
		minimapKey: $("gd-minimap-key"),
		featureSep: $("gd-feature-sep"),
		compareApp: $("gd-compare-app"),
		technical: $("gd-technical"),
		tabs: $("gd-tabs"),
		tabsPrev: $("gd-tabs-prev"),
		tabsNext: $("gd-tabs-next"),
		tabChecks: $("gd-tab-checks"),
		countChecks: $("gd-count-checks"),
		checks: $("gd-checks"),
		partAdd: $("gd-popover-part"),
		partsPanel: $("gd-parts-panel"),
		partsTitle: $("gd-parts-title"),
		partsList: $("gd-parts-list"),
		countOpen: $("gd-count-open"),
		tabPanel: $("gd-tabpanel"),
		handoffPanel: $("gd-handoff-panel"),
		handoffTitle: $("gd-handoff-title"),
		timeline: $("gd-timeline"),
		back: $("gd-back"),
		minimap: $("gd-minimap"),
		minimapMap: $("gd-minimap-map"),
		minimapView: $("gd-minimap-view"),
		comment: $("gd-comment"),
		status: $("gd-status"),
		viewport: $("gd-viewport"),
		world: $("gd-world"),
		empty: $("gd-empty"),
		popover: $("gd-popover"),
		form: $("gd-popover-form"),
		target: $("gd-popover-target"),
		text: $("gd-popover-text"),
		message: $("gd-popover-message"),
		cancel: $("gd-popover-cancel"),
		send: $("gd-popover-send"),
		shotInput: $("gd-shot-input"),
		shotAttach: $("gd-shot-attach"),
		shotPreview: $("gd-shot-preview"),
		shotImage: $("gd-shot-image"),
		shotRemove: $("gd-shot-remove"),
		modeSend: $("gd-mode-send"),
		modeCollect: $("gd-mode-collect"),
		sendAll: $("gd-send-all"),
		sendNote: $("gd-send-note"),
		sendPending: $("gd-send-pending"),
		panelToggle: $("gd-panel-toggle"),
		panel: $("gd-panel"),
		tabComments: $("gd-tab-comments"),
		commentFilter: $("gd-comment-filter"),
		filterOpen: $("gd-filter-open"),
		filterResolved: $("gd-filter-resolved"),
		filterAll: $("gd-filter-all"),
		commentsEmpty: $("gd-comments-empty"),
		panelEmpty: $("gd-panel-empty"),
		list: $("gd-comment-list"),
		toast: $("gd-toast"),
		compare: $("gd-compare"),
		compareTitle: $("gd-compare-title"),
		compareFit: $("gd-compare-fit"),
		compareFitField: $("gd-compare-fit-field"),
		compareOpen: $("gd-compare-open"),
		compareBack: $("gd-compare-back"),
		compareMessage: $("gd-compare-message"),
		compareStage: $("gd-compare-stage"),
		compareSizer: $("gd-compare-sizer"),
		comparePanes: $("gd-compare-panes"),
		inspector: $("gd-inspector"),
		inspectorTitle: $("gd-inspector-title"),
		inspectorSelector: $("gd-inspector-selector"),
		inspectorList: $("gd-inspector-list"),
		inspectorNote: $("gd-inspector-note"),
		inspectorFix: $("gd-inspector-fix"),
		inspectorCopy: $("gd-inspector-copy"),
		menu: $("gd-menu"),
		arrange: Object.fromEntries(ARRANGEMENTS.map((kind) => [kind, $(`gd-arrange-${kind}`)])),
		device: $("gd-device"),
		deviceIcon: $("gd-device-icon"),
		deviceName: $("gd-device-name"),
		deviceSize: $("gd-device-size"),
		deviceMenu: $("gd-device-menu"),
		variantDialog: $("gd-variant"),
		variantForm: $("gd-variant-form"),
		variantSource: $("gd-variant-source"),
		variantNote: $("gd-variant-note"),
		variantText: $("gd-variant-text"),
		variantChips: $("gd-variant-chips"),
		variantMessage: $("gd-variant-message"),
		variantCancel: $("gd-variant-cancel"),
		variantSend: $("gd-variant-send"),
	};

	function storedMode() {
		try {
			return localStorage.getItem(MODE_KEY) === "collect" ? "collect" : "send";
		} catch {
			return "send";
		}
	}

	function storedTechnical() {
		try {
			return localStorage.getItem(TECHNICAL_KEY) === "on";
		} catch {
			return false;
		}
	}

	const state = {
		slug: typeof config.slug === "string" ? config.slug : null,
		manifest: null,
		boards: [],
		system: null,
		systemBoard: null,
		zoom: 1,
		// True while the view is the one Fit gave; a resize then fits again (refit).
		fitted: false,
		x: FIT_PADDING,
		y: FIT_PADDING,
		commenting: false,
		pick: null,
		// The one screenshot of the open popover: { mimeType, data: base64 }, or null.
		shot: null,
		shotToken: 0,
		closeTimer: 0,
		comments: [],
		// The review tab (TAB_NAMES), and which comments the Comments tab lists: "open", "resolved" or "all".
		tab: "comments",
		filter: "open",
		mode: storedMode(),
		// Technical details: selectors on the cards and the token inspector, off unless switched on (TECHNICAL_KEY).
		technical: storedTechnical(),
		// The step-by-step help: on (saved in this browser), the step whose card was dismissed with Got it, and where focus
		// was when the card took it (only when you turn it on).
		help: { on: false, dismissed: null, returnFocus: null },
		// The design's parts handed off on their own (parts.json, canvas-implement-part S3).
		parts: { slug: null, parts: [] },
		activeId: null,
		designCount: 0,
		// Where the boards sit in the world (canvas-layout S1-S3), as design/<slug>/layout.json keeps it: the arrangement
		// ("row", "column", "grid", or "free" once a board is moved by hand) and each board's top left by its key, in world
		// px with the bounds' top left at 0, 0. `saved` is the JSON last read or written, so the page's own write is not news.
		layout: { slug: null, arrangement: "row", positions: {}, saved: "null" },
		// Layout saves still in flight: until they land, a layout.json change may be older than what the page shows.
		layoutSaves: 0,
		// The artboard pressed last, outlined until a press elsewhere, Esc or focus mode (canvas-layout S10), or null.
		selected: null,
		// Space held to pan (canvas-layout S9): { used } once a press panned with it, or null.
		space: null,
		// The minimap's switch (M); it also hides in focus mode and Compare.
		minimap: true,
		// The open artboard menu: { board, button, items, actions }, or null.
		menu: null,
		// The open device menu: { items, input, error }, or null.
		deviceMenu: null,
		// The open "another direction" dialog: { board, button, sending }, or null.
		variant: null,
		// The "<NN> · New direction" board shown until the manifest changes, or null.
		placeholder: null,
		// The focused board, and the view to restore when focus mode ends.
		focus: null,
		savedView: null,
		savedPanel: null,
		// The size shown while focused: { kind: "phone" | "tablet" | "desktop" | "all" }, or { kind: "custom", width }.
		size: { kind: "desktop" },
		// The project's design tokens (design/system.md), for the inspector: [{ name, value, section, group }].
		tokens: [],
		// The ring Show draws around a finding's element: { board, issue, ring, label, card }, or null. One at a time.
		mark: null,
		// The element the inspector panel shows: { surface, measure, flags, text }, and what keeps the panel open.
		inspect: null,
		inspectGen: 0,
		inspectorHover: false,
		// The handoffs.json of design `slug`; boards of another design ignore it.
		handoffs: { slug: null, chosen: null, handoffs: {} },
		// The open Compare view: { board, preview, artboardFrame, appFrame, timer, loaded }.
		compare: null,
		toastTimer: 0,
		// Failed resolve or reopen replies by comment id, shown in that comment's card.
		cardErrors: new Map(),
		// Drafts of the comments being edited in their card (canvas-layout S17), by id; they survive a re-render.
		editing: new Map(),
	};

	/** The status line: the text of `key` (none clears it), kept in the language of the page. */
	function setStatus(key, isError, params) {
		loc(els.status, "text", key, params);
		els.status.classList.toggle("gd-error", Boolean(isError));
	}

	/** Text that is not the canvas's own (a code, a server reason, a browser message): shown as it is, never translated. */
	function setRaw(element, text) {
		loc(element, "text", null);
		element.textContent = text;
	}

	/**
	 * A failed reply in words: { key, params, text, detail }: the catalog key of the sentence with the cause and the way out,
	 * that sentence now, and the raw code (and the server's own reason) as the detail, which is never translated.
	 * `action` picks an action-specific sentence over the generic one, when it has one: a refused handoff is taken back,
	 * so it is not "unsent comments". `reply` is what postJson returns; a code without a sentence gets a generic one.
	 */
	function explain(reply, action) {
		const body = reply && reply.body && typeof reply.body === "object" ? reply.body : {};
		const code = typeof body.error === "string" && body.error ? body.error : `http-${reply ? reply.status : 0}`;
		const reason = typeof body.reason === "string" && body.reason ? body.reason : "";
		let key = action && hasKey(`reason.${action}.${code}`) ? `reason.${action}.${code}` : `reason.${code}`;
		if (!hasKey(key)) key = code.startsWith("invalid-") ? "reason.invalid" : "reason.unknown";
		const params = { max: LIMITS.variant };
		return { key, params, text: t(key, params), detail: reason ? `${code}: ${reason}` : code };
	}

	/** A sprite icon; the SVG namespace comes from the page's own icon in the footer alert. */
	function icon(name, className) {
		const SVG_NS = document.getElementById("gd-send-alert-icon").namespaceURI;
		const svg = document.createElementNS(SVG_NS, "svg");
		svg.setAttribute("class", className);
		svg.setAttribute("aria-hidden", "true");
		const use = document.createElementNS(SVG_NS, "use");
		use.setAttribute("href", `#${name}`);
		svg.append(use);
		return svg;
	}

	/** An inline error next to the action that failed: icon, sentence, small code, and a dismiss button. */
	function createAlert() {
		const root = document.createElement("div");
		root.className = "gd-alert";
		root.setAttribute("role", "alert");
		root.hidden = true;
		const body = document.createElement("div");
		body.className = "gd-alert-body";
		const text = document.createElement("p");
		text.className = "gd-alert-text";
		const detail = document.createElement("small");
		detail.className = "gd-alert-detail";
		body.append(text, detail);
		const dismiss = document.createElement("button");
		dismiss.type = "button";
		dismiss.className = "gd-alert-dismiss";
		loc(dismiss, "aria-label", "common.dismiss");
		loc(dismiss, "title", "common.dismiss");
		dismiss.append(icon("i-x", "gd-i"));
		root.append(icon("i-alert", "gd-i gd-alert-icon"), body, dismiss);
		return alertParts(root, text, detail, dismiss);
	}

	function alertParts(root, text, detail, dismiss) {
		const parts = { root, text, detail, dismiss };
		dismiss.addEventListener("click", () => {
			hideAlert(parts);
			if (parts.onDismiss) parts.onDismiss();
		});
		return parts;
	}

	function showAlert(parts, reply, action) {
		const info = explain(reply, action);
		loc(parts.text, "text", info.key, info.params);
		setRaw(parts.detail, info.detail);
		parts.root.title = info.detail;
		parts.root.hidden = false;
	}

	function hideAlert(parts) {
		parts.root.hidden = true;
		loc(parts.text, "text", null);
		setRaw(parts.detail, "");
	}

	const sendAlert = alertParts($("gd-send-alert"), $("gd-send-alert-text"), $("gd-send-alert-detail"), $("gd-send-alert-dismiss"));

	/** A confirmation that stays on screen for a few seconds, beyond the status line. */
	function showToast(text, isError) {
		clearTimeout(state.toastTimer);
		els.toast.textContent = text;
		els.toast.classList.toggle("gd-error", Boolean(isError));
		els.toast.hidden = false;
		state.toastTimer = setTimeout(() => { els.toast.hidden = true; }, TOAST_MS);
	}

	function fileUrl(slug, file) {
		return `${base}files/${encodeURIComponent(slug)}/${file.split("/").map(encodeURIComponent).join("/")}`;
	}

	async function getJson(path) {
		const response = await fetch(base + path, { headers: { Accept: "application/json" }, cache: "no-store" });
		let body = null;
		try { body = await response.json(); } catch { body = null; }
		if (!response.ok) {
			const reason = body && (body.reason || body.error);
			throw new Error(reason ? String(reason) : `HTTP ${response.status}`);
		}
		return body;
	}

	// ---- view transform -------------------------------------------------

	function clampZoom(value) {
		return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
	}

	function applyView() {
		els.world.style.transform = `translate(${state.x}px, ${state.y}px) scale(${state.zoom})`;
		els.world.style.setProperty("--gd-inv-zoom", String(1 / state.zoom));
		els.zoomLevel.textContent = `${Math.round(state.zoom * 100)}%`;
		for (const board of allBoards()) board.wrapper.classList.toggle("gd-compact", board.artboard.width * state.zoom < COMPACT_BOARD_WIDTH);
		closeMenu(false);
		renderMinimap();
		placeGuide();
	}

	/** Zoom so the world point under (px, py) in viewport coordinates stays put. */
	function zoomAt(nextZoom, px, py) {
		const zoom = clampZoom(nextZoom);
		state.x = px - (px - state.x) * (zoom / state.zoom);
		state.y = py - (py - state.y) * (zoom / state.zoom);
		state.zoom = zoom;
		state.fitted = false;
		applyView();
		closePopover();
	}

	function zoomAtCenter(factor) {
		const rect = els.viewport.getBoundingClientRect();
		zoomAt(state.zoom * factor, rect.width / 2, rect.height / 2);
	}

	function panBy(dx, dy) {
		state.x += dx;
		state.y += dy;
		state.fitted = false;
		applyView();
		closePopover();
	}

	function fit() {
		if (state.focus) return;
		// A label may have grown (a handoff row, a wrapped tradeoff) since the boards were placed.
		sizeWorld();
		const rect = els.viewport.getBoundingClientRect();
		const width = els.world.offsetWidth;
		const height = els.world.offsetHeight;
		if (!width || !height) return;
		const zoom = clampZoom(Math.min((rect.width - FIT_PADDING * 2) / width, (rect.height - FIT_PADDING * 2) / height, 1));
		state.zoom = zoom;
		state.x = (rect.width - width * zoom) / 2;
		state.y = Math.max(FIT_PADDING, (rect.height - height * zoom) / 2);
		state.fitted = true;
		applyView();
		closePopover();
	}

	// ---- minimap ----------------------------------------------------------

	/** What the minimap shows is whatever the world lays out, in order: the boards and any placeholder board (class gd-placeholder). */
	function minimapEntries() {
		const boards = allBoards();
		const entries = [];
		for (const wrapper of Array.from(els.world.children)) {
			const board = boards.find((candidate) => candidate.wrapper === wrapper);
			if (board) entries.push({ wrapper, board });
			else if (wrapper.classList.contains("gd-placeholder")) entries.push({ wrapper, board: null });
		}
		return entries;
	}

	/** Where the world box (0, 0) lands in the map, and how big a world px is there: the boards' bounds fitted to the map. */
	function minimapScale(rects) {
		const minX = Math.min(...rects.map((rect) => rect.x));
		const minY = Math.min(...rects.map((rect) => rect.y));
		const width = Math.max(...rects.map((rect) => rect.x + rect.width)) - minX;
		const height = Math.max(...rects.map((rect) => rect.y + rect.height)) - minY;
		const scale = Math.min((MINIMAP.width - MINIMAP.pad * 2) / width, (MINIMAP.height - MINIMAP.pad * 2) / height);
		return { scale, x: (MINIMAP.width - width * scale) / 2 - minX * scale, y: (MINIMAP.height - height * scale) / 2 - minY * scale };
	}

	const rounded = (value) => `${Number(value.toFixed(2))}px`;

	function minimapVisible() {
		return state.minimap && !state.focus && !state.compare && allBoards().length > 0;
	}

	function minimapBlock(entry) {
		const block = document.createElement("span");
		block.className = "gd-minimap-block";
		block.setAttribute("aria-hidden", "true");
		return block;
	}

	function minimapTitle(entry) {
		return entry.board ? `${entry.board.system ? "" : `${String(entry.board.number).padStart(2, "0")} · `}${titleOf(entry.board)}` : t((PLACEHOLDER_KEYS[entry.wrapper.dataset.kind] ?? PLACEHOLDER_KEYS.variant).title);
	}

	/** The world, the boards and the visible area, drawn small. Blocks are plain boxes: each artboard's Open button stays the keyboard path. */
	function renderMinimap() {
		const visible = minimapVisible();
		els.minimap.hidden = !visible;
		if (!visible) return;
		const chosen = chosenBoard();
		const entries = minimapEntries()
			.map((entry) => ({ ...entry, rect: { x: entry.wrapper.offsetLeft, y: entry.wrapper.offsetTop, width: entry.wrapper.offsetWidth, height: entry.wrapper.offsetHeight } }))
			.filter((entry) => entry.rect.width > 0 && entry.rect.height > 0);
		const count = state.boards.length;
		loc(els.minimapMap, "aria-label", plural("minimap.aria", count), { count });
		const blocks = entries.map((entry, index) => {
			const old = els.minimapMap.children[index];
			const block = old && old !== els.minimapView && old.entry === entry.wrapper ? old : minimapBlock(entry);
			block.entry = entry.wrapper;
			return block;
		});
		const map = minimapScale(entries.length > 0 ? entries.map((entry) => entry.rect) : [{ x: 0, y: 0, width: 1, height: 1 }]);
		entries.forEach((entry, index) => {
			const block = blocks[index];
			block.classList.toggle("gd-minimap-system", Boolean(entry.board && entry.board.system));
			block.classList.toggle("gd-minimap-chosen", Boolean(entry.board && entry.board === chosen));
			block.classList.toggle("gd-minimap-discarded", Boolean(chosen && entry.board && !entry.board.system && entry.board !== chosen));
			block.classList.toggle("gd-minimap-placeholder", !entry.board);
			block.title = minimapTitle(entry);
			block.style.left = rounded(map.x + entry.rect.x * map.scale);
			block.style.top = rounded(map.y + entry.rect.y * map.scale);
			block.style.width = rounded(Math.max(MINIMAP.minBlock, entry.rect.width * map.scale));
			block.style.height = rounded(Math.max(MINIMAP.minBlock, entry.rect.height * map.scale));
		});
		const children = [...blocks, els.minimapView];
		// Only when the set of boards changed: a pan only moves the outline, and re-attaching nodes on every pointer move is wasted work.
		if (Array.from(els.minimapMap.children).some((child, index) => child !== children[index]) || els.minimapMap.children.length !== children.length) els.minimapMap.replaceChildren(...children);
		// The visible area in world px, pinned inside the map so it still points the way when the view is far away.
		const viewport = els.viewport.getBoundingClientRect();
		const clamp = (value, limit) => Math.min(limit, Math.max(0, value));
		const left = clamp(map.x - (state.x / state.zoom) * map.scale, MINIMAP.width);
		const top = clamp(map.y - (state.y / state.zoom) * map.scale, MINIMAP.height);
		const right = clamp(map.x + ((viewport.width - state.x) / state.zoom) * map.scale, MINIMAP.width);
		const bottom = clamp(map.y + ((viewport.height - state.y) / state.zoom) * map.scale, MINIMAP.height);
		els.minimapView.style.left = rounded(left);
		els.minimapView.style.top = rounded(top);
		els.minimapView.style.width = rounded(right - left);
		els.minimapView.style.height = rounded(bottom - top);
		state.minimapMap = map;
	}

	function setMinimap(show) {
		state.minimap = show;
		renderMinimap();
	}

	/** Centers the view on the world point under a pointer in the map (zoom stays). */
	function panToMinimap(event) {
		const map = state.minimapMap;
		if (!map || map.scale <= 0) return;
		const rect = els.minimapMap.getBoundingClientRect();
		const worldX = (event.clientX - rect.left - map.x) / map.scale;
		const worldY = (event.clientY - rect.top - map.y) / map.scale;
		const viewport = els.viewport.getBoundingClientRect();
		state.x = viewport.width / 2 - worldX * state.zoom;
		state.y = viewport.height / 2 - worldY * state.zoom;
		applyView();
		closePopover();
	}

	let minimapDrag = null;
	els.minimapMap.addEventListener("pointerdown", (event) => {
		if (event.button !== 0) return;
		minimapDrag = event.pointerId;
		els.minimapMap.setPointerCapture(event.pointerId);
		panToMinimap(event);
	});
	els.minimapMap.addEventListener("pointermove", (event) => {
		if (minimapDrag === event.pointerId) panToMinimap(event);
	});
	const endMinimapDrag = (event) => {
		if (minimapDrag === event.pointerId) minimapDrag = null;
	};
	els.minimapMap.addEventListener("pointerup", endMinimapDrag);
	els.minimapMap.addEventListener("pointercancel", endMinimapDrag);

	/**
	 * A fitted overview follows the viewport's size (a window that opens small, the comments panel); a zoom or pan of yours stays.
	 * While a comment is being written it waits, since fit() closes the comment box; the next size change fits again.
	 */
	function refit() {
		if (state.fitted && !state.focus && els.popover.hidden) fit();
	}

	function wheelPixels(delta, mode) {
		return mode === 1 ? delta * 16 : mode === 2 ? delta * 400 : delta;
	}

	/** Shared by native wheel events and wheel events forwarded from artboards. */
	function handleWheel(deltaX, deltaY, deltaMode, zooming, shift, clientX, clientY) {
		if (state.focus) return;
		const dx = wheelPixels(deltaX, deltaMode);
		const dy = wheelPixels(deltaY, deltaMode);
		if (zooming) {
			const rect = els.viewport.getBoundingClientRect();
			const step = Math.max(-50, Math.min(50, dy));
			zoomAt(state.zoom * Math.exp(-step * 0.01), clientX - rect.left, clientY - rect.top);
		} else if (shift && dx === 0) {
			panBy(-dy, 0);
		} else {
			panBy(-dx, -dy);
		}
	}

	els.viewport.addEventListener("wheel", (event) => {
		event.preventDefault();
		handleWheel(event.deltaX, event.deltaY, event.deltaMode, event.ctrlKey || event.metaKey, event.shiftKey, event.clientX, event.clientY);
	}, { passive: false });

	const CONTROL_TAGS = ["button", "a", "input", "select", "textarea", "label", "iframe"];
	function interactiveTarget(target) {
		const editable = target.closest("[contenteditable]");
		return Boolean(target.closest(CONTROL_TAGS.join(", ")) || (editable && editable.isContentEditable));
	}

	// A press on any part of an artboard that is not a control moves that artboard and selects it
	// (canvas-layout S9, S10), saved once on release; a press on the background pans and clears the selection.
	// A shield released without moving is a click on that artboard: focus mode, in Comment mode too
	// (S1: elements are picked inside it). With Space held, every press pans and changes nothing else.
	let drag = null;
	els.viewport.addEventListener("pointerdown", (event) => {
		if (state.focus || event.button !== 0 || interactiveTarget(event.target)) return;
		const shield = event.target.closest(".gd-shield");
		const wrapper = event.target.closest(".gd-artboard");
		if (!shield && !wrapper && event.target !== els.viewport && event.target !== els.world) return;
		event.preventDefault();
		const space = state.space;
		if (space) space.used = true;
		const board = space ? null : shield ? boardOfShield(shield) : wrapper ? allBoards().find((candidate) => candidate.wrapper === wrapper) ?? null : null;
		const from = board ? state.layout.positions[layoutKey(board)] : null;
		drag = { id: event.pointerId, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, moved: false, board: shield ? board : null, mover: from ? { board, from } : null };
		if (!space) selectBoard(drag.mover ? board : null);
		els.viewport.setPointerCapture(event.pointerId);
		els.viewport.classList.add(drag.mover ? "gd-moving" : "gd-panning");
	});
	// An old text selection can still initiate a native drag and cancel the pan.
	els.viewport.addEventListener("dragstart", (event) => {
		if (!state.focus && !interactiveTarget(event.target)) event.preventDefault();
	});
	els.viewport.addEventListener("pointermove", (event) => {
		if (!drag || drag.id !== event.pointerId) return;
		if (Math.abs(event.clientX - drag.startX) > CLICK_SLOP || Math.abs(event.clientY - drag.startY) > CLICK_SLOP) drag.moved = true;
		if (drag.mover) {
			// In world px, so the artboard stays under the pointer at any zoom; a still press moves nothing.
			if (!drag.moved) return;
			const { board, from } = drag.mover;
			moveBoard(board, { x: Math.round(from.x + (event.clientX - drag.startX) / state.zoom), y: Math.round(from.y + (event.clientY - drag.startY) / state.zoom) });
			return;
		}
		panBy(event.clientX - drag.x, event.clientY - drag.y);
		drag.x = event.clientX;
		drag.y = event.clientY;
	});
	const endDrag = (event) => {
		if (!drag || drag.id !== event.pointerId) return;
		const ended = drag;
		drag = null;
		els.viewport.classList.remove("gd-panning", "gd-moving");
		if (ended.mover && ended.moved) {
			// A cancelled move (the browser took the pointer) puts the artboard back; a release keeps it, by hand.
			if (event.type === "pointerup") finishMove();
			else moveBoard(ended.mover.board, ended.mover.from);
			ended.mover.board.wrapper.classList.remove("gd-lifted");
			return;
		}
		if (event.type === "pointerup" && ended.board && !ended.moved) enterFocus(ended.board);
	};

	/** The artboard pressed last shows selected, all of it (canvas-layout S10); null clears it. */
	function selectBoard(board) {
		state.selected = board;
		for (const candidate of allBoards()) candidate.wrapper.classList.toggle("gd-selected", candidate === board);
	}

	// Space held pans from anywhere, over an artboard too (canvas-layout S9). Not while typing, from a
	// button or a link (Space is theirs), with the comment box, a menu or a dialog open, or in focus mode.
	const spaceTarget = (target) => target === document.body || target === document.documentElement || target === els.viewport || Boolean(target && target.closest && target.closest(".gd-shield"));
	function releaseSpace() {
		state.space = null;
		els.viewport.classList.remove("gd-space-pan");
	}
	document.addEventListener("keydown", (event) => {
		// A shield prevents Space's default itself (it opens on release), so defaultPrevented is no reason to skip.
		if (event.key !== " " || event.ctrlKey || event.metaKey || event.altKey || !spaceTarget(event.target)) return;
		if (state.focus || guideBlocked()) return;
		event.preventDefault();
		if (!state.space) state.space = { used: false };
		els.viewport.classList.add("gd-space-pan");
	});
	document.addEventListener("keyup", (event) => {
		if (event.key === " " && state.space) releaseSpace();
	});
	// The release never comes once the window loses focus.
	window.addEventListener("blur", () => {
		if (state.space) releaseSpace();
	});
	els.viewport.addEventListener("pointerup", endDrag);
	els.viewport.addEventListener("pointercancel", endDrag);

	// A still click on the canvas (its background, an artboard, a header; also in focus mode) clears a check's ring; a drag keeps it.
	let markPress = null;
	els.viewport.addEventListener("pointerdown", (event) => {
		const target = event.target;
		const onCanvas = target === els.viewport || target === els.world || target.closest(".gd-shield") || target.closest(".gd-artboard-label");
		markPress = state.mark && event.button === 0 && onCanvas && !target.closest("button") ? { id: event.pointerId, x: event.clientX, y: event.clientY } : null;
	});
	els.viewport.addEventListener("pointerup", (event) => {
		const press = markPress;
		markPress = null;
		if (press && press.id === event.pointerId && Math.abs(event.clientX - press.x) <= CLICK_SLOP && Math.abs(event.clientY - press.y) <= CLICK_SLOP) clearMark();
	});

	els.viewport.addEventListener("keydown", (event) => {
		if (event.target !== els.viewport || state.focus) return;
		const step = event.shiftKey ? 200 : 50;
		const actions = {
			ArrowLeft: () => panBy(step, 0),
			ArrowRight: () => panBy(-step, 0),
			ArrowUp: () => panBy(0, step),
			ArrowDown: () => panBy(0, -step),
			"+": () => zoomAtCenter(1.25),
			"=": () => zoomAtCenter(1.25),
			"-": () => zoomAtCenter(0.8),
			"0": fit,
		};
		const action = actions[event.key];
		if (!action) return;
		event.preventDefault();
		action();
	});

	els.zoomIn.addEventListener("click", () => zoomAtCenter(1.25));
	els.zoomOut.addEventListener("click", () => zoomAtCenter(0.8));
	els.fit.addEventListener("click", fit);
	els.railFit.addEventListener("click", fit);

	// ---- navigation and focus modes ---------------------------------------

	function allBoards() {
		return state.systemBoard ? [state.systemBoard, ...state.boards] : state.boards;
	}

	function boardOfShield(shield) {
		return allBoards().find((board) => board.shield === shield) ?? null;
	}

	/** The shield's hint and name say what a click does: open the direction, and in Comment mode open it to comment. */
	function renderShield(board) {
		if (board.system) return;
		loc(board.hint, "text", state.commenting ? "board.hintComment" : "board.hintUse");
		loc(board.shield, "aria-label", state.commenting ? "board.comment" : "board.use", { title: board.artboard.title });
	}

	/** The board's own frame, then the extra frames All sizes adds: every one reports picks and pins the same way. */
	function surfacesOf(board) {
		return board.sizeFrames.length > 0 ? [board, ...board.sizeFrames] : [board];
	}

	/** The artboard a frame belongs to: a board is its own, a size frame names its board. */
	function ownerOf(surface) {
		return surface.board ?? surface;
	}

	function sendFocus(surface) {
		surface.frame.contentWindow?.postMessage({ type: "gd:focus", enabled: ownerOf(surface) === state.focus }, "*");
	}

	/**
	 * The artboard's visible size: its manifest size, or the focused size. A report of horizontal
	 * overflow belongs to one width, so a new width clears it until the page reports again.
	 */
	function setFrameSize(board, width, height) {
		if (board.viewWidth !== width) {
			board.overflow = null;
			board.viewWidth = width;
			board.frame.style.width = `${width}px`;
			renderOverflow(board);
		}
		board.viewHeight = height;
		board.frame.style.height = `${height}px`;
	}

	/** Desktop in focus mode: the viewport's whole width at 100%, never narrower than the artboard was designed. */
	function desktopSize(board) {
		const room = Math.floor(els.viewport.getBoundingClientRect().width - FOCUS_MARGIN * 2);
		return { width: Math.max(board.artboard.width, room), height: board.artboard.height };
	}

	function presetSize(board, preset) {
		return preset.manifest ? { width: board.artboard.width, height: board.artboard.height } : { width: preset.width, height: preset.height };
	}

	/** What the focused size means for one artboard (All sizes keeps the artboard's own frame at its manifest size). */
	function focusSize(board) {
		const size = state.size;
		if (size.kind === "custom") return { width: size.width, height: board.artboard.height };
		if (size.kind === "desktop") return desktopSize(board);
		const preset = SIZE_PRESETS.find((candidate) => candidate.kind === size.kind);
		return preset ? presetSize(board, preset) : presetSize(board, SIZE_PRESETS[2]);
	}

	/**
	 * 100% zoom with the focused artboard centered and its label (Implement this) in view.
	 * A wider artboard keeps its real width and is drawn smaller to fit the viewport, like
	 * All sizes (the zoom says how much), since the canvas cannot pan in focus mode.
	 * A taller artboard is top-aligned and its frame is clipped to the viewport, so it
	 * scrolls inside like a browser window instead of leaving its bottom out of reach.
	 * The frame has the focused size (Phone, a custom width...);
	 * All sizes puts the label at the top and fits three frames below it.
	 */
	function centerFocus() {
		const board = state.focus;
		if (!board) return;
		const viewport = els.viewport.getBoundingClientRect();
		// Layout offsets inside the world ignore its transform, so re-centering is idempotent
		// (a scaled bounding rect carries sub-pixel error that shifted the board by 1 px). The artboard is placed
		// in the world and its frame box below its label, inside it.
		const box = board.frame.parentElement;
		const left = board.wrapper.offsetLeft + box.offsetLeft;
		const top = board.wrapper.offsetTop + box.offsetTop;
		const labelSpace = box.offsetTop;
		const all = state.size.kind === "all";
		const { width, height } = focusSize(board);
		// Screen pixels per artboard pixel: 1 when it fits beside the margins.
		const zoom = all ? 1 : Math.min(1, (viewport.width - FOCUS_MARGIN * 2) / width);
		const minTop = FOCUS_MARGIN + labelSpace * zoom;
		const available = viewport.height - minTop - BACK_SPACE;
		const tall = all || height * zoom > available;
		setFrameSize(board, width, tall ? Math.max(120, Math.floor(available / zoom)) : height);
		state.zoom = zoom;
		state.x = Math.round(!all && width * zoom + FOCUS_MARGIN * 2 <= viewport.width ? (viewport.width - width * zoom) / 2 - left * zoom : FOCUS_MARGIN - left * zoom);
		state.y = Math.round((tall ? minTop : Math.max(minTop, (viewport.height - height * zoom) / 2)) - top * zoom);
		applyView();
		if (all) layoutSizes(board, minTop, viewport);
	}

	/** Shields, dimming, inert boards, toolbar controls and the mode label follow state.focus. */
	function applyFocusState() {
		const focused = state.focus;
		els.viewport.classList.toggle("gd-focused", Boolean(focused));
		for (const board of allBoards()) {
			const active = board === focused;
			board.wrapper.classList.toggle("gd-focus-board", active);
			board.wrapper.inert = Boolean(focused) && !active;
			board.shield.hidden = active;
			board.wrapper.classList.toggle("gd-all-sizes", active && state.size.kind === "all");
			if (board.openButton) {
				board.openButton.hidden = active;
				board.implement.root.hidden = !active;
			}
			if (!active) {
				// Leaving focus mode, or focusing another artboard, restores the manifest size.
				setFrameSize(board, board.artboard.width, board.artboard.height);
				removeSizeFrames(board);
			}
			renderOverflow(board);
			surfacesOf(board).forEach(sendFocus);
		}
		// The device menu belongs to the artboard it opened on.
		closeDeviceMenu(false);
		renderDevice();
		for (const control of [els.zoomOut, els.zoomIn, els.fit, els.railFit]) control.disabled = Boolean(focused);
		renderArrange();
		els.design.disabled = Boolean(focused) || state.designCount === 0;
		els.back.hidden = !focused;
		els.compareApp.disabled = Boolean(state.compare);
		renderNavMode();
		renderMinimap();
		renderGuide(false);
	}

	/** The floating chip: focus mode, comment mode or plain navigation. */
	function renderNavMode() {
		const focused = state.focus;
		if (focused) loc(els.navMode, "text", "mode.using", { title: titleOf(focused) });
		else loc(els.navMode, "text", state.commenting ? "mode.commenting" : "mode.navigating");
		els.navMode.classList.toggle("gd-using", Boolean(focused));
		els.navMode.classList.toggle("gd-commenting-chip", !focused && state.commenting);
	}

	function enterFocus(board) {
		if (state.focus === board) return;
		if (!state.focus) {
			state.savedView = { zoom: state.zoom, x: state.x, y: state.y };
			// The artboard keeps its designed width at 100%; hiding the panel gains room for it.
			state.savedPanel = !els.panel.hidden;
			setPanel(false);
		}
		closePopover();
		selectBoard(null);
		state.focus = board;
		// Every focus session starts at Desktop.
		state.size = { kind: "desktop" };
		// The state first: the focus header's layout is the room above the frame that centering counts.
		applyFocusState();
		centerFocus();
		board.frame.focus();
	}

	function exitFocus() {
		if (!state.focus) return;
		closePopover();
		state.focus = null;
		state.size = { kind: "desktop" };
		if (state.savedPanel !== null) setPanel(state.savedPanel);
		state.savedPanel = null;
		if (state.savedView) Object.assign(state, state.savedView);
		state.savedView = null;
		applyView();
		applyFocusState();
		els.viewport.focus();
	}

	els.back.addEventListener("click", exitFocus);

	// ---- designs and artboards -------------------------------------------

	function showEmpty(key, params) {
		exitFocus();
		closeMenu(false);
		state.placeholder = null;
		els.world.replaceChildren();
		sizeWorld();
		state.boards = [];
		clearMark();
		renderHandoffViews();
		renderMinimap();
		loc(els.empty, "text", key, params);
		els.empty.hidden = false;
	}

	function renderDesignOptions(designs) {
		const options = designs.map((design) => {
			const option = document.createElement("option");
			option.value = design.slug;
			if (design.valid) option.textContent = design.title;
			else loc(option, "text", "designs.invalid", { slug: design.slug });
			return option;
		});
		els.design.replaceChildren(...options);
		state.designCount = designs.length;
		els.design.disabled = designs.length === 0 || Boolean(state.focus);
		els.designField.hidden = designs.length === 0;
		if (state.slug) els.design.value = state.slug;
	}

	/** pickLatest: with no design selected, select the most recent one (not for the system-only view). */
	async function refreshDesigns(pickLatest = true) {
		const { designs } = await getJson("api/designs");
		if (pickLatest && !state.slug && designs.length > 0) state.slug = designs[0].slug;
		renderDesignOptions(designs);
		return designs;
	}

	function sendMode(surface) {
		surface.frame.contentWindow?.postMessage({ type: "gd:mode", enabled: state.commenting && !ownerOf(surface).system }, "*");
	}

	function boardUrl(board) {
		return board.system ? `${base}system.html` : fileUrl(board.slug, board.artboard.file);
	}

	/** A board's title: the system board's is the canvas's own text, a design's artboard is the user's. */
	const titleOf = (board) => (board.system ? t("system.title") : board.artboard.title);

	function createBoard(slug, artboard, system = false, number = 0) {
		const wrapper = document.createElement("section");
		wrapper.className = system ? "gd-artboard gd-system-board" : "gd-artboard";
		if (system) loc(wrapper, "aria-label", "system.title");
		else wrapper.setAttribute("aria-label", artboard.title);
		const label = document.createElement("div");
		label.className = "gd-artboard-label";
		// The header: number, title and, while focused, the handoff state chip.
		const head = document.createElement("div");
		head.className = "gd-artboard-head";
		const title = document.createElement("h2");
		title.className = "gd-artboard-title";
		if (system) loc(title, "text", "system.title");
		else title.textContent = artboard.title;
		let stateChip = null;
		let menuButton = null;
		if (!system) {
			const num = chip("gd-artboard-num", String(number).padStart(2, "0"));
			num.setAttribute("aria-hidden", "true");
			// The handoff row below says the same in words; this chip only repeats it in the focus header.
			stateChip = chip("gd-artboard-state", "");
			stateChip.hidden = true;
			stateChip.setAttribute("aria-hidden", "true");
			menuButton = createMenuButton(artboard.title);
			head.append(num, title, stateChip, menuButton);
		} else head.append(title);
		label.append(head);
		if (artboard.tradeoff) {
			const tradeoff = document.createElement("p");
			tradeoff.className = "gd-artboard-tradeoff";
			if (system) loc(tradeoff, "text", "system.tradeoff");
			else {
				tradeoff.textContent = artboard.tradeoff;
				// The overview shows two lines; the tooltip keeps the rest.
				tradeoff.title = artboard.tradeoff;
			}
			label.append(tradeoff);
		}
		// The handoff state, the chosen badge and Compare (rendered by renderHandoff) stack above
		// Implement this, at screen size, so neither covers the other at any zoom.
		const handoff = document.createElement("div");
		handoff.className = "gd-handoff";
		handoff.hidden = true;
		let implement = null;
		let openButton = null;
		if (!system) {
			const actions = document.createElement("div");
			actions.className = "gd-board-actions";
			// Open in the overview (comparing); Implement this only inside the direction, in focus mode (reviewing).
			openButton = document.createElement("button");
			openButton.type = "button";
			openButton.className = "gd-board-open gd-small";
			loc(openButton, "text", "board.open");
			loc(openButton, "aria-label", "board.openAria", { number: String(number).padStart(2, "0"), title: artboard.title });
			implement = createImplementControl(slug, artboard);
			implement.root.hidden = true;
			actions.append(handoff, openButton, implement.root);
			label.append(actions);
		}
		if (system) {
			loc(label, "title", "system.note");
			const note = document.createElement("p");
			note.className = "gd-system-note";
			loc(note, "title", "system.note");
			loc(note, "text", "system.commentsOff");
			label.append(note);
		}
		const frame = document.createElement("iframe");
		frame.className = "gd-artboard-frame";
		frame.setAttribute("sandbox", "allow-scripts");
		frame.setAttribute("referrerpolicy", "no-referrer");
		if (system) loc(frame, "title", "system.frameTitle");
		else loc(frame, "title", "board.frameTitle", { title: artboard.title });
		frame.style.width = `${artboard.width}px`;
		const box = document.createElement("div");
		box.className = "gd-frame-box";
		const shield = document.createElement("div");
		shield.className = "gd-shield";
		shield.setAttribute("role", "button");
		shield.tabIndex = 0;
		if (system) loc(shield, "aria-label", "system.view");
		const hint = document.createElement("span");
		hint.className = "gd-shield-hint";
		hint.setAttribute("aria-hidden", "true");
		if (system) loc(hint, "text", "board.hintSystem");
		shield.append(hint);
		const pins = document.createElement("div");
		pins.className = "gd-pins";
		// rects: null until the artboard reports where each commented element is.
		const flag = createOverflowFlag();
		wrapper.layoutSize = { width: artboard.width, height: artboard.height };
		const board = { slug, artboard, number, frame, wrapper, header: label, shield, hint, pins, handoff, stateChip, rects: null, system, viewWidth: artboard.width, viewHeight: artboard.height, flag, overflow: null, sizeFrames: [], sizesView: null, checks: null, menuButton, implement, openButton };
		setFrameSize(board, artboard.width, artboard.height);
		renderShield(board);
		renderHandoff(board);
		if (menuButton) wireMenuButton(board);
		if (openButton) openButton.addEventListener("click", () => enterFocus(board));
		shield.addEventListener("keydown", (event) => {
			if (event.key !== "Enter" && event.key !== " ") return;
			event.preventDefault();
			if (event.key === "Enter") enterFocus(board);
		});
		// Space opens on release, like a button, so a Space held to pan (canvas-layout S9) opens nothing.
		shield.addEventListener("keyup", (event) => {
			if (event.key !== " " || (state.space && state.space.used)) return;
			event.preventDefault();
			enterFocus(board);
		});
		frame.addEventListener("load", () => {
			surfaceLoaded(board);
			// A live reload of the focused artboard keeps focus mode and its keyboard focus.
			if (state.focus === board && els.popover.hidden && (document.activeElement === frame || document.activeElement === document.body)) frame.focus();
		});
		frame.src = boardUrl(board);
		box.append(frame, shield, pins, flag);
		wrapper.append(label, box);
		return board;
	}

	// ---- screen sizes --------------------------------------------------------

	/** A frame (the board's own or a size frame) finished loading: it knows nothing yet, so tell it the state. */
	function surfaceLoaded(surface) {
		surface.rects = null;
		// A check's ring belongs to the page it was measured in.
		if (state.mark && state.mark.board === ownerOf(surface)) clearMark();
		// A reloaded artboard is checked again: its old result no longer describes it.
		if (surface === ownerOf(surface) && !surface.system && surface.checks) {
			surface.checks = null;
			renderChecks();
		}
		surface.overflow = null;
		renderOverflow(surface);
		sendMode(surface);
		sendFocus(surface);
		if (!ownerOf(surface).system) sendPins(surface);
	}

	/** The "Overflows" chip of one frame; its title says how wide the frame is (renderOverflow). */
	function createOverflowFlag() {
		const flag = document.createElement("span");
		flag.className = "gd-overflow-flag";
		flag.hidden = true;
		const label = chip("gd-overflow-text", "");
		loc(label, "text", "overflow.label");
		flag.append(label, chip("gd-visually-hidden", ""));
		return flag;
	}

	/**
	 * Shown while the page last reported content wider than this frame. The artboard's own frame
	 * shows it only at a single focused size; in All sizes each size frame has its own.
	 */
	function renderOverflow(surface) {
		const board = ownerOf(surface);
		const shown = Boolean(surface.overflow) && (surface !== board || (state.focus === board && state.size.kind !== "all"));
		surface.flag.hidden = !shown;
		if (!shown) return;
		loc(surface.flag, "title", "overflow.note", { width: surface.viewWidth });
		loc(surface.flag.children[1], "text", "overflow.note", { width: surface.viewWidth }, true);
	}

	/**
	 * The top bar's device button: the icon and short name of the focused size, and its width × height at one size.
	 * Outside focus mode it is off: the sizes act on an open artboard only (canvas-layout S6).
	 */
	function renderDevice() {
		const board = state.focus;
		const kind = board ? state.size.kind : "desktop";
		const preset = SIZE_PRESETS.find((candidate) => candidate.kind === kind);
		const name = kind === "all" ? "size.all" : kind === "custom" ? "size.custom" : preset.name;
		els.deviceIcon.setAttribute("href", `#${SIZE_ICONS[kind]}`);
		loc(els.deviceName, "text", name);
		let size = "";
		if (board && kind !== "all") {
			const { width, height } = focusSize(board);
			size = `${width} × ${height}`;
		}
		els.deviceSize.textContent = size;
		els.device.disabled = !board;
		loc(els.device, "title", board ? "device.title" : "device.off");
		loc(els.device, "aria-label", "device.button", { size: size ? `${t(name)} ${size}` : t(name) });
	}

	/** One radio item of the device menu: icon, name and, for a preset, its size for the focused artboard. */
	function deviceItem(kind, name, titleKey, titleParams, size) {
		const item = document.createElement("button");
		item.type = "button";
		item.className = "gd-menu-item gd-device-item";
		item.setAttribute("role", "menuitemradio");
		item.setAttribute("aria-checked", String(state.size.kind === kind));
		item.setAttribute("tabindex", "-1");
		item.dataset.size = kind;
		loc(item, "title", titleKey, titleParams);
		item.append(icon(SIZE_ICONS[kind], "gd-i gd-i-s"), chip("gd-menu-label", t(name)));
		if (size) item.append(chip("gd-device-dim", size));
		item.append(icon("i-check", "gd-i gd-i-s gd-device-check"));
		item.addEventListener("click", () => chooseDeviceItem(item));
		return item;
	}

	/**
	 * The device menu, built when it opens: Phone, Tablet, Desktop and All sizes as radio items, then
	 * the custom width field. The arrows reach the field as the last entry; inside it the other keys stay with the field.
	 */
	function openDeviceMenu(last) {
		const board = state.focus;
		if (!board) return;
		closeMenu(false);
		closeDeviceMenu(false);
		const items = SIZE_PRESETS.map((preset) => {
			const { width, height } = preset.kind === "desktop" ? desktopSize(board) : presetSize(board, preset);
			return deviceItem(preset.kind, preset.name, "size.preset.title", { name: ref(preset.name), width, height }, `${width} × ${height}`);
		});
		items.push(deviceItem("all", "size.all", "size.all.title"));
		const separator = document.createElement("div");
		separator.className = "gd-menu-separator";
		separator.setAttribute("role", "separator");
		const custom = document.createElement("label");
		custom.className = "gd-device-custom";
		custom.classList.toggle("gd-selected", state.size.kind === "custom");
		const input = document.createElement("input");
		input.type = "number";
		// A name keeps the browser from flagging an anonymous form field.
		input.name = "gd-custom-width";
		input.className = "gd-device-input";
		loc(input, "aria-label", "size.customAria");
		input.setAttribute("min", String(CUSTOM_WIDTH.min));
		input.setAttribute("max", String(CUSTOM_WIDTH.max));
		input.setAttribute("step", "1");
		input.setAttribute("inputmode", "numeric");
		input.value = state.size.kind === "custom" ? String(state.size.width) : "";
		const unit = chip("gd-device-unit", "px");
		unit.setAttribute("aria-hidden", "true");
		custom.append(icon(SIZE_ICONS.custom, "gd-i gd-i-s"), chip("gd-device-custom-label", t("size.custom")), input, unit);
		const error = document.createElement("p");
		error.className = "gd-device-error";
		error.setAttribute("role", "alert");
		error.hidden = true;
		input.addEventListener("change", applyCustomWidth);
		input.addEventListener("keydown", (event) => {
			if (event.key !== "Enter") return;
			event.preventDefault();
			applyCustomWidth();
		});
		loc(els.deviceMenu, "aria-label", "size.group");
		els.deviceMenu.replaceChildren(...items, separator, custom, error);
		els.deviceMenu.hidden = false;
		els.device.setAttribute("aria-expanded", "true");
		state.deviceMenu = { items: [...items, input], input, error };
		placeMenu(els.device, els.deviceMenu);
		(last ? input : items[0]).focus();
		renderGuide(false);
	}

	/** Closes the device menu; focus goes back to its button when it was inside the menu (or `refocus`). */
	function closeDeviceMenu(refocus) {
		const open = state.deviceMenu;
		if (!open) return;
		state.deviceMenu = null;
		const inside = els.deviceMenu.contains(document.activeElement);
		els.deviceMenu.hidden = true;
		els.deviceMenu.replaceChildren();
		els.device.setAttribute("aria-expanded", "false");
		if (refocus || inside) els.device.focus();
		renderGuide(false);
	}

	function chooseDeviceItem(item) {
		// The field is an entry of the arrow keys, not a choice: Enter in it applies the width.
		if (!item.dataset.size) return;
		closeDeviceMenu(true);
		setSize({ kind: item.dataset.size });
	}

	/** The custom width: whole px from 240 to 2560; anything else keeps the menu open with the error under the field. */
	function applyCustomWidth() {
		const open = state.deviceMenu;
		if (!open) return;
		const text = open.input.value.trim();
		const width = Number(text);
		if (!/^\d+$/.test(text) || width < CUSTOM_WIDTH.min || width > CUSTOM_WIDTH.max) {
			open.input.setAttribute("aria-invalid", "true");
			loc(open.error, "text", "size.error", { min: CUSTOM_WIDTH.min, max: CUSTOM_WIDTH.max });
			open.error.hidden = false;
			return;
		}
		open.input.removeAttribute("aria-invalid");
		open.error.hidden = true;
		closeDeviceMenu(true);
		setSize({ kind: "custom", width });
	}

	els.device.addEventListener("click", () => {
		if (state.deviceMenu) closeDeviceMenu(true);
		else openDeviceMenu(false);
	});
	els.device.addEventListener("keydown", (event) => {
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			openDeviceMenu(event.key === "ArrowUp");
		} else if (event.key === "Escape" && state.deviceMenu) {
			event.preventDefault();
			event.stopPropagation();
			closeDeviceMenu(true);
		}
	});
	els.deviceMenu.addEventListener("keydown", (event) => {
		const open = state.deviceMenu;
		if (!open) return;
		// In the width field typing, Home, End and Space stay with it, and Enter is its own (applyCustomWidth).
		if (event.target === open.input && !["ArrowDown", "ArrowUp", "Escape", "Tab"].includes(event.key)) return;
		menuKeydown(event, open.items, closeDeviceMenu, chooseDeviceItem);
	});

	/**
	 * The size a pick was made at, for the comment: the focused single size, or the picked size frame of
	 * All sizes. Null at the artboard's own size (nothing to record) and when comments.json would refuse it.
	 */
	function viewportOf(surface) {
		const board = ownerOf(surface);
		let size;
		if (surface !== board) size = { width: surface.width, height: surface.height };
		else if (state.focus === board && state.size.kind !== "all") size = focusSize(board);
		else return null;
		if (size.width === board.artboard.width && size.height === board.artboard.height) return null;
		const { minWidth, maxWidth, minHeight, maxHeight } = VIEWPORT_LIMITS;
		const fits = size.width >= minWidth && size.width <= maxWidth && size.height >= minHeight && size.height <= maxHeight;
		return fits && Number.isInteger(size.width) && Number.isInteger(size.height) ? size : null;
	}

	/** `Phone 390 × 844`, `Tablet 820 × 1180` or `<w> × <h>`: the preset's name only for its exact size. */
	function describeViewport(viewport) {
		const size = `${viewport.width} × ${viewport.height}`;
		const preset = SIZE_PRESETS.find((candidate) => !candidate.manifest && candidate.width === viewport.width && candidate.height === viewport.height);
		return preset ? `${t(preset.name)} ${size}` : size;
	}

	/** Picks a size for the focused artboard; a bad custom width never gets here (the field refuses it). */
	function setSize(size) {
		const board = state.focus;
		if (!board) return;
		closePopover();
		// Another size is another layout: the ring would be measured in the wrong one.
		clearMark();
		state.size = size;
		applySize();
	}

	/** Brings the focused artboard's frames, centering, the device button and the chip in line with state.size. */
	function applySize() {
		const board = state.focus;
		if (!board) return;
		const all = state.size.kind === "all";
		board.wrapper.classList.toggle("gd-all-sizes", all);
		if (all && !board.sizesView) createSizeFrames(board);
		else if (!all) removeSizeFrames(board);
		centerFocus();
		renderDevice();
		renderOverflow(board);
	}

	/**
	 * All sizes: a real iframe per size at its true width (so the design's media queries apply), scaled down
	 * together. They are registered like the artboard's own frame (surfacesOf), so they take picks and show pins.
	 */
	function createSizeFrames(board) {
		const view = document.createElement("div");
		view.className = "gd-sizes-all";
		view.classList.toggle("gd-commenting", state.commenting);
		view.setAttribute("role", "group");
		loc(view, "aria-label", "size.all");
		board.sizeFrames = SIZE_PRESETS.map((preset) => createSizeFrame(board, preset));
		view.append(...board.sizeFrames.map((surface) => surface.root));
		board.sizesView = view;
		els.viewport.append(view);
	}

	function createSizeFrame(board, preset) {
		const { width, height } = presetSize(board, preset);
		const root = document.createElement("section");
		root.className = "gd-size-frame";
		loc(root, "aria-label", "size.frameAria", { name: ref(preset.name), width, height });
		const head = document.createElement("div");
		head.className = "gd-size-head";
		const scaleLabel = chip("gd-size-scale", "");
		const name = chip("gd-size-name", "");
		loc(name, "text", preset.name);
		head.append(icon(preset.icon, "gd-i gd-i-s"), name, chip("gd-size-dim", `${width} × ${height}`), scaleLabel);
		const scaled = document.createElement("div");
		scaled.className = "gd-size-scaled";
		const stage = document.createElement("div");
		stage.className = "gd-size-stage";
		stage.style.width = `${width}px`;
		stage.style.height = `${height}px`;
		const frame = document.createElement("iframe");
		frame.className = "gd-size-iframe";
		frame.setAttribute("sandbox", "allow-scripts");
		frame.setAttribute("referrerpolicy", "no-referrer");
		loc(frame, "title", "size.frameTitle", { title: board.artboard.title, name: ref(preset.name), width, height });
		frame.style.width = `${width}px`;
		frame.style.height = `${height}px`;
		const pins = document.createElement("div");
		pins.className = "gd-pins";
		const flag = createOverflowFlag();
		stage.append(frame, pins);
		scaled.append(stage, flag);
		root.append(head, scaled);
		const surface = { board, kind: preset.kind, width, height, viewWidth: width, viewHeight: height, frame, pins, flag, rects: null, overflow: null, root, scaled, stage, scaleLabel };
		frame.addEventListener("load", () => surfaceLoaded(surface));
		frame.src = boardUrl(board);
		return surface;
	}

	function removeSizeFrames(board) {
		if (!board.sizesView) return;
		board.sizesView.remove();
		board.sizesView = null;
		board.sizeFrames = [];
	}

	/** One scale for the three frames: small enough that they fit side by side under the label and above Back to canvas. */
	function layoutSizes(board, minTop, viewport) {
		const view = board.sizesView;
		const frames = board.sizeFrames;
		if (!view || frames.length === 0) return;
		const top = minTop + 8;
		view.style.left = `${FOCUS_MARGIN}px`;
		view.style.right = `${FOCUS_MARGIN}px`;
		view.style.top = `${top}px`;
		view.style.bottom = `${BACK_SPACE}px`;
		const availableWidth = viewport.width - FOCUS_MARGIN * 2 - SIZES_GAP * (frames.length - 1);
		const availableHeight = viewport.height - top - BACK_SPACE - SIZES_HEAD;
		const totalWidth = frames.reduce((sum, surface) => sum + surface.width, 0);
		const tallest = Math.max(...frames.map((surface) => surface.height));
		const scale = Math.max(MIN_SIZES_SCALE, Math.min(1, availableWidth / totalWidth, availableHeight / tallest));
		for (const surface of frames) {
			surface.scaled.style.width = `${Math.round(surface.width * scale)}px`;
			surface.scaled.style.height = `${Math.round(surface.height * scale)}px`;
			surface.stage.style.transform = `scale(${scale})`;
			surface.stage.style.setProperty("--gd-inv-zoom", String(1 / scale));
			surface.scaleLabel.textContent = `· ${Math.round(scale * 100)}%`;
		}
	}

	/** "Implement this" with an inline confirm step; the system board never gets one. */
	let implementNotes = 0;

	function createImplementControl(slug, artboard) {
		const box = document.createElement("div");
		box.className = "gd-implement";
		const start = document.createElement("button");
		start.type = "button";
		start.className = "gd-implement-start";
		loc(start, "text", "implement.start");
		loc(start, "aria-label", "implement.startAria", { title: artboard.title });
		const confirm = document.createElement("div");
		confirm.className = "gd-implement-confirm";
		confirm.setAttribute("role", "group");
		loc(confirm, "aria-label", "implement.confirmAria", { title: artboard.title });
		confirm.hidden = true;
		const question = document.createElement("span");
		question.className = "gd-implement-question";
		loc(question, "text", "implement.question");
		const yes = document.createElement("button");
		yes.type = "button";
		yes.className = "gd-primary";
		loc(yes, "text", "common.send");
		const no = document.createElement("button");
		no.type = "button";
		loc(no, "text", "common.cancel");
		confirm.append(question, yes, no);
		const alert = createAlert();
		let note = null;
		let refreshNote = () => {};
		if (!DELIVERY.implement) {
			// No session to hand off to: say so up front instead of failing on click.
			const info = explain({ status: 501, body: { error: "implement-unavailable" } });
			start.disabled = true;
			start.title = info.detail;
			// A short visible line keeps the artboard header readable; the full sentence stays
			// in the tooltip and, for screen readers, in the visually hidden rest of the note.
			note = chip("gd-implement-note", "");
			const hidden = chip("gd-visually-hidden", "");
			// Text and a child in one element: a switch of language writes both again.
			refreshNote = () => {
				const words = explain({ status: 501, body: { error: "implement-unavailable" } });
				note.textContent = t("session.notConnected");
				note.title = words.text;
				hidden.textContent = ` ${words.text}`;
				note.append(hidden);
			};
			refreshNote();
			note.id = `gd-implement-note-${++implementNotes}`;
			start.setAttribute("aria-describedby", note.id);
		}
		const close = (focus) => {
			confirm.hidden = true;
			start.hidden = false;
			if (focus) start.focus();
		};
		// The header button and the artboard menu's Implement this both open the confirm step.
		const open = () => {
			if (start.disabled) return;
			hideAlert(alert);
			start.hidden = true;
			confirm.hidden = false;
			yes.disabled = false;
			yes.focus();
		};
		start.addEventListener("click", open);
		no.addEventListener("click", () => close(true));
		confirm.addEventListener("keydown", (event) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			close(true);
		});
		yes.addEventListener("click", async () => {
			yes.disabled = true;
			hideAlert(alert);
			const reply = await postJson(`api/designs/${encodeURIComponent(slug)}/implement`, { file: artboard.file });
			if (reply.ok) {
				const queued = reply.body.queued === true;
				showToast(t(queued ? "implement.queued" : "implement.sent", { title: artboard.title }), false);
				// The server recorded it before answering; the handoffs.json change event confirms it.
				noteHandoff(slug, artboard.file, queued);
			} else {
				showAlert(alert, reply, "implement");
				// The alert says it next to the button; only a board collapsed by zoom hides it, so only then toast.
				if (box.closest(".gd-compact")) showToast(alert.text.textContent, true);
			}
			close(true);
		});
		box.append(start, confirm, ...(note ? [note] : []), alert.root);
		// Once another artboard is chosen this one is discarded: the button switches the handoff to it instead.
		let discarded = false;
		const setDiscarded = (value) => {
			if (value === discarded) return;
			discarded = value;
			start.classList.toggle("gd-implement-switch", value);
			loc(start, "text", value ? "implement.switch" : "implement.start");
			loc(start, "aria-label", value ? "implement.switchAria" : "implement.startAria", { title: artboard.title });
			loc(question, "text", value ? "implement.switchQuestion" : "implement.question");
		};
		return { root: box, open, refresh: refreshNote, setDiscarded, isDiscarded: () => discarded };
	}

	// ---- artboard menu ---------------------------------------------------------
	// A ⋯ button in each design artboard's header opens one shared menu (index.html). It is built each
	// time it opens, so it follows the handoff state. Implement this is also in the header, in focus mode.

	let menuNotes = 0;

	function createMenuButton(title) {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "gd-menu-button";
		loc(button, "aria-label", "board.menuButton", { title });
		button.setAttribute("aria-haspopup", "menu");
		button.setAttribute("aria-expanded", "false");
		button.setAttribute("aria-controls", "gd-menu");
		button.append(icon("i-more", "gd-i gd-i-s"));
		return button;
	}

	/** What the menu offers for one artboard, in order. `off` is the explanation when the action cannot run. */
	function menuActions(board) {
		const { entry } = handoffOf(board);
		const preview = entry && handoffKind(entry) === "implemented" ? previewTarget(entry.previewUrl) : null;
		const off = (available, code) => (available ? null : explain({ status: 501, body: { error: code } }));
		const actions = [{ label: "menu.variant", icon: "i-sparkles", off: off(DELIVERY.variant, "variant-unavailable"), run: (button) => openVariantDialog(board, button) }];
		if (preview) actions.push({ label: "menu.compare", icon: "i-compare", run: () => enterCompare(board, preview) });
		actions.push(
			{ label: "menu.exportPng", icon: "i-image", separator: true, run: () => exportArtboard(board, 1) },
			{ label: "menu.exportPng2x", icon: "i-image", run: () => exportArtboard(board, 2) },
			{ label: "menu.exportPdf", icon: "i-image", run: () => exportPdf(board) },
			{ label: "menu.downloadHtml", icon: "i-download", run: () => downloadHtml(board) },
			// Implement this lives inside the direction: from the overview the menu opens it first, then the confirm step.
			{ label: board.implement.isDiscarded() ? "menu.switch" : "menu.implement", separator: true, off: off(DELIVERY.implement, "implement-unavailable"), run: () => { enterFocus(board); board.implement.open(); } },
		);
		return actions;
	}

	function nextPaint() {
		return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
	}

	function nextVideoFrame(video) {
		return new Promise((resolve) => (video.requestVideoFrameCallback ? video.requestVideoFrameCallback(() => resolve()) : setTimeout(resolve, 100)));
	}

	/** An Error whose message is the catalog text of `key` and which remembers the key, so an alert that shows it can follow the language. */
	function exportError(key, params) {
		return Object.assign(new Error(t(key, params)), { i18n: { key, params } });
	}

	/** Export a visible artboard from the browser's tab capture, without sending pixels to the server. */
	async function exportArtboard(board, scale) {
		const alert = board.exportAlert || (board.exportAlert = createAlert());
		if (!alert.root.parentElement) board.implement.root.append(alert.root);
		hideAlert(alert);
		// A reason is an error made by exportError (the catalog key it carries follows a switch of language) or a browser's own text.
		const fail = (reason) => {
			loc(alert.text, "text", "export.failed");
			if (reason.i18n) loc(alert.detail, "text", reason.i18n.key, reason.i18n.params);
			else setRaw(alert.detail, reason.message || "");
			alert.root.hidden = false;
		};
		if (!navigator.mediaDevices?.getDisplayMedia) {
			fail(exportError("export.unavailable"));
			return;
		}
		if (!window.confirm(t("export.confirm"))) return;
		let stream;
		const previous = { focus: state.focus, size: state.size, zoom: state.zoom, x: state.x, y: state.y };
		try {
			// This call must happen directly from the menu activation, before any asynchronous work.
			stream = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: "browser" }, audio: false, preferCurrentTab: true });
			// Some systems (such as Linux on Wayland) only offer windows or screens; their frame is not this tab's viewport.
			const surface = stream.getVideoTracks?.()[0]?.getSettings?.().displaySurface;
			if (surface && surface !== "browser") throw exportError(surface === "monitor" ? "export.sharedScreen" : "export.sharedOther", { surface });
			if (state.focus !== board) enterFocus(board);
			if (state.size.kind !== "desktop") setSize({ kind: "desktop" });
			// Desktop fills the window (canvas-layout S8); the image is the artboard at its own width.
			setFrameSize(board, board.artboard.width, board.viewHeight);
			// The viewport covers the window without the canvas chrome; the artboard goes to its top left at 100%.
			document.body.classList.add("gd-exporting");
			Object.assign(state, { zoom: 1, x: 0, y: 0 });
			applyView();
			await nextPaint();
			const start = board.frame.getBoundingClientRect();
			state.x -= start.left;
			state.y -= start.top;
			applyView();
			await nextPaint();
			const rect = board.frame.getBoundingClientRect();
			if (rect.width <= 0 || rect.height <= 0 || rect.left < 0 || rect.top < 0 || rect.right > window.innerWidth || rect.bottom > window.innerHeight) {
				throw exportError("export.window", { width: Math.ceil(rect.width), height: Math.ceil(rect.height) });
			}
			const video = document.createElement("video");
			video.srcObject = stream;
			video.muted = true;
			await video.play();
			// The first frame can predate the layout above; wait for frames painted after it.
			await nextVideoFrame(video);
			await nextVideoFrame(video);
			const sx = video.videoWidth / window.innerWidth;
			const sy = video.videoHeight / window.innerHeight;
			if (!Number.isFinite(sx) || !Number.isFinite(sy) || sx <= 0 || sy <= 0) throw exportError("export.noFrame");
			const canvas = document.createElement("canvas");
			canvas.width = Math.round(rect.width * scale);
			canvas.height = Math.round(rect.height * scale);
			const context = canvas.getContext("2d");
			if (!context) throw exportError("export.noPng");
			context.drawImage(video, rect.left * sx, rect.top * sy, rect.width * sx, rect.height * sy, 0, 0, canvas.width, canvas.height);
			stream.getTracks().forEach((track) => track.stop());
			stream = null;
			const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
			if (!blob) throw exportError("export.encode");
			const url = URL.createObjectURL(blob);
			try {
				const link = document.createElement("a");
				link.href = url;
				link.download = `${board.artboard.file.split("/").pop().replace(/\.[^.]+$/, "")}${scale === 2 ? "@2x" : ""}.png`;
				link.click();
			} finally { URL.revokeObjectURL(url); }
			showToast(t(scale === 2 && (sx < 2 || sy < 2) ? "export.doneUpscaled" : "export.done"), false);
		} catch (error) {
			fail(error?.i18n ? error : error?.message ? error : exportError("export.denied"));
		} finally {
			stream?.getTracks().forEach((track) => track.stop());
			document.body.classList.remove("gd-exporting");
			if (!previous.focus && state.focus) exitFocus();
			else if (previous.focus && state.focus !== previous.focus) enterFocus(previous.focus);
			if (previous.focus && state.focus === previous.focus) setSize(previous.size);
			Object.assign(state, { zoom: previous.zoom, x: previous.x, y: previous.y });
			applyView();
		}
	}

	/**
	 * Prints the artboard alone, at its own size, from this page (artboards are sandboxed without modals, so
	 * they cannot print themselves): the browser's print dialog saves it as PDF. Nothing goes to the server.
	 */
	function exportPdf(board) {
		document.querySelector?.(".gd-print")?.remove();
		const { width, height, title, file } = board.artboard;
		const holder = document.createElement("div");
		holder.className = "gd-print";
		const frame = document.createElement("iframe");
		frame.setAttribute("sandbox", "allow-scripts");
		frame.setAttribute("referrerpolicy", "no-referrer");
		loc(frame, "title", "board.frameTitle", { title });
		frame.style.width = `${width}px`;
		frame.style.height = `${height}px`;
		holder.append(frame);
		document.body.append(holder);
		document.body.classList.add("gd-printing");
		const page = setPrintPage(width, height);
		const done = () => {
			page?.();
			holder.remove();
			document.body.classList.remove("gd-printing");
		};
		window.addEventListener("afterprint", done, { once: true });
		frame.addEventListener("load", () => window.print(), { once: true });
		frame.setAttribute("src", fileUrl(board.slug, file));
	}

	/** One page the artboard's size (canvas.css sets no margin); returns how to remove it, or null where the browser gives no CSSOM. */
	function setPrintPage(width, height) {
		const sheet = [...(document.styleSheets ?? [])].find((candidate) => /canvas\.css(\?|$)/.test(candidate.href ?? ""));
		if (!sheet?.insertRule) return null;
		try {
			const size = [width, height].map((value) => `${value}px`).join(" ");
			const index = sheet.insertRule(`@page { size: ${size}; }`, sheet.cssRules.length);
			return () => { if (sheet.cssRules[index]) sheet.deleteRule(index); };
		} catch {
			return null;
		}
	}

	/** Saves the artboard file as written: the server injects the inspector into every artboard, so remove that tag again. */
	async function downloadHtml(board) {
		const alert = board.exportAlert || (board.exportAlert = createAlert());
		if (!alert.root.parentElement) board.implement.root.append(alert.root);
		hideAlert(alert);
		const url = fileUrl(board.slug, board.artboard.file);
		try {
			const response = await fetch(url, { cache: "no-store" });
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const served = await response.text();
			const tag = `<script src="${base}assets/inspector.js"></script>`;
			const at = served.lastIndexOf(tag);
			const html = at === -1 ? served : served.slice(0, at) + served.slice(at + tag.length);
			const link = document.createElement("a");
			const blobUrl = URL.createObjectURL(new Blob([html], { type: "text/html" }));
			try {
				link.href = blobUrl;
				link.download = board.artboard.file.split("/").pop();
				link.click();
			} finally { URL.revokeObjectURL(blobUrl); }
		} catch (error) {
			loc(alert.text, "text", "download.failed");
			setRaw(alert.detail, error?.message || "");
			alert.root.hidden = false;
		}
	}

	function menuItem(action) {
		const item = document.createElement("button");
		item.type = "button";
		item.className = "gd-menu-item";
		// A switch (the step-by-step help) is a checkable item: its state is announced and shown with a check at the end.
		const checkable = typeof action.checked === "boolean";
		item.setAttribute("role", checkable ? "menuitemcheckbox" : "menuitem");
		if (checkable) item.setAttribute("aria-checked", String(action.checked));
		item.setAttribute("tabindex", "-1");
		if (action.icon) item.append(icon(action.icon, "gd-i gd-i-s"));
		item.append(chip("gd-menu-label", t(action.label)));
		if (checkable) item.append(icon("i-check", "gd-i gd-i-s gd-menu-check"));
		// A single-key shortcut that does the same, shown at the end of the item.
		if (action.shortcut) {
			item.setAttribute("aria-keyshortcuts", action.shortcut);
			const key = document.createElement("kbd");
			key.className = "gd-menu-kbd";
			key.setAttribute("aria-hidden", "true");
			key.textContent = action.shortcut;
			item.append(key);
		}
		// Nothing to act on (no design system board): announced as unavailable, choosing it does nothing.
		if (action.disabled) item.setAttribute("aria-disabled", "true");
		if (action.off) {
			// Like the disabled Implement this: a short visible line, the full way out in its tooltip and for screen readers.
			item.setAttribute("aria-disabled", "true");
			item.title = action.off.detail;
			const note = chip("gd-menu-note", t("session.notConnected"));
			note.title = action.off.text;
			note.append(chip("gd-visually-hidden", ` ${action.off.text}`));
			note.id = `gd-menu-note-${++menuNotes}`;
			item.setAttribute("aria-describedby", note.id);
			item.append(note);
		}
		return item;
	}

	/**
	 * Puts `menu` (an action menu or the device menu) under `button`, inside the window; `beside` puts it right of
	 * the button instead (the rail's Settings, at the bottom left), bottom-aligned with it when there is no room below.
	 */
	function placeMenu(button, menu, beside = false) {
		const rect = button.getBoundingClientRect();
		// A fixed box without a width shrinks to the room right of its left edge: measure it where nothing narrows it.
		menu.style.left = "0px";
		const width = menu.offsetWidth;
		const height = menu.offsetHeight;
		const left = Math.max(0, Math.min(beside ? rect.left + rect.width + 8 : rect.left, window.innerWidth - width - 12));
		let top = beside ? rect.top : rect.bottom + 4;
		if (top + height > window.innerHeight - 12) top = Math.max(0, beside ? rect.top + rect.height - height : rect.top - height - 4);
		menu.style.left = `${left}px`;
		menu.style.top = `${top}px`;
	}

	function openMenu(board, button, last) {
		showMenu(button, menuActions(board), t("menu.aria", { title: board.artboard.title }), last);
	}

	/** Builds the shared menu (#gd-menu) from `actions` under `button`, named `label`, with focus on its first (or `last`) item. */
	function showMenu(button, actions, label, last, beside = false) {
		closeMenu(false);
		closeDeviceMenu(false);
		const nodes = [];
		const items = [];
		const byItem = new Map();
		for (const action of actions) {
			if (action.separator) {
				const separator = document.createElement("div");
				separator.className = "gd-menu-separator";
				separator.setAttribute("role", "separator");
				nodes.push(separator);
			}
			const item = menuItem(action);
			item.addEventListener("click", () => chooseMenuItem(item));
			byItem.set(item, action);
			items.push(item);
			nodes.push(item);
		}
		els.menu.setAttribute("aria-label", label);
		els.menu.replaceChildren(...nodes);
		els.menu.hidden = false;
		button.setAttribute("aria-expanded", "true");
		state.menu = { button, items, byItem };
		placeMenu(button, els.menu, beside);
		(last ? items[items.length - 1] : items[0]).focus();
		renderGuide(false);
	}

	/** Closes the menu; focus goes back to its button when it was inside the menu (or `refocus`). */
	function closeMenu(refocus) {
		const open = state.menu;
		if (!open) return;
		state.menu = null;
		const inside = els.menu.contains(document.activeElement);
		els.menu.hidden = true;
		els.menu.replaceChildren();
		open.button.setAttribute("aria-expanded", "false");
		if (refocus || inside) open.button.focus();
		renderGuide(false);
	}

	function chooseMenuItem(item) {
		const open = state.menu;
		const action = open && open.byItem.get(item);
		if (!action || action.off || action.disabled) return;
		// Back on the button first: the action then moves focus where it needs it (the dialog, the confirm step).
		closeMenu(true);
		action.run(open.button);
	}

	function wireMenuButton(board) {
		wireMenu(board.menuButton, (last) => openMenu(board, board.menuButton, last));
	}

	/** A button that opens the shared menu: a click toggles it, the arrows open it on the first or the last item, Escape closes it. */
	function wireMenu(button, open) {
		button.addEventListener("click", () => {
			if (state.menu && state.menu.button === button) closeMenu(true);
			else open(false);
		});
		button.addEventListener("keydown", (event) => {
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				open(event.key === "ArrowUp");
			} else if (event.key === "Escape" && state.menu && state.menu.button === button) {
				event.preventDefault();
				event.stopPropagation();
				closeMenu(true);
			}
		});
	}

	/** The keys the menus share: arrows, Home and End move; Escape closes with focus back on the button; Tab closes; Enter and Space choose. */
	function menuKeydown(event, items, close, choose) {
		const current = items.findIndex((item) => item.contains(event.target));
		const move = (index) => {
			event.preventDefault();
			items[(index + items.length) % items.length].focus();
		};
		if (event.key === "ArrowDown") move(current + 1);
		else if (event.key === "ArrowUp") move(current < 0 ? items.length - 1 : current - 1);
		else if (event.key === "Home") move(0);
		else if (event.key === "End") move(items.length - 1);
		else if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			close(true);
		} else if (event.key === "Tab") close(true);
		else if ((event.key === "Enter" || event.key === " ") && current >= 0) {
			event.preventDefault();
			choose(items[current]);
		}
	}

	els.menu.addEventListener("keydown", (event) => {
		if (state.menu) menuKeydown(event, state.menu.items, closeMenu, chooseMenuItem);
	});

	document.addEventListener("pointerdown", (event) => {
		const open = state.menu;
		if (open && !els.menu.contains(event.target) && !open.button.contains(event.target)) closeMenu(false);
		if (state.deviceMenu && !els.deviceMenu.contains(event.target) && !els.device.contains(event.target)) closeDeviceMenu(false);
	});

	// ---- appearance (canvas-layout S15) ---------------------------------------------------
	// Settings > Appearance: the theme and the language as radio groups in a dialog built like the shortcuts list.
	// A choice applies at once and the dialog stays open; Close or Esc returns to Settings.

	/** Checks the radios of the current theme and language choice. */
	function renderAppearance() {
		for (const name of THEMES) els.themeInputs[name].checked = name === theme;
		for (const choice of LANG_CHOICES) els.languageInputs[choice].checked = choice === languageChoice;
	}

	/** Saves the theme (gentle or neutral) and repaints the canvas with it; nothing reloads. */
	function setTheme(name) {
		if (!THEMES.includes(name)) return;
		theme = name;
		try { localStorage.setItem(THEME_KEY, name); } catch { /* storage may be unavailable: the theme holds for this page only */ }
		applyTheme();
		renderAppearance();
	}

	for (const name of THEMES) els.themeInputs[name].addEventListener("change", () => setTheme(name));
	for (const choice of LANG_CHOICES) els.languageInputs[choice].addEventListener("change", () => setLanguage(choice));

	function openAppearance() {
		renderAppearance();
		if (typeof els.appearance.showModal === "function") els.appearance.showModal();
		else els.appearance.setAttribute("open", "");
		renderGuide(false);
	}

	function closeAppearance() {
		if (typeof els.appearance.close === "function") els.appearance.close();
		else els.appearance.removeAttribute("open");
		renderGuide(false);
		els.railSettings.focus();
	}

	// The browser closes the modal dialog on Esc too.
	els.appearance.addEventListener("close", () => {
		renderGuide(false);
		els.railSettings.focus();
	});

	els.appearanceClose.addEventListener("click", closeAppearance);

	/** Saves the choice (es, en or auto) and rewrites the page in the language it resolves to. */
	function setLanguage(choice) {
		if (!LANG_CHOICES.includes(choice)) return;
		languageChoice = choice;
		language = resolveLanguage(choice);
		try { localStorage.setItem(LANG_KEY, choice); } catch { /* storage may be unavailable */ }
		applyLanguage();
	}

	/** The compare view's frame titles in the current language; loc keeps its captions and texts. */
	function renderCompareText() {
		const compare = state.compare;
		if (!compare) return;
		compare.artboardFrame.title = t("board.frameTitle", { title: compare.board.artboard.title });
		compare.appFrame.title = t("compare.appFrame", { url: compare.preview });
	}

	/**
	 * The whole page in the current language, live: <html lang>, everything marked with a key (index.html and what loc
	 * wrote), then what is built from state. No artboard frame is touched, so nothing reloads.
	 */
	function applyLanguage() {
		document.documentElement.lang = language;
		refreshLoc();
		renderAppearance();
		if (state.systemBoard) Object.assign(state.systemBoard.artboard, { title: t("system.title"), tradeoff: t("system.tradeoff") });
		renderNavMode();
		renderConnection();
		renderComments();
		renderHandoffs();
		for (const board of state.boards) board.implement.refresh();
		renderDevice();
		renderCompareText();
		renderMark();
		renderGuide(false);
		if (state.inspect && !els.inspector.hidden) showInspector(state.inspect.surface, state.inspect.measure);
	}

	// ---- another direction -------------------------------------------------------
	// "Try another direction from this…" asks the session for the next artboard of the design, based on one
	// artboard. Until the manifest gains it, a placeholder board shows where it will appear.

	const nextNumber = () => String(state.boards.length + 1).padStart(2, "0");

	function variantProblem(text, detail) {
		els.variantMessage.textContent = text;
		els.variantMessage.title = detail || "";
		els.variantMessage.classList.add("gd-error");
		els.variantText.setAttribute("aria-invalid", "true");
	}

	function clearVariantProblem() {
		els.variantMessage.textContent = "";
		els.variantMessage.title = "";
		els.variantMessage.classList.remove("gd-error");
		els.variantText.removeAttribute("aria-invalid");
	}

	function openVariantDialog(board, button) {
		state.variant = { board, button, sending: false };
		els.variantSource.textContent = board.artboard.title;
		loc(els.variantNote, "text", "variant.note", { number: nextNumber() });
		els.variantText.value = "";
		els.variantSend.disabled = false;
		clearVariantProblem();
		if (!els.variantDialog.hasAttribute("open")) {
			if (typeof els.variantDialog.showModal === "function") els.variantDialog.showModal();
			else els.variantDialog.setAttribute("open", "");
		}
		renderGuide(false);
		els.variantText.focus();
	}

	function closeVariantDialog() {
		const open = state.variant;
		state.variant = null;
		if (els.variantDialog.hasAttribute("open")) {
			if (typeof els.variantDialog.close === "function") els.variantDialog.close();
			else els.variantDialog.removeAttribute("open");
		}
		renderGuide(false);
		if (open) open.button.focus();
	}

	// The browser closes a modal dialog on Esc and reports it here.
	els.variantDialog.addEventListener("close", () => {
		renderGuide(false);
		const open = state.variant;
		if (!open) return;
		state.variant = null;
		open.button.focus();
	});
	els.variantCancel.addEventListener("click", closeVariantDialog);

	for (const key of VARIANT_SUGGESTIONS) {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "gd-suggestion";
		loc(button, "text", key);
		button.addEventListener("click", () => {
			const suggestion = button.textContent;
			const text = els.variantText.value.trim();
			const added = text ? `${text}, ${suggestion.toLowerCase()}` : suggestion;
			const present = text.toLowerCase().includes(suggestion.toLowerCase());
			if (!present && added.length <= LIMITS.variant) els.variantText.value = added;
			clearVariantProblem();
			els.variantText.focus();
		});
		els.variantChips.append(button);
	}

	els.variantText.addEventListener("input", clearVariantProblem);

	els.variantForm.addEventListener("submit", async (event) => {
		event.preventDefault();
		const open = state.variant;
		if (!open || open.sending) return;
		const instruction = els.variantText.value.replace(/\r\n?/g, "\n").trim();
		if (instruction.length < 1 || instruction.length > LIMITS.variant) {
			variantProblem(t("variant.problem", { max: LIMITS.variant }));
			els.variantText.focus();
			return;
		}
		open.sending = true;
		els.variantSend.disabled = true;
		clearVariantProblem();
		const { board } = open;
		const reply = await postJson(`api/designs/${encodeURIComponent(board.slug)}/variant`, { file: board.artboard.file, instruction });
		open.sending = false;
		els.variantSend.disabled = false;
		const stillOpen = state.variant === open;
		if (!reply.ok) {
			const info = explain(reply, "variant");
			if (stillOpen) variantProblem(info.text, info.detail);
			else showToast(info.text, true);
			return;
		}
		if (stillOpen) closeVariantDialog();
		const title = board.artboard.title;
		showToast(t(reply.body.queued === true ? "variant.queued" : "variant.sent", { title }), false);
		// A design change while the request was in flight leaves nothing to wait for here.
		if (board.slug === state.slug) showPlaceholder(board, "variant");
	});

	/** What a placeholder board is called and says, by the request that made it: another direction. */
	const PLACEHOLDER_KEYS = {
		variant: { title: "placeholder.title", aria: "placeholder.aria", status: "placeholder.status" },
	};

	/**
	 * The "<NN> · New direction" board, "Designing…", after the last artboard, with what is being
	 * designed centered in its frame at screen size; the minimap draws it as a dashed block.
	 */
	function showPlaceholder(source, kind) {
		if (state.placeholder) state.placeholder.remove();
		const keys = PLACEHOLDER_KEYS[kind];
		const number = nextNumber();
		const wrapper = document.createElement("section");
		wrapper.className = "gd-artboard gd-placeholder";
		wrapper.dataset.kind = kind;
		loc(wrapper, "aria-label", keys.aria, { number });
		const label = document.createElement("div");
		label.className = "gd-artboard-label";
		const head = document.createElement("div");
		head.className = "gd-artboard-head";
		const num = chip("gd-artboard-num", number);
		num.setAttribute("aria-hidden", "true");
		const title = document.createElement("h2");
		title.className = "gd-artboard-title";
		loc(title, "text", keys.title);
		const designing = chip("gd-placeholder-state", "");
		loc(designing, "text", "placeholder.state");
		designing.setAttribute("role", "status");
		head.append(num, title, designing);
		label.append(head);
		const box = document.createElement("div");
		box.className = "gd-frame-box";
		const frame = document.createElement("div");
		frame.className = "gd-placeholder-frame";
		frame.setAttribute("aria-hidden", "true");
		frame.style.width = `${source.artboard.width}px`;
		frame.style.height = `${source.artboard.height}px`;
		for (const width of ["60%", "100%", "100%", "80%"]) {
			const line = document.createElement("i");
			line.style.width = width;
			frame.append(line);
		}
		// Visual only: the head's status is the one announced.
		const status = chip("gd-placeholder-status", "");
		loc(status, "text", keys.status);
		frame.append(status);
		box.append(frame);
		wrapper.append(label, box);
		wrapper.layoutSize = { width: source.artboard.width, height: source.artboard.height };
		state.placeholder = wrapper;
		els.world.append(wrapper);
		applyLayout();
		renderMinimap();
	}

	// ---- handoffs ------------------------------------------------------------

	function ownPort() {
		const location = window.location;
		return location && typeof location.port === "string" ? location.port : "";
	}

	/**
	 * The preview URL Compare may frame: http(s) on localhost, 127.0.0.1 or [::1], no
	 * credentials, and never this canvas server's port (the server validates it too).
	 */
	function previewTarget(value) {
		if (typeof value !== "string" || value.length === 0 || value.length > MAX_PREVIEW_URL) return null;
		let url;
		try { url = new URL(value); } catch { return null; }
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		if (url.username || url.password || !LOOPBACK_HOSTS.includes(url.hostname)) return null;
		const port = url.port || (url.protocol === "https:" ? "443" : "80");
		return port === ownPort() ? null : url.href;
	}

	function handoffOf(board) {
		const data = state.handoffs;
		if (board.system || data.slug !== board.slug) return { chosen: null, entry: null };
		const file = board.artboard.file;
		const entry = Object.prototype.hasOwnProperty.call(data.handoffs, file) ? data.handoffs[file] : null;
		return { chosen: data.chosen, entry: entry && typeof entry === "object" ? entry : null };
	}

	function handoffKind(entry) {
		if (entry.status === "sent") return entry.queued === true ? "queued" : "sent";
		return entry.status === "in_progress" || entry.status === "implemented" ? entry.status : null;
	}

	function chip(className, text) {
		const element = document.createElement("span");
		element.className = className;
		element.textContent = text;
		return element;
	}

	// The four handoff steps, as the timeline and the chosen artboard's stepper show them.
	const STEPPER_KEYS = ["choice.chosen", "stepper.sent", "handoff.in_progress", "timeline.implemented"];

	/** Where a handoff of this kind stands on the four steps: each one done, current or pending. */
	function handoffSteps(kind) {
		// The index of the step the handoff is at; steps before it are done, a step at it is current.
		const at = { queued: 1, sent: 2, in_progress: 2, implemented: 4 }[kind] ?? 1;
		return STEPPER_KEYS.map((key, index) => (index < at ? "done" : index === at && kind ? "current" : "pending"));
	}

	/** The chosen artboard's mini stepper: Chosen → Sent → In progress → Implemented, and in words which step it is at. */
	function miniStepper(kind) {
		const steps = handoffSteps(kind);
		const current = steps.indexOf("current");
		const at = current >= 0 ? current : steps.lastIndexOf("done");
		const root = chip("gd-ministep", "");
		// Never color alone: the position is in words for assistive technology, the dots are decoration.
		const words = chip("gd-visually-hidden gd-ministep-words", t("stepper.position", { n: at + 1, total: steps.length, step: t(STEPPER_KEYS[at]) }));
		const list = document.createElement("ol");
		list.className = "gd-ministep-list";
		list.setAttribute("aria-hidden", "true");
		list.append(...steps.map((status, index) => {
			const item = document.createElement("li");
			item.className = "gd-ministep-step";
			item.dataset.state = status;
			item.append(chip("gd-ministep-dot", ""), chip("gd-ministep-label", t(STEPPER_KEYS[index])));
			return item;
		}));
		root.append(words, list);
		return root;
	}

	/** The header row of one artboard: Chosen or Discarded, the chosen one's stepper, the handoff badge, its feature document, note and Compare. */
	function renderHandoff(board) {
		if (board.system || !board.handoff) return;
		const { chosen, entry } = handoffOf(board);
		const isChosen = typeof chosen === "string" && chosen === board.artboard.file;
		const isDiscarded = typeof chosen === "string" && !isChosen;
		board.wrapper.classList.toggle("gd-chosen", isChosen);
		board.wrapper.classList.toggle("gd-discarded", isDiscarded);
		board.implement.setDiscarded(isDiscarded);
		const parts = [];
		const kind = entry ? handoffKind(entry) : null;
		if (isChosen) parts.push(miniStepper(kind));
		if (typeof chosen === "string") parts.push(chip(`gd-choice ${isChosen ? "gd-choice-chosen" : "gd-choice-discarded"}`, t(isChosen ? "choice.chosen" : "choice.discarded")));
		board.stateChip.hidden = !kind;
		board.stateChip.textContent = kind ? t(`handoff.${kind}`) : "";
		if (kind) board.stateChip.dataset.status = kind;
		else delete board.stateChip.dataset.status;
		let compare = null;
		if (kind) {
			const badge = chip("gd-handoff-badge", t(`handoff.${kind}`));
			badge.dataset.status = kind;
			parts.push(badge);
			if (typeof entry.feature === "string" && entry.feature) {
				const feature = chip("gd-handoff-feature", entry.feature);
				feature.title = t("handoff.featureTitle");
				parts.push(feature);
			}
			if (typeof entry.note === "string" && entry.note) {
				const note = chip("gd-handoff-note", entry.note);
				note.title = entry.note;
				parts.push(note);
			}
			const preview = kind === "implemented" ? previewTarget(entry.previewUrl) : null;
			if (preview) {
				compare = document.createElement("button");
				compare.type = "button";
				compare.className = "gd-compare-start";
				compare.textContent = t("handoff.compare");
				compare.setAttribute("aria-label", t("handoff.compareAria", { title: board.artboard.title }));
				compare.addEventListener("click", () => enterCompare(board, preview));
				parts.push(compare);
			}
		}
		const hadFocus = board.handoff.contains(document.activeElement);
		board.handoff.replaceChildren(...parts);
		board.handoff.hidden = parts.length === 0;
		board.wrapper.classList.toggle("gd-has-handoff", parts.length > 0);
		board.wrapper.classList.toggle("gd-has-stepper", isChosen);
		if (hadFocus && compare) compare.focus();
	}

	function renderHandoffs() {
		state.boards.forEach(renderHandoff);
		renderHandoffViews();
	}

	/** The chosen artboard of the open design, or null. */
	function chosenBoard() {
		const chosen = state.handoffs.slug === state.slug ? state.handoffs.chosen : null;
		return typeof chosen === "string" ? state.boards.find((board) => board.artboard.file === chosen) ?? null : null;
	}

	/** Everything outside the artboards that follows handoffs, boards and comments: the minimap, Compare with app, timeline. */
	function renderHandoffViews() {
		renderMinimap();
		renderCompareApp();
		renderTimeline();
		renderParts();
		// After Compare with app: the help points at it once it shows.
		renderGuide(false);
	}

	function renderCompareApp() {
		const board = chosenBoard();
		const entry = board ? handoffOf(board).entry : null;
		const preview = entry && handoffKind(entry) === "implemented" ? previewTarget(entry.previewUrl) : null;
		state.comparePreview = board && preview ? { board, preview } : null;
		els.compareApp.hidden = !state.comparePreview;
	}

	els.compareApp.addEventListener("click", () => {
		if (state.comparePreview) enterCompare(state.comparePreview.board, state.comparePreview.preview);
	});

	/**
	 * A short local time: "Today 10:42" / "Hoy 10:42", "Oct 26, 10:42" / "26 oct, 10:42", or "Mar 4 2020, 09:05" / "4 mar 2020, 09:05"
	 * from another year (month names from Intl); "" when unreadable.
	 */
	function shortTime(value) {
		const date = typeof value === "string" ? new Date(value) : null;
		if (!date || Number.isNaN(date.getTime())) return "";
		const now = new Date();
		const clock = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
		if (date.toDateString() === now.toDateString()) return t("time.today", { clock });
		const day = new Intl.DateTimeFormat(dateLocale(), { month: "short", day: "numeric" }).format(date);
		return `${date.getFullYear() === now.getFullYear() ? day : `${day} ${date.getFullYear()}`}, ${clock}`;
	}

	/** A time in Partial implementations: just HH:MM today, otherwise the short date as the timeline writes it. */
	function clockOrDate(value) {
		const date = typeof value === "string" ? new Date(value) : null;
		if (!date || Number.isNaN(date.getTime())) return "";
		if (date.toDateString() !== new Date().toDateString()) return shortTime(value);
		return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
	}

	// ---- connection (canvas-progressive S3, canvas-layout S14) ------------------------------
	// Connected while every delivery the page config names exists, shown as a dot alone: the word stays for screen readers
	// and the sentence in the tooltip. Otherwise Not connected, in words and the warning style, with the way out (the S15
	// wording) in its tooltip and, for screen readers, in a visually hidden sentence.

	let connectionParts = null;

	function renderConnection() {
		if (!connectionParts) {
			const dot = chip("gd-connection-dot", "");
			dot.setAttribute("aria-hidden", "true");
			connectionParts = { label: chip("gd-connection-label", ""), hidden: chip("gd-visually-hidden", "") };
			els.connection.replaceChildren(dot, connectionParts.label, connectionParts.hidden);
		}
		const online = Object.values(DELIVERY).every(Boolean);
		els.connection.dataset.state = online ? "on" : "off";
		connectionParts.label.textContent = t(online ? "connection.on" : "connection.off");
		connectionParts.label.classList.toggle("gd-visually-hidden", online);
		const sentence = online ? t("connection.onTitle") : t("connection.offTitle", { slug: state.slug ?? "<slug>" });
		els.connection.title = sentence;
		connectionParts.hidden.textContent = online ? "" : ` ${sentence}`;
	}

	// ---- step-by-step help (replaces the canvas-progressive S6 first-run guide) ------------
	// Off by default. Settings' Step-by-step help turns it on and saves it in this browser (HELP_KEY); while on, a non-modal
	// card names the step you are at and what to do there, and changes with it: the directions, a direction in focus, the
	// agent building the chosen one (its header), and Compare with app once it is implemented. Got it (or Esc) hides the card until the
	// step changes; Turn off help turns it off. It never shows over Compare, the comment box, a dialog or a menu: it waits
	// while one is open and comes back. Only turning it on moves focus into the card; a new step never takes the keyboard.

	const HELP_STEPS = {
		compare: { title: "guide.compare.title", text: "guide.compare.text", target: () => els.world },
		review: { title: "guide.review.title", text: "guide.review.text", target: () => state.focus?.implement?.root ?? null },
		building: { title: "guide.building.title", text: "guide.building.text", target: () => chosenBoard()?.header ?? null },
		done: { title: "guide.done.title", text: "guide.done.text", target: () => (els.compareApp.hidden ? chosenBoard()?.header ?? null : els.compareApp) },
	};
	// The card's own list of steps, and which one each help step is at: the agent building it and done are both Implement.
	const GUIDE_STEP_KEYS = ["guide.step.compare", "guide.step.review", "guide.step.choose", "guide.step.implement"];
	const GUIDE_STEP_AT = { compare: 0, review: 1, building: 3, done: 3 };
	// The room the spotlight leaves around its target, and between the target and the card (where its arrow is).
	const GUIDE_PAD = 8;
	const GUIDE_GAP = 16;

	/** True only when this browser saved the help as on; unreadable storage starts with it off. */
	function storedHelp() {
		try {
			return localStorage.getItem(HELP_KEY) === "on";
		} catch {
			return false;
		}
	}
	state.help.on = storedHelp();

	/** The step the help speaks about, or null on the design system board or with no directions. */
	function helpStep() {
		if (state.boards.length === 0 || state.focus?.system) return null;
		const board = chosenBoard();
		if (board) {
			const entry = handoffOf(board).entry;
			return entry && handoffKind(entry) === "implemented" ? "done" : "building";
		}
		return state.focus ? "review" : "compare";
	}

	function guideBlocked() {
		return Boolean(state.compare || state.menu || state.deviceMenu || !els.popover.hidden || els.shortcuts.hasAttribute("open") || els.appearance.hasAttribute("open") || els.variantDialog.hasAttribute("open"));
	}

	/** Turns the help on (its card for the current step takes focus, coming back to `returnFocus`) or off, and saves it. */
	function setHelp(on, returnFocus) {
		state.help = { on, dismissed: null, returnFocus: on ? returnFocus ?? document.activeElement : null };
		try { localStorage.setItem(HELP_KEY, on ? "on" : "off"); } catch { /* storage may be unavailable: on for this page only */ }
		renderGuide(on);
	}

	/** Got it and Esc: hides this step's card; the next step shows its own. */
	function dismissGuide() {
		state.help.dismissed = helpStep();
		hideGuide();
	}

	/** Gives focus back where it was when the card took it, when the keyboard was in the card. */
	function hideGuide() {
		const inside = els.guide.contains(document.activeElement) || document.activeElement === els.guideNext || document.activeElement === els.guideSkip;
		const back = state.help.returnFocus && state.help.returnFocus !== document.body ? state.help.returnFocus : els.viewport;
		state.help.returnFocus = null;
		renderGuide(false);
		if (inside || document.activeElement === document.body) back.focus();
	}

	/** Shows the card and the spotlight for the current step, or hides them; `moveFocus` puts the keyboard on Got it. */
	function renderGuide(moveFocus) {
		const name = state.help.on ? helpStep() : null;
		if (state.help.dismissed && state.help.dismissed !== name) state.help.dismissed = null;
		const shown = Boolean(name) && state.help.dismissed !== name && !guideBlocked();
		els.guide.hidden = !shown;
		els.guideSpot.hidden = !shown;
		if (!shown) return;
		const step = HELP_STEPS[name];
		const at = GUIDE_STEP_AT[name];
		loc(els.guideEyebrow, "text", "guide.eyebrow", { n: at + 1, total: GUIDE_STEP_KEYS.length });
		loc(els.guideTitle, "text", step.title);
		loc(els.guideText, "text", step.text);
		els.guideSteps.replaceChildren(...GUIDE_STEP_KEYS.map((key, index) => {
			const item = document.createElement("li");
			loc(item, "text", key);
			if (index === at) item.setAttribute("aria-current", "step");
			return item;
		}));
		els.guide.dataset.target = name;
		placeGuide();
		if (moveFocus) els.guideNext.focus();
	}

	/**
	 * The spotlight around the step's target (the directions and the chosen artboard's header are clipped to the viewport; one
	 * out of view falls back to it) and the card below it, above it, or inside the viewport.
	 */
	function placeGuide() {
		const name = els.guide.hidden ? null : els.guide.dataset.target;
		if (!name || !HELP_STEPS[name]) return;
		const view = els.viewport.getBoundingClientRect();
		const element = HELP_STEPS[name].target();
		let rect = element ? element.getBoundingClientRect() : null;
		if (!rect || (rect.width === 0 && rect.height === 0)) rect = view;
		if (name === "compare" || (element && element === chosenBoard()?.header)) {
			const left = Math.max(rect.left, view.left);
			const top = Math.max(rect.top, view.top);
			const right = Math.min(rect.left + rect.width, view.left + view.width);
			const bottom = Math.min(rect.top + rect.height, view.top + view.height);
			rect = right > left && bottom > top ? { left, top, width: right - left, height: bottom - top } : view;
		}
		const spot = { left: rect.left - GUIDE_PAD, top: rect.top - GUIDE_PAD, width: rect.width + GUIDE_PAD * 2, height: rect.height + GUIDE_PAD * 2 };
		els.guideSpot.style.left = `${spot.left}px`;
		els.guideSpot.style.top = `${spot.top}px`;
		els.guideSpot.style.width = `${spot.width}px`;
		els.guideSpot.style.height = `${spot.height}px`;
		const width = els.guide.offsetWidth;
		const height = els.guide.offsetHeight;
		let side = "below";
		let top = spot.top + spot.height + GUIDE_GAP;
		if (top + height > window.innerHeight - 12) {
			side = "above";
			top = spot.top - GUIDE_GAP - height;
		}
		if (top < 12) {
			side = "inside";
			top = Math.max(12, view.top + view.height - height - 24);
		}
		const center = rect.left + rect.width / 2;
		const left = Math.max(12, Math.min(center - width / 2, window.innerWidth - width - 12));
		els.guide.dataset.side = side;
		els.guide.style.left = `${left}px`;
		els.guide.style.top = `${top}px`;
		// The card's arrow points at the target's center, kept on the card.
		els.guide.style.setProperty("--gd-guide-arrow", `${Math.max(20, Math.min(center - left, width - 20))}px`);
	}

	els.guideNext.addEventListener("click", dismissGuide);
	els.guideSkip.addEventListener("click", () => {
		const back = state.help.returnFocus;
		state.help = { on: false, dismissed: null, returnFocus: back };
		try { localStorage.setItem(HELP_KEY, "off"); } catch { /* storage may be unavailable */ }
		hideGuide();
	});
	els.guide.addEventListener("keydown", (event) => {
		if (event.key !== "Escape") return;
		event.preventDefault();
		event.stopPropagation();
		dismissGuide();
	});
	// Esc anywhere on the page hides the card first, while it shows (it never shows over what else takes Esc).
	document.addEventListener("keydown", (event) => {
		if (event.defaultPrevented || event.key !== "Escape" || event.shiftKey || els.guide.hidden) return;
		event.preventDefault();
		dismissGuide();
	});

	/** Chosen, Sent to the session, In progress, Implemented: done, current or pending, with timestamps. */
	function renderTimeline() {
		const board = chosenBoard();
		els.handoffPanel.hidden = !board;
		if (!board) {
			els.timeline.replaceChildren();
			return;
		}
		els.handoffTitle.textContent = t("timeline.title", { title: board.artboard.title });
		const entry = handoffOf(board).entry;
		const kind = entry ? handoffKind(entry) : null;
		const steps = handoffSteps(kind);
		const sent = entry ? shortTime(entry.sentAt) : "";
		const started = entry ? shortTime(entry.startedAt) : "";
		const finished = entry ? shortTime(entry.implementedAt) : "";
		const note = entry && typeof entry.note === "string" && entry.note ? `“${entry.note}”` : "";
		const queued = kind === "queued";
		const defs = [
			[t("choice.chosen"), []],
			[t("timeline.sent"), queued ? [sent ? t("timeline.queued", { time: sent }) : t("handoff.queued")] : kind ? [sent] : [t("timeline.useImplement")]],
			[t("handoff.in_progress"), kind ? [started, note] : []],
			[t("timeline.implemented"), [kind === "implemented" ? finished : t("timeline.compareWhenReady")]],
		];
		els.timeline.replaceChildren(...defs.map(([label, details], index) => {
			const status = steps[index];
			const item = document.createElement("li");
			item.className = `gd-step gd-step-${status}`;
			item.dataset.state = status;
			if (status === "current") item.setAttribute("aria-current", "step");
			const dot = document.createElement("span");
			dot.className = "gd-step-dot";
			dot.setAttribute("aria-hidden", "true");
			const body = document.createElement("span");
			body.className = "gd-step-body";
			// Never color alone: the state is also in words for assistive technology.
			const words = chip("gd-visually-hidden gd-step-state", ` ${t(status === "done" ? "timeline.done" : status === "current" ? "timeline.current" : "timeline.pending")}`);
			body.append(chip("gd-step-label", label), words, ...details.filter(Boolean).map((text) => chip("gd-step-detail", text)));
			item.append(dot, body);
			return item;
		}));
	}

	function setHandoffs(slug, data) {
		const valid = Boolean(data && typeof data === "object" && data.handoffs && typeof data.handoffs === "object" && !Array.isArray(data.handoffs));
		state.handoffs = { slug, chosen: valid && typeof data.chosen === "string" ? data.chosen : null, handoffs: valid ? data.handoffs : {} };
		renderHandoffs();
	}

	async function loadHandoffs() {
		const slug = state.slug;
		if (!slug) return;
		let data = null;
		try {
			data = await getJson(`api/designs/${encodeURIComponent(slug)}/handoffs`);
		} catch (error) {
			setStatus("status.handoffs", true, { slug, message: error.message });
		}
		if (slug === state.slug) setHandoffs(slug, data);
	}

	// ---- partial implementations (canvas-implement-part S3) ----------------------------------
	// Parts handed off with Implement only this, from parts.json: listed under the handoff timeline with their state in
	// words, time, the agent's note and Show. They never choose a direction.

	async function loadParts() {
		const slug = state.slug;
		if (!slug) return;
		let data = null;
		try {
			data = await getJson(`api/designs/${encodeURIComponent(slug)}/parts`);
		} catch (error) {
			setStatus("status.handoffs", true, { slug, message: error.message });
		}
		if (slug !== state.slug) return;
		state.parts = { slug, parts: data && Array.isArray(data.parts) ? data.parts.filter((part) => part && typeof part === "object" && typeof part.id === "string" && typeof part.file === "string") : [] };
		renderParts();
	}

	/** A part the server just accepted, before its parts.json change event arrives. */
	function noteParts(slug, part) {
		if (state.parts.slug !== slug) state.parts = { slug, parts: [] };
		if (!state.parts.parts.some((entry) => entry.id === part.id)) state.parts.parts.push(part);
		renderParts();
	}

	function partKind(part) {
		if (part.status === "implemented" || part.status === "in_progress") return part.status;
		return part.queued ? "queued" : "sent";
	}

	function renderParts() {
		const parts = state.parts.slug === state.slug ? state.parts.parts : [];
		els.partsPanel.hidden = parts.length === 0;
		if (parts.length === 0) {
			els.partsList.replaceChildren();
			return;
		}
		els.partsTitle.textContent = t("parts.title", { count: parts.length });
		els.partsList.replaceChildren(...parts.map((part, index) => {
			const kind = partKind(part);
			const board = state.boards.find((candidate) => candidate.artboard.file === part.file);
			const item = document.createElement("li");
			item.className = "gd-part";
			item.dataset.status = kind;
			const head = document.createElement("div");
			head.className = "gd-part-head";
			const title = board ? `${String(board.number).padStart(2, "0")} · ${board.artboard.title}` : part.file;
			head.append(chip("gd-part-title", title), chip("gd-part-state", t(`part.state.${kind}`)));
			item.append(head);
			if (part.excerpt) item.append(chip("gd-part-excerpt", `“${part.excerpt}”`));
			if (state.technical) item.append(chip("gd-part-selector", part.selector));
			const stamp = kind === "implemented" ? part.implementedAt : kind === "in_progress" ? part.startedAt : part.sentAt;
			const time = clockOrDate(stamp);
			if (time) item.append(chip("gd-part-time", t(`part.time.${kind}`, { time })));
			if (typeof part.note === "string" && part.note) item.append(chip("gd-part-note", `“${part.note}”`));
			const show = document.createElement("button");
			show.type = "button";
			show.className = "gd-part-show gd-small";
			show.textContent = t("part.show");
			show.setAttribute("aria-label", t("part.showAria", { n: index + 1, file: part.file }));
			show.disabled = !board;
			show.addEventListener("click", () => showPart(part));
			item.append(show);
			return item;
		}));
	}

	/** Show: the part's artboard in focus, with its element highlighted by the artboard's inspector. */
	function showPart(part) {
		const board = state.boards.find((candidate) => candidate.artboard.file === part.file);
		if (!board) return;
		exitCompare(false);
		enterFocus(board);
		for (const surface of surfacesOf(board)) surface.frame.contentWindow?.postMessage({ type: "gd:highlight", selector: part.selector }, "*");
	}

	/** Shows a handoff the server just accepted, before its handoffs.json change event arrives. */
	function noteHandoff(slug, file, queued) {
		const current = state.handoffs.slug === slug ? state.handoffs.handoffs : {};
		const feature = state.manifest && state.manifest.slug === slug && typeof state.manifest.feature === "string" ? state.manifest.feature : undefined;
		const entry = { status: "sent", queued, sentAt: new Date().toISOString(), startedAt: null, implementedAt: null };
		if (feature) entry.feature = feature;
		const handoffs = Object.assign({}, current);
		handoffs[file] = entry;
		state.handoffs = { slug, chosen: file, handoffs };
		renderHandoffs();
	}

	// ---- compare -------------------------------------------------------------

	function comparePane(frame, key, params) {
		const figure = document.createElement("figure");
		figure.className = "gd-compare-pane";
		const label = document.createElement("figcaption");
		label.className = "gd-compare-caption";
		loc(label, "text", key, params);
		figure.append(label, frame);
		return figure;
	}

	function compareFrame(width, height, title) {
		const frame = document.createElement("iframe");
		frame.className = "gd-compare-frame";
		frame.setAttribute("referrerpolicy", "no-referrer");
		frame.title = title;
		frame.style.width = `${width}px`;
		frame.style.height = `${height}px`;
		return frame;
	}

	function setCompareMessage(key, params, isError) {
		loc(els.compareMessage, "text", key, params);
		els.compareMessage.classList.toggle("gd-error", Boolean(isError));
	}

	/** 100% by default; past the window width, "Scale to fit" shrinks the pair to fit. */
	function layoutCompare() {
		const compare = state.compare;
		if (!compare) return;
		const { width } = compare.board.artboard;
		const needed = width * 2 + COMPARE_GAP;
		const available = els.compareStage.getBoundingClientRect().width - COMPARE_PADDING * 2;
		const wide = needed > available;
		els.compareFitField.hidden = !wide;
		const scale = wide && els.compareFit.checked ? Math.max(0.05, available / needed) : 1;
		els.comparePanes.style.transform = scale === 1 ? "none" : `scale(${scale.toFixed(3)})`;
		// The sizer keeps the scroll area at the scaled size.
		els.compareSizer.style.width = scale === 1 ? "" : `${Math.ceil(needed * scale)}px`;
		els.compareSizer.style.height = scale === 1 ? "" : `${Math.ceil(els.comparePanes.offsetHeight * scale)}px`;
	}

	/** The artboard (sandboxed as on the canvas) next to the running app, both at the artboard's size. */
	function enterCompare(board, preview) {
		exitCompare(false);
		exitFocus();
		closePopover();
		const { width, height, title } = board.artboard;
		const artboardFrame = compareFrame(width, height, t("board.frameTitle", { title }));
		artboardFrame.setAttribute("sandbox", "allow-scripts");
		// Like focus mode: the artboard owns its scroll, and Shift+Esc inside it asks to leave.
		artboardFrame.addEventListener("load", () => artboardFrame.contentWindow?.postMessage({ type: "gd:focus", enabled: true }, "*"));
		artboardFrame.src = boardUrl(board);
		const app = compareFrame(width, height, t("compare.appFrame", { url: preview }));
		app.setAttribute("sandbox", PREVIEW_SANDBOX);
		const compare = { board, preview, artboardFrame, appFrame: app, timer: 0, loaded: false };
		const failed = (key) => {
			if (state.compare === compare) setCompareMessage(key, { url: preview }, true);
		};
		// A frame refused by X-Frame-Options or frame-ancestors may still fire load, so the
		// Open in new tab fallback is always shown; a missing load also says so.
		app.addEventListener("load", () => { compare.loaded = true; });
		app.addEventListener("error", () => failed("compare.errorFrame"));
		compare.timer = setTimeout(() => {
			if (!compare.loaded) failed("compare.errorTimeout");
		}, PREVIEW_TIMEOUT_MS);
		app.src = preview;
		state.compare = compare;
		renderMinimap();
		loc(els.compareTitle, "text", "compare.titleFor", { title });
		// A new tab with no opener and no Referer: the canvas URL carries the server token.
		els.compareOpen.setAttribute("target", "_blank");
		els.compareOpen.setAttribute("rel", "noopener noreferrer");
		els.compareOpen.href = preview;
		setCompareMessage(new URL(preview).hostname === "[::1]" ? "compare.hintIpv6" : "compare.hint", { url: new URL(preview).origin }, false);
		els.comparePanes.replaceChildren(comparePane(artboardFrame, "compare.designCaption", { file: board.artboard.file }), comparePane(app, "compare.appCaption", { url: preview }));
		// On by default (polish F5): it only applies when the pair is wider than the window, and can be unchecked.
		els.compareFit.checked = true;
		els.compare.hidden = false;
		renderGuide(false);
		els.viewport.inert = true;
		els.panel.inert = true;
		for (const control of [els.zoomOut, els.zoomIn, els.fit, els.railFit, els.design, els.compareApp]) control.disabled = true;
		layoutCompare();
		els.compareBack.focus();
	}

	function exitCompare(restoreFocus) {
		const compare = state.compare;
		if (!compare) return;
		clearTimeout(compare.timer);
		state.compare = null;
		els.comparePanes.replaceChildren();
		els.compareOpen.removeAttribute("href");
		els.compare.hidden = true;
		els.viewport.inert = false;
		els.panel.inert = false;
		applyFocusState();
		if (!restoreFocus) return;
		const board = state.boards.find((candidate) => candidate.artboard.file === compare.board.artboard.file);
		const button = board ? Array.from(board.handoff.children).find((child) => child.classList.contains("gd-compare-start")) : null;
		(button ?? els.viewport).focus();
	}

	els.compareBack.addEventListener("click", () => exitCompare(true));
	els.compareFit.addEventListener("change", layoutCompare);

	function showFeature(manifest) {
		const feature = manifest && typeof manifest.feature === "string" ? manifest.feature : "";
		els.feature.textContent = feature;
		els.feature.hidden = !feature;
		els.featureSep.hidden = !feature;
	}

	/** No design selected: only the system board, or the empty notice. */
	function showSystemOnly() {
		state.manifest = null;
		state.boards = [];
		useLayout(null, null);
		showFeature(null);
		if (!state.systemBoard) {
			showEmpty("empty.noDesigns");
			return;
		}
		els.empty.hidden = true;
		placeBoards();
		renderHandoffViews();
		setStatus("", false);
		requestAnimationFrame(fit);
	}

	async function loadManifest(slug, keepView) {
		let manifest;
		try {
			manifest = await getJson(`api/designs/${encodeURIComponent(slug)}`);
		} catch (error) {
			showEmpty("empty.cannotShow", { slug, message: error.message });
			setStatus("status.invalidManifest", true, { slug });
			return;
		}
		if (slug !== state.slug) return;
		// Where the boards sit; a save in flight is newer than what the file may still say.
		const layout = await fetchLayout(slug);
		if (slug !== state.slug) return;
		if (state.layout.slug !== slug || state.layoutSaves === 0) useLayout(slug, layout);
		closePopover();
		renderConnection();
		// A manifest change is the new artboard arriving (or any other edit): the placeholder has done its job.
		state.placeholder = null;
		state.manifest = manifest;
		showFeature(manifest);
		document.title = `${manifest.title} · Gentle Design`;
		history.replaceState(null, "", `${base}d/${encodeURIComponent(slug)}/`);
		if (manifest.artboards.length === 0 && !state.systemBoard) {
			showEmpty("empty.noArtboards");
			return;
		}
		els.empty.hidden = true;
		const focusFile = state.focus && !state.focus.system ? state.focus.artboard.file : null;
		state.boards.forEach(removeSizeFrames);
		state.boards = manifest.artboards.map((artboard, index) => createBoard(slug, artboard, false, index + 1));
		// A manifest reload keeps focus mode on the same artboard file while it still exists.
		if (focusFile) state.focus = state.boards.find((board) => board.artboard.file === focusFile) ?? state.focus;
		placeBoards();
		if (state.focus) requestAnimationFrame(applySize);
		const warnings = Array.isArray(manifest.warnings) ? manifest.warnings.filter((warning) => typeof warning === "string") : [];
		if (warnings.length > 0) setStatus("status.warnings", true, { warnings: warnings.join("; ") });
		else setStatus(state.boards.length === 0 ? "empty.noArtboards" : "", false);
		if (!keepView) requestAnimationFrame(fit);
		await loadHandoffs();
		await loadParts();
		await loadComments();
	}

	function reloadBoard(board) {
		const url = `${boardUrl(board)}?v=${Date.now()}`;
		for (const surface of surfacesOf(board)) {
			surface.rects = null;
			surface.frame.src = url;
		}
	}

	// ---- layout (canvas-layout) ------------------------------------------------
	// Artboards are placed in the world by position, not by the flow of a row: the world is as big as their bounds,
	// so fit, the minimap, focus mode and the help card read it as before.

	/** A board's key in layout.json: its artboard file, or the system board's own key. */
	function layoutKey(board) {
		return board.system ? LAYOUT_SYSTEM_KEY : board.artboard.file;
	}

	/** A world child's box in world px: its manifest width, and its frame (at its manifest height) below its label. */
	function layoutSize(wrapper) {
		const box = wrapper.children[wrapper.children.length - 1];
		const size = wrapper.layoutSize ?? { width: 0, height: 0 };
		return { width: size.width, height: (box ? box.offsetTop : 0) + size.height };
	}

	/** api/designs/<slug>/layout's layout, or null when it is none (the boards then sit in a row). */
	function readLayout(value) {
		if (!value || typeof value !== "object" || Array.isArray(value)) return null;
		if (value.arrangement !== "free" && !ARRANGEMENTS.includes(value.arrangement)) return null;
		const raw = value.positions;
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
		const positions = {};
		for (const [key, position] of Object.entries(raw)) {
			if (!position || !Number.isInteger(position.x) || !Number.isInteger(position.y)) return null;
			positions[key] = { x: position.x, y: position.y };
		}
		return { arrangement: value.arrangement, positions };
	}

	/** The saved layout of design `slug`; null when it has none or it cannot be read (the canvas never fails on it). */
	async function fetchLayout(slug) {
		try {
			const data = await getJson(`api/designs/${encodeURIComponent(slug)}/layout`);
			return readLayout(data && data.layout);
		} catch {
			return null;
		}
	}

	/** Takes `layout` (null: none, a row) as design `slug`'s; the boards move at the next applyLayout. */
	function useLayout(slug, layout) {
		state.layout = { slug, arrangement: layout ? layout.arrangement : "row", positions: layout ? { ...layout.positions } : {}, saved: JSON.stringify(layout) };
	}

	/** The top left of a box right of the boxes `rects`, top-aligned with them, or below them, left-aligned. */
	function spotAfter(rects, below) {
		if (rects.length === 0) return { x: 0, y: 0 };
		const left = Math.min(...rects.map((rect) => rect.x));
		const top = Math.min(...rects.map((rect) => rect.y));
		if (below) return { x: left, y: Math.max(...rects.map((rect) => rect.y + rect.height)) + BOARD_GAP };
		return { x: Math.max(...rects.map((rect) => rect.x + rect.width)) + BOARD_GAP, y: top };
	}

	/**
	 * Positions of `boards` in arrangement `kind`, in order, BOARD_GAP apart: a grid of roughly square columns, each as
	 * wide as its widest board, and rows as tall as their tallest; a row is a grid of one row, a column one of one column.
	 */
	function arranged(kind, boards) {
		const columns = Math.max(1, kind === "row" ? boards.length : kind === "column" ? 1 : Math.ceil(Math.sqrt(boards.length)));
		const widths = [];
		const heights = [];
		boards.forEach((board, index) => {
			const size = layoutSize(board.wrapper);
			const column = index % columns;
			const row = Math.floor(index / columns);
			widths[column] = Math.max(widths[column] ?? 0, size.width);
			heights[row] = Math.max(heights[row] ?? 0, size.height);
		});
		const starts = (lengths) => lengths.map((_, index) => lengths.slice(0, index).reduce((sum, length) => sum + length + BOARD_GAP, 0));
		const xs = starts(widths);
		const ys = starts(heights);
		return Object.fromEntries(boards.map((board, index) => [layoutKey(board), { x: xs[index % columns], y: ys[Math.floor(index / columns)] }]));
	}

	function place(wrapper, at) {
		wrapper.layoutAt = at;
		wrapper.style.left = `${at.x}px`;
		wrapper.style.top = `${at.y}px`;
	}

	/** The world as big as the bounds of what is placed in it, so fit and the help card see every board. */
	function sizeWorld() {
		let right = 0;
		let bottom = 0;
		for (const wrapper of Array.from(els.world.children)) {
			if (!wrapper.layoutAt) continue;
			const size = layoutSize(wrapper);
			right = Math.max(right, wrapper.layoutAt.x + size.width);
			bottom = Math.max(bottom, wrapper.layoutAt.y + size.height);
		}
		els.world.style.width = `${right}px`;
		els.world.style.height = `${bottom}px`;
	}

	/**
	 * Puts every board where the layout says, and the placeholder after them, and sizes the world to their bounds. An
	 * arrangement is laid out again from the boards' sizes; a free layout keeps each board's position, a board it does
	 * not know goes after the others, and one the design lost drops out. Positions keep the bounds' top left at 0, 0:
	 * when a board went left of (or above) the others, everything shifts and the view follows, so nothing jumps.
	 */
	function applyLayout() {
		const boards = allBoards();
		const layout = state.layout;
		const keys = boards.map(layoutKey);
		let positions = {};
		if (layout.arrangement === "free") {
			const rects = [];
			const known = boards.filter((board, index) => layout.positions[keys[index]]);
			for (const board of [...known, ...boards.filter((board) => !known.includes(board))]) {
				const key = layoutKey(board);
				positions[key] = layout.positions[key] ?? spotAfter(rects, false);
				rects.push({ ...positions[key], ...layoutSize(board.wrapper) });
			}
		} else positions = arranged(layout.arrangement, boards);
		const minX = boards.length > 0 ? Math.min(...keys.map((key) => positions[key].x)) : 0;
		const minY = boards.length > 0 ? Math.min(...keys.map((key) => positions[key].y)) : 0;
		layout.positions = Object.fromEntries(keys.map((key) => [key, { x: positions[key].x - minX, y: positions[key].y - minY }]));
		boards.forEach((board, index) => place(board.wrapper, layout.positions[keys[index]]));
		if (state.placeholder) place(state.placeholder, spotAfter(boards.map((board) => ({ ...board.wrapper.layoutAt, ...layoutSize(board.wrapper) })), layout.arrangement === "column"));
		sizeWorld();
		if (minX === 0 && minY === 0) return;
		const view = state.focus ? state.savedView : state;
		if (view) {
			view.x += minX * view.zoom;
			view.y += minY * view.zoom;
		}
		if (!state.focus) applyView();
	}

	/** Puts `board` at `at` while it is dragged by its title; it is saved on release (finishMove). */
	function moveBoard(board, at) {
		state.layout.positions[layoutKey(board)] = at;
		board.wrapper.classList.add("gd-lifted");
		place(board.wrapper, at);
		sizeWorld();
		renderMinimap();
	}

	/** A board moved by hand: the layout is free from now on, and it is saved once. */
	function finishMove() {
		state.layout.arrangement = "free";
		applyLayout();
		renderArrange();
		saveLayout();
	}

	/** Writes the layout of the design shown to its layout.json; a failure says so in the status line and the boards stay. */
	async function saveLayout() {
		const slug = state.slug;
		if (!slug || !state.manifest || state.layout.slug !== slug) return;
		const body = { arrangement: state.layout.arrangement, positions: state.layout.positions };
		state.layout.saved = JSON.stringify(body);
		state.layoutSaves += 1;
		const reply = await postJson(`api/designs/${encodeURIComponent(slug)}/layout`, body);
		state.layoutSaves -= 1;
		if (!reply.ok && slug === state.slug) setStatus("status.layout", true, { slug, message: explain(reply).detail });
	}

	/** layout.json changed: another page moved or arranged the boards, so they move here too; the page's own save is no news. */
	async function onLayoutChange() {
		const slug = state.slug;
		if (!slug || state.layoutSaves > 0) return;
		const layout = await fetchLayout(slug);
		if (slug !== state.slug || !state.manifest || state.layoutSaves > 0 || (drag && drag.mover)) return;
		if (JSON.stringify(layout) === state.layout.saved) return;
		useLayout(slug, layout);
		applyLayout();
		renderArrange();
		renderMinimap();
		if (state.focus) centerFocus();
	}

	/** The Row / Column / Grid buttons: the current arrangement pressed (none for a hand-made layout), off inside a direction. */
	function renderArrange() {
		const off = Boolean(state.focus) || !state.manifest;
		for (const kind of ARRANGEMENTS) {
			els.arrange[kind].setAttribute("aria-pressed", String(state.layout.arrangement === kind));
			els.arrange[kind].disabled = off;
		}
	}

	/** Lays every board out as a row, a column or a grid, saves it and shows them all. */
	function arrange(kind) {
		if (state.focus || !state.manifest) return;
		state.layout.arrangement = kind;
		applyLayout();
		renderArrange();
		saveLayout();
		fit();
	}

	for (const kind of ARRANGEMENTS) els.arrange[kind].addEventListener("click", () => arrange(kind));

	/** The system board first, then the design's artboards, each where the layout puts it. */
	function placeBoards() {
		const boards = allBoards();
		closeMenu(false);
		// A board being moved is replaced by a new one: the move ends where it is, unsaved.
		if (drag && drag.mover) {
			drag = null;
			els.viewport.classList.remove("gd-moving");
		}
		els.world.replaceChildren(...boards.map((board) => board.wrapper), ...(state.placeholder ? [state.placeholder] : []));
		applyLayout();
		if (state.mark && !boards.includes(state.mark.board)) clearMark();
		if (state.selected && !boards.includes(state.selected)) state.selected = null;
		if (state.focus && !boards.includes(state.focus)) exitFocus();
		else applyFocusState();
	}

	/** Reads api/system and creates or drops the system board; true when it appeared or went away. */
	async function refreshSystem() {
		let info = null;
		try { info = await getJson("api/system"); } catch { info = null; }
		const exists = Boolean(info && info.exists === true && isFiniteNumber(info.width) && isFiniteNumber(info.height));
		state.system = exists ? info : null;
		if (exists === Boolean(state.systemBoard)) return false;
		state.systemBoard = exists ? createBoard(null, { file: String(info.file), title: t("system.title"), tradeoff: t("system.tradeoff"), width: info.width, height: info.height }, true) : null;
		return true;
	}

	/** The tokens of design/system.md; none when it is missing, unreadable or malformed (the canvas never fails on it). */
	async function loadTokens() {
		let data = null;
		try { data = await getJson("api/system/tokens"); } catch { data = null; }
		const list = data && Array.isArray(data.tokens) ? data.tokens : [];
		state.tokens = list.slice(0, LIMITS.tokens)
			.filter((token) => token && typeof token.name === "string" && /^--[A-Za-z0-9_-]+$/.test(token.name) && typeof token.value === "string" && token.value.length > 0)
			.map((token) => ({ name: token.name, value: token.value, section: typeof token.section === "string" ? token.section : "", group: typeof token.group === "string" ? token.group : "other" }));
	}

	async function onSystemChange() {
		if (!(await refreshSystem())) {
			if (state.systemBoard) reloadBoard(state.systemBoard);
			return;
		}
		if (state.focus && !allBoards().includes(state.focus)) exitFocus();
		if (!state.slug) {
			showSystemOnly();
			return;
		}
		if (!state.manifest || state.manifest.slug !== state.slug) return;
		if (state.boards.length === 0 && !state.systemBoard) showEmpty("empty.noArtboards");
		else {
			els.empty.hidden = true;
			placeBoards();
		}
	}

	els.design.addEventListener("change", () => {
		exitCompare(false);
		state.slug = els.design.value;
		loadManifest(state.slug, false);
	});

	/**
	 * The server's show event (S14): `open` while this page is connected switches it to
	 * that design (null: the system-only view) and reloads every board from the server, so
	 * a change event this page missed is caught up. The same design refreshes in place and
	 * keeps zoom, pan and focus mode on the same artboard; another design leaves focus mode
	 * first, since its artboards differ.
	 */
	async function showDesign(slug) {
		const same = slug === state.slug;
		if (!same) {
			exitCompare(false);
			exitFocus();
			state.slug = slug;
			state.comments = [];
			state.activeId = null;
			renderComments();
		}
		if (!(await refreshSystem()) && state.systemBoard) reloadBoard(state.systemBoard);
		if (slug !== state.slug) return;
		try {
			await refreshDesigns(false);
		} catch (error) {
			setStatus("empty.cannotList", true, { message: error.message });
		}
		if (slug !== state.slug) return;
		if (slug === null) {
			history.replaceState(null, "", base);
			document.title = "Gentle Design";
			if (!same || !state.systemBoard) showSystemOnly();
			return;
		}
		await loadManifest(slug, same);
	}

	async function start() {
		applyView();
		loadTokens().catch(() => {});
		await refreshSystem();
		try {
			await refreshDesigns();
		} catch (error) {
			showEmpty("empty.cannotList", { message: error.message });
			return;
		}
		if (!state.slug) {
			showSystemOnly();
			return;
		}
		await loadManifest(state.slug, false);
	}

	// ---- live reload -------------------------------------------------------

	function connectEvents() {
		const source = new EventSource(`${base}events`);
		source.addEventListener("open", () => {
			if (els.status.classList.contains("gd-error")) setStatus("", false);
		});
		source.addEventListener("error", () => setStatus("status.disconnected", true));
		source.addEventListener("show", (event) => {
			let request;
			try { request = JSON.parse(event.data); } catch { return; }
			if (!request || typeof request !== "object") return;
			if (request.slug !== null && !(typeof request.slug === "string" && /^[a-z0-9][a-z0-9-]*$/.test(request.slug))) return;
			showDesign(request.slug).catch(() => {});
		});
		source.addEventListener("change", (event) => {
			let change;
			try { change = JSON.parse(event.data); } catch { return; }
			if (!change || typeof change.file !== "string") return;
			if (change.slug === null) {
				if (change.file === "system.html") onSystemChange().catch(() => {});
				else if (change.file === "system.md") loadTokens().catch(() => {});
				return;
			}
			if (typeof change.slug !== "string") return;
			if (change.file === "design.json") {
				refreshDesigns().then(() => {
					if (change.slug === state.slug) return loadManifest(state.slug, true);
					if (!state.manifest && state.slug) return loadManifest(state.slug, false);
					return undefined;
				}).catch(() => {});
				return;
			}
			if (change.slug !== state.slug) return;
			if (change.file === "comments.json") {
				loadComments();
				return;
			}
			if (change.file === "handoffs.json") {
				loadHandoffs();
				return;
			}
			// Not a shared asset: a part's progress reloads no artboard.
			if (change.file === "parts.json") {
				loadParts();
				return;
			}
			// Nor is where the boards sit: they move, nothing reloads.
			if (change.file === "layout.json") {
				onLayoutChange().catch(() => {});
				return;
			}
			if (state.compare && state.compare.board.artboard.file === change.file) state.compare.artboardFrame.src = `${boardUrl(state.compare.board)}?v=${Date.now()}`;
			const matching = state.boards.filter((board) => board.artboard.file === change.file);
			// A shared asset (CSS, image, font) can affect every artboard of the design.
			const targets = matching.length > 0 ? matching : change.file.endsWith(".html") ? [] : state.boards;
			targets.forEach(reloadBoard);
		});
	}

	// ---- token inspector -------------------------------------------------------
	// In Comment mode the artboard reports the element under the pointer (gd:inspect); the canvas compares its
	// colors, font, sizes, spacing and radius with the tokens of design/system.md (state.tokens), computes the
	// WCAG contrast and shows the result in a panel beside the artboard. Heuristics, not a full audit.

	const INSPECTOR_WIDTH = 280;
	const INSPECTOR_HEIGHT = 340;
	const INSPECTOR_GAP = 12;
	const INSPECTOR_HIDE_MS = 300;
	// Channels are whole numbers, so a token matches only when it is the same color; alpha tolerates hex rounding.
	const ALPHA_EPSILON = 0.01;
	const NEAR_ALPHA = 0.05;
	const SIZE_EPSILON = 0.01;

	function parseTokenColor(value) {
		const hex = /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(value.trim());
		if (hex) {
			const digits = hex[1].length <= 4 ? Array.from(hex[1], (digit) => digit + digit).join("") : hex[1];
			const channel = (index) => Number.parseInt(digits.slice(index * 2, index * 2 + 2), 16);
			return { r: channel(0), g: channel(1), b: channel(2), a: digits.length === 8 ? Math.round((channel(3) / 255) * 100) / 100 : 1 };
		}
		const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(value.trim());
		if (rgb && [rgb[1], rgb[2], rgb[3]].every((channel) => Number(channel) <= 255)) return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]), a: rgb[4] === undefined ? 1 : Math.min(1, Number(rgb[4])) };
		return null;
	}

	/** px of a token like `8px` or `0.5rem`, else null. */
	function parseTokenLength(value) {
		const match = /^(-?\d*\.?\d+)(px|rem)$/.exec(value.trim());
		return match ? Number(match[1]) * (match[2] === "rem" ? 16 : 1) : null;
	}

	function linearChannel(value) {
		const unit = value / 255;
		return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
	}

	/** WCAG relative luminance of an sRGB color. */
	function luminance(color) {
		return 0.2126 * linearChannel(color.r) + 0.7152 * linearChannel(color.g) + 0.0722 * linearChannel(color.b);
	}

	/** WCAG contrast ratio, 1 to 21. */
	function contrastRatio(a, b) {
		const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
		return (high + 0.05) / (low + 0.05);
	}

	/** OKLab coordinates, so distances follow perceived difference rather than sRGB channel values. */
	function oklab(color) {
		const r = linearChannel(color.r);
		const g = linearChannel(color.g);
		const b = linearChannel(color.b);
		const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
		const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
		const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
		return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
	}

	function colorDistance(a, b) {
		const [x, y] = [oklab(a), oklab(b)];
		return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
	}

	const hex2 = (value) => Math.round(value).toString(16).padStart(2, "0");
	const colorHex = (color) => `#${hex2(color.r)}${hex2(color.g)}${hex2(color.b)}${color.a !== undefined && color.a < 1 ? hex2(color.a * 255) : ""}`;
	const fmt = (value) => String(Number(value.toFixed(2)));
	/** Contrast shown to two decimals, never rounded up: 4.499 must not read as a pass. */
	const fmtRatio = (ratio) => String(Math.floor(ratio * 100) / 100);

	/** The tokens by what they can be compared with: colors, font families, and px lengths by purpose. */
	function tokenKinds() {
		const kinds = { color: [], family: [], radius: [], spacing: [], fontSize: [] };
		for (const token of state.tokens) {
			const color = parseTokenColor(token.value);
			const length = color ? null : parseTokenLength(token.value);
			if (color) kinds.color.push({ token, color });
			else if (length !== null) {
				if (token.group === "radius" || /radius/.test(token.name)) kinds.radius.push({ token, px: length });
				else if (token.group === "spacing" || /(^|-)(space|spacing|gap|pad|padding|margin)(-|$)/.test(token.name)) kinds.spacing.push({ token, px: length });
				else if (token.group === "font" || /font|text|type/.test(token.name)) kinds.fontSize.push({ token, px: length });
			} else if ((token.group === "font" || /font|family/.test(token.name)) && /[a-zA-Z]/.test(token.value)) kinds.family.push(token);
		}
		return kinds;
	}

	/** Families of a font stack, quotes stripped, split on commas outside quotes. */
	function familyList(value) {
		const families = [];
		let current = "";
		let quote = "";
		for (const char of value) {
			if (quote) {
				if (char === quote) quote = "";
				else current += char;
			} else if (char === "\"" || char === "'") quote = char;
			else if (char === ",") {
				families.push(current);
				current = "";
			} else current += char;
		}
		families.push(current);
		return families.map((family) => family.trim()).filter(Boolean);
	}

	const sameFamilies = (a, b) => a.length === b.length && a.every((family, index) => family.toLowerCase() === b[index].toLowerCase());

	const span = (className, text) => chip(className, text);
	const okChip = (text) => span("gd-inspector-ok", `✓ ${text}`);
	const badChip = (text) => span("gd-inspector-bad", `⚠ ${text}`);
	// The flagged values below are written as sentences too: they become the comment that Ask the agent to fix sends,
	// so they are for the session (toSession) and stay English whatever the panel shows.

	function swatch(color) {
		const box = span("gd-inspector-swatch", "");
		box.setAttribute("aria-hidden", "true");
		box.style.background = color.a === undefined || color.a >= 1 ? `rgb(${color.r}, ${color.g}, ${color.b})` : `rgba(${color.r}, ${color.g}, ${color.b}, ${color.a})`;
		return box;
	}

	function row(label, nodes) {
		const item = document.createElement("div");
		item.className = "gd-inspector-row";
		const term = document.createElement("dt");
		term.className = "gd-inspector-label";
		term.textContent = label;
		const value = document.createElement("dd");
		value.className = "gd-inspector-value";
		value.append(...nodes);
		item.append(term, value);
		return item;
	}

	/** A length against the tokens of one kind: exact token names, else the nearest by numeric distance. */
	function matchLength(px, candidates) {
		const exact = candidates.filter((candidate) => Math.abs(candidate.px - px) < SIZE_EPSILON).map((candidate) => candidate.token);
		if (exact.length > 0) return { exact };
		let nearest = null;
		for (const candidate of candidates) if (!nearest || Math.abs(candidate.px - px) < Math.abs(nearest.px - px)) nearest = candidate;
		return { exact: [], nearest: nearest ? nearest.token : null };
	}

	/** The nodes of a color row: swatch and hex, the matching token(s) or ⚠ no token with the nearest one. */
	function colorValue(color, tokens, flags, label) {
		const nodes = [swatch(color), span("gd-inspector-code", colorHex(color))];
		if (tokens.length === 0) return nodes;
		const same = tokens.filter((entry) => entry.color.r === color.r && entry.color.g === color.g && entry.color.b === color.b && Math.abs(entry.color.a - (color.a ?? 1)) < ALPHA_EPSILON);
		if (same.length > 0) {
			nodes.push(okChip(same.map((entry) => entry.token.name).join(" / ")));
			return nodes;
		}
		nodes.push(badChip(t("inspector.noToken")));
		let nearest = null;
		let best = Infinity;
		for (const entry of tokens) {
			if (Math.abs(entry.color.a - (color.a ?? 1)) > NEAR_ALPHA) continue;
			const distance = colorDistance(color, entry.color);
			if (distance < best) {
				best = distance;
				nearest = entry;
			}
		}
		if (nearest) {
			nodes.push(span("gd-inspector-near", t("inspector.nearest", { name: nearest.token.name })), span("gd-inspector-code", nearest.token.value));
			flags.push(toSession(`${label} ${colorHex(color)} is not a token; nearest is ${nearest.token.name} (${nearest.token.value}).`));
		} else flags.push(toSession(`${label} ${colorHex(color)} is not a token.`));
		return nodes;
	}

	/** A px value against tokens of one kind; no tokens of that kind means nothing to compare. */
	function lengthValue(px, candidates, flags, label) {
		const nodes = [span("gd-inspector-code", `${fmt(px)} px`)];
		if (candidates.length === 0) return nodes;
		const match = matchLength(px, candidates);
		if (match.exact.length > 0) {
			nodes.push(okChip(match.exact.map((token) => token.name).join(" / ")));
			return nodes;
		}
		nodes.push(badChip(t("inspector.noToken")));
		if (match.nearest) {
			nodes.push(span("gd-inspector-near", t("inspector.nearest", { name: match.nearest.name })), span("gd-inspector-code", match.nearest.value));
			flags.push(toSession(`${label} ${fmt(px)}px is not a token; nearest is ${match.nearest.name} (${match.nearest.value}).`));
		} else flags.push(toSession(`${label} ${fmt(px)}px is not a token.`));
		return nodes;
	}

	const sides = (values) => values.map(fmt).join(" ");

	/** The panel's rows for one measured element, and the flagged values as sentences. */
	function describeInspection(m) {
		const kinds = tokenKinds();
		const flags = [];
		const rows = [];
		const text = m.color;
		const behind = m.background;
		rows.push(row(t("inspector.color"), text ? colorValue(text, kinds.color, flags, toSession("Text color")) : [span("gd-inspector-code", t("inspector.unreadable"))]));
		rows.push(row(t("inspector.background"), behind ? colorValue(behind, kinds.color, flags, toSession("Background")) : [span("gd-inspector-code", t("inspector.imageBackground"))]));

		let contrast = [span("gd-inspector-code", "—")];
		if (m.hasText && text && !behind) contrast = [span("gd-inspector-code", t("inspector.unknownBackground"))];
		else if (m.hasText && text && behind) {
			const over = text.a < 1 ? { r: Math.round(text.r * text.a + behind.r * (1 - text.a)), g: Math.round(text.g * text.a + behind.g * (1 - text.a)), b: Math.round(text.b * text.a + behind.b * (1 - text.a)) } : text;
			const ratio = contrastRatio(over, behind);
			const large = m.fontSize >= 24 || (m.fontSize >= 18.66 && m.fontWeight >= 700);
			const needed = large ? 3 : 4.5;
			if (ratio >= needed) contrast = [okChip(`${fmtRatio(ratio)} : 1`), span("gd-inspector-near", t(large ? "inspector.aaLarge" : "inspector.aa"))];
			else {
				contrast = [badChip(`${fmtRatio(ratio)} : 1`), span("gd-inspector-near", t(large ? "inspector.needsLarge" : "inspector.needs", { needed }))];
				flags.push(toSession(`Contrast ${fmtRatio(ratio)}:1 is below WCAG AA (${needed}:1 for ${large ? "large" : "normal"} text).`));
			}
		}
		rows.push(row(t("inspector.contrast"), contrast));

		const mine = familyList(m.fontFamily);
		const first = mine[0] || "—";
		const family = [span("gd-inspector-code", first)];
		family[0].title = m.fontFamily;
		if (kinds.family.length > 0) {
			const exact = kinds.family.filter((token) => sameFamilies(familyList(token.value), mine));
			const byFirst = exact.length > 0 ? exact : kinds.family.filter((token) => mine.length > 0 && familyList(token.value)[0]?.toLowerCase() === mine[0].toLowerCase());
			if (byFirst.length > 0) family.push(okChip(byFirst.map((token) => token.name).join(" / ")));
			else {
				family.push(badChip(t("inspector.noToken")));
				flags.push(toSession(`Font family "${first}" is not a token (${kinds.family.map((token) => token.name).join(", ")}).`));
			}
		}
		rows.push(row(t("inspector.font"), family));
		rows.push(row(t("inspector.size"), [...lengthValue(m.fontSize, kinds.fontSize, flags, toSession("Font size")), span("gd-inspector-near", t("inspector.weight", { value: m.fontWeight }))]));
		rows.push(row(t("inspector.lineHeight"), [span("gd-inspector-code", m.lineHeight === null ? t("inspector.normal") : `${fmt(m.lineHeight)} px`)]));

		const spacing = [];
		if (m.margin.some((value) => value !== 0)) spacing.push(span("gd-inspector-code", t("inspector.margin", { sides: sides(m.margin) })));
		if (m.padding.some((value) => value !== 0)) spacing.push(span("gd-inspector-code", t("inspector.padding", { sides: sides(m.padding) })));
		if (spacing.length === 0) spacing.push(span("gd-inspector-code", "—"));
		else if (kinds.spacing.length > 0) {
			const values = [...new Set([...m.margin, ...m.padding].filter((value) => value > 0))];
			const off = values.map((value) => ({ value, match: matchLength(value, kinds.spacing) })).filter((entry) => entry.match.exact.length === 0);
			if (off.length === 0) spacing.push(okChip(t("inspector.onScale")));
			for (const entry of off) {
				const near = entry.match.nearest;
				spacing.push(badChip(t("inspector.offScale", { value: fmt(entry.value) })));
				if (near) spacing.push(span("gd-inspector-near", t("inspector.nearest", { name: near.name })), span("gd-inspector-code", near.value));
				flags.push(toSession(`Spacing ${fmt(entry.value)}px is not on the token scale${near ? `; nearest is ${near.name} (${near.value})` : ""}.`));
			}
		}
		rows.push(row(t("inspector.spacing"), spacing));

		const corners = m.radius;
		let radius;
		if (corners.every((value) => value === 0)) radius = [span("gd-inspector-code", "—")];
		else if (corners.every((value) => value === corners[0])) radius = lengthValue(corners[0], kinds.radius, flags, toSession("Border radius"));
		else {
			radius = [span("gd-inspector-code", `${sides(corners)} px`)];
			for (const value of new Set(corners.filter((corner) => corner > 0))) {
				const match = kinds.radius.length > 0 ? matchLength(value, kinds.radius) : { exact: [{}] };
				if (match.exact.length > 0) continue;
				radius.push(badChip(t("inspector.radiusNoToken", { value: fmt(value) })));
				flags.push(toSession(`Border radius ${fmt(value)}px is not a token${match.nearest ? `; nearest is ${match.nearest.name} (${match.nearest.value})` : ""}.`));
			}
		}
		rows.push(row(t("inspector.radius"), radius));

		const message = flags.length > 0
			? toSession(`Fix the values on ${m.selector} that are off the design system (design/system.md):\n${flags.map((flag) => `- ${flag}`).join("\n")}`)
			: toSession(`Nothing is off the design system on ${m.selector}.`);
		return { rows, flags, text: message.slice(0, LIMITS.comment) };
	}

	function finiteRgb(value, withAlpha) {
		if (value === null) return null;
		if (!value || typeof value !== "object") return undefined;
		if (!["r", "g", "b"].every((key) => isFiniteNumber(value[key]) && value[key] >= 0 && value[key] <= 255)) return undefined;
		if (!withAlpha) return { r: value.r, g: value.g, b: value.b };
		return isFiniteNumber(value.a) && value.a >= 0 && value.a <= 1 ? { r: value.r, g: value.g, b: value.b, a: value.a } : undefined;
	}

	function fourNumbers(value) {
		return Array.isArray(value) && value.length === 4 && value.every(isFiniteNumber) ? value.slice() : null;
	}

	/** A gd:inspect measurement checked field by field (the page is the design's own code, not trusted); null when malformed. */
	function readMeasure(raw) {
		if (!raw || typeof raw !== "object") return null;
		const selector = typeof raw.selector === "string" ? raw.selector.trim() : "";
		const rect = raw.rect && typeof raw.rect === "object" ? raw.rect : null;
		const color = finiteRgb(raw.color, true);
		const background = finiteRgb(raw.background, false);
		const margin = fourNumbers(raw.margin);
		const padding = fourNumbers(raw.padding);
		const radius = fourNumbers(raw.radius);
		if (!selector || selector.length > LIMITS.selector || !rect || !["x", "y", "width", "height"].every((key) => isFiniteNumber(rect[key]))) return null;
		if (color === undefined || background === undefined || !margin || !padding || !radius) return null;
		if (!isFiniteNumber(raw.fontSize) || !isFiniteNumber(raw.fontWeight) || typeof raw.fontFamily !== "string" || (raw.lineHeight !== null && !isFiniteNumber(raw.lineHeight))) return null;
		return {
			selector,
			label: typeof raw.label === "string" && raw.label ? raw.label.slice(0, 80) : selector.slice(0, 80),
			text: typeof raw.text === "string" ? raw.text.slice(0, LIMITS.excerpt) : "",
			hasText: raw.hasText === true,
			rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
			color, background, fontFamily: raw.fontFamily.slice(0, 300), fontSize: raw.fontSize, fontWeight: raw.fontWeight, lineHeight: raw.lineHeight,
			margin, padding, radius,
		};
	}

	/** Beside the frame (right, else left), level with the element; below or above it when the frame leaves no room. */
	function placeInspector(surface, rect) {
		const viewport = els.viewport.getBoundingClientRect();
		const box = surface.frame.getBoundingClientRect();
		const frame = { left: box.left, top: box.top, width: box.width, right: box.left + box.width };
		const scale = frame.width / surface.viewWidth || 1;
		const top = frame.top + rect.y * scale;
		const bottom = frame.top + (rect.y + rect.height) * scale;
		const width = els.inspector.offsetWidth || INSPECTOR_WIDTH;
		const height = els.inspector.offsetHeight || INSPECTOR_HEIGHT;
		const minX = viewport.left + INSPECTOR_GAP;
		const maxX = viewport.left + viewport.width - width - INSPECTOR_GAP;
		const minY = viewport.top + INSPECTOR_GAP;
		const maxY = Math.max(minY, viewport.top + viewport.height - height - INSPECTOR_GAP);
		const clamp = (value, low, high) => Math.min(Math.max(value, low), high);
		let x;
		let y = clamp(top, minY, maxY);
		if (frame.right + INSPECTOR_GAP <= maxX) x = frame.right + INSPECTOR_GAP;
		else if (frame.left - INSPECTOR_GAP - width >= minX) x = frame.left - INSPECTOR_GAP - width;
		else {
			x = clamp(frame.left + rect.x * scale, minX, Math.max(minX, maxX));
			y = clamp(bottom + 8 + height <= viewport.top + viewport.height - INSPECTOR_GAP ? bottom + 8 : top - 8 - height, minY, maxY);
		}
		els.inspector.style.left = `${x - viewport.left}px`;
		els.inspector.style.top = `${y - viewport.top}px`;
	}

	function showInspector(surface, measure) {
		const result = describeInspection(measure);
		// A new element cancels a pending hide (scheduleInspectorHide checks the generation).
		state.inspectGen += 1;
		state.inspect = { surface, measure, flags: result.flags, text: result.text };
		els.inspectorTitle.textContent = measure.label;
		els.inspectorSelector.textContent = measure.selector;
		els.inspectorSelector.title = measure.selector;
		els.inspectorList.replaceChildren(...result.rows);
		els.inspectorNote.hidden = state.tokens.length > 0;
		els.inspectorNote.textContent = t("inspector.noTokens");
		const nothing = result.flags.length === 0;
		els.inspectorFix.disabled = nothing;
		els.inspectorFix.title = nothing ? t("inspector.nothingToFix") : "";
		els.inspector.hidden = false;
		placeInspector(surface, measure.rect);
	}

	function hideInspector() {
		state.inspectGen += 1;
		state.inspect = null;
		state.inspectorHover = false;
		els.inspector.hidden = true;
	}

	/** The element was left: the panel goes soon, unless the pointer or the keyboard is in it by then. */
	function scheduleInspectorHide() {
		const generation = ++state.inspectGen;
		setTimeout(() => {
			if (generation !== state.inspectGen) return;
			if (state.inspectorHover || els.inspector.contains(document.activeElement)) return;
			hideInspector();
		}, INSPECTOR_HIDE_MS);
	}

	els.inspector.addEventListener("pointerenter", () => { state.inspectorHover = true; });
	els.inspector.addEventListener("pointerleave", () => {
		state.inspectorHover = false;
		scheduleInspectorHide();
	});
	// The panel is not part of the artboard: wheel over it never pans the canvas.
	els.inspector.addEventListener("wheel", (event) => event.stopPropagation());

	els.inspectorFix.addEventListener("click", () => {
		const current = state.inspect;
		if (!current || current.flags.length === 0) return;
		const { surface, measure, text } = current;
		openPopover(surface, { selector: measure.selector, excerpt: measure.text, rect: measure.rect });
		els.text.value = text.slice(0, LIMITS.comment);
	});

	/** The Clipboard API, else the browser's copy command through a hidden text area. */
	async function copyText(text) {
		try {
			if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
				await navigator.clipboard.writeText(text);
				return true;
			}
		} catch { /* denied or unavailable: use the fallback */ }
		const previous = document.activeElement;
		const area = document.createElement("textarea");
		area.value = text;
		area.setAttribute("readonly", "");
		area.className = "gd-visually-hidden";
		document.body.append(area);
		try {
			area.focus?.();
			area.select?.();
			return typeof document.execCommand === "function" && document.execCommand("copy") === true;
		} catch {
			return false;
		} finally {
			area.remove();
			previous?.focus?.();
		}
	}

	els.inspectorCopy.addEventListener("click", async () => {
		const current = state.inspect;
		if (!current) return;
		const ok = await copyText(current.text);
		showToast(t(ok ? "inspector.copied" : "inspector.copyFailed"), !ok);
	});

	// ---- accessibility checks -------------------------------------------------
	// Each artboard's own frame reports gd:checks after it loads (inspector.js). The result belongs to the
	// artboard until it reloads. They are heuristics, not a full audit: see docs/gentle-shell.md.

	const CHECK_IDS = ["contrast", "target", "alt", "label", "heading"];

	/** Failures of a board's last result (advice is not counted), or null when it has not reported. */
	function checkFailures(board) {
		return board.checks ? board.checks.checks.reduce((sum, check) => sum + check.count, 0) : null;
	}

	function boundedText(value, max) {
		return typeof value === "string" ? value.slice(0, max) : null;
	}

	/** A gd:checks report checked field by field; null when malformed. */
	function readChecks(data) {
		if (!Array.isArray(data.checks) || data.checks.length > 10 || !Array.isArray(data.issues) || data.issues.length > 200) return null;
		const checks = [];
		for (const entry of data.checks) {
			if (!entry || !CHECK_IDS.includes(entry.id) || typeof entry.label !== "string" || !Number.isInteger(entry.count) || entry.count < 0 || !Number.isInteger(entry.advice) || entry.advice < 0) return null;
			// The artboard names its checks in English; the canvas names them from its catalog (check.name.<id>).
			checks.push({ id: entry.id, label: entry.label.slice(0, 60), count: entry.count, advice: entry.advice });
		}
		const issues = [];
		for (const raw of data.issues) {
			if (!raw || !CHECK_IDS.includes(raw.check) || (raw.severity !== "fail" && raw.severity !== "advice")) return null;
			const title = boundedText(raw.title, 80);
			const detail = boundedText(raw.detail, 400);
			const selector = boundedText(raw.selector, LIMITS.selector);
			const label = boundedText(raw.label, 80);
			const rect = raw.rect && typeof raw.rect === "object" ? raw.rect : null;
			if (!title || detail === null || !selector || label === null || !rect || !["x", "y", "width", "height"].every((key) => isFiniteNumber(rect[key]))) return null;
			// Only `hidden: true` means out of sight; an older inspector leaves it out, and that reads as visible.
			issues.push({ check: raw.check, severity: raw.severity, title, detail, selector, label, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, hidden: raw.hidden === true });
		}
		return { checks, issues };
	}

	/** The Checks tab: its count and, while it is shown, one group per checked artboard. */
	function renderChecks() {
		const total = state.boards.reduce((sum, board) => sum + (checkFailures(board) ?? 0), 0);
		els.countChecks.textContent = String(total);
		if (state.tab !== "checks") return;
		const groups = state.boards.filter((board) => board.checks).map(checkGroup);
		if (groups.length === 0) {
			const empty = chip("gd-check-empty", t("checks.empty"));
			els.checks.replaceChildren(empty);
			return;
		}
		els.checks.replaceChildren(...groups);
	}

	/**
	 * The title and detail of a finding in the current language. The artboard's inspector writes them in English with the
	 * numbers and names in fixed places; a finding that does not have the shape of one of those sentences is shown as it came.
	 */
	function issueWords(issue) {
		const raw = { title: issue.title, detail: issue.detail };
		const fail = issue.severity === "fail";
		let found;
		if (issue.check === "contrast" && fail && (found = /^"([^]*)" is ([\d.]+) : 1 \((#[0-9a-f]{6}) on (#[0-9a-f]{6})\); WCAG AA needs ([\d.]+) : 1( for large text)?\.$/.exec(issue.detail))) {
			return { title: t("check.contrast.title"), detail: t(found[6] ? "check.contrast.detailLarge" : "check.contrast.detail", { text: found[1], ratio: found[2], fg: found[3], bg: found[4], needed: found[5] }) };
		}
		if (issue.check === "target" && fail && (found = /^([^]*) is (\d+) × (\d+) px; WCAG 2\.2 needs at least (\d+) × \d+ px\.$/.exec(issue.detail))) {
			return { title: t("check.target.title"), detail: t("check.target.detail", { subject: found[1], width: found[2], height: found[3], min: found[4] }) };
		}
		if (issue.check === "target" && !fail && (found = /^([^]*) is (\d+) × (\d+) px; (\d+) × \d+ px is recommended for touch\.$/.exec(issue.detail))) {
			return { title: t("check.targetAdvice.title"), detail: t("check.targetAdvice.detail", { subject: found[1], width: found[2], height: found[3], advised: found[4] }) };
		}
		if (issue.check === "alt" && fail && (found = /^([^]*) has no alt attribute\. Describe it, or use alt="" if it is decorative\.$/.exec(issue.detail))) {
			return { title: t("check.alt.title"), detail: found[1] === "The image" ? t("check.alt.detailImage") : t("check.alt.detail", { subject: found[1] }) };
		}
		if (issue.check === "label" && fail && (found = /^The (select|text area|([a-z]+) field)(?: "([^]*)")? has no label\. Add a <label for>, aria-label or aria-labelledby; a placeholder is not a label\.$/.exec(issue.detail))) {
			const kind = found[1] === "select" ? "check.field.select" : found[1] === "text area" ? "check.field.textarea" : `check.field.${found[2]}`;
			const named = hasKey(kind) ? t(kind) : t("check.field.generic", { type: found[2] });
			return { title: t("check.label.title"), detail: t("check.label.detail", { kind: named, hint: found[3] === undefined ? "" : ` "${found[3]}"` }) };
		}
		if (issue.check === "heading" && fail && (found = /^h(\d) "([^]*)" follows h(\d): ([^]*) (?:is|are) missing\.$/.exec(issue.detail))) {
			return { title: t("check.heading.title"), detail: tn("check.heading.detail", found[4].split(", ").length, { level: found[1], text: found[2], previous: found[3], missing: found[4] }) };
		}
		return raw;
	}

	function checkGroup(board) {
		const { checks, issues } = board.checks;
		const failures = checkFailures(board);
		const group = document.createElement("section");
		group.className = "gd-check-group";
		group.setAttribute("aria-label", t("checks.groupAria", { name: `${String(board.number).padStart(2, "0")} ${board.artboard.title}` }));
		const heading = document.createElement("h3");
		heading.className = "gd-check-heading";
		heading.textContent = `${String(board.number).padStart(2, "0")} ${board.artboard.title}`;
		const summary = chip(`gd-check-summary${failures === 0 ? " gd-check-summary-ok" : ""}`, failures === 0 ? t("a11y.ok") : tn("a11y.fails", failures));
		const head = document.createElement("div");
		head.className = "gd-check-head";
		head.append(heading, summary);
		const passed = checks.filter((check) => check.count === 0).map((check) => t(`check.name.${check.id}`));
		const parts = [head, ...issues.map((issue) => checkCard(board, issue))];
		if (passed.length > 0) parts.push(chip("gd-check-passed", t("checks.passed", { list: passed.join(" · ") })));
		group.append(...parts);
		return group;
	}

	let hiddenNotes = 0;

	function checkCard(board, issue) {
		const fail = issue.severity === "fail";
		const card = document.createElement("article");
		card.className = `gd-check ${fail ? "gd-check-fail" : "gd-check-advice"}`;
		// A re-render (another tab and back, a language switch) keeps the card of the ring linked to it.
		if (isMarked(board, issue)) {
			state.mark.card = card;
			setCardMarked(card, true);
		}
		const body = document.createElement("div");
		body.className = "gd-check-body";
		const words = issueWords(issue);
		const title = document.createElement("b");
		title.className = "gd-check-title";
		title.textContent = words.title;
		const heading = document.createElement("div");
		heading.className = "gd-check-top";
		heading.append(title, chip("gd-check-kind", t(fail ? "checks.kind.fail" : "checks.kind.advice")));
		const detail = document.createElement("small");
		detail.className = "gd-check-detail";
		detail.textContent = words.detail;
		const actions = document.createElement("div");
		actions.className = "gd-check-actions";
		const show = document.createElement("button");
		show.type = "button";
		show.className = "gd-check-show gd-small";
		show.setAttribute("aria-label", t("checks.showAria", { title: words.title, label: issue.label, name: `${String(board.number).padStart(2, "0")} ${board.artboard.title}` }));
		show.append(icon("i-target", "gd-i gd-i-s"), chip("", t("checks.show")));
		show.addEventListener("click", () => showIssue(board, issue, card));
		const fix = document.createElement("button");
		fix.type = "button";
		fix.className = "gd-check-fix gd-small";
		fix.setAttribute("aria-label", t("checks.fixAria", { title: words.title, label: issue.label }));
		fix.append(chip("", t("checks.fix")));
		fix.addEventListener("click", () => askAboutIssue(board, issue));
		actions.append(show, fix);
		body.append(heading, detail);
		if (state.technical) {
			const selector = document.createElement("code");
			selector.className = "gd-check-selector";
			selector.textContent = issue.selector;
			selector.title = issue.selector;
			body.append(selector);
		}
		// Show cannot point at what is out of sight: the card says why nothing is marked.
		if (issue.hidden) {
			const note = chip("gd-check-hidden", t("checks.hidden"));
			note.id = `gd-check-hidden-${++hiddenNotes}`;
			show.setAttribute("aria-describedby", note.id);
			body.append(note);
		}
		body.append(actions);
		card.append(icon("i-alert", "gd-i gd-i-s gd-check-icon"), body);
		return card;
	}

	// Under SHOW_ZOOM, Show zooms in to it, or less when the element would not fit in SHOW_ROOM of the view at that zoom.
	const SHOW_ZOOM = 1;
	const SHOW_ROOM = 0.8;

	/**
	 * Brings a rect of an artboard (its CSS px) into view: another artboard's focus ends, and with none focused the canvas
	 * centers the rect. With zoomIn, a canvas under SHOW_ZOOM first zooms in about the rect; it never zooms out.
	 */
	function revealIssue(board, rect, zoomIn = false) {
		if (state.focus && state.focus !== board) exitFocus();
		if (state.focus) return;
		const viewport = els.viewport.getBoundingClientRect();
		const frame = board.frame.getBoundingClientRect();
		const scale = frame.width / board.viewWidth || 1;
		const x = frame.left + (rect.x + rect.width / 2) * scale;
		const y = frame.top + (rect.y + rect.height / 2) * scale;
		if (zoomIn && state.zoom < SHOW_ZOOM) {
			const clear = Math.min(SHOW_ZOOM, (viewport.width * SHOW_ROOM) / rect.width, (viewport.height * SHOW_ROOM) / rect.height);
			// Zooming about the rect's center keeps it at (x, y), so the pan below still centers it.
			zoomAt(Math.max(state.zoom, clear), x - viewport.left, y - viewport.top);
		}
		panBy(viewport.left + viewport.width / 2 - x, viewport.top + viewport.height / 2 - y);
	}

	/** Show: the canvas zooms to the element and rings it; an element out of sight gets no ring, and its artboard is centered instead. */
	function showIssue(board, issue, card) {
		if (issue.hidden) {
			clearMark();
			revealIssue(board, { x: 0, y: 0, width: board.viewWidth, height: board.viewHeight });
		} else {
			revealIssue(board, issue.rect, true);
			placeMark(board, issue, card);
		}
		for (const surface of surfacesOf(board)) surface.frame.contentWindow?.postMessage({ type: "gd:highlight", selector: issue.selector }, "*");
	}

	// ---- the ring of Show ----
	// Drawn by the canvas, never by the artboard's page: a box in the transformed world like the pins, so it follows zoom and
	// pan, with its stroke, label and smallest size kept on screen by --gd-inv-zoom (canvas.css). Esc, a still click on the
	// canvas, another Show, a reload of its artboard, another size or another design clear it.

	function isMarked(board, issue) {
		return Boolean(state.mark) && state.mark.board === board && state.mark.issue === issue;
	}

	function setCardMarked(card, marked) {
		if (!card) return;
		card.classList.toggle("gd-check-active", marked);
		if (marked) card.setAttribute("aria-current", "true");
		else card.removeAttribute("aria-current");
	}

	/** The frame the checks ran in: the artboard's own, or in All sizes its Desktop frame (the manifest size). */
	function markHost(board) {
		return board.sizeFrames.length > 0 ? board.sizeFrames[board.sizeFrames.length - 1].stage : board.frame.parentElement;
	}

	function placeMark(board, issue, card) {
		clearMark();
		const ring = document.createElement("div");
		ring.className = `gd-check-mark ${issue.severity === "fail" ? "gd-check-mark-fail" : "gd-check-mark-advice"}`;
		// The card is the accessible path (aria-current); the ring is only drawn.
		ring.setAttribute("aria-hidden", "true");
		const label = chip("gd-check-mark-label", "");
		ring.append(label);
		state.mark = { board, issue, ring, label, card };
		renderMark();
		markHost(board).append(ring);
		setCardMarked(card, true);
	}

	/** The ring at its finding's rect, centered (artboard CSS px), with the check's title in the current language. */
	function renderMark() {
		const mark = state.mark;
		if (!mark) return;
		const { rect } = mark.issue;
		mark.ring.style.left = `${rect.x + rect.width / 2}px`;
		mark.ring.style.top = `${rect.y + rect.height / 2}px`;
		mark.ring.style.setProperty("--gd-mark-w", `${rect.width}px`);
		mark.ring.style.setProperty("--gd-mark-h", `${rect.height}px`);
		mark.label.textContent = issueWords(mark.issue).title;
	}

	function clearMark() {
		const mark = state.mark;
		if (!mark) return;
		state.mark = null;
		mark.ring.remove();
		setCardMarked(mark.card, false);
	}

	/** A new report of the ringed artboard (after a resize): the ring moves to the same finding (check, kind, element), or goes. */
	function followMark(board) {
		const mark = state.mark;
		if (!mark || mark.board !== board) return;
		const same = board.checks.issues.find((issue) => issue.check === mark.issue.check && issue.severity === mark.issue.severity && issue.selector === mark.issue.selector);
		if (!same || same.hidden) {
			clearMark();
			return;
		}
		mark.issue = same;
		renderMark();
	}

	function askAboutIssue(board, issue) {
		// Asking about another finding moves the canvas away from the ring.
		if (!isMarked(board, issue)) clearMark();
		revealIssue(board, issue.rect);
		for (const surface of surfacesOf(board)) surface.frame.contentWindow?.postMessage({ type: "gd:highlight", selector: issue.selector }, "*");
		const fail = issue.severity === "fail";
		const text = fail
			? toSession(`Accessibility check on ${issue.selector}: ${issue.title}.\n${issue.detail}\nFix it so it meets WCAG 2.2 AA, keeping the design's tokens.`)
			: toSession(`Accessibility advice on ${issue.selector}: ${issue.title}.\n${issue.detail}\nConsider fixing it, keeping the design's tokens.`);
		// In All sizes the artboard's own frame is hidden: ask on the Desktop frame, the manifest size.
		openPopover(board.sizeFrames.length > 0 ? board.sizeFrames[board.sizeFrames.length - 1] : board, { selector: issue.selector, excerpt: issue.label, rect: issue.rect });
		els.text.value = text.slice(0, LIMITS.comment);
	}

	// ---- comments ----------------------------------------------------------

	function commentsForBoard(board) {
		return state.comments.filter((comment) => comment.file === board.artboard.file);
	}

	/** The artboard locates the comments' elements and reports where they are. */
	function sendPins(surface) {
		const comments = commentsForBoard(ownerOf(surface)).slice(0, LIMITS.pins).map((comment) => ({ id: comment.id, selector: comment.selector }));
		surface.frame.contentWindow?.postMessage({ type: "gd:pins", pins: comments }, "*");
	}

	/** Detached: the artboard is gone, or it reported that the selector matches nothing. */
	function isDetached(comment) {
		const board = state.boards.find((candidate) => candidate.artboard.file === comment.file);
		if (!board) return true;
		return Boolean(board.rects && board.rects.has(comment.id) && board.rects.get(comment.id) === null);
	}

	function detachedKey() {
		return state.comments.filter(isDetached).map((comment) => comment.id).join(",");
	}

	function commentNumber(comment) {
		return state.comments.indexOf(comment) + 1;
	}

	/** The pins of one frame, at their element's position in that frame; a size frame has its own set. */
	function renderPins(surface) {
		const pins = [];
		for (const comment of commentsForBoard(ownerOf(surface))) {
			const rect = surface.rects?.get(comment.id);
			if (!rect) continue;
			if (rect.x + rect.width < 0 || rect.y + rect.height < 0 || rect.x > surface.viewWidth || rect.y > surface.viewHeight) continue;
			const pin = document.createElement("button");
			pin.type = "button";
			pin.className = "gd-pin";
			pin.dataset.id = comment.id;
			pin.dataset.status = comment.status;
			pin.classList.toggle("gd-pin-active", comment.id === state.activeId);
			pin.textContent = String(commentNumber(comment));
			pin.setAttribute("aria-label", t("pin.aria", { number: commentNumber(comment), status: t(`comment.status.${comment.status}`), text: comment.comment }));
			pin.style.left = `${Math.max(0, rect.x)}px`;
			pin.style.top = `${Math.max(0, rect.y)}px`;
			pin.addEventListener("click", (event) => {
				event.stopPropagation();
				selectComment(comment.id, { scroll: false, focusList: true });
			});
			pins.push(pin);
		}
		const focused = surface.pins.contains(document.activeElement) ? document.activeElement.dataset.id : null;
		surface.pins.replaceChildren(...pins);
		if (focused) pins.find((pin) => pin.dataset.id === focused)?.focus();
	}

	function renderList() {
		const open = state.comments.filter((comment) => comment.status === "open");
		const resolved = state.comments.filter((comment) => comment.status === "resolved");
		els.countOpen.textContent = String(open.length);
		loc(els.filterOpen, "text", "filter.open", { count: open.length });
		loc(els.filterResolved, "text", "filter.resolved", { count: resolved.length });
		els.filterOpen.setAttribute("aria-pressed", String(state.filter === "open"));
		els.filterResolved.setAttribute("aria-pressed", String(state.filter === "resolved"));
		els.filterAll.setAttribute("aria-pressed", String(state.filter === "all"));
		// New counts change how wide the row is without resizing it.
		updateTabFades();
		const tabIndex = TAB_NAMES.indexOf(state.tab);
		TAB_NAMES.forEach((name, index) => {
			const tab = tabButtons()[index];
			tab.setAttribute("aria-selected", String(index === tabIndex));
			tab.setAttribute("tabindex", index === tabIndex ? "0" : "-1");
		});
		els.tabPanel.setAttribute("aria-labelledby", tabButtons()[tabIndex].id);
		const unsent = open.filter((comment) => comment.sentAt === null).length;
		loc(els.sendAll, "text", "panel.sendAll", { count: unsent });
		els.sendAll.disabled = unsent === 0 || !DELIVERY.batch;
		loc(els.sendPending, "text", unsent > 0 ? plural("panel.pending", unsent) : null, { count: unsent });
		els.sendPending.hidden = unsent === 0;
		const checks = state.tab === "checks";
		els.checks.hidden = !checks;
		els.list.hidden = checks;
		els.commentFilter.hidden = state.tab !== "comments";
		renderChecks();
		const shown = state.filter === "resolved" ? resolved : state.filter === "all" ? state.comments : open;
		// No comments at all: how to add one; comments but none under this filter: one line.
		const none = state.comments.length === 0;
		els.commentsEmpty.hidden = state.tab !== "comments" || !none;
		els.panelEmpty.hidden = state.tab !== "comments" || none || shown.length > 0;
		loc(els.panelEmpty, "text", state.filter === "resolved" ? "panel.empty.resolved" : "panel.empty.open");
		els.list.replaceChildren(...shown.map((comment) => {
			const item = document.createElement("li");
			item.className = "gd-comment-item";
			item.dataset.id = comment.id;
			item.classList.toggle("gd-active", comment.id === state.activeId);
			const show = document.createElement("button");
			show.type = "button";
			show.className = "gd-comment-show";
			show.setAttribute("aria-label", t("comment.show", { number: commentNumber(comment), file: comment.file }));
			// Pin number, the element's selector (with Technical details on), and whether the session has it yet.
			const meta = document.createElement("span");
			meta.className = "gd-comment-meta";
			const number = document.createElement("span");
			number.className = "gd-comment-number";
			number.textContent = String(commentNumber(comment));
			meta.append(number);
			if (state.technical) {
				const selector = document.createElement("code");
				selector.className = "gd-comment-selector";
				selector.title = `${comment.file} · ${comment.selector}`;
				selector.textContent = comment.selector;
				meta.append(selector);
			}
			const badge = (text, kind) => {
				const element = document.createElement("span");
				element.className = `gd-badge gd-badge-${kind}`;
				element.textContent = text;
				meta.append(element);
			};
			badge(t(comment.sentAt ? "comment.sent" : "comment.waiting"), comment.sentAt ? "sent" : "unsent");
			if (isDetached(comment)) badge(t("comment.detached"), "detached");
			const text = document.createElement("span");
			text.className = "gd-comment-text";
			text.style.display = "block";
			text.textContent = comment.comment;
			const file = document.createElement("span");
			file.className = "gd-comment-file";
			file.textContent = comment.file;
			// An open comment can still change (canvas-layout S17): its text becomes an editor outside the button.
			const editable = comment.status === "open";
			if (!editable) state.editing.delete(comment.id);
			const editing = editable && state.editing.has(comment.id);
			show.append(meta);
			if (!editing) show.append(text);
			// Where the comment was made, when not at the artboard's own size.
			if (comment.viewport && typeof comment.viewport === "object") {
				const label = describeViewport(comment.viewport);
				const size = chip("gd-comment-viewport", label);
				size.title = t("comment.madeAt", { label });
				show.append(size);
			}
			show.append(file);
			if (comment.screenshot) {
				const shot = document.createElement("img");
				shot.className = "gd-comment-shot";
				shot.alt = t("comment.shot", { number: commentNumber(comment) });
				shot.loading = "lazy";
				shot.src = `${base}api/designs/${encodeURIComponent(state.slug)}/comments/${encodeURIComponent(comment.id)}/screenshot`;
				show.append(shot);
			}
			show.addEventListener("click", () => selectComment(comment.id, { scroll: true, focusList: false }));
			const actions = document.createElement("div");
			actions.className = "gd-comment-actions";
			const toggle = document.createElement("button");
			toggle.type = "button";
			toggle.className = "gd-comment-toggle";
			const next = comment.status === "open" ? "resolved" : "open";
			toggle.textContent = t(next === "resolved" ? "comment.resolve" : "comment.reopen");
			toggle.setAttribute("aria-label", t(next === "resolved" ? "comment.resolveAria" : "comment.reopenAria", { number: commentNumber(comment) }));
			toggle.addEventListener("click", () => setCommentStatus(comment.id, next));
			item.append(show);
			if (editing) {
				const field = document.createElement("textarea");
				field.className = "gd-comment-editor";
				field.rows = 3;
				field.setAttribute("maxlength", String(LIMITS.comment));
				field.setAttribute("aria-label", t("comment.editLabel", { number: commentNumber(comment) }));
				field.value = state.editing.get(comment.id);
				const save = document.createElement("button");
				save.type = "button";
				save.className = "gd-comment-save gd-primary";
				save.textContent = t("common.save");
				const cancel = document.createElement("button");
				cancel.type = "button";
				cancel.className = "gd-comment-cancel";
				cancel.textContent = t("common.cancel");
				const sync = () => { save.disabled = field.value.trim().length === 0; };
				field.addEventListener("input", () => { state.editing.set(comment.id, field.value); sync(); });
				field.addEventListener("keydown", (event) => {
					if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel.click(); }
					else if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !save.disabled) { event.preventDefault(); save.click(); }
				});
				cancel.addEventListener("click", () => {
					state.editing.delete(comment.id);
					state.cardErrors.delete(comment.id);
					renderList();
					els.list.querySelector(`[data-id="${CSS.escape(comment.id)}"] .gd-comment-edit`)?.focus();
				});
				save.addEventListener("click", () => saveCommentText(comment.id));
				sync();
				item.append(field);
				actions.append(cancel, save);
			} else {
				if (editable) {
					const edit = document.createElement("button");
					edit.type = "button";
					edit.className = "gd-comment-edit";
					edit.textContent = t("comment.edit");
					edit.setAttribute("aria-label", t("comment.editAria", { number: commentNumber(comment) }));
					edit.addEventListener("click", () => {
						state.editing.set(comment.id, comment.comment);
						state.cardErrors.delete(comment.id);
						renderList();
						const field = els.list.querySelector(`[data-id="${CSS.escape(comment.id)}"] .gd-comment-editor`);
						field?.focus();
						field?.setSelectionRange?.(field.value.length, field.value.length);
					});
					actions.append(edit);
				}
				actions.append(toggle);
			}
			// What the agent did, from the note it gave when resolving; a reopened comment has none.
			if (comment.status === "resolved" && typeof comment.resolution === "string" && comment.resolution) {
				const reply = document.createElement("div");
				reply.className = "gd-comment-reply";
				reply.append(chip("gd-comment-reply-label", t("comment.agent")), chip("gd-comment-reply-text", comment.resolution));
				item.append(reply);
			}
			item.append(actions);
			if (state.cardErrors.has(comment.id)) {
				const alert = createAlert();
				showAlert(alert, state.cardErrors.get(comment.id));
				alert.onDismiss = () => { state.cardErrors.delete(comment.id); };
				item.append(alert.root);
			}
			return item;
		}));
	}

	function renderComments() {
		renderList();
		state.boards.forEach((board) => surfacesOf(board).forEach(renderPins));
	}

	async function loadComments() {
		const slug = state.slug;
		if (!slug) return;
		let comments = [];
		try {
			comments = (await getJson(`api/designs/${encodeURIComponent(slug)}/comments`)).comments;
		} catch (error) {
			setStatus("status.comments", true, { slug, message: error.message });
		}
		if (slug !== state.slug || !Array.isArray(comments)) return;
		state.comments = comments;
		if (state.activeId && !comments.some((comment) => comment.id === state.activeId)) state.activeId = null;
		state.boards.forEach((board) => surfacesOf(board).forEach(sendPins));
		renderComments();
	}

	function selectComment(id, options) {
		state.activeId = id;
		renderComments();
		const comment = state.comments.find((candidate) => candidate.id === id);
		if (!comment) return;
		// All already lists every comment; Open or Resolved switches to the one that lists it.
		if (options.focusList && (state.tab !== "comments" || (state.filter !== "all" && state.filter !== comment.status))) setFilter(state.filter === "all" ? "all" : comment.status);
		const board = state.boards.find((candidate) => candidate.artboard.file === comment.file);
		if (board) for (const surface of surfacesOf(board)) surface.frame.contentWindow?.postMessage({ type: "gd:highlight", id }, "*");
		// Keyboard focus lands on the card's Show button, its first child.
		if (options.focusList) Array.from(els.list.children).find((item) => item.dataset.id === id)?.children[0]?.focus();
		if (!options.scroll) return;
		// The focused artboard is already at 1:1; another board's comment leaves focus mode first.
		if (state.focus) {
			if (state.focus === board) return;
			exitFocus();
		}
		const pin = board?.pins.querySelector(`[data-id="${CSS.escape(id)}"]`);
		const target = pin ?? board?.frame;
		if (!target) return;
		const viewport = els.viewport.getBoundingClientRect();
		const rect = target.getBoundingClientRect();
		panBy(viewport.left + viewport.width / 2 - (rect.left + rect.width / 2), viewport.top + viewport.height / 2 - (rect.top + rect.height / 2));
	}

	async function postJson(path, body) {
		let response;
		try {
			response = await fetch(base + path, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				cache: "no-store",
				body: JSON.stringify(body),
			});
		} catch (error) {
			// The request itself failed: the server is gone or unreachable.
			return { status: 0, ok: false, body: { error: "network", reason: typeof error?.message === "string" ? error.message : String(error) } };
		}
		let reply = null;
		try { reply = await response.json(); } catch { reply = null; }
		return { status: response.status, ok: response.ok, body: reply || {} };
	}

	async function setCommentStatus(id, status) {
		const slug = state.slug;
		if (state.cardErrors.delete(id)) renderList();
		const reply = await postJson(`api/designs/${encodeURIComponent(slug)}/comments/${encodeURIComponent(id)}/status`, { status });
		if (!reply.ok) {
			// The failure stays in that comment's card until it is dismissed or the next attempt.
			state.cardErrors.set(id, reply);
			renderList();
			els.list.querySelector(`[data-id="${CSS.escape(id)}"] .gd-comment-toggle`)?.focus();
		} else showToast(t(status === "resolved" ? "comment.resolved" : "comment.reopened"), false);
		await loadComments();
	}

	async function saveCommentText(id) {
		const slug = state.slug;
		const draft = state.editing.get(id);
		if (typeof draft !== "string" || draft.trim().length === 0) return;
		if (state.cardErrors.delete(id)) renderList();
		const reply = await postJson(`api/designs/${encodeURIComponent(slug)}/comments/${encodeURIComponent(id)}/text`, { comment: draft });
		if (!reply.ok) {
			// The editor and its draft stay, with the reason in the card, so nothing typed is lost.
			state.cardErrors.set(id, reply);
			renderList();
			els.list.querySelector(`[data-id="${CSS.escape(id)}"] .gd-comment-editor`)?.focus();
		} else {
			state.editing.delete(id);
			showToast(t(reply.body.sent ? "comment.updatedSent" : "comment.updated"), false);
		}
		await loadComments();
	}

	els.sendAll.addEventListener("click", async () => {
		const slug = state.slug;
		if (!slug) return;
		els.sendAll.disabled = true;
		hideAlert(sendAlert);
		const reply = await postJson(`api/designs/${encodeURIComponent(slug)}/comments/send-all`, {});
		if (!reply.ok) showAlert(sendAlert, reply);
		else showToast(reply.body.sent ? tn("panel.sent", reply.body.sent) : t("panel.noUnsent"), false);
		await loadComments();
		renderList();
	});

	function setMode(mode) {
		state.mode = mode === "collect" ? "collect" : "send";
		els.modeSend.checked = state.mode === "send";
		els.modeCollect.checked = state.mode === "collect";
		loc(els.send, "text", state.mode === "collect" ? "common.save" : "common.send");
		try { localStorage.setItem(MODE_KEY, state.mode); } catch { /* storage may be unavailable */ }
	}

	els.modeSend.addEventListener("change", () => setMode("send"));
	els.modeCollect.addEventListener("change", () => setMode("collect"));

	// ---- technical details (S2) ------------------------------------------------
	// The top bar's Technical details toggle: on, the cards show their CSS selector and Comment mode shows the token
	// inspector on hover; off (the default), neither. Saved in this browser; a switch applies at once.

	function setTechnical(on) {
		state.technical = on;
		try { localStorage.setItem(TECHNICAL_KEY, on ? "on" : "off"); } catch { /* storage may be unavailable */ }
		if (!on) hideInspector();
		renderTechnical();
		renderList();
		renderParts();
	}

	function renderTechnical() {
		els.technical.setAttribute("aria-pressed", String(state.technical));
	}

	els.technical.addEventListener("click", () => setTechnical(!state.technical));

	function tabButtons() {
		return [els.tabComments, els.tabChecks];
	}

	function setTab(name) {
		state.tab = name;
		renderList();
		updateTabFades();
	}

	/** The Comments tab's filter, "open", "resolved" or "all"; it shows the Comments tab too. */
	function setFilter(filter) {
		state.filter = filter;
		setTab("comments");
	}

	els.filterOpen.addEventListener("click", () => setFilter("open"));
	els.filterResolved.addEventListener("click", () => setFilter("resolved"));
	els.filterAll.addEventListener("click", () => setFilter("all"));

	/** The tab row scrolls when it is wider than the panel; each edge with tabs behind it fades and shows its arrow (L10, A2). */
	function updateTabFades() {
		const tabs = els.tabs;
		const left = Number(tabs.scrollLeft) || 0;
		const hidden = (Number(tabs.scrollWidth) || 0) - (Number(tabs.clientWidth) || 0);
		const start = left > 1;
		const end = left < hidden - 1;
		tabs.classList.toggle("gd-tabs-more-start", start);
		tabs.classList.toggle("gd-tabs-more-end", end);
		els.tabsPrev.hidden = !start;
		els.tabsNext.hidden = !end;
	}

	/** An arrow scrolls the row by most of its width toward its side; the keyboard path is still the tabs' own arrow keys. */
	function scrollTabs(direction) {
		const tabs = els.tabs;
		const step = Math.max(80, (Number(tabs.clientWidth) || 0) * 0.7);
		const max = Math.max(0, (Number(tabs.scrollWidth) || 0) - (Number(tabs.clientWidth) || 0));
		let left = Math.min(max, Math.max(0, (Number(tabs.scrollLeft) || 0) + direction * step));
		// A sliver left over would show the arrow again for a few pixels: go to the edge instead.
		if (left < 40) left = 0;
		else if (max - left < 40) left = max;
		const smooth = !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
		if (typeof tabs.scrollTo === "function") tabs.scrollTo({ left, behavior: smooth ? "smooth" : "auto" });
		else tabs.scrollLeft = left;
		updateTabFades();
	}

	els.tabs.addEventListener("scroll", updateTabFades);
	els.tabsPrev.addEventListener("click", () => scrollTabs(-1));
	els.tabsNext.addEventListener("click", () => scrollTabs(1));
	tabButtons().forEach((tab, index) => tab.addEventListener("click", () => setTab(TAB_NAMES[index])));
	// Arrow keys, Home and End move between the tabs, wrapping around.
	els.tabs.addEventListener("keydown", (event) => {
		const current = TAB_NAMES.indexOf(state.tab);
		const count = TAB_NAMES.length;
		const next = { ArrowRight: (current + 1) % count, ArrowLeft: (current + count - 1) % count, Home: 0, End: count - 1 }[event.key];
		if (next === undefined) return;
		event.preventDefault();
		setTab(TAB_NAMES[next]);
		tabButtons()[next].focus();
		tabButtons()[next].scrollIntoView({ block: "nearest", inline: "nearest" });
	});
	function setPanel(show) {
		els.panel.hidden = !show;
		els.panelToggle.setAttribute("aria-pressed", String(show));
		// The viewport changes size with the panel; without ResizeObserver nothing else reports it.
		if (typeof ResizeObserver !== "function") viewportResized();
	}

	els.panelToggle.addEventListener("click", () => setPanel(els.panel.hidden));

	/**
	 * What the rail's Settings offers: Appearance (the theme and the language), the design system board (when there is one, and
	 * not over Compare), the keyboard shortcuts and the step-by-step help switch.
	 */
	function settingsActions() {
		return [
			{ label: "rail.appearance", icon: "i-contrast", run: openAppearance },
			{ label: "rail.system", icon: "i-palette", disabled: !state.systemBoard || Boolean(state.compare), run: () => enterFocus(state.systemBoard) },
			{ label: "rail.keys", icon: "i-keys", shortcut: keyText(shortcutKey(shortcutById("help"))), run: openShortcuts },
			{ label: "rail.help", icon: "i-help", checked: state.help.on, run: () => setHelp(!state.help.on, els.railSettings) },
		];
	}

	wireMenu(els.railSettings, (last) => showMenu(els.railSettings, settingsActions(), t("rail.settings"), last, true));

	function openShortcuts() {
		showKeysMessage(null);
		if (typeof els.shortcuts.showModal === "function") els.shortcuts.showModal();
		else els.shortcuts.setAttribute("open", "");
		renderGuide(false);
	}

	function closeShortcuts() {
		stopKeyWait();
		if (typeof els.shortcuts.close === "function") els.shortcuts.close();
		else els.shortcuts.removeAttribute("open");
		renderGuide(false);
		els.railSettings.focus();
	}

	// The browser closes the modal list on Esc too (not while a Change waits: that Esc only cancels the wait).
	els.shortcuts.addEventListener("close", () => {
		stopKeyWait();
		renderGuide(false);
	});

	els.shortcutsClose.addEventListener("click", closeShortcuts);

	function readRects(data) {
		if (!Array.isArray(data.rects) || data.rects.length > LIMITS.pins) return null;
		const rects = new Map();
		for (const entry of data.rects) {
			if (!entry || typeof entry.id !== "string" || entry.id.length > 32) return null;
			const rect = entry.rect;
			if (rect === null) rects.set(entry.id, null);
			else if (rect && ["x", "y", "width", "height"].every((key) => isFiniteNumber(rect[key]))) rects.set(entry.id, { x: rect.x, y: rect.y, width: rect.width, height: rect.height });
			else return null;
		}
		return rects;
	}

	/** Navigate and Comment are one pressed pair. */
	function renderTools() {
		els.comment.setAttribute("aria-pressed", String(state.commenting));
		els.toolNavigate.setAttribute("aria-pressed", String(!state.commenting));
	}

	function setCommenting(enabled) {
		state.commenting = enabled;
		renderTools();
		renderNavMode();
		els.world.classList.toggle("gd-commenting", enabled);
		state.boards.forEach((board) => board.sizesView?.classList.toggle("gd-commenting", enabled));
		state.boards.forEach((board) => surfacesOf(board).forEach(sendMode));
		state.boards.forEach(renderShield);
		if (!enabled) closePopover();
	}

	els.comment.addEventListener("click", () => setCommenting(!state.commenting));
	els.toolNavigate.addEventListener("click", () => setCommenting(false));

	// ---- single-key shortcuts (canvas-layout S11) ------------------------------------
	// The tool and panel actions, each with its default key. The shortcuts list gives any of them another single key,
	// saved in this browser for every design (SHORTCUTS_KEY); keys match without letter case, so they are kept lower case.
	// Esc, Shift+Esc, the arrows, Space, Enter, Tab and the zoom keys stay as they are and are never assigned.
	const SHORTCUTS = [
		{ id: "navigate", key: "v", label: "keys.navigate", run: () => setCommenting(false) },
		{ id: "comment", key: "c", label: "keys.comment", run: () => setCommenting(true) },
		{ id: "fit", key: "f", label: "keys.fit", run: fit },
		{ id: "minimap", key: "m", label: "keys.minimap", run: () => setMinimap(!state.minimap) },
		{ id: "panel", key: "]", label: "keys.panel", run: () => setPanel(els.panel.hidden) },
		{ id: "help", key: "?", label: "keys.help", run: openShortcuts },
	];
	const FIXED_KEYS = ["Escape", "Enter", "Tab", " ", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "+", "=", "-", "0"];
	const ARROW_KEYS = { ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓" };
	// Pressed alone while a Change waits, these keep it waiting: Shift (and AltGr) are how many keyboards type ? or ].
	const MODIFIER_KEYS = ["Shift", "Control", "Alt", "AltGraph", "Meta", "OS", "CapsLock", "NumLock", "ScrollLock", "Fn", "FnLock", "Hyper", "Super", "Symbol", "SymbolLock"];

	/** The key a shortcut can take from `key`: one printable character (a letter, a digit or punctuation), lower case; otherwise "". */
	const singleKey = (key) => (typeof key === "string" && [...key].length === 1 && /^\S$/u.test(key) ? key.toLowerCase() : "");
	/** How a key is written: a letter upper case, as on the keyboard. */
	const keyText = (key) => (key.toUpperCase().length === key.length ? key.toUpperCase() : key);
	const shortcutById = (id) => SHORTCUTS.find((shortcut) => shortcut.id === id);

	/** The custom keys saved in this browser; an entry that is no usable key, names no action or takes another action's key is left out. */
	function storedShortcuts() {
		let stored = null;
		try {
			stored = JSON.parse(localStorage.getItem(SHORTCUTS_KEY) ?? "null");
		} catch {
			stored = null;
		}
		const custom = {};
		if (!stored || typeof stored !== "object" || Array.isArray(stored)) return custom;
		for (const shortcut of SHORTCUTS) {
			if (!Object.prototype.hasOwnProperty.call(stored, shortcut.id)) continue;
			const key = singleKey(stored[shortcut.id]);
			if (key && !FIXED_KEYS.includes(key) && key !== shortcut.key) custom[shortcut.id] = key;
		}
		// A key two actions would share is neither's custom key: those fall back to their defaults, until no two share one.
		for (;;) {
			const keyOf = (shortcut) => custom[shortcut.id] ?? shortcut.key;
			const shared = SHORTCUTS.filter((shortcut) => shortcut.id in custom && SHORTCUTS.some((other) => other !== shortcut && keyOf(other) === custom[shortcut.id]));
			if (shared.length === 0) return custom;
			for (const shortcut of shared) delete custom[shortcut.id];
		}
	}

	let customKeys = storedShortcuts();
	// The shortcut whose Change waits for the next key, or null.
	let keyWait = null;
	const shortcutRows = new Map();
	const shortcutKey = (shortcut) => customKeys[shortcut.id] ?? shortcut.key;

	function saveShortcuts() {
		try { localStorage.setItem(SHORTCUTS_KEY, JSON.stringify(customKeys)); } catch { /* storage may be unavailable: the keys hold for this page only */ }
	}

	/** The line under the list that says what a Change did; a refusal reads as an error. No key clears it. */
	function showKeysMessage(key, params, refused = false) {
		loc(els.keysMessage, "text", key, params);
		els.keysMessage.classList.toggle("gd-error", refused);
	}

	// Where the rail and the top bar name a key: in the tooltip, and in aria-keyshortcuts for screen readers.
	const SHORTCUT_HINTS = [["navigate", els.toolNavigate, "rail.navigate.title"], ["comment", els.comment, "rail.comment.title"], ["fit", els.railFit, "rail.overview.title"], ["panel", els.panelToggle, "panel.toggleTitle"]];

	/** Every place that shows a key shows the current one: the rail, the review panel button, the minimap's title and the list. */
	function renderShortcuts() {
		for (const [id, element, title] of SHORTCUT_HINTS) {
			const key = keyText(shortcutKey(shortcutById(id)));
			element.setAttribute("aria-keyshortcuts", key);
			loc(element, "title", title, { key });
		}
		const minimap = keyText(shortcutKey(shortcutById("minimap")));
		els.minimapKey.textContent = minimap;
		for (const shortcut of SHORTCUTS) renderShortcutRow(shortcut);
	}

	/** A row of the list: the action, its key, Change and Reset. Built once and kept, so a change never takes the focus away. */
	function renderShortcutRow(shortcut) {
		let row = shortcutRows.get(shortcut.id);
		if (!row) {
			const root = document.createElement("li");
			root.className = "gd-key-row";
			root.dataset.shortcut = shortcut.id;
			const action = chip("gd-key-action", "");
			loc(action, "text", shortcut.label);
			const key = document.createElement("kbd");
			key.className = "gd-key-current";
			const change = document.createElement("button");
			change.type = "button";
			change.className = "gd-key-change gd-small";
			const reset = document.createElement("button");
			reset.type = "button";
			reset.className = "gd-key-reset gd-small";
			loc(reset, "text", "keys.reset");
			change.addEventListener("click", () => {
				if (keyWait !== shortcut) startKeyWait(shortcut);
				else {
					stopKeyWait();
					showKeysMessage("keys.kept", { action: ref(shortcut.label), key: keyText(shortcutKey(shortcut)) });
				}
			});
			// Leaving the button (a click elsewhere, Restore defaults) ends its wait.
			change.addEventListener("blur", () => {
				if (keyWait !== shortcut) return;
				stopKeyWait();
				showKeysMessage(null);
			});
			reset.addEventListener("click", () => {
				stopKeyWait();
				assignKey(shortcut, shortcut.key, "keys.resetDone");
			});
			root.append(action, key, change, reset);
			els.keysCustom.append(root);
			row = { root, key, change, reset };
			shortcutRows.set(shortcut.id, row);
		}
		const key = keyText(shortcutKey(shortcut));
		const waiting = keyWait === shortcut;
		row.root.classList.toggle("gd-key-waiting", waiting);
		row.key.textContent = key;
		loc(row.change, "text", waiting ? "keys.waiting" : "keys.change");
		// While it waits, its visible text is its name.
		if (waiting) loc(row.change, "aria-label", null);
		else loc(row.change, "aria-label", "keys.changeAria", { action: ref(shortcut.label), key });
		loc(row.reset, "aria-label", "keys.resetAria", { action: ref(shortcut.label), key: keyText(shortcut.key) });
	}

	function startKeyWait(shortcut) {
		const previous = keyWait;
		keyWait = shortcut;
		if (previous) renderShortcutRow(previous);
		renderShortcutRow(shortcut);
		showKeysMessage("keys.waitingMessage", { action: ref(shortcut.label) });
		shortcutRows.get(shortcut.id).change.focus();
	}

	function stopKeyWait() {
		const shortcut = keyWait;
		if (!shortcut) return;
		keyWait = null;
		renderShortcutRow(shortcut);
	}

	/** Gives `shortcut` the key, unless another action has it; `done` is the message that says it was given. */
	function assignKey(shortcut, key, done) {
		const owner = SHORTCUTS.find((other) => other !== shortcut && shortcutKey(other) === key);
		if (owner) {
			showKeysMessage("keys.taken", { key: keyText(key), action: ref(owner.label) }, true);
			return;
		}
		if (key === shortcut.key) delete customKeys[shortcut.id];
		else customKeys[shortcut.id] = key;
		saveShortcuts();
		renderShortcuts();
		showKeysMessage(done, { action: ref(shortcut.label), key: keyText(key) });
	}

	els.keysRestore.addEventListener("click", () => {
		stopKeyWait();
		customKeys = {};
		saveShortcuts();
		renderShortcuts();
		showKeysMessage("keys.restored");
	});

	// While a Change waits, the next key is the new one and nothing else gets it; Esc cancels the wait (in the capture
	// phase, ahead of every other key handler, and without closing the list).
	document.addEventListener("keydown", (event) => {
		const shortcut = keyWait;
		if (!shortcut || MODIFIER_KEYS.includes(event.key)) return;
		event.preventDefault();
		stopKeyWait();
		if (event.key === "Escape" && !event.shiftKey) {
			showKeysMessage("keys.kept", { action: ref(shortcut.label), key: keyText(shortcutKey(shortcut)) });
			return;
		}
		if (FIXED_KEYS.includes(event.key)) {
			const name = event.key === "Escape" ? "Shift+Esc" : event.key === " " ? ref("keys.spaceKey") : ARROW_KEYS[event.key] ?? event.key;
			showKeysMessage("keys.fixed", { key: name }, true);
			return;
		}
		const key = event.ctrlKey || event.metaKey || event.altKey ? "" : singleKey(event.key);
		if (key) assignKey(shortcut, key, "keys.assigned");
		else showKeysMessage("keys.invalid", undefined, true);
	}, true);

	// The shortcuts never fire while typing, with a browser chord, while the comment box, the shortcuts list (where the help
	// key closes it) or Appearance is open, in Compare, or in focus mode (the artboard owns the keyboard there; Shift+Esc is handled apart).
	const TYPING_TAGS = ["input", "textarea", "select"];
	document.addEventListener("keydown", (event) => {
		if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
		const target = event.target;
		if (target && (TYPING_TAGS.includes(target.localName) || target.isContentEditable)) return;
		const key = singleKey(event.key);
		const shortcut = key ? SHORTCUTS.find((entry) => shortcutKey(entry) === key) : null;
		if (els.shortcuts.hasAttribute("open")) {
			if (shortcut && shortcut.id === "help") {
				event.preventDefault();
				closeShortcuts();
			}
			return;
		}
		if (!els.popover.hidden || state.focus || state.compare || state.menu || state.deviceMenu || els.appearance.hasAttribute("open") || els.variantDialog.hasAttribute("open")) return;
		if (!shortcut) return;
		event.preventDefault();
		shortcut.run();
	});

	function isFiniteNumber(value) {
		return typeof value === "number" && Number.isFinite(value);
	}

	function readPick(data) {
		if (typeof data.selector !== "string") return null;
		const selector = data.selector.trim();
		if (!selector || selector.length > LIMITS.selector) return null;
		const excerpt = typeof data.excerpt === "string" ? data.excerpt.slice(0, LIMITS.excerpt) : "";
		const rect = data.rect && typeof data.rect === "object" ? data.rect : {};
		const box = ["x", "y", "width", "height"].every((key) => isFiniteNumber(rect[key])) ? rect : { x: 0, y: 0, width: 0, height: 0 };
		return { selector, excerpt, rect: { x: box.x, y: box.y, width: box.width, height: box.height } };
	}

	function openPopover(surface, pick) {
		hideInspector();
		clearTimeout(state.closeTimer);
		const board = ownerOf(surface);
		state.pick = { board, surface, viewport: viewportOf(surface), ...pick };
		els.target.textContent = `${board.artboard.file} · ${pick.selector}`;
		els.message.textContent = "";
		els.message.title = "";
		els.message.classList.remove("gd-error");
		els.send.disabled = false;
		// Implement only this needs a session behind the canvas; without one it says so in its tooltip.
		els.partAdd.disabled = !DELIVERY.part;
		loc(els.partAdd, "title", DELIVERY.part ? "part.addTitle" : "reason.implement-part-unavailable");
		els.popover.hidden = false;
		renderGuide(false);
		// Beside the element in the frame it was picked in, which may be scaled (All sizes) or resized (a single size).
		const frameRect = surface.frame.getBoundingClientRect();
		const scale = frameRect.width / surface.viewWidth || 1;
		const width = els.popover.offsetWidth;
		const height = els.popover.offsetHeight;
		let left = frameRect.left + pick.rect.x * scale;
		let top = frameRect.top + (pick.rect.y + pick.rect.height) * scale + 8;
		if (top + height > window.innerHeight - 12) top = frameRect.top + pick.rect.y * scale - height - 8;
		left = Math.min(Math.max(12, left), window.innerWidth - width - 12);
		top = Math.min(Math.max(12, top), window.innerHeight - height - 12);
		els.popover.style.left = `${left}px`;
		els.popover.style.top = `${top}px`;
		els.text.focus();
	}

	function clearShot() {
		state.shot = null;
		state.shotToken += 1;
		els.shotInput.value = "";
		els.shotImage.removeAttribute("src");
		els.shotPreview.hidden = true;
		els.shotAttach.hidden = false;
	}

	function shotError(message) {
		els.message.textContent = message;
		els.message.classList.add("gd-error");
	}

	/** Reads one image file into the popover; a later attach or a clear discards a read still running. */
	function attachShot(file) {
		if (!file || els.popover.hidden) return;
		if (!SCREENSHOT_TYPES.includes(file.type)) return shotError(t("shot.type"));
		if (file.size === 0 || file.size > LIMITS.screenshotBytes) return shotError(t("shot.size"));
		const token = ++state.shotToken;
		const reader = new FileReader();
		reader.addEventListener("load", () => {
			if (token !== state.shotToken || typeof reader.result !== "string") return;
			const url = reader.result;
			state.shot = { mimeType: file.type, data: url.slice(url.indexOf(",") + 1) };
			els.shotImage.src = url;
			els.shotPreview.hidden = false;
			els.shotAttach.hidden = true;
			els.message.textContent = "";
			els.message.classList.remove("gd-error");
		});
		reader.addEventListener("error", () => { if (token === state.shotToken) shotError(t("shot.read")); });
		reader.readAsDataURL(file);
	}

	function imageFile(list) {
		return Array.from(list || []).find((file) => file.type.startsWith("image/")) || (list && list[0]) || null;
	}

	els.shotAttach.addEventListener("click", () => els.shotInput.click());
	els.shotInput.addEventListener("change", () => attachShot(els.shotInput.files && els.shotInput.files[0]));
	els.shotRemove.addEventListener("click", () => {
		clearShot();
		els.shotAttach.focus();
	});
	els.popover.addEventListener("paste", (event) => {
		const items = Array.from(event.clipboardData ? event.clipboardData.items : []);
		const item = items.find((entry) => entry.kind === "file" && entry.type.startsWith("image/"));
		if (!item) return;
		event.preventDefault();
		attachShot(item.getAsFile());
	});
	els.popover.addEventListener("dragover", (event) => {
		if (!event.dataTransfer || !Array.from(event.dataTransfer.types).includes("Files")) return;
		event.preventDefault();
		event.dataTransfer.dropEffect = "copy";
		els.popover.classList.add("gd-dropping");
	});
	els.popover.addEventListener("dragleave", (event) => {
		if (!els.popover.contains(event.relatedTarget)) els.popover.classList.remove("gd-dropping");
	});
	els.popover.addEventListener("drop", (event) => {
		els.popover.classList.remove("gd-dropping");
		if (!event.dataTransfer || event.dataTransfer.files.length === 0) return;
		event.preventDefault();
		attachShot(imageFile(event.dataTransfer.files));
	});

	function closePopover() {
		hideInspector();
		if (els.popover.hidden) return;
		clearTimeout(state.closeTimer);
		const surface = state.pick && state.pick.surface;
		state.pick = null;
		clearShot();
		els.popover.hidden = true;
		renderGuide(false);
		surface?.frame.contentWindow?.postMessage({ type: "gd:clear" }, "*");
		if (els.popover.contains(document.activeElement) || document.activeElement === document.body) (state.focus ? state.focus.frame : els.comment).focus();
	}

	els.cancel.addEventListener("click", closePopover);
	els.popover.addEventListener("keydown", (event) => {
		if (event.key === "Escape") {
			event.preventDefault();
			closePopover();
		}
	});
	document.addEventListener("keydown", (event) => {
		if (event.defaultPrevented || event.key !== "Escape") return;
		if (event.shiftKey) {
			if (state.compare) {
				event.preventDefault();
				exitCompare(true);
				return;
			}
			if (!state.focus) return;
			event.preventDefault();
			exitFocus();
		} else if (state.mark && els.popover.hidden && !state.compare && !els.shortcuts.hasAttribute("open") && !els.appearance.hasAttribute("open") && !els.variantDialog.hasAttribute("open")) {
			// A check's ring goes first; the next Esc leaves comment mode as before.
			event.preventDefault();
			clearMark();
		} else if (state.selected && !guideBlocked()) {
			// Then the selected artboard (canvas-layout S10).
			event.preventDefault();
			selectBoard(null);
		} else if (state.commenting && els.popover.hidden && event.target === document.body) setCommenting(false);
	});

	els.form.addEventListener("submit", async (event) => {
		event.preventDefault();
		const pick = state.pick;
		if (!pick) return;
		const comment = els.text.value.trim();
		if (!comment || comment.length > LIMITS.comment) {
			els.message.textContent = t("popover.tooLong", { max: LIMITS.comment });
			els.message.classList.add("gd-error");
			return;
		}
		els.send.disabled = true;
		els.message.classList.remove("gd-error");
		els.message.textContent = t("popover.sending");
		const shot = state.shot;
		const reply = await postJson("api/comments", { slug: pick.board.slug, file: pick.board.artboard.file, selector: pick.selector, excerpt: pick.excerpt, comment, mode: state.mode, ...(shot ? { screenshot: shot } : {}), ...(pick.viewport ? { viewport: pick.viewport } : {}) });
		// Delivery can fail after the comment was saved; it then waits for "Send all".
		const savedOnly = reply.status === 500 && reply.body.saved === true;
		if (!reply.ok && !savedOnly) {
			if (state.pick !== pick) return;
			const info = explain(reply);
			els.send.disabled = false;
			els.message.textContent = info.text;
			els.message.title = info.detail;
			els.message.classList.add("gd-error");
			return;
		}
		loadComments();
		if (state.pick !== pick) return;
		els.text.value = "";
		if (state.shot === shot) clearShot();
		const done = t(savedOnly ? "popover.savedOnly" : reply.status === 201 ? "popover.saved" : "popover.sentDone");
		els.message.textContent = done;
		els.message.title = savedOnly ? explain(reply).detail : "";
		els.message.classList.toggle("gd-error", savedOnly);
		state.closeTimer = setTimeout(closePopover, savedOnly ? 2500 : 1200);
	});

	// The popover's second action (canvas-implement-part S1): the picked element goes to the session to be built on its
	// own, with the field as its optional note. It is recorded in parts.json and chooses no direction.
	els.partAdd.addEventListener("click", async () => {
		const pick = state.pick;
		if (!pick || els.partAdd.disabled) return;
		const note = els.text.value.replace(/\r\n?/g, "\n").trim();
		const fail = (text, detail) => {
			els.message.textContent = text;
			els.message.title = detail ?? "";
			els.message.classList.add("gd-error");
		};
		if (note.length > LIMITS.comment) return fail(t("part.noteTooLong", { max: LIMITS.comment }));
		els.partAdd.disabled = true;
		els.message.classList.remove("gd-error");
		els.message.textContent = t("popover.sending");
		const board = pick.board;
		const reply = await postJson(`api/designs/${encodeURIComponent(board.slug)}/implement-part`, { file: board.artboard.file, selector: pick.selector, excerpt: pick.excerpt, note });
		els.partAdd.disabled = !DELIVERY.part;
		if (state.pick !== pick) return;
		if (!reply.ok) {
			const info = explain(reply);
			return fail(info.text, info.detail);
		}
		const queued = reply.body.queued === true;
		if (typeof reply.body.id === "string") {
			noteParts(board.slug, { id: reply.body.id, file: board.artboard.file, selector: pick.selector, excerpt: pick.excerpt, status: "sent", queued, sentAt: new Date().toISOString(), startedAt: null, implementedAt: null, ...(note ? { instruction: note } : {}) });
		}
		els.text.value = "";
		els.message.textContent = t("popover.sentDone");
		els.message.title = "";
		showToast(t(queued ? "part.queued" : "part.sent", { title: board.artboard.title }), false);
		state.closeTimer = setTimeout(closePopover, 1200);
	});

	window.addEventListener("message", (event) => {
		// Shift+Esc inside the compared artboard leaves Compare; nothing else from it is trusted.
		if (state.compare && event.source === state.compare.artboardFrame.contentWindow) {
			if (event.data && typeof event.data === "object" && event.data.type === "gd:exit-focus") exitCompare(true);
			return;
		}
		// A board's own frame or, in All sizes, one of its size frames; nothing else is trusted.
		const surface = allBoards().flatMap(surfacesOf).find((candidate) => candidate.frame.contentWindow === event.source);
		if (!surface || !event.data || typeof event.data !== "object") return;
		const board = ownerOf(surface);
		const data = event.data;
		if (data.type === "gd:pick") {
			// The system board never takes comments, even if its page posts a pick.
			if (!state.commenting || board.system || (state.focus && board !== state.focus)) return;
			const pick = readPick(data);
			if (pick) openPopover(surface, pick);
		} else if (data.type === "gd:wheel") {
			if (![data.deltaX, data.deltaY, data.deltaMode, data.x, data.y].every(isFiniteNumber)) return;
			const frameRect = surface.frame.getBoundingClientRect();
			const scale = frameRect.width / surface.viewWidth || 1;
			handleWheel(data.deltaX, data.deltaY, data.deltaMode, data.zoom === true, data.shift === true, frameRect.left + data.x * scale, frameRect.top + data.y * scale);
		} else if (data.type === "gd:pin-rects") {
			if (board.system) return;
			const rects = readRects(data);
			if (!rects) return;
			const detachedBefore = detachedKey();
			surface.rects = rects;
			renderPins(surface);
			// Re-render the list only when a badge changes, so keyboard focus in it survives.
			// Only the artboard's own frame says whether a comment is detached.
			if (detachedKey() !== detachedBefore) renderList();
		} else if (data.type === "gd:overflow") {
			if (board.system || typeof data.overflow !== "boolean" || !isFiniteNumber(data.width) || !isFiniteNumber(data.scrollWidth)) return;
			// A report for another width is a late one from before the frame was resized.
			if (Math.round(data.width) !== surface.viewWidth) return;
			surface.overflow = data.overflow ? { scrollWidth: data.scrollWidth } : null;
			renderOverflow(surface);
		} else if (data.type === "gd:inspect") {
			// Only with Technical details on, while commenting on the focused artboard (or any, in the overview), never while the comment box is open.
			if (!state.technical || board.system || !state.commenting || !els.popover.hidden || (state.focus && board !== state.focus)) return;
			if (data.element === null) {
				if (state.inspect && state.inspect.surface === surface) scheduleInspectorHide();
				return;
			}
			const measure = readMeasure(data.element);
			if (measure) showInspector(surface, measure);
		} else if (data.type === "gd:checks") {
			// Only the artboard's own frame says how the artboard is; the system board is never checked.
			if (board.system || surface !== board) return;
			const result = readChecks(data);
			if (!result) return;
			board.checks = result;
			followMark(board);
			renderChecks();
		} else if (data.type === "gd:escape") {
			if (!els.popover.hidden) closePopover();
			else if (state.mark) clearMark();
			else if (state.commenting) setCommenting(false);
		} else if (data.type === "gd:exit-focus") {
			// Only the focused artboard may end its own focus mode.
			if (board === state.focus) exitFocus();
		}
	});

	window.addEventListener("resize", closePopover);
	window.addEventListener("resize", () => closeMenu(false));
	window.addEventListener("resize", () => closeDeviceMenu(false));
	window.addEventListener("resize", layoutCompare);
	window.addEventListener("resize", renderMinimap);
	window.addEventListener("resize", updateTabFades);
	window.addEventListener("resize", placeGuide);
	// The viewport also changes size when the comments panel opens or closes (setPanel).
	function viewportResized() {
		centerFocus();
		refit();
	}
	if (typeof ResizeObserver === "function") new ResizeObserver(() => { viewportResized(); renderMinimap(); }).observe(els.viewport);
	// Fires once on observe, then when fonts or the panel change the row: the fades are right from the first layout.
	if (typeof ResizeObserver === "function") new ResizeObserver(updateTabFades).observe(els.tabs);
	else window.addEventListener("resize", viewportResized);

	// index.html starts them hidden; the menus are built when they open. The guide too, until it opens.
	els.menu.hidden = true;
	els.deviceMenu.hidden = true;
	els.guide.hidden = true;
	els.guideSpot.hidden = true;
	setMode(state.mode);
	renderTools();
	renderShortcuts();
	renderTechnical();
	if (!DELIVERY.batch) {
		const info = explain({ status: 501, body: { error: "batch-delivery-unavailable" } });
		loc(els.sendNote, "text", info.key, info.params);
		els.sendNote.title = info.detail;
		els.sendNote.hidden = false;
	}
	applyLanguage();
	start();
	connectEvents();
})();
