/**
 * Effort (CONTEXT.md: Effort) in the Console: how hard the harness thinks on
 * an Attempt, in that harness's own words. The engine passes the value
 * through verbatim and never checks it, so every effort input is free text;
 * the words each harness is known to take are offered as suggestions only,
 * and a harness with none known offers none.
 */

import { h } from "./dom";
import type { AssignmentView } from "./project";

/** The words each harness is known to take (its own flag's help). */
export const KNOWN_EFFORTS: Readonly<Record<string, readonly string[]>> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  opencode: ["minimal", "low", "medium", "high", "max"],
};

export function knownEfforts(harness: string | null | undefined): readonly string[] {
  return (harness && KNOWN_EFFORTS[harness.trim()]) || [];
}

/**
 * An Assignment's effort as the card and the Detail read it: absent when
 * none is set (the harness runs on its own default), and marked when the
 * harness cannot take it in the mode it launches in.
 */
export function effortText(assignment: AssignmentView): string | null {
  const value = effortValue(assignment);
  return value === null ? null : `effort ${value}`;
}

/** The same, without the label: for a surface that labels the field itself. */
export function effortValue(assignment: AssignmentView): string | null {
  if (!assignment.effort) return null;
  return assignment.effortApplied === false
    ? `${assignment.effort} (not applied)`
    : assignment.effort;
}

export const EFFORT_NOT_APPLIED_TITLE =
  "this harness cannot take an effort in the mode it launches in, so it runs on its own default";

/**
 * A free-text effort input with a datalist of the words `harness` is known
 * to take. The wrapper is `display: contents`, so the input lays out
 * exactly where a bare one would.
 */
export function effortInput(options: {
  key: string;
  harness: string | null | undefined;
  value: string;
  placeholder?: string | null;
  class?: string;
  disabled?: boolean;
  onInput: (value: string) => void;
}): HTMLElement {
  const known = knownEfforts(options.harness);
  const listId = `${options.key}-efforts`;
  return h(
    "span",
    { class: "effort-control", key: `${options.key}-wrap` },
    h("input", {
      class: options.class ?? "settings-input",
      key: options.key,
      type: "text",
      list: known.length > 0 ? listId : null,
      value: options.value,
      placeholder: options.placeholder ?? null,
      disabled: options.disabled ?? null,
      oninput: (event: Event) =>
        options.onInput((event.currentTarget as HTMLInputElement).value),
    }),
    known.length > 0
      ? h(
          "datalist",
          { id: listId, key: listId },
          ...known.map((word) => h("option", { value: word, key: word })),
        )
      : null,
  );
}
