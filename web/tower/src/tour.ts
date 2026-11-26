// A short first-run tour: a spotlight on each clickable zone with a line on what it does.
// Dismissible; "Don't show again" is remembered in this browser; the "?" button reopens it.
import { esc } from "./panels";

/** Text-entry targets keep their arrow keys. */
const editable = (t: EventTarget | null) => t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || (t instanceof HTMLElement && t.isContentEditable);

export interface Box { x: number; y: number; w: number; h: number }
export interface TourStep { title: string; text: string; target: () => Box | undefined }

const KEY = "gentle-tower:tour";
const fromDom = (el: Element | null): Box | undefined => {
	if (!el) return undefined;
	const r = el.getBoundingClientRect();
	return r.width || r.height ? { x: r.left, y: r.top, w: r.width, h: r.height } : undefined;
};
export const domTarget = (selector: string) => () => fromDom(document.querySelector(selector));

export function tourDismissed(): boolean {
	try { return localStorage.getItem(KEY) === "off"; } catch { return false; }
}
function remember(off: boolean) {
	try { if (off) localStorage.setItem(KEY, "off"); else localStorage.removeItem(KEY); } catch { /* storage unavailable: shows again next time */ }
}

export class Tour {
	private i = 0;
	private spot = document.createElement("div");
	private card = document.createElement("section");
	private back: HTMLElement | null = null;
	constructor(private steps: TourStep[]) {
		this.spot.className = "tour-spot"; this.spot.setAttribute("aria-hidden", "true"); this.spot.hidden = true;
		this.card.className = "tour px"; this.card.hidden = true;
		this.card.setAttribute("role", "dialog"); this.card.setAttribute("aria-modal", "false"); this.card.setAttribute("aria-labelledby", "tour-title");
		document.body.append(this.spot, this.card);
		document.addEventListener("keydown", (e) => {
			if (!this.isOpen) return;
			if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); this.close(); }
			else if (e.key === "ArrowRight" && !editable(e.target)) { e.preventDefault(); e.stopImmediatePropagation(); this.go(1); }
			else if (e.key === "ArrowLeft" && !editable(e.target)) { e.preventDefault(); e.stopImmediatePropagation(); this.go(-1); }
		}, true);
		addEventListener("scroll", () => this.place(), { passive: true });
		addEventListener("resize", () => this.place());
	}
	get isOpen(): boolean { return !this.card.hidden; }
	open(): void {
		this.back = document.activeElement as HTMLElement | null;
		this.i = 0;
		this.card.hidden = false; this.spot.hidden = false;
		this.show(true);
	}
	close(): void {
		const off = (this.card.querySelector("#tour-off") as HTMLInputElement | null)?.checked === true;
		if (off) remember(true);
		this.card.hidden = true; this.spot.hidden = true;
		this.back?.focus?.();
	}
	private go(d: number) {
		const next = this.i + d;
		if (next < 0) return;
		if (next >= this.steps.length) { remember(true); this.close(); return; }
		this.i = next;
		this.show(true);
	}
	private show(scroll: boolean) {
		const step = this.steps[this.i], last = this.i === this.steps.length - 1;
		const off = (this.card.querySelector("#tour-off") as HTMLInputElement | null)?.checked ?? tourDismissed();
		this.card.innerHTML = `<header><b id="tour-title">${esc(step.title)}</b><small>${this.i + 1} / ${this.steps.length}</small><button class="x" aria-label="Close the tour">✕</button></header>
			<p>${step.text}</p>
			<footer><label><input type="checkbox" id="tour-off"${off ? " checked" : ""}> Don't show again</label>
			<span><button class="btn" data-go="-1"${this.i === 0 ? " disabled" : ""}>Back</button><button class="btn primary" data-go="1">${last ? "Done" : "Next"}</button></span></footer>`;
		this.card.querySelector(".x")!.addEventListener("click", () => this.close());
		this.card.querySelectorAll<HTMLButtonElement>("[data-go]").forEach((b) => b.addEventListener("click", () => this.go(+b.dataset.go!)));
		(this.card.querySelector("#tour-off") as HTMLInputElement).addEventListener("change", (e) => remember((e.target as HTMLInputElement).checked));
		const box = step.target();
		// Bring the zone into view first (instantly: no motion to sit through).
		if (scroll && box && (box.y < 60 || box.y + box.h > innerHeight - 40)) scrollBy({ top: box.y - innerHeight / 3, behavior: "auto" });
		this.place();
		(this.card.querySelector("[data-go='1']") as HTMLElement).focus();
	}
	/** Keeps the spotlight on its zone through scrolls, resizes and live updates. */
	place(): void {
		if (!this.isOpen) return;
		const box = this.steps[this.i].target();
		const pad = 6;
		if (box) Object.assign(this.spot.style, { left: `${box.x - pad}px`, top: `${box.y - pad}px`, width: `${box.w + pad * 2}px`, height: `${box.h + pad * 2}px`, opacity: "1" });
		else Object.assign(this.spot.style, { left: "50%", top: "40%", width: "0px", height: "0px", opacity: "1" });
		const cw = this.card.offsetWidth, ch = this.card.offsetHeight;
		const b = box ?? { x: innerWidth / 2 - cw / 2, y: innerHeight / 2 - ch / 2 - 20, w: cw, h: 0 };
		const below = b.y + b.h + pad + 12;
		const top = Math.min(Math.max(8, below + ch < innerHeight - 8 ? below : b.y - pad - 12 - ch), Math.max(8, innerHeight - ch - 8));
		const left = Math.min(Math.max(8, b.x), innerWidth - cw - 8);
		Object.assign(this.card.style, { left: `${left}px`, top: `${box ? top : b.y}px` });
	}
}
