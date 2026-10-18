/**
 * The Plans view's inspector: the fields of the selected node or edge, or
 * of the Plan itself when nothing is selected. A pure render; every control
 * yields one change for the store's edit pipeline. A change is a function
 * of the node, meta or cap as the pipeline will send it, not of what this
 * render saw, so two changes to one node in one batch both land. Text
 * fields show the store's buffer while they are typed in and commit on
 * `change` (blur or Enter) as one edit.
 */

import type {
  PlanAssign,
  PlanEditFile,
  PlanFile,
  PlanLoopCap,
  PlanNodeFile,
} from "../../protocol/wire.ts";
import { h } from "./dom";
import { knownEfforts } from "./effort";
import type { PlanSelection } from "./plan-canvas";
import { KIND_LABEL, edgeKeyText, type EdgeKey, type PlanDrawing } from "./plan-projection";

export type PlanMeta = Omit<Extract<PlanEditFile, { edit: "setMeta" }>, "edit">;

/** One change the operator made, turned into a wire edit when its batch is sent. */
export type PlanChange =
  | { kind: "edit"; edit: PlanEditFile }
  | { kind: "node"; id: string; change: (node: PlanNodeFile) => PlanNodeFile }
  | { kind: "meta"; change: (meta: PlanMeta) => PlanMeta }
  | { kind: "cap"; key: EdgeKey; change: (cap: PlanLoopCap | undefined) => PlanLoopCap | undefined };

export interface InspectorModel {
  plan: PlanFile;
  drawing: PlanDrawing;
  selection: PlanSelection;
  /** The text a field shows: what is being typed into it, else the document's. */
  text(key: string, fromDoc: string): string;
}

export interface InspectorIntents {
  change(change: PlanChange): void;
  select(selection: PlanSelection): void;
  type(key: string, text: string): void;
  /** A text field's change; a null change is text that makes no edit (a cap of "x"). */
  commit(key: string, text: string, fromDoc: string, change: PlanChange | null): void;
  blur(key: string): void;
}

/** The harnesses the Assignment's quick picks offer; blank is the pool default. */
const HARNESSES = ["claude", "codex", "cursor", "opencode"] as const;

/** A copy of `of` with `field` set, or removed when `value` is undefined or blank. */
export function withField<T extends object>(of: T, field: string, value: unknown): T {
  const next: Record<string, unknown> = { ...(of as Record<string, unknown>) };
  if (value === undefined || value === "") delete next[field];
  else next[field] = value;
  return next as T;
}

function withAssign(assign: PlanAssign | undefined, field: keyof PlanAssign, value: string): PlanAssign | undefined {
  const next = withField(assign ?? {}, field, value.trim());
  return Object.keys(next).length ? next : undefined;
}

const nodeChange = (id: string, change: (node: PlanNodeFile) => PlanNodeFile): PlanChange => ({
  kind: "node",
  id,
  change,
});

export function renderInspector(model: InspectorModel, on: InspectorIntents): HTMLElement {
  const sel = model.selection;
  const node = sel?.kind === "node" ? model.plan.nodes.find((n) => n.id === sel.id) : undefined;
  const edge =
    sel?.kind === "edge"
      ? model.drawing.edges.find((e) => edgeKeyText(e.edge) === edgeKeyText(sel.key))
      : undefined;
  const body = node
    ? renderNode(model, on, node)
    : edge
      ? renderEdge(model, on, edge.edge, edge.problems)
      : renderMeta(model, on);
  return h("div", { class: "plan-inspector", key: "plan-inspector" }, ...body);
}

// ---------------------------------------------------------------------------
// The Plan
// ---------------------------------------------------------------------------

function renderMeta(model: InspectorModel, on: InspectorIntents): HTMLElement[] {
  const plan = model.plan;
  const meta = (field: keyof PlanMeta, label: string, area = false) =>
    textField(model, on, `plan:${field}`, label, String(plan[field] ?? ""), area, (text) => ({
      kind: "meta",
      change: (m) => withField(m, field, field === "name" ? text : text.trim()),
    }));
  return [
    heading("Plan", null),
    meta("name", "name"),
    meta("author", "author"),
    meta("source", "source"),
    meta("note", "note", true),
    checkField("plan:stewardEdits", "the Steward may edit a Line running this Plan", plan.stewardEdits === true, (value) =>
      on.change({ kind: "meta", change: (m) => withField(m, "stewardEdits", value || undefined) }),
    ),
    h("div", { class: "plan-help" }, "Select a node or a link's label to set it up. Drag a verdict port onto a node to link them."),
  ];
}

// ---------------------------------------------------------------------------
// A node
// ---------------------------------------------------------------------------

function renderNode(model: InspectorModel, on: InspectorIntents, node: PlanNodeFile): (HTMLElement | null)[] {
  const id = node.id;
  const drawn = model.drawing.nodes.find((n) => n.node.id === id);
  const set = (field: string, value: unknown) =>
    on.change(nodeChange(id, (n) => withField(n, field, value)));
  const text = (field: string, label: string, fromDoc: string, area = false) =>
    textField(model, on, `node:${id}:${field}`, label, fromDoc, area, (value) =>
      nodeChange(id, (n) => withField(n, field, field === "title" ? value : value.trim())),
    );
  const assignOf = (assign: PlanAssign | undefined) =>
    assignFields(model, on, `node:${id}:assign`, assign, (f) =>
      nodeChange(id, (n) => withField(n, "assign", f((n as { assign?: PlanAssign }).assign))),
    );
  const out: (HTMLElement | null)[] = [
    heading(`${KIND_LABEL[node.kind]} · ${id}`, null),
    problemList(drawn?.problems ?? []),
    text("title", "title", node.title),
  ];
  switch (node.kind) {
    case "conversation":
      out.push(text("skill", "skill", node.skill ?? ""), ...assignOf(node.assign), text("note", "note", node.note ?? "", true));
      break;
    case "agent":
    case "prove":
    case "review":
    case "decide":
      out.push(
        text("skill", "skill", node.skill ?? ""),
        ...assignOf(node.assign),
        copiesField(model, on, node.id, node.copies),
        checkField(`node:${id}:makesItems`, "taught to return items in its Outcome", node.makesItems === true, (value) =>
          set("makesItems", value || undefined),
        ),
        segField(`node:${id}:checkpoint`, "a checkpoint is answered by", node.checkpoint ?? "operator", ["operator", "steward"], (value) =>
          set("checkpoint", value),
        ),
        segField(`node:${id}:spawns`, "spawns its Tickets propose", node.spawns ?? "hold", ["hold", "land"], (value) =>
          set("spawns", value),
        ),
        text("note", "note on every Ticket body", node.note ?? "", true),
      );
      break;
    case "merger": {
      const resolver = node.conflict && node.conflict !== "wait" ? node.conflict.resolver : null;
      out.push(
        h("div", { class: "plan-help" }, `Folds the copies of ${node.of} through the Merge queue once every copy is done.`),
        segField(`node:${id}:conflict`, "on a merge conflict", resolver ? "resolver" : "wait", ["wait", "resolver"], (value) =>
          set("conflict", value === "wait" ? "wait" : { resolver: {} }),
        ),
      );
      if (resolver) {
        out.push(
          ...assignFields(model, on, `node:${id}:resolver`, resolver, (f) =>
            nodeChange(id, (n) => {
              const conflict = (n as { conflict?: unknown }).conflict;
              const current = conflict && typeof conflict === "object" ? (conflict as { resolver: PlanAssign }).resolver : undefined;
              return withField(n, "conflict", { resolver: f(current) ?? {} });
            }),
          ),
        );
      }
      break;
    }
    case "gate":
      out.push(
        segField(`node:${id}:open`, "who opens it", node.open ?? "operator", ["operator", "steward", "auto"], (value) =>
          set("open", value),
        ),
        segField(`node:${id}:join`, "opens on a handoff from", node.join ?? "any", ["any", "all"], (value) =>
          set("join", value),
        ),
      );
      break;
    case "finish": {
      const act = node.act ?? "none";
      const other = typeof act === "object";
      out.push(
        segField(
          `node:${id}:act`,
          "once approved, it",
          other ? "other" : act,
          ["none", "draft-pr", "pr", "fast-forward", "other"],
          (value) => set("act", value === "other" ? { other: "" } : value),
        ),
      );
      if (other) {
        out.push(
          textField(model, on, `node:${id}:act-other`, "the act, in words", act.other, true, (value) =>
            nodeChange(id, (n) => withField(n, "act", { other: value.trim() })),
          ),
        );
      }
      out.push(...assignOf(node.assign));
      break;
    }
  }
  if (drawn && drawn.ports.length) out.push(...linksSection(model, on, node, drawn.ports.map((p) => p.on)));
  out.push(
    h(
      "div",
      { class: "plan-inspector-foot" },
      h(
        "button",
        {
          class: "btn btn-danger plan-remove-node",
          type: "button",
          onclick: () => on.change({ kind: "edit", edit: { edit: "removeNode", id } }),
        },
        "Remove node",
      ),
    ),
  );
  return out;
}

function copiesField(
  model: InspectorModel,
  on: InspectorIntents,
  id: string,
  copies: "one" | { perItem: number | "all" } | undefined,
): HTMLElement {
  const perItem = copies && copies !== "one" ? copies.perItem : null;
  const set = (value: unknown) => on.change(nodeChange(id, (n) => withField(n, "copies", value)));
  return h(
    "div",
    { class: "plan-field", key: `node:${id}:copies` },
    h("span", { class: "plan-field-label" }, "copies"),
    h(
      "div",
      { class: "plan-row" },
      seg(`node:${id}:copies-mode`, perItem === null ? "one" : "per item", ["one", "per item"], (value) =>
        set(value === "one" ? "one" : { perItem: 2 }),
      ),
      perItem !== null
        ? numberInput(model, on, `node:${id}:perItem`, perItem === "all" ? "" : String(perItem), "cap", (text) =>
            /^\d+$/.test(text) ? nodeChange(id, (n) => withField(n, "copies", { perItem: Number(text) })) : null,
          )
        : null,
      perItem !== null
        ? h(
            "button",
            {
              class: "plan-pick" + (perItem === "all" ? " plan-pick-on" : ""),
              type: "button",
              onclick: () => set({ perItem: "all" }),
            },
            "all",
          )
        : null,
    ),
    h(
      "span",
      { class: "plan-help" },
      perItem === null
        ? "One copy, whatever it is handed."
        : perItem === "all"
          ? "One copy per item, all at once; a Merger folds them."
          : `One copy per item, at most ${perItem} at once; a Merger folds them.`,
    ),
  );
}

function linksSection(model: InspectorModel, on: InspectorIntents, node: PlanNodeFile, verdicts: string[]): HTMLElement[] {
  const outs = model.plan.edges.filter((e) => e.from === node.id);
  const titleOf = (id: string) => model.plan.nodes.find((n) => n.id === id)?.title ?? id;
  const targets = model.plan.nodes.map((n) => n.id);
  const optionsKey = `${verdicts.join("|")}/${targets.join("|")}`;
  return [
    heading("Links", "what comes next"),
    h(
      "div",
      { class: "plan-links" },
      ...(outs.length
        ? outs.map((edge) => {
            const key: EdgeKey = { from: edge.from, on: edge.on, to: edge.to };
            return h(
              "div",
              { class: "plan-link-row", key: `link:${edgeKeyText(edge)}` },
              h(
                "span",
                { class: "plan-link-text" },
                "says ",
                h("b", {}, edge.on),
                ` → ${titleOf(edge.to)}`,
                edge.cap ? h("span", { class: "dim" }, ` · cap ${edge.cap.max}`) : null,
              ),
              h(
                "span",
                { class: "plan-link-actions" },
                h("button", { class: "btn", type: "button", onclick: () => on.select({ kind: "edge", key }) }, "Edit"),
                h(
                  "button",
                  {
                    class: "btn",
                    type: "button",
                    title: "remove this link",
                    onclick: () => on.change({ kind: "edit", edit: { edit: "unlink", ...key } }),
                  },
                  "✕",
                ),
              ),
            );
          })
        : [h("span", { class: "plan-help" }, "Nothing follows yet.")]),
      h(
        "div",
        { class: "plan-link-add", key: `link-add:${optionsKey}` },
        h("span", { class: "dim" }, "when it says"),
        h(
          "select",
          { class: "plan-input plan-link-on" },
          ...verdicts.map((v) => h("option", { value: v }, v)),
        ),
        h("span", { class: "dim" }, "go to"),
        h(
          "select",
          { class: "plan-input plan-link-to" },
          ...targets.map((id) => h("option", { value: id }, `${titleOf(id)} (${id})`)),
        ),
        h(
          "button",
          {
            class: "btn btn-primary plan-link-make",
            type: "button",
            onclick: (event: Event) => {
              const row = (event.currentTarget as HTMLElement).parentElement;
              const verdict = row?.querySelector<HTMLSelectElement>(".plan-link-on")?.value;
              const to = row?.querySelector<HTMLSelectElement>(".plan-link-to")?.value;
              if (verdict && to) on.change({ kind: "edit", edit: { edit: "link", edge: { from: node.id, on: verdict, to } } });
            },
          },
          "Link",
        ),
      ),
    ),
  ];
}

// ---------------------------------------------------------------------------
// An edge
// ---------------------------------------------------------------------------

function renderEdge(
  model: InspectorModel,
  on: InspectorIntents,
  edge: PlanFile["edges"][number],
  problems: string[],
): (HTMLElement | null)[] {
  const key: EdgeKey = { from: edge.from, on: edge.on, to: edge.to };
  const k = `edge:${edgeKeyText(key)}`;
  const cap = edge.cap;
  const capChange = (change: (cap: PlanLoopCap | undefined) => PlanLoopCap | undefined): PlanChange => ({
    kind: "cap",
    key,
    change,
  });
  const targets = model.plan.nodes.map((n) => n.id);
  const whenSpent = !cap?.whenSpent || cap.whenSpent === "hold" ? "hold" : cap.whenSpent.to;
  return [
    heading("Link", null),
    h("div", { class: "plan-edge-says" }, h("b", {}, edge.from), " says ", h("b", {}, edge.on), " → ", h("b", {}, edge.to)),
    problemList(problems),
    h(
      "div",
      { class: "plan-field", key: `${k}:max` },
      h("span", { class: "plan-field-label" }, "passes allowed (blank: no cap)"),
      numberInput(model, on, `${k}:max`, cap ? String(cap.max) : "", "no cap", (text) =>
        text === ""
          ? capChange(() => undefined)
          : /^\d+$/.test(text)
            ? capChange((c) => ({ ...c, max: Number(text) }))
            : null,
      ),
      h("span", { class: "plan-help" }, "A link that loops back keeps a cap; once it is spent the Line asks before going round again."),
    ),
    checkField(`${k}:stewardExtra`, "the Steward may buy one more pass", cap?.stewardExtra === true, (value) =>
      on.change(capChange((c) => (c ? withField(c, "stewardExtra", value || undefined) : c))),
      !cap,
    ),
    h(
      "label",
      { class: "plan-field", key: `${k}:whenSpent` },
      h("span", { class: "plan-field-label" }, "when the cap is spent"),
      h(
        "select",
        {
          class: "plan-input",
          key: `${k}:whenSpent:${targets.join("|")}`,
          value: whenSpent,
          disabled: cap ? null : true,
          onchange: (event: Event) => {
            const value = (event.currentTarget as HTMLSelectElement).value;
            on.change(capChange((c) => (c ? withField(c, "whenSpent", value === "hold" ? "hold" : { to: value }) : c)));
          },
        },
        h("option", { value: "hold" }, "hold for the operator"),
        ...targets.map((id) => h("option", { value: id }, `hand on to ${id}`)),
      ),
    ),
    h(
      "div",
      { class: "plan-inspector-foot" },
      h(
        "button",
        {
          class: "btn btn-danger plan-unlink",
          type: "button",
          onclick: () => on.change({ kind: "edit", edit: { edit: "unlink", ...key } }),
        },
        "Remove link",
      ),
    ),
  ];
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

function heading(text: string, sub: string | null): HTMLElement {
  return h("div", { class: "plan-inspector-head" }, text, sub ? h("span", { class: "dim" }, ` ${sub}`) : null);
}

function problemList(problems: string[]): HTMLElement | null {
  if (!problems.length) return null;
  return h("div", { class: "plan-problems" }, ...problems.map((p) => h("div", { class: "plan-problem" }, p)));
}

/** A text field on the store's buffer: input types, change commits, blur forgets an untouched buffer. */
function textInput(
  model: InspectorModel,
  on: InspectorIntents,
  key: string,
  fromDoc: string,
  area: boolean,
  toChange: (text: string) => PlanChange | null,
  attrs: Record<string, unknown> = {},
): HTMLElement {
  return h(area ? "textarea" : "input", {
    class: "plan-input" + (area ? " plan-area" : ""),
    key: `input:${key}`,
    type: area ? null : "text",
    value: model.text(key, fromDoc),
    oninput: (event: Event) => on.type(key, (event.currentTarget as HTMLInputElement).value),
    onchange: (event: Event) => {
      const text = (event.currentTarget as HTMLInputElement).value;
      on.commit(key, text, fromDoc, toChange(text));
    },
    onblur: () => on.blur(key),
    ...attrs,
  });
}

function textField(
  model: InspectorModel,
  on: InspectorIntents,
  key: string,
  label: string,
  fromDoc: string,
  area: boolean,
  toChange: (text: string) => PlanChange | null,
): HTMLElement {
  return h(
    "label",
    { class: "plan-field", key },
    h("span", { class: "plan-field-label" }, label),
    textInput(model, on, key, fromDoc, area, toChange),
  );
}

function numberInput(
  model: InspectorModel,
  on: InspectorIntents,
  key: string,
  fromDoc: string,
  placeholder: string,
  toChange: (text: string) => PlanChange | null,
): HTMLElement {
  return textInput(model, on, key, fromDoc, false, (text) => toChange(text.trim()), {
    class: "plan-input plan-number",
    inputmode: "numeric",
    placeholder,
  });
}

function assignFields(
  model: InspectorModel,
  on: InspectorIntents,
  key: string,
  assign: PlanAssign | undefined,
  set: (change: (assign: PlanAssign | undefined) => PlanAssign | undefined) => PlanChange,
): HTMLElement[] {
  const text = (field: keyof PlanAssign) => (value: string) => set((a) => withAssign(a, field, value));
  const harness = assign?.harness ?? "";
  const efforts = knownEfforts(harness);
  const listId = `${key}:efforts`;
  return [
    h(
      "div",
      { class: "plan-field", key: `${key}:harness` },
      h("span", { class: "plan-field-label" }, "harness"),
      textInput(model, on, `${key}:harness`, harness, false, text("harness"), { placeholder: "pool default" }),
      h(
        "div",
        { class: "plan-picks" },
        ...["", ...HARNESSES].map((name) =>
          h(
            "button",
            {
              class: "plan-pick" + (name === harness ? " plan-pick-on" : ""),
              type: "button",
              key: name || "default",
              onclick: () => on.change(set((a) => withAssign(a, "harness", name))),
            },
            name || "pool default",
          ),
        ),
      ),
    ),
    h(
      "label",
      { class: "plan-field", key: `${key}:model` },
      h("span", { class: "plan-field-label" }, "model"),
      textInput(model, on, `${key}:model`, assign?.model ?? "", false, text("model"), { placeholder: "pool default" }),
    ),
    h(
      "label",
      { class: "plan-field", key: `${key}:effort` },
      h("span", { class: "plan-field-label" }, "effort"),
      textInput(model, on, `${key}:effort`, assign?.effort ?? "", false, text("effort"), {
        placeholder: "harness default",
        list: efforts.length ? listId : null,
      }),
      efforts.length
        ? h("datalist", { id: listId, key: listId }, ...efforts.map((word) => h("option", { value: word, key: word })))
        : null,
    ),
  ];
}

function seg(key: string, value: string, choices: readonly string[], onPick: (value: string) => void): HTMLElement {
  return h(
    "div",
    { class: "plan-seg", key },
    ...choices.map((choice) =>
      h(
        "button",
        {
          class: "plan-seg-btn" + (choice === value ? " plan-seg-on" : ""),
          type: "button",
          key: choice,
          onclick: () => {
            if (choice !== value) onPick(choice);
          },
        },
        choice,
      ),
    ),
  );
}

function segField(
  key: string,
  label: string,
  value: string,
  choices: readonly string[],
  onPick: (value: string) => void,
): HTMLElement {
  return h(
    "div",
    { class: "plan-field", key },
    h("span", { class: "plan-field-label" }, label),
    seg(`${key}:seg`, value, choices, onPick),
  );
}

function checkField(
  key: string,
  label: string,
  checked: boolean,
  onSet: (value: boolean) => void,
  disabled = false,
): HTMLElement {
  return h(
    "label",
    { class: "plan-check", key },
    h("input", {
      type: "checkbox",
      checked,
      disabled: disabled ? true : null,
      onchange: (event: Event) => onSet((event.currentTarget as HTMLInputElement).checked),
    }),
    label,
  );
}
