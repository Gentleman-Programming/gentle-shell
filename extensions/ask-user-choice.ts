import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Input, isKeyRelease, matchesKey, Text, type KeybindingsManager, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { NativeChoiceList } from "../lib/native-choice-list.ts";
import { createNativeFullscreenInteraction } from "../lib/native-fullscreen-interaction.ts";

const CHOICE_TOOL_NAME = "ask_user_choice";
const ASK_USER_CHOICE_BLOCKED_EVENT = "gentle-pi:ask-user-choice:blocked";

const ChoiceOptionSchema = Type.Object(
	{
		label: Type.String({ description: "User-facing option label" }),
		description: Type.String({ description: "User-facing option description" }),
		value: Type.String({ description: "Opaque envelope-owned answer token returned only after selection" }),
	},
	{ additionalProperties: false },
);

const ChoiceParamsSchema = Type.Object(
	{
		question: Type.String({ description: "The one question to display" }),
		options: Type.Array(ChoiceOptionSchema, {
			minItems: 2,
			maxItems: 4,
			description: "Two to four ordered closed options",
		}),
		allowCustomResponse: Type.Optional(Type.Boolean({
			description: "Opt in to an Other… free-text response. Never enable for provider-owned consent prompts, maintenance authorizations, or any exact opaque-token decision.",
		})),
	},
	{ additionalProperties: false },
);

type ChoiceOption = Static<typeof ChoiceOptionSchema>;
type ChoiceParams = Static<typeof ChoiceParamsSchema>;

interface ChoiceSelection {
	value: string;
	label: string;
	index: number;
}

interface ChoiceDetails {
	question: string;
	options: ChoiceOption[];
	selection?: ChoiceSelection;
	customResponse?: string;
	cancelled?: true;
}

type ChoiceResult = ChoiceSelection | { customResponse: string };

class CustomResponseEditor extends Container {
	private readonly input = new Input({ prompt: "> ", placeholder: "Type your response" });
	private readonly validationText = new Text("", 1, 0);
	private readonly keybindings: KeybindingsManager | undefined;
	private readonly onSubmit: (value: string) => void;
	private readonly onCancel: () => void;

	constructor(
		keybindings: KeybindingsManager | undefined,
		onSubmit: (value: string) => void,
		onCancel: () => void,
	) {
		super();
		this.keybindings = keybindings;
		this.onSubmit = onSubmit;
		this.onCancel = onCancel;
		this.input.focused = true;
		this.addChild(new Text("Custom response", 1, 0));
		this.addChild(this.input);
		this.addChild(this.validationText);
		this.addChild(new Text("Submit to continue • Cancel to return to choices", 1, 0));
	}

	handleInput(data: string): void {
		if (isKeyRelease(data)) return;
		if (this.matches(data, "tui.select.cancel")) {
			this.onCancel();
			return;
		}
		if (this.matches(data, "tui.input.submit")) {
			const value = this.input.getValue();
			if (value.trim().length > 0) this.onSubmit(value);
			else this.validationText.setText("Response cannot be empty.");
			this.invalidate();
			return;
		}
		if (this.matches(data, "tui.editor.deleteCharBackward")) {
			this.input.handleInput(data);
			this.validationText.setText("");
			this.invalidate();
			return;
		}
		this.input.handleInput(data);
		this.validationText.setText("");
		this.invalidate();
	}

	private matches(
		data: string,
		binding: "tui.select.cancel" | "tui.input.submit" | "tui.editor.deleteCharBackward",
	): boolean {
		if (this.keybindings?.matches) return this.keybindings.matches(data, binding);
		const key = binding === "tui.select.cancel" ? "escape"
			: binding === "tui.input.submit" ? "enter" : "backspace";
		return matchesKey(data, key);
	}
}

class ChoiceModeView extends Container {
	private editing = false;
	private readonly list: NativeChoiceList<{ id: string; label: string; description: string }>;
	private readonly editor: CustomResponseEditor;

	constructor(
		list: NativeChoiceList<{ id: string; label: string; description: string }>,
		editor: CustomResponseEditor,
	) {
		super();
		this.list = list;
		this.editor = editor;
	}

	showEditor(): void {
		this.editing = true;
		this.invalidate();
	}

	showList(): void {
		this.editing = false;
		this.invalidate();
	}

	handleInput(data: string): void {
		if (this.editing) this.editor.handleInput(data);
		else this.list.handleInput(data);
	}

	override handleMouse(event: TuiMouseEvent) {
		return this.editing ? undefined : this.list.handleMouse(event);
	}

	override render(width: number): string[] {
		return (this.editing ? this.editor : this.list).render(width);
	}
}

function reconcileToolAvailability(pi: ExtensionAPI, interactiveTui: boolean): void {
	const active = pi.getActiveTools();
	const isActive = active.includes(CHOICE_TOOL_NAME);
	if (interactiveTui === isActive) return;
	const next = interactiveTui
		? [...new Set([...active, CHOICE_TOOL_NAME])]
		: active.filter((name) => name !== CHOICE_TOOL_NAME);
	pi.setActiveTools(next);
}

function resultDetails(params: ChoiceParams): ChoiceDetails {
	return { question: params.question, options: params.options };
}

export default function askUserChoice(pi: ExtensionAPI): void {
	pi.registerTool({
		name: CHOICE_TOOL_NAME,
		renderShell: "self",
		label: "Ask User Choice",
		description: "Ask one single-select question with two to four ordered options. A custom response is available only when allowCustomResponse is explicitly enabled.",
		promptGuidelines: [
			"Use ask_user_choice only for one exactly representable single-select question with 2-4 ordered options. Enable allowCustomResponse only when free text is safe and intended.",
			"Never enable allowCustomResponse for provider-owned consent prompts, maintenance authorizations, or any decision that requires an exact opaque token.",
		],
		parameters: ChoiceParamsSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params: ChoiceParams, _signal, _onUpdate, ctx) {
			if (ctx.mode !== "tui") {
				throw new Error("ask_user_choice is unavailable outside the interactive TUI");
			}

			const items = params.options.map((option, index) => ({
				id: `choice-${index}`,
				label: option.label,
				description: option.description,
			}));
			const customItemId = "choice-custom-response";
			if (params.allowCustomResponse === true) {
				items.push({ id: customItemId, label: "Other…", description: "Provide a custom response" });
			}
			let selection: ChoiceResult | undefined;
			try {
				pi.events.emit(ASK_USER_CHOICE_BLOCKED_EVENT, { active: true });
				selection = await ctx.ui.custom<ChoiceResult | undefined>((tui, theme, keybindings, done) => {
					const list = new NativeChoiceList(items, {
						selectedPrefix: (text) => theme.fg("accent", text),
						selectedText: (text) => theme.fg("accent", text),
						description: (text) => theme.fg("muted", text),
						hoverBackground: (text) => theme.bg("toolPendingBg", text),
					}, keybindings);
					let completed = false;
					const finish = (result: ChoiceResult | undefined) => {
						if (completed) return;
						completed = true;
						list.setDisabled(true);
						done(result);
					};
					let view: ChoiceModeView;
					const editor = new CustomResponseEditor(
						keybindings,
						(value) => finish({ customResponse: value }),
						() => view.showList(),
					);
					view = new ChoiceModeView(list, editor);
					const container = createNativeFullscreenInteraction({
						keyboardTarget: view,
						requestRender: () => tui.requestRender(),
						mouseObserver: list.createMouseObserver(() => tui.requestRender()),
					});
					list.onSelect = (item) => {
						if (item.id === customItemId) {
							view.showEditor();
							tui.requestRender();
						}
						else {
							const index = items.indexOf(item);
							const option = params.options[index];
							if (option) finish({ value: option.value, label: option.label, index: index + 1 });
						}
					};
					list.onCancel = () => finish(undefined);
					container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
					container.addChild(new Text(theme.fg("accent", theme.bold(params.question)), 1, 0));
					container.addChild(view);
					container.addChild(new Text(theme.fg("dim", "↑↓ navigate • Enter select • Esc cancel"), 1, 0));
					container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
					return container;
				});
			} finally {
				pi.events.emit(ASK_USER_CHOICE_BLOCKED_EVENT, { active: false });
			}

			if (selection === undefined) {
				return {
					content: [{ type: "text", text: "User cancelled the choice" }],
					details: { ...resultDetails(params), cancelled: true },
				};
			}
			if ("customResponse" in selection) {
				return {
					content: [{ type: "text", text: `User responded: ${selection.customResponse}` }],
					details: { ...resultDetails(params), customResponse: selection.customResponse },
				};
			}
			return {
				content: [{ type: "text", text: `User selected: ${selection.index}. ${selection.label} (value: ${selection.value})` }],
				details: { ...resultDetails(params), selection },
			};
		},
		renderCall(args, theme) {
			const options = Array.isArray(args.options) ? args.options : [];
			const labels = options
				.map((option) => (typeof option === "object" && option !== null && "label" in option && typeof option.label === "string" ? option.label : ""))
				.filter((label) => label.length > 0);
			return new Text(
				theme.fg("toolTitle", theme.bold("ask_user_choice ")) +
				theme.fg("muted", typeof args.question === "string" ? args.question : "") +
				(labels.length > 0 ? theme.fg("dim", ` (${labels.join(", ")})`) : ""),
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const details = result.details as ChoiceDetails | undefined;
			if (details?.selection) {
				return new Text(theme.fg("success", `✓ ${details.selection.index}. ${details.selection.label}`), 0, 0);
			}
			if (details?.customResponse !== undefined) return new Text(theme.fg("success", "✓ Custom response"), 0, 0);
			return new Text(theme.fg("warning", "Cancelled"), 0, 0);
		},
	});

	pi.on("before_agent_start", (_event, ctx) => {
		reconcileToolAvailability(pi, ctx.mode === "tui");
	});
}
