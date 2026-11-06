import type { ImageContent } from "@earendil-works/pi-ai";
import { getImageDimensions, type ImageDimensions } from "@earendil-works/pi-tui";
import type { ClipboardImage } from "./clipboard-image.ts";

// Pasted images live in the draft as atomic `[Image#N]` chips (gentle-shell#2464).
// The bytes stay in memory: a chip deleted from the draft is never sent, and
// the chips still in the text become real image attachments on submit.
//
// The token has no whitespace on purpose: Pi's word motions, word deletion and
// word wrap treat any segment containing a space as whitespace unless it is
// one of Pi's own paste markers, so `[Image #1]` would be skipped and eaten
// together with the word before it.

export const IMAGE_TOKEN_PATTERN = /\[Image#(\d+)\]/g;

export interface ImageAttachment {
	id: number;
	token: string;
	mimeType: string;
	byteLength: number;
	base64: string;
	dimensions?: ImageDimensions;
}

export interface SubmittedImages {
	text: string;
	images: ImageContent[];
	/** Chips the active model cannot receive; their tokens become a plain note. */
	omitted: number;
}

export interface TextSpan { start: number; end: number }

interface Segment { segment: string; index: number; input: string }

export function imageToken(id: number): string {
	return `[Image#${id}]`;
}

export class ImageAttachments {
	private readonly entries = new Map<number, ImageAttachment>();
	// Never reset: Pi's prompt history keeps the raw submitted text, so a
	// reused id would let a recalled `[Image#1]` bind to a different image.
	private counter = 0;

	get size(): number { return this.entries.size; }

	has(id: number): boolean { return this.entries.has(id); }

	add(image: ClipboardImage): ImageAttachment {
		const id = ++this.counter;
		const base64 = Buffer.from(image.bytes).toString("base64");
		const attachment: ImageAttachment = {
			id,
			token: imageToken(id),
			mimeType: image.mimeType,
			byteLength: image.bytes.length,
			base64,
			dimensions: getImageDimensions(base64, image.mimeType) ?? undefined,
		};
		this.entries.set(id, attachment);
		return attachment;
	}

	/** Registered chips in the order they appear in `text`, each once. */
	referenced(text: string): ImageAttachment[] {
		const seen = new Set<number>();
		const result: ImageAttachment[] = [];
		for (const match of text.matchAll(IMAGE_TOKEN_PATTERN)) {
			const id = Number(match[1]);
			const attachment = this.entries.get(id);
			if (!attachment || seen.has(id)) continue;
			seen.add(id);
			result.push(attachment);
		}
		return result;
	}

	/**
	 * Resolve a submitted draft. Returns undefined when it holds no registered
	 * chip, so ordinary prompts pass through untouched.
	 *
	 * Pi can run input handlers after the editor already holds a new draft
	 * (a prompt queued during compaction), so only chips the current draft
	 * still shows survive; everything else, sent or deleted, is released.
	 */
	submit(text: string, modelAcceptsImages: boolean, currentDraft = ""): SubmittedImages | undefined {
		const attachments = this.referenced(text);
		const keep = new Set(this.referenced(currentDraft).map((attachment) => attachment.id));
		for (const id of [...this.entries.keys()]) if (!keep.has(id)) this.entries.delete(id);
		if (attachments.length === 0) return undefined;
		if (modelAcceptsImages) {
			return { text, images: attachments.map((attachment) => ({ type: "image", data: attachment.base64, mimeType: attachment.mimeType })), omitted: 0 };
		}
		const ids = new Set(attachments.map((attachment) => attachment.id));
		const noted = text.replace(IMAGE_TOKEN_PATTERN, (token, id: string) => ids.has(Number(id)) ? `${token.slice(0, -1)} omitted: the current model does not accept images]` : token);
		return { text: noted, images: [], omitted: attachments.length };
	}

	/** Drop every pending image; numbering keeps counting up. */
	clear(): void {
		this.entries.clear();
	}

	/** Character spans of the registered chips in `text`. */
	spans(text: string): TextSpan[] {
		if (this.entries.size === 0 || !text.includes("[Image#")) return [];
		const spans: TextSpan[] = [];
		for (const match of text.matchAll(IMAGE_TOKEN_PATTERN)) {
			if (this.entries.has(Number(match[1]))) spans.push({ start: match.index, end: match.index + match[0].length });
		}
		return spans;
	}

	/**
	 * Merge every registered chip into one segment, so cursor movement, word
	 * wrap and deletion treat it as a single unit (one Backspace removes it).
	 * Segments that already span several graphemes, such as Pi's own paste
	 * markers, pass through unchanged.
	 */
	segment(text: string, segments: Iterable<Segment>): Iterable<Segment> {
		const spans = this.spans(text);
		if (spans.length === 0) return segments;
		const merged: Segment[] = [];
		let span = 0;
		for (const segment of segments) {
			while (span < spans.length && spans[span]!.end <= segment.index) span++;
			const current = spans[span];
			if (current && segment.index >= current.start && segment.index < current.end) {
				if (segment.index === current.start) merged.push({ segment: text.slice(current.start, current.end), index: current.start, input: text });
				continue;
			}
			merged.push(segment);
		}
		return merged;
	}
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** `png · 1280×720 · 84 KB`: the chip's description when no preview is drawn. */
export function describeAttachment(attachment: Pick<ImageAttachment, "mimeType" | "byteLength" | "dimensions">): string {
	const format = attachment.mimeType.replace(/^image\//, "").replace("jpeg", "jpg");
	const size = attachment.dimensions ? `${attachment.dimensions.widthPx}×${attachment.dimensions.heightPx}` : undefined;
	return [format, size, formatBytes(attachment.byteLength)].filter(Boolean).join(" · ");
}
