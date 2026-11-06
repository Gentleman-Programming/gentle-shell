import { spawnSync } from "node:child_process";

export interface ExternalEditorHost {
	stop(): void;
	start(): void;
	requestRender(force?: boolean): void;
}

export function openInExternalEditor(host: ExternalEditorHost, path: string, env: NodeJS.ProcessEnv = process.env, spawn: typeof spawnSync = spawnSync, cwd?: string): boolean {
	const command = env.VISUAL || env.EDITOR;
	if (!command) return false;
	const [editor, ...editorArgs] = command.split(" ");
	// Repository-controlled paths must never become shell syntax. Batch
	// editors require cmd.exe, so fail closed rather than quoting for a shell.
	if (process.platform === "win32" && /\.(cmd|bat)$/i.test(editor)) {
		throw new Error("Could not open editor: Windows batch editors are not supported. Set $VISUAL or $EDITOR to a direct executable (.exe).");
	}

	host.stop();
	try {
		const result = spawn(editor, [...editorArgs, path], { cwd, stdio: "inherit", shell: false });
		if (result.error) throw result.error;
		if (result.status !== 0) throw new Error(result.signal ? `terminated by ${result.signal}` : `exit status ${result.status}`);
	} catch (error) {
		throw new Error(`Could not open editor: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	} finally {
		host.start();
		host.requestRender(true);
	}
	return true;
}
