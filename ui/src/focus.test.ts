/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import {
  FOCUS_KEY_ATTR,
  captureFocus,
  focusKeySelector,
  restoreFocus,
  type FocusableLike,
  type RestorableLike,
} from "./focus";

// bun's tests have no DOM, so the capture and restore run against the
// smallest fakes that satisfy their slices: an element with attributes and a
// selection, and a root that finds one by the key selector.

interface FakeField extends RestorableLike {
  focused: number;
  selection: [number, number] | null;
}

function field(
  key: string | null,
  options: { value?: string; selection?: [number, number] | null } = {},
): FakeField {
  const selection: [number, number] | null =
    options.selection === undefined ? [0, 0] : options.selection;
  const el: FakeField = {
    focused: 0,
    selection,
    value: options.value ?? "",
    getAttribute: (name) => (name === FOCUS_KEY_ATTR ? key : null),
    focus: () => {
      el.focused += 1;
    },
    setSelectionRange: (start, end) => {
      el.selection = [start, end];
    },
  };
  // A text control reports its caret; a checkbox reports null on both ends.
  Object.defineProperty(el, "selectionStart", { get: () => el.selection?.[0] ?? null });
  Object.defineProperty(el, "selectionEnd", { get: () => el.selection?.[1] ?? null });
  return el;
}

function root(...fields: FakeField[]) {
  return {
    querySelector: (selector: string) =>
      fields.find((f) => focusKeySelector(f.getAttribute(FOCUS_KEY_ATTR) ?? "") === selector) ??
      null,
  };
}

describe("captureFocus", () => {
  it("captures a keyed field's key and caret", () => {
    const active = field("conversation-form:title", { value: "roadmap", selection: [3, 5] });
    expect(captureFocus({ activeElement: active })).toEqual({
      key: "conversation-form:title",
      start: 3,
      end: 5,
    });
  });

  it("returns null when nothing is focused or the element carries no key", () => {
    expect(captureFocus({ activeElement: null })).toBeNull();
    expect(captureFocus({ activeElement: field(null) })).toBeNull();
    expect(captureFocus({ activeElement: field("") })).toBeNull();
    const button: FocusableLike = { getAttribute: () => null };
    expect(captureFocus({ activeElement: button })).toBeNull();
  });

  it("captures a checkbox's key with no selection", () => {
    const box = field("enlist-form:block:01", { selection: null });
    expect(captureFocus({ activeElement: box })).toEqual({
      key: "enlist-form:block:01",
      start: null,
      end: null,
    });
  });
});

describe("restoreFocus", () => {
  it("focuses the rebuilt element with the same key and puts the caret back", () => {
    const stale = field("conversation-form:title", { value: "roadmap", selection: [3, 5] });
    const capture = captureFocus({ activeElement: stale });
    const rebuilt = field("conversation-form:title", { value: "roadmap" });
    const other = field("conversation-form:opening", { value: "" });
    restoreFocus(root(other, rebuilt), capture);
    expect(rebuilt.focused).toBe(1);
    expect(rebuilt.selection).toEqual([3, 5]);
    expect(other.focused).toBe(0);
  });

  it("clamps the caret to the rebuilt value's length", () => {
    const rebuilt = field("01:detail", { value: "abc" });
    restoreFocus(root(rebuilt), { key: "01:detail", start: 7, end: 9 });
    expect(rebuilt.selection).toEqual([3, 3]);
  });

  it("focuses a checkbox without touching a selection", () => {
    const box = field("enlist-form:block:01", { selection: null });
    restoreFocus(root(box), { key: "enlist-form:block:01", start: null, end: null });
    expect(box.focused).toBe(1);
    expect(box.selection).toBeNull();
  });

  it("is a no-op with nothing captured or when the key left the page", () => {
    const rebuilt = field("conversation-form:title");
    restoreFocus(root(rebuilt), null);
    restoreFocus(root(rebuilt), { key: "gone:tray", start: 0, end: 0 });
    expect(rebuilt.focused).toBe(0);
  });
});

describe("focusKeySelector", () => {
  it("quotes the key as an attribute selector", () => {
    expect(focusKeySelector("01:tray")).toBe('[data-focus-key="01:tray"]');
  });

  it("escapes quotes and backslashes inside the key", () => {
    expect(focusKeySelector('a"b\\c')).toBe('[data-focus-key="a\\"b\\\\c"]');
  });
});
