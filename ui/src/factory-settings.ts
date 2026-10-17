/**
 * The Factory settings (issue #187, ADR-0037) as the Settings pane edits
 * them: one flat draft per layer (the Machine defaults' and the Pool
 * settings'), each field a string the way the pane's inputs hold it, and the
 * pure conversions to and from the `factory` block the engine reads. Every
 * field falls through on its own, so an empty field is "inherit", never a
 * value: the pool's falls to the machine's, the machine's to the built-in
 * settings, and a Line brief may still override either for its own Line.
 * Changes reach the next Station Ticket the engine writes, at the next
 * Tick (ADR-0040), never one already written.
 */

import type { FactorySettings, StationSettings } from "./project";

/** The Stations whose settings the pane edits, in the Line's order. */
export const FACTORY_STATIONS = ["implement", "prove", "review", "decide", "grill"] as const;
export type FactoryStation = (typeof FACTORY_STATIONS)[number];

/** Only Prove and Review can be switched off. */
export const SWITCHABLE_STATIONS = ["prove", "review"] as const;
type SwitchableStation = (typeof SWITCHABLE_STATIONS)[number];

const STATION_TEXT = ["drivers", "harness", "model", "effort", "note"] as const;
type StationText = (typeof STATION_TEXT)[number];

export type FactoryField =
  | `${FactoryStation}.${StationText}`
  | `${SwitchableStation}.enabled`
  | "proveFailsPerRound"
  | "extraRounds"
  | "finish";

/** One layer's draft. `<station>.enabled` is "" (inherit), "on" or "off". */
export type FactoryDraft = Record<FactoryField, string>;

/**
 * The built-in settings (crates/core/src/line.rs `default_factory`), shown as
 * the machine form's placeholders and under the pool form's where the
 * machine sets nothing.
 */
export const FACTORY_DEFAULTS: FactoryDraft = (() => {
  const draft = emptyDraft();
  const station = (key: FactoryStation, drivers: string, effort: string): void => {
    draft[`${key}.drivers`] = drivers;
    draft[`${key}.harness`] = "claude";
    draft[`${key}.model`] = "opus";
    draft[`${key}.effort`] = effort;
  };
  station("implement", "implement", "high");
  station("prove", "my-verify", "medium");
  station("review", "code-review", "high");
  station("decide", "html", "medium");
  station("grill", "my-grill-with-docs show-me", "high");
  draft["prove.enabled"] = "on";
  draft["review.enabled"] = "on";
  draft.proveFailsPerRound = "2";
  draft.extraRounds = "1";
  draft.finish = "none";
  return draft;
})();

function emptyDraft(): FactoryDraft {
  const draft = {} as FactoryDraft;
  for (const station of FACTORY_STATIONS) {
    for (const field of STATION_TEXT) draft[`${station}.${field}`] = "";
  }
  for (const station of SWITCHABLE_STATIONS) draft[`${station}.enabled`] = "";
  draft.proveFailsPerRound = "";
  draft.extraRounds = "";
  draft.finish = "";
  return draft;
}

/** The draft a layer seeds, every absent field empty. */
export function factoryDraftFrom(layer: FactorySettings | undefined): FactoryDraft {
  const draft = emptyDraft();
  for (const key of FACTORY_STATIONS) {
    const station = layer?.stations?.[key];
    draft[`${key}.drivers`] = station?.drivers ?? "";
    draft[`${key}.harness`] = station?.assign?.harness ?? "";
    draft[`${key}.model`] = station?.assign?.model ?? "";
    draft[`${key}.effort`] = station?.assign?.effort ?? "";
    draft[`${key}.note`] = station?.note ?? "";
  }
  for (const key of SWITCHABLE_STATIONS) {
    const enabled = layer?.stations?.[key]?.enabled;
    draft[`${key}.enabled`] = enabled === true ? "on" : enabled === false ? "off" : "";
  }
  draft.proveFailsPerRound = numberField(layer?.limits?.proveFailsPerRound);
  draft.extraRounds = numberField(layer?.limits?.extraRounds);
  draft.finish = layer?.finish ?? "";
  return draft;
}

function numberField(value: number | undefined): string {
  return typeof value === "number" ? String(value) : "";
}

/**
 * The value in force under a layer: `below` (the layer underneath, already
 * merged) where `layer` leaves the field empty. The pool form's placeholders
 * are the machine's merged layer over the built-in settings.
 */
export function factoryUnder(layer: FactoryDraft, below: FactoryDraft): FactoryDraft {
  const merged = { ...below };
  for (const field of Object.keys(layer) as FactoryField[]) {
    if (layer[field].trim()) merged[field] = layer[field].trim();
  }
  return merged;
}

/** What is wrong with a layer's draft, or null: only the two limits have a
 *  shape the operator can get wrong here. */
export function validateFactoryDraft(draft: FactoryDraft): string | null {
  for (const [field, label] of [
    ["proveFailsPerRound", "Prove fails per Round"],
    ["extraRounds", "extra Rounds"],
  ] as const) {
    const value = draft[field].trim();
    if (value && !/^\d+$/.test(value)) {
      return `${label} must be a whole number of 0 or more, or empty to inherit`;
    }
  }
  return null;
}

/**
 * The layer a draft writes, every empty field left out, or null when the
 * draft sets nothing (the pool patch's null removes the key, and the machine
 * file leaves it out).
 */
export function factoryFrom(draft: FactoryDraft): FactorySettings | null {
  const text = (field: FactoryField): string | undefined => draft[field].trim() || undefined;
  const stations: NonNullable<FactorySettings["stations"]> = {};
  for (const key of FACTORY_STATIONS) {
    const assign = {
      ...(text(`${key}.harness`) ? { harness: text(`${key}.harness`) } : {}),
      ...(text(`${key}.model`) ? { model: text(`${key}.model`) } : {}),
      ...(text(`${key}.effort`) ? { effort: text(`${key}.effort`) } : {}),
    };
    const enabled =
      key === "prove" || key === "review" ? draft[`${key}.enabled`] : "";
    const station: StationSettings = {
      ...(enabled === "on" ? { enabled: true } : enabled === "off" ? { enabled: false } : {}),
      ...(text(`${key}.drivers`) ? { drivers: text(`${key}.drivers`) } : {}),
      ...(Object.keys(assign).length > 0 ? { assign } : {}),
      ...(text(`${key}.note`) ? { note: text(`${key}.note`) } : {}),
    };
    if (Object.keys(station).length > 0) stations[key] = station;
  }
  const limit = (field: "proveFailsPerRound" | "extraRounds"): number | undefined =>
    text(field) === undefined ? undefined : Number(text(field));
  const limits = {
    ...(limit("proveFailsPerRound") !== undefined
      ? { proveFailsPerRound: limit("proveFailsPerRound") }
      : {}),
    ...(limit("extraRounds") !== undefined ? { extraRounds: limit("extraRounds") } : {}),
  };
  const layer: FactorySettings = {
    ...(Object.keys(stations).length > 0 ? { stations } : {}),
    ...(Object.keys(limits).length > 0 ? { limits } : {}),
    ...(text("finish") ? { finish: text("finish") } : {}),
  };
  return Object.keys(layer).length > 0 ? layer : null;
}

/** Whether two drafts would write the same layer: text compares trimmed. */
export function sameFactoryDraft(a: FactoryDraft, b: FactoryDraft): boolean {
  return (Object.keys(a) as FactoryField[]).every((field) => a[field].trim() === b[field].trim());
}
