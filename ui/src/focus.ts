/**
 * Focus rescue across the full-DOM rebuild. Every render replaces the page
 * from scratch, and two client-side timers (the Vitals poll and the terminal
 * peek poll) render on their own cadence, so a field the operator is typing
 * into is torn down every couple of seconds. Its text survives (drafts live
 * in the stores), but focus and caret do not. Any field that should survive
 * carries a stable `data-focus-key`; the view captures the active element's
 * key and selection before the swap and puts them back on the rebuilt
 * element after it. One mechanism for every field: the Detail and tray
 * notes, the New Conversation form, the Enlist form.
 *
 * The functions take the narrowest slice of the DOM they touch, so they run
 * under bun's DOM-less tests against hand-built fakes.
 */

/** The attribute a rebuild-surviving field carries; its value is the key. */
export const FOCUS_KEY_ATTR = "data-focus-key";

/** The active field's identity and selection, captured before a rebuild. */
export interface FocusCapture {
  key: string;
  /** The selection range; null for a control without one (a checkbox). */
  start: number | null;
  end: number | null;
}

/** The slice of an element the capture reads. */
export interface FocusableLike {
  getAttribute(name: string): string | null;
  selectionStart?: number | null;
  selectionEnd?: number | null;
}

/** The slice of a rebuilt field the restore writes. */
export interface RestorableLike extends FocusableLike {
  focus(): void;
  value?: string;
  setSelectionRange?(start: number, end: number): void;
}

export interface DocumentLike {
  activeElement: FocusableLike | null;
}

export interface RootLike {
  querySelector(selector: string): RestorableLike | null;
}

/**
 * Capture the active element's focus key and selection, or null when the
 * focus sits on nothing keyed (the body, a button, the canvas).
 */
export function captureFocus(doc: DocumentLike): FocusCapture | null {
  const active = doc.activeElement;
  const key = active?.getAttribute(FOCUS_KEY_ATTR);
  if (!active || !key) return null;
  // A text control always reports a selection; a checkbox reports null on
  // both ends and gets its focus back without one.
  const start = active.selectionStart;
  const end = active.selectionEnd;
  return {
    key,
    start: typeof start === "number" ? start : null,
    end: typeof end === "number" ? end : null,
  };
}

/**
 * Put a captured focus back on the freshly rebuilt element carrying the same
 * key, clamping the selection to the rebuilt value (the draft may have been
 * trimmed between capture and restore). A key with no element (the form
 * closed, the interrupt resolved) is a no-op.
 */
export function restoreFocus(root: RootLike, focus: FocusCapture | null): void {
  if (!focus) return;
  const next = root.querySelector(focusKeySelector(focus.key));
  if (!next) return;
  next.focus();
  if (focus.start === null || focus.end === null || !next.setSelectionRange) return;
  const length = next.value?.length ?? 0;
  next.setSelectionRange(Math.min(focus.start, length), Math.min(focus.end, length));
}

/** The attribute selector for a key, quoted for use in querySelector. */
export function focusKeySelector(key: string): string {
  return `[${FOCUS_KEY_ATTR}="${key.replace(/["\\]/g, "\\$&")}"]`;
}
