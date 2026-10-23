import * as realPiAgent from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";

export function fallbackGenerateUnifiedPatch(path: string, oldContent: string, newContent: string): string {
	if (oldContent === newContent) return "";
	const oldLines = oldContent === "" ? [] : oldContent.split("\n");
	const newLines = newContent === "" ? [] : newContent.split("\n");
	const oldCount = oldLines.length;
	const newCount = newLines.length;
	const oldStart = oldCount === 0 ? 0 : 1;
	const newStart = newCount === 0 ? 0 : 1;
	const oldRange = oldCount === 1 ? `${oldStart}` : `${oldStart},${oldCount}`;
	const newRange = newCount === 1 ? `${newStart}` : `${newStart},${newCount}`;
	const header = `--- ${path}\n+++ ${path}\n@@ -${oldRange} +${newRange} @@\n`;
	const removed = oldLines.map((line) => `-${line}\n`).join("");
	const added = newLines.map((line) => `+${line}\n`).join("");
	return `${header}${removed}${added}`;
}

export function fallbackCreateCodemodeExtension(_options?: unknown): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		if (typeof pi.registerTool === "function") {
			pi.registerTool({
				name: "codemode",
				description: "Execute code mode actions (unsupported in this host environment)",
				parameters: { type: "object", properties: {} } as never,
				defaultActive: false,
				execute() {
					throw new Error("Codemode is not supported in this host environment");
				},
			});
		}
	};
}

type GenerateUnifiedPatchFn = (path: string, oldContent: string, newContent: string) => string;
type CreateCodemodeExtensionFn = (options?: unknown) => ExtensionFactory;

const agentNamespace = realPiAgent as unknown as {
	generateUnifiedPatch?: GenerateUnifiedPatchFn;
	createCodemodeExtension?: CreateCodemodeExtensionFn;
	getReadmePath?: () => string;
};

export const generateUnifiedPatch: GenerateUnifiedPatchFn =
	agentNamespace.generateUnifiedPatch ?? fallbackGenerateUnifiedPatch;

export const createCodemodeExtension: CreateCodemodeExtensionFn =
	agentNamespace.createCodemodeExtension ?? fallbackCreateCodemodeExtension;

export const getReadmePath = agentNamespace.getReadmePath ?? (() => "");

export * from "@earendil-works/pi-coding-agent";
