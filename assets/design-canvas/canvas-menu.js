// The shared action menu (#gd-menu): one menu at a time, built from a list of
// actions under the button that opened it, with the keyboard behavior every menu
// of the canvas shares (arrows, Home, End, Enter and Space choose, Escape and Tab
// close) and a press outside to close it. The rail's Settings uses it; the
// per-artboard menu reuses it later. The open menu lives in the store (setMenu),
// so the single-key shortcuts can stay off while it is open.

export function init(ctx) {
	const { win, doc, els, store } = ctx;
	const { state } = store;

	/**
	 * An icon from the page's sprite (index.html, #gd-sprite). The sprite is an <svg>,
	 * so its namespace is the SVG one; taking it from there keeps URLs out of the code.
	 */
	function icon(name, className) {
		const namespace = els.sprite.namespaceURI;
		const svg = doc.createElementNS(namespace, "svg");
		svg.setAttribute("class", className);
		svg.setAttribute("aria-hidden", "true");
		const use = doc.createElementNS(namespace, "use");
		use.setAttribute("href", `#${name}`);
		svg.append(use);
		return svg;
	}

	/**
	 * One item of a menu. action: { label, icon?, shortcut?, disabled? }; a disabled
	 * item (nothing to act on) is announced as unavailable and choosing it does nothing.
	 */
	function menuItem(action) {
		const item = doc.createElement("button");
		item.type = "button";
		item.className = "gd-menu-item";
		item.setAttribute("role", "menuitem");
		item.setAttribute("tabindex", "-1");
		if (action.icon) item.append(icon(action.icon, "gd-i gd-i-s"));
		const label = doc.createElement("span");
		label.className = "gd-menu-label";
		label.textContent = action.label;
		item.append(label);
		// A single key that does the same, shown at the end of the item.
		if (action.shortcut) {
			item.setAttribute("aria-keyshortcuts", action.shortcut);
			const key = doc.createElement("kbd");
			key.className = "gd-menu-kbd";
			key.setAttribute("aria-hidden", "true");
			key.textContent = action.shortcut;
			item.append(key);
		}
		if (action.disabled) item.setAttribute("aria-disabled", "true");
		return item;
	}

	/**
	 * Puts `menu` under `button`, inside the window; `beside` puts it right of the button
	 * instead (the rail's Settings, at the bottom left), bottom-aligned with it when there
	 * is no room below.
	 */
	function placeMenu(button, menu, beside = false) {
		const rect = button.getBoundingClientRect();
		// A fixed box without a width shrinks to the room right of its left edge: measure it where nothing narrows it.
		menu.style.left = "0px";
		const width = menu.offsetWidth;
		const height = menu.offsetHeight;
		const left = Math.max(0, Math.min(beside ? rect.left + rect.width + 8 : rect.left, win.innerWidth - width - 12));
		let top = beside ? rect.top : rect.bottom + 4;
		if (top + height > win.innerHeight - 12) top = Math.max(0, beside ? rect.top + rect.height - height : rect.top - height - 4);
		menu.style.left = `${left}px`;
		menu.style.top = `${top}px`;
	}

	/**
	 * Builds the menu from `actions` under `button`, named `label`, with focus on its first
	 * (or `last`) item; `run(button)` is what choosing an action does.
	 */
	function showMenu(button, actions, label, last = false, beside = false) {
		closeMenu(false);
		const items = [];
		const byItem = new Map();
		for (const action of actions) {
			const item = menuItem(action);
			item.addEventListener("click", () => chooseMenuItem(item));
			byItem.set(item, action);
			items.push(item);
		}
		els.menu.setAttribute("aria-label", label);
		els.menu.replaceChildren(...items);
		els.menu.hidden = false;
		button.setAttribute("aria-expanded", "true");
		store.setMenu({ button, items, byItem });
		placeMenu(button, els.menu, beside);
		(last ? items[items.length - 1] : items[0]).focus();
	}

	/** Closes the menu; focus goes back to its button when it was inside the menu (or `refocus`). */
	function closeMenu(refocus) {
		const open = state.menu;
		if (!open) return;
		store.setMenu(null);
		const inside = els.menu.contains(doc.activeElement);
		els.menu.hidden = true;
		els.menu.replaceChildren();
		open.button.setAttribute("aria-expanded", "false");
		if (refocus || inside) open.button.focus();
	}

	function chooseMenuItem(item) {
		const open = state.menu;
		const action = open && open.byItem.get(item);
		if (!action || action.disabled) return;
		// Back on the button first: the action then moves focus where it needs it (a dialog, a confirm step).
		closeMenu(true);
		action.run(open.button);
	}

	/** A button that opens a menu: a click toggles it, the arrows open it on the first or the last item, Escape closes it. */
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

	doc.addEventListener("pointerdown", (event) => {
		const open = state.menu;
		if (open && !els.menu.contains(event.target) && !open.button.contains(event.target)) closeMenu(false);
	});

	return { icon, showMenu, closeMenu, wireMenu, menuKeydown };
}
