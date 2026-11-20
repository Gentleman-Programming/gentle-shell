// The status line and the toast.

const TOAST_MS = 5000;

export function init(ctx) {
	const { win, els, store } = ctx;
	const { state } = store;

	function setStatus(text, isError) {
		els.status.textContent = text;
		els.status.classList.toggle("gd-error", Boolean(isError));
	}

	/** A confirmation that stays on screen for a few seconds, beyond the status line. */
	function showToast(text, isError) {
		win.clearTimeout(state.toastTimer);
		els.toast.textContent = text;
		els.toast.classList.toggle("gd-error", Boolean(isError));
		els.toast.hidden = false;
		store.setToastTimer(win.setTimeout(() => { els.toast.hidden = true; }, TOAST_MS));
	}

	return { setStatus, showToast };
}
