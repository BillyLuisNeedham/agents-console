/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import { Detail, type DetailHandlers, type DetailModel } from "./detail";
import { ReassignStore } from "./reassign";
import { commit } from "./morph";
import { DraftAnswers } from "./drafts";
import { useDom } from "./test-dom";
import type {
  EnrichedSnapshot,
  ReassignRequest,
  ReassignResponse,
  SettingsResponse,
  TicketDetailView,
} from "./project";

useDom();

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const SNAPSHOT = {
  seq: 1,
  phase: "running",
  poolName: "repo/pool",
  poolTitle: null,
  poolDir: "/tmp/pool",
  finishedTerminals: 0,
  spawnUsage: { spawnedThisRun: 0, perAttempt: 5, perRun: 20 },
  pendingSpawns: [],
  heldSpawns: [],
  state: {
    tickets: [],
    conversations: [],
    log: [],
    outcomes: {},
    interrupts: [],
    mergeQueue: [],
    queuedAnswers: [],
    config: {},
  },
} as EnrichedSnapshot;

function settings(): SettingsResponse {
  return {
    pool: {
      path: "/tmp/pool/console.json",
      config: {},
      bootOnly: [],
      effective: { port: 4300, terminal: null, stale: [] },
    },
    machine: { path: "/home/me/defaults.json", defaults: {}, own: {} },
    harnesses: ["claude", "opencode"],
  };
}

function detailView(overrides: Partial<TicketDetailView> = {}): TicketDetailView {
  return {
    kind: "ticket",
    ticketId: "A",
    title: "ticket A",
    status: "ready",
    mergeState: null,
    resolver: null,
    blockedBy: [],
    blockedByCheckpoint: [],
    outcome: null,
    interrupt: null,
    winner: null,
    assignment: { harness: "claude", model: "opus", drivers: "implement" },
    enlisted: false,
    hasLiveAttempt: false,
    stewardBudget: null,
    reassign: {
      eligible: true,
      reason: null,
      verify: null,
      sources: { harness: "default", model: "pinned", effort: "unset", drivers: "default" },
    },
    ...overrides,
  };
}

function model(detail: TicketDetailView): DetailModel {
  return {
    detail,
    timeline: null,
    logPane: null,
    detailTabs: [
      { id: "spec", label: "Spec", active: true, interruptDot: false },
      { id: "progress", label: "Progress", active: false, interruptDot: false },
      { id: "outcome", label: "Outcome", active: false, interruptDot: false },
    ],
    detailBody: null,
    detailBodyError: null,
  };
}

/** The Detail over a real store wired to hand-settled deferreds, painted the
 *  way the composition root paints it: build the tree and morph the page. */
function rig(detail: TicketDetailView) {
  const reads: Deferred<SettingsResponse>[] = [];
  const writes: { request: ReassignRequest; deferred: Deferred<ReassignResponse> }[] = [];
  const store = new ReassignStore({
    onGetSettings: () => {
      const d = deferred<SettingsResponse>();
      reads.push(d);
      return d.promise;
    },
    onReassign: (request) => {
      const d = deferred<ReassignResponse>();
      writes.push({ request, deferred: d });
      return d.promise;
    },
    onChange: () => {},
  });
  const pane = new Detail({ onClose: () => {}, drafts: new DraftAnswers() });
  const handlers: DetailHandlers = {
    onSelectAttempt: () => {},
    onSelectStream: () => {},
    onLoadEarlier: () => {},
    onAnswer: () => {},
    onKeepTalking: () => {},
    onUseStewardNote: () => {},
    onSelectTab: () => {},
    onEndConversation: () => {},
    onFocusConversationTerminal: () => Promise.resolve(true),
    onFocusResolver: () => Promise.resolve(true),
    renderSpawnDecision: () => document.createElement("div"),
    reassign: store,
  };
  const root = document.createElement("div");
  document.body.appendChild(root);
  let view = detail;
  const paint = (next: TicketDetailView = view) => {
    view = next;
    commit(root, () => {
      const shell = document.createElement("div");
      shell.className = "shell";
      shell.appendChild(pane.render(model(view), handlers));
      return shell;
    });
  };
  return { root, paint, store, reads, writes };
}

const save = (root: HTMLElement) =>
  root.querySelector<HTMLButtonElement>(".reassign-save");

describe("Detail: the Reassign section (issue #126)", () => {
  it("prefills each field from the Assignment in force, with its source pill", () => {
    const r = rig(detailView());
    r.paint();
    const section = r.root.querySelector('[data-key="reassign-section"]');
    expect(section).not.toBeNull();
    const model = r.root.querySelector<HTMLInputElement>(
      '[data-key="reassign-detail-model"]',
    );
    expect(model!.value).toBe("opus");
    const modelField = r.root.querySelector('[data-key="reassign-field-model"]');
    expect(modelField?.querySelector(".reassign-source")?.textContent).toBe("pinned");
    const harnessField = r.root.querySelector('[data-key="reassign-field-harness"]');
    expect(harnessField?.querySelector(".reassign-source")?.textContent).toBe("default");
  });

  it("offers clear only on a field this ticket pins", () => {
    const r = rig(detailView());
    r.paint();
    expect(
      r.root.querySelector('[data-key="reassign-field-model"] .reassign-clear'),
    ).not.toBeNull();
    expect(
      r.root.querySelector('[data-key="reassign-field-harness"] .reassign-clear'),
    ).toBeNull();
  });

  it("disables Save until the draft would write something", () => {
    const r = rig(detailView());
    r.paint();
    expect(save(r.root)!.disabled).toBe(true);
    r.store.setField("A", "model", "sonnet", {
      assignment: { harness: "claude", model: "opus", drivers: "implement" },
      verify: null,
    });
    r.paint();
    expect(save(r.root)!.disabled).toBe(false);
  });

  it("sends only the edited field for the one ticket", async () => {
    const r = rig(detailView());
    r.paint();
    const input = r.root.querySelector<HTMLInputElement>(
      '[data-key="reassign-detail-model"]',
    );
    input!.value = "sonnet";
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    r.paint();
    save(r.root)!.click();
    expect(r.writes[0]!.request).toEqual({
      tickets: ["A"],
      fields: { model: "sonnet" },
    });
    r.writes[0]!.deferred.resolve({ applied: ["A"], skipped: [], snapshot: SNAPSHOT });
    await r.writes[0]!.deferred.promise;
    await Promise.resolve();
  });

  it("edits effort with the harness's words offered, and sends it", () => {
    const r = rig(detailView());
    r.paint();
    const input = r.root.querySelector<HTMLInputElement>('[data-key="reassign-detail-effort"]')!;
    expect(input.placeholder).toBe("(harness default)");
    const list = r.root.querySelector(`#${input.getAttribute("list")}`)!;
    expect([...list.querySelectorAll("option")].map((o) => o.getAttribute("value"))).toContain(
      "xhigh",
    );
    input.value = "max";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    r.paint();
    save(r.root)!.click();
    expect(r.writes[0]!.request.fields).toEqual({ effort: "max" });
  });

  it("says plainly when the effort in force is not applied", () => {
    const r = rig(
      detailView({
        assignment: {
          harness: "cursor",
          model: "m",
          effort: "high",
          effortApplied: false,
          drivers: "implement",
        },
      }),
    );
    r.paint();
    expect(r.root.querySelector(".effort-unapplied-note")?.textContent).toContain(
      "effort high is not applied",
    );
    // cursor takes no effort at all, so nothing is suggested.
    const input = r.root.querySelector<HTMLInputElement>('[data-key="reassign-detail-effort"]')!;
    expect(input.getAttribute("list")).toBeNull();
  });

  it("clearing a pinned field empties it, so the write clears the entry", () => {
    const r = rig(detailView());
    r.paint();
    r.root
      .querySelector<HTMLButtonElement>('[data-key="reassign-field-model"] .reassign-clear')!
      .click();
    r.paint();
    expect(
      r.root.querySelector<HTMLInputElement>('[data-key="reassign-detail-model"]')!.value,
    ).toBe("");
    save(r.root)!.click();
    expect(r.writes[0]!.request.fields).toEqual({ model: null });
  });

  it("shows a refusal beside Save and keeps the draft", async () => {
    const r = rig(detailView());
    r.paint();
    r.store.setField("A", "model", "sonnet", {
      assignment: { harness: "claude", model: "opus", drivers: "implement" },
      verify: null,
    });
    const writing = r.store.save("A", {
      assignment: { harness: "claude", model: "opus", drivers: "implement" },
      verify: null,
    });
    r.writes[0]!.deferred.reject(new Error("A would end up unassigned"));
    await writing;
    r.paint();
    expect(r.root.querySelector(".reassign-failure")?.textContent).toBe(
      "A would end up unassigned",
    );
    expect(
      r.root.querySelector<HTMLInputElement>('[data-key="reassign-detail-model"]')!.value,
    ).toBe("sonnet");
  });

  it("keeps the input the operator is typing into across a re-render", () => {
    const r = rig(detailView());
    r.paint();
    const input = r.root.querySelector<HTMLInputElement>(
      '[data-key="reassign-detail-model"]',
    );
    input!.value = "half-typed";
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    r.paint();
    expect(
      r.root.querySelector<HTMLInputElement>('[data-key="reassign-detail-model"]'),
    ).toBe(input);
    expect(input!.value).toBe("half-typed");
  });

  it("selects the harness against the options the read brought", async () => {
    const r = rig(detailView());
    r.store.ensureHarnesses();
    r.reads[0]!.resolve(settings());
    await r.reads[0]!.promise;
    await Promise.resolve();
    r.paint();
    const select = r.root.querySelector<HTMLSelectElement>(".reassign-select");
    expect(select!.value).toBe("claude");
    expect(select!.options.length).toBe(3);
  });

  it("shows the ticket's own verify and marks it pinned", () => {
    const r = rig(
      detailView({
        reassign: {
          eligible: true,
          reason: null,
          verify: 3,
          sources: { harness: "default", model: "default", effort: "unset", drivers: "default" },
        },
      }),
    );
    r.paint();
    expect(
      r.root.querySelector<HTMLInputElement>('[data-key="reassign-detail-verify"]')!.value,
    ).toBe("3");
    expect(
      r.root.querySelector('[data-key="reassign-field-verify"] .reassign-source')
        ?.textContent,
    ).toBe("pinned");
  });

  it("notes the caveat on an eligible ticket without taking the form away", () => {
    const r = rig(
      detailView({
        enlisted: true,
        reassign: {
          eligible: true,
          reason: "enlisted: the write waits until the engine releases the pane",
          verify: null,
          sources: { harness: "default", model: "default", effort: "unset", drivers: "default" },
        },
      }),
    );
    r.paint();
    expect(save(r.root)).not.toBeNull();
    expect(r.root.querySelector(".reassign-note")?.textContent).toContain(
      "waits until the engine releases the pane",
    );
  });

  it("offers only the harness on an enlisted ticket, the rest read-only", () => {
    const r = rig(
      detailView({
        enlisted: true,
        reassign: {
          eligible: true,
          reason: null,
          verify: null,
          sources: { harness: "default", model: "inherited", effort: "unset", drivers: "inherited" },
        },
      }),
    );
    r.paint();
    expect(r.root.querySelector(".reassign-select")).not.toBeNull();
    expect(r.root.querySelector('[data-key="reassign-detail-model"]')).toBeNull();
    expect(r.root.querySelector('[data-key="reassign-detail-drivers"]')).toBeNull();
    expect(r.root.querySelector('[data-key="reassign-detail-verify"]')).toBeNull();
    const fixed = r.root.querySelector('[data-key="reassign-fixed"]');
    expect(fixed?.textContent).toContain("opus");
    expect(fixed?.querySelector(".reassign-source-inherited")?.textContent).toBe(
      "inherited",
    );
    expect(r.root.querySelector(".reassign-note")?.textContent).toContain(
      "only its harness can be reassigned",
    );
  });

  it("sends only the harness for an enlisted ticket", () => {
    const view = detailView({
      enlisted: true,
      reassign: {
        eligible: true,
        reason: null,
        verify: null,
        sources: { harness: "default", model: "inherited", effort: "unset", drivers: "inherited" },
      },
    });
    const r = rig(view);
    r.paint();
    const select = r.root.querySelector<HTMLSelectElement>(".reassign-select");
    // The option list carries the pinned value, so picking is a real change.
    select!.value = "";
    select!.dispatchEvent(new Event("change", { bubbles: true }));
    r.paint();
    save(r.root)!.click();
    expect(r.writes[0]!.request).toEqual({
      tickets: ["A"],
      fields: { harness: null },
    });
  });

  it("keys the harness select on the option list, so an unknown harness still shows", async () => {
    const r = rig(
      detailView({
        assignment: { harness: "retired-harness", model: "opus", drivers: "implement" },
      }),
    );
    r.paint();
    expect(r.root.querySelector<HTMLSelectElement>(".reassign-select")!.value).toBe(
      "retired-harness",
    );
    // The harness list lands, and the fallback option must stay with it.
    r.store.ensureHarnesses();
    r.reads[0]!.resolve(settings());
    await r.reads[0]!.promise;
    await Promise.resolve();
    r.paint();
    const select = r.root.querySelector<HTMLSelectElement>(".reassign-select");
    expect(select!.value).toBe("retired-harness");
    expect(select!.options.length).toBe(4);
  });

  it("renders the Assignment read-only with its reason when the ticket is not eligible", () => {
    const r = rig(
      detailView({
        status: "in-progress",
        hasLiveAttempt: true,
        reassign: {
          eligible: false,
          reason: "an Attempt is in flight; it keeps the Assignment it started on",
          verify: null,
          sources: { harness: "pinned", model: "inherited", effort: "unset", drivers: "default" },
        },
      }),
    );
    r.paint();
    expect(save(r.root)).toBeNull();
    expect(r.root.querySelector('[data-key="reassign-detail-model"]')).toBeNull();
    const readonly = r.root.querySelector(".reassign-readonly");
    expect(readonly?.textContent).toContain("opus");
    expect(readonly?.querySelector(".reassign-source-inherited")?.textContent).toBe(
      "inherited",
    );
    expect(r.root.querySelector(".reassign-reason")?.textContent).toBe(
      "an Attempt is in flight; it keeps the Assignment it started on",
    );
  });

  it("reads unassigned fields as unassigned in the read-only view", () => {
    const r = rig(
      detailView({
        assignment: { harness: null, model: null, drivers: "implement" },
        reassign: {
          eligible: false,
          reason: "a done ticket keeps the Assignment it ran on",
          verify: null,
          sources: { harness: "unset", model: "unset", effort: "unset", drivers: "default" },
        },
      }),
    );
    r.paint();
    expect(r.root.querySelector(".reassign-readonly")?.textContent).toContain(
      "unassigned",
    );
    // Effort is optional by nature: none reads as the harness's own default.
    expect(
      r.root.querySelector('[data-key="reassign-readonly-effort"]')?.textContent,
    ).toContain("(harness default)");
  });
});

describe("Detail: Keep talking (issue #139)", () => {
  // The Detail on its Progress tab, where the interrupt form renders, with
  // Keep talking's clicks and Resume's answers recorded.
  function paintInterrupt(interrupt: TicketDetailView["interrupt"]) {
    const keepTalks: string[] = [];
    const answers: string[] = [];
    const pane = new Detail({ onClose: () => {}, drafts: new DraftAnswers() });
    const handlers: DetailHandlers = {
      onSelectAttempt: () => {},
      onSelectStream: () => {},
      onLoadEarlier: () => {},
      onAnswer: (ticketId, action) => answers.push(`${ticketId}:${action}`),
      onKeepTalking: (ticketId) => keepTalks.push(ticketId),
      onUseStewardNote: () => {},
      onSelectTab: () => {},
      onEndConversation: () => {},
      onFocusConversationTerminal: () => Promise.resolve(true),
      onFocusResolver: () => Promise.resolve(true),
      renderSpawnDecision: () => document.createElement("div"),
      reassign: new ReassignStore({
        onGetSettings: () => new Promise(() => {}),
        onReassign: () => new Promise(() => {}),
        onChange: () => {},
      }),
    };
    const root = document.createElement("div");
    document.body.appendChild(root);
    commit(root, () => {
      const shell = document.createElement("div");
      shell.className = "shell";
      shell.appendChild(
        pane.render(
          {
            ...model(detailView({ status: "checkpoint", interrupt })),
            detailTabs: [
              { id: "spec", label: "Spec", active: false, interruptDot: true },
              { id: "progress", label: "Progress", active: true, interruptDot: true },
              { id: "outcome", label: "Outcome", active: false, interruptDot: true },
            ],
          },
          handlers,
        ),
      );
      return shell;
    });
    return { root, keepTalks, answers };
  }

  const checkpoint = (
    keepTalking: NonNullable<TicketDetailView["interrupt"]>["keepTalking"],
    kind: "checkpoint" | "merge-conflict" = "checkpoint",
  ): TicketDetailView["interrupt"] => ({
    ticketId: "A",
    kind,
    body: "the brief",
    form: {
      title: kind,
      actions: [{ action: "resume", label: "resume", tone: "primary" }],
    },
    queued: false,
    keepTalking,
  });

  const button = (root: HTMLElement) =>
    root.querySelector<HTMLButtonElement>(".interrupt-actions .keep-talking");

  it("sits beside Resume on a checkpoint with a Held pane, and calls the seam with the ticket", () => {
    const r = paintInterrupt(checkpoint({ requesting: false, failure: null }));
    const actions = [...r.root.querySelectorAll(".interrupt-actions button")].map(
      (b) => b.textContent,
    );
    expect(actions).toEqual(["resume", "Keep talking"]);
    expect(button(r.root)?.title).toContain("same terminal");
    button(r.root)!.click();
    expect(r.keepTalks).toEqual(["A"]);
    // Keep talking is not an answer: Resume's seam never fired.
    expect(r.answers).toEqual([]);
  });

  it("is absent when the interrupt does not offer it", () => {
    const r = paintInterrupt(checkpoint(null, "merge-conflict"));
    expect(r.root.querySelector(".interrupt-actions")).not.toBeNull();
    expect(button(r.root)).toBeNull();
  });

  it("disables while the request is out", () => {
    const r = paintInterrupt(checkpoint({ requesting: true, failure: null }));
    expect(button(r.root)?.disabled).toBe(true);
  });

  it("shows a refusal's reason under the form", () => {
    const r = paintInterrupt(
      checkpoint({ requesting: false, failure: "the pane is gone" }),
    );
    expect(button(r.root)?.disabled).toBe(false);
    expect(r.root.querySelector(".interrupt-box .keep-talking-failure")?.textContent).toBe(
      "the pane is gone",
    );
  });
});

describe("Detail: the shared Draft answer and writing it full size (issue #147)", () => {
  const checkpoint: TicketDetailView["interrupt"] = {
    ticketId: "A",
    kind: "checkpoint",
    body: "the brief",
    form: {
      title: "checkpoint",
      actions: [{ action: "resume", label: "resume", tone: "primary" }],
    },
    queued: false,
    keepTalking: null,
  };

  // The Detail on its Progress tab over a given Draft answers store, painted
  // the composition root's way, with Resume's answers recorded.
  function rigNote(drafts: DraftAnswers) {
    const answers: { ticketId: string; action: string; note?: string }[] = [];
    const pane = new Detail({ onClose: () => {}, drafts });
    const handlers: DetailHandlers = {
      onSelectAttempt: () => {},
      onSelectStream: () => {},
      onLoadEarlier: () => {},
      onAnswer: (ticketId, action, note) => answers.push({ ticketId, action, note }),
      onKeepTalking: () => {},
      onUseStewardNote: () => {},
      onSelectTab: () => {},
      onEndConversation: () => {},
      onFocusConversationTerminal: () => Promise.resolve(true),
      onFocusResolver: () => Promise.resolve(true),
      renderSpawnDecision: () => document.createElement("div"),
      reassign: new ReassignStore({
        onGetSettings: () => new Promise(() => {}),
        onReassign: () => new Promise(() => {}),
        onChange: () => {},
      }),
    };
    const root = document.createElement("div");
    document.body.appendChild(root);
    const paint = () =>
      commit(root, () => {
        const shell = document.createElement("div");
        shell.className = "shell";
        shell.appendChild(
          pane.render(
            {
              ...model(detailView({ status: "checkpoint", interrupt: checkpoint })),
              detailTabs: [
                { id: "spec", label: "Spec", active: false, interruptDot: true },
                { id: "progress", label: "Progress", active: true, interruptDot: true },
                { id: "outcome", label: "Outcome", active: false, interruptDot: true },
              ],
            },
            handlers,
          ),
        );
        return shell;
      });
    paint();
    const note = () => root.querySelector<HTMLTextAreaElement>(".detail-open textarea.interrupt-note")!;
    return { root, pane, paint, note, answers };
  }

  it("shows the draft typed in the tray, and Resume sends it", () => {
    const drafts = new DraftAnswers();
    drafts.set("A", "typed in the tray");
    const r = rigNote(drafts);
    expect(r.note().value).toBe("typed in the tray");
    r.root.querySelector<HTMLButtonElement>(".interrupt-actions .btn-primary")!.click();
    expect(r.answers).toEqual([{ ticketId: "A", action: "resume", note: "typed in the tray" }]);
  });

  it("writes what is typed to the shared store the tray reads", () => {
    const drafts = new DraftAnswers();
    const r = rigNote(drafts);
    r.note().value = "written full size";
    r.note().dispatchEvent(new Event("input", { bubbles: true }));
    expect(drafts.get("A")).toBe("written full size");
  });

  it("opens full size and focuses the note with the caret at the end", () => {
    const drafts = new DraftAnswers();
    drafts.set("A", "started in the tray");
    const r = rigNote(drafts);
    r.pane.writeFullSize("A");
    r.paint();
    expect(r.root.querySelector(".detail-open")?.classList.contains("detail-fullscreen")).toBe(true);
    r.pane.settleNoteFocus(r.root);
    expect(document.activeElement).toBe(r.note());
    const end = "started in the tray".length;
    expect([r.note().selectionStart, r.note().selectionEnd]).toEqual([end, end]);
    // The focus is asked for once: a later render leaves focus where the
    // operator has since put it.
    r.note().blur();
    r.paint();
    r.pane.settleNoteFocus(r.root);
    expect(document.activeElement).not.toBe(r.note());
  });

  it("drops a pending focus when fullscreen is left before the note renders", () => {
    const r = rigNote(new DraftAnswers());
    r.pane.writeFullSize("A");
    r.pane.exitFullscreen();
    r.paint();
    r.pane.settleNoteFocus(r.root);
    expect(document.activeElement).not.toBe(r.note());
    expect(r.root.querySelector(".detail-fullscreen")).toBeNull();
  });
});

describe("Detail: Held spawn events on the timeline (issue #149)", () => {
  it("shows a spawn event's line under its row, as a reassignment's is", () => {
    const event = (kind: string, spawn: string | null) => ({
      kind,
      at: "2026-09-29T10:00:00Z",
      timeLabel: "10:00:00",
      grade: null,
      reassignment: null,
      spawn,
      files: null,
      steward: null,
    });
    const pane = new Detail({ onClose: () => {}, drafts: new DraftAnswers() });
    const base = model(detailView());
    const root = document.createElement("div");
    commit(root, () => {
      const shell = document.createElement("div");
      shell.appendChild(
        pane.render(
          {
            ...base,
            detailTabs: base.detailTabs!.map((tab) => ({ ...tab, active: tab.id === "progress" })),
            timeline: {
              reconstructed: false,
              attempts: [
                {
                  number: 1,
                  reconstructed: false,
                  running: false,
                  logFile: null,
                  streamFile: null,
                  events: [
                    event("spawn-held", "1 spawn held (per-run cap): 'Fix the login test'"),
                    event("exited", null),
                  ],
                },
              ],
            },
          },
          {
            onSelectAttempt: () => {},
            onSelectStream: () => {},
            onLoadEarlier: () => {},
            onAnswer: () => {},
            onKeepTalking: () => {},
            onUseStewardNote: () => {},
            onSelectTab: () => {},
            onEndConversation: () => {},
            onFocusConversationTerminal: () => Promise.resolve(true),
            onFocusResolver: () => Promise.resolve(true),
            renderSpawnDecision: () => document.createElement("div"),
            reassign: new ReassignStore({
              onGetSettings: () => new Promise(() => {}),
              onReassign: () => new Promise(() => {}),
              onChange: () => {},
            }),
          },
        ),
      );
      return shell;
    });
    const lines = [...root.querySelectorAll(".timeline-spawn")].map((el) => el.textContent);
    expect(lines).toEqual(["1 spawn held (per-run cap): 'Fix the login test'"]);
  });
});

describe("Detail: the Steward (ADR-0030)", () => {
  // The Detail on Progress, its Steward note uses recorded.
  function paintProgress(detail: TicketDetailView, timeline: DetailModel["timeline"] = null) {
    const uses: { ticketId: string; text: string }[] = [];
    const answers: string[] = [];
    const pane = new Detail({ onClose: () => {}, drafts: new DraftAnswers() });
    const handlers: DetailHandlers = {
      onSelectAttempt: () => {},
      onSelectStream: () => {},
      onLoadEarlier: () => {},
      onAnswer: (ticketId, action) => answers.push(`${ticketId}:${action}`),
      onKeepTalking: () => {},
      onUseStewardNote: (ticketId, text) => uses.push({ ticketId, text }),
      onSelectTab: () => {},
      onEndConversation: () => {},
      onFocusConversationTerminal: () => Promise.resolve(true),
      onFocusResolver: () => Promise.resolve(true),
      renderSpawnDecision: () => document.createElement("div"),
      reassign: new ReassignStore({
        onGetSettings: () => new Promise(() => {}),
        onReassign: () => new Promise(() => {}),
        onChange: () => {},
      }),
    };
    const root = document.createElement("div");
    document.body.appendChild(root);
    commit(root, () => {
      const shell = document.createElement("div");
      shell.appendChild(
        pane.render(
          {
            ...model(detail),
            timeline,
            detailTabs: [
              { id: "spec", label: "Spec", active: false, interruptDot: false },
              { id: "progress", label: "Progress", active: true, interruptDot: false },
              { id: "outcome", label: "Outcome", active: false, interruptDot: false },
            ],
          },
          handlers,
        ),
      );
      return shell;
    });
    return { root, uses, answers };
  }

  const note = { text: "needs a product call: keep both flags?", at: "2026-10-01T02:00:00Z", conversation: "conv-3" };
  const interrupt = (queued = false): TicketDetailView["interrupt"] => ({
    ticketId: "A",
    kind: "checkpoint",
    body: "the brief",
    form: { title: "checkpoint", actions: [{ action: "resume", label: "resume", tone: "primary" }] },
    queued,
    keepTalking: null,
    stewardNote: note,
  });

  it("shows the Steward note above the note field, and Use as answer hands it to the draft seam", () => {
    const r = paintProgress(detailView({ status: "checkpoint", interrupt: interrupt() }));
    const box = r.root.querySelector(".interrupt-box .steward-note");
    expect(box?.querySelector(".steward-note-text")?.textContent).toBe(note.text);
    expect(box?.nextElementSibling?.classList.contains("interrupt-note")).toBe(true);
    box!.querySelector<HTMLButtonElement>(".steward-note-use")!.click();
    expect(r.uses).toEqual([{ ticketId: "A", text: note.text }]);
    expect(r.answers).toEqual([]);
  });

  it("steps the note aside with the form once an answer is queued", () => {
    const r = paintProgress(detailView({ status: "checkpoint", interrupt: interrupt(true) }));
    expect(r.root.querySelector(".steward-note")).toBeNull();
  });

  it("shows the Steward budget used and left once the Steward has answered the ticket", () => {
    const r = paintProgress(
      detailView({ status: "in-progress", stewardBudget: { used: 5, budget: 5, remaining: 0 } }),
    );
    const line = r.root.querySelector(".detail-steward-budget");
    expect(line?.textContent).toBe("Steward budget · 5 of 5 used · 0 left");
    expect(line?.classList.contains("detail-steward-budget-spent")).toBe(true);
    expect(paintProgress(detailView()).root.querySelector(".detail-steward-budget")).toBeNull();
  });

  it("shows a Steward act's line under its timeline row", () => {
    const r = paintProgress(detailView({ status: "checkpoint" }), {
      reconstructed: false,
      attempts: [
        {
          number: 1,
          reconstructed: false,
          running: false,
          logFile: null,
          streamFile: null,
          events: [
            {
              kind: "answered",
              at: "2026-10-01T02:00:00Z",
              timeLabel: "02:00:00",
              grade: null,
              reassignment: null,
              spawn: null,
              files: null,
              steward: "the Steward answered checkpoint: resume · tests pass now",
            },
          ],
        },
      ],
    });
    expect(r.root.querySelector(".timeline-steward")?.textContent).toBe(
      "the Steward answered checkpoint: resume · tests pass now",
    );
  });
});
