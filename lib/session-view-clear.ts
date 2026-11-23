import type { Container, TUI } from "@earendil-works/pi-tui";

// Pi 1.6.0 no expone ninguna operación para vaciar la conversación: su API de
// extensiones llega hasta widgets, encabezado, footer y editor. La conversación
// sí es un Container que Pi vacía con su propio `clear()` cuando reconstruye la
// sesión (renderCurrentSessionState, compactaciones y navegación del árbol), así
// que limpiar la vista es llamar a ese mismo método y pedir un repintado. No se
// parchea nada del host: solo se localiza el contenedor y, si su forma no
// coincide con la esperada, el comando avisa y no toca nada. La sesión, sus
// entradas y el hook `context` quedan fuera por completo.

/** Aviso tras limpiar: el contexto sigue completo y la sesión lo devuelve al reanudar. */
export const SESSION_VIEW_CLEAR_NOTICE = "Pantalla limpia. El agente conserva todo el contexto; reanuda la sesión para ver el historial.";

/** Lo mínimo de un `Container` de pi-tui que este módulo necesita, sin `instanceof` (evita copias dobles). */
type ContainerShape = { children: unknown[]; addChild: unknown; clear: unknown; render: unknown };
/** El TUI con las dos capas internas que Pi publica en tiempo de ejecución (como ya hace el rail). */
export type SessionViewHost = TUI & { mode?: string; layoutRoot?: { children?: unknown[] } };

export interface SessionViewClearHost {
	/** Aviso al usuario; en la sesión real es `ctx.ui.notify`. */
	notify(message: string, type?: "info" | "warning" | "error"): void;
	/** El agente debe estar inactivo: el turno en curso vive en un componente que Pi descarta al terminar. */
	isIdle(): boolean;
}

/** Un contenedor de pi-tui, o undefined cuando el valor no tiene la forma esperada. */
function asContainer(value: unknown): Container | undefined {
	const candidate = value as Partial<ContainerShape> | undefined;
	if (!candidate || !Array.isArray(candidate.children)) return undefined;
	if (typeof candidate.addChild !== "function" || typeof candidate.clear !== "function" || typeof candidate.render !== "function") return undefined;
	return candidate as unknown as Container;
}

/**
 * El `ScrollView` del transcript guarda el documento como su hijo único, y ese
 * documento debe ser el mismo que Pi montó primero en el TUI. Cruzar ambas
 * rutas falla cerrado si Pi cambia el layout de pantalla completa.
 */
function transcriptMounts(document: Container, host: SessionViewHost): boolean {
	const transcript = asContainer(host.layoutRoot?.children?.[0]);
	if (!transcript || transcript.children.length !== 1 || transcript.children[0] !== document) return false;
	return typeof (transcript as unknown as { scrollTop?: unknown }).scrollTop === "number";
}

/**
 * El `chatContainer` de la sesión: el tercer hijo del documento que Pi monta
 * (encabezado, recursos cargados y conversación, en ese orden).
 */
export function findSessionChatContainer(tui: TUI | undefined): Container | undefined {
	if (!tui) return undefined;
	const host = tui as SessionViewHost;
	const document = asContainer(tui.children[0]);
	if (!document) return undefined;
	if (host.mode === "fullscreen" && !transcriptMounts(document, host)) return undefined;
	// Exactamente tres: si Pi añade o reordena contenedores, no se adivina cuál es el chat.
	if (document.children.length !== 3) return undefined;
	return asContainer(document.children[2]);
}

/**
 * Vacía la vista de la conversación y devuelve cuántos componentes ocultó, o
 * undefined cuando la vista no se pudo localizar (nada se toca en ese caso).
 */
export function clearSessionView(tui: TUI | undefined): number | undefined {
	const chat = findSessionChatContainer(tui);
	if (!chat || !tui) return undefined;
	const hidden = chat.children.length;
	chat.clear();
	chat.invalidate?.();
	tui.requestRender();
	return hidden;
}

/** El comando completo: comprueba el host, espera el turno y avisa en español. */
export function runSessionViewClear(tui: TUI | undefined, host: SessionViewClearHost): number | undefined {
	if (!tui) {
		host.notify("Esta consola no tiene una vista de conversación que limpiar.", "warning");
		return undefined;
	}
	if (!host.isIdle()) {
		host.notify("Espera a que el turno termine para limpiar la pantalla.", "warning");
		return undefined;
	}
	const hidden = clearSessionView(tui);
	if (hidden === undefined) {
		host.notify("No se pudo localizar la vista de la conversación en esta versión de Pi; no se cambió nada.", "warning");
		return undefined;
	}
	host.notify(SESSION_VIEW_CLEAR_NOTICE, "info");
	return hidden;
}
