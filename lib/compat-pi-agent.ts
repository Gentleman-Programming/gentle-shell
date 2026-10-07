import * as realPiAgent from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";

export function fallbackGenerateUnifiedPatch(path: string, oldContent: string, newContent: string): string {
	if (oldContent === newContent) return "";
	return `--- ${path}\n+++ ${path}\n@@ -1 +1 @@\n-${oldContent}\n+${newContent}\n`;
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
	agentNamespace.createCodemodeExtension ?? ((_options?: unknown) => (_api: ExtensionAPI) => {});

export const getReadmePath = agentNamespace.getReadmePath ?? (() => "");

export * from "@earendil-works/pi-coding-agent";
