/**
 * Drawers: the bottom strip holding the log channel and the full State
 * inspector side by side. One module owns the strip's render, the shared vh
 * height, and the resize drag on its top edge, as instance state on the
 * class the composition root creates once per session, so the dragged
 * height is rendered from state on every snapshot. Open and closed stay in
 * the app model; this module owns only the height.
 */

import {
  clampDrawersHeight,
  DRAWER_DEFAULT_VH,
} from "./project";
import { h } from "./dom";

/** The slice of the app model the drawers render from. */
export interface DrawersModel {
  log: string[];
  logOpen: boolean;
  inspectorJson: string;
  inspectorOpen: boolean;
}

/** The handlers the drawer bars report through. */
export interface DrawersHandlers {
  onToggleLog: () => void;
  onToggleInspector: () => void;
}

export class Drawers {
  // One shared vh height drives both drawer bodies.
  private height = DRAWER_DEFAULT_VH;
  private drag: { startY: number; startHeight: number } | null = null;

  render(model: DrawersModel, handlers: DrawersHandlers): HTMLElement {
    const handle = h("div", {
      class: "drawer-handle",
      title: "drag to resize drawers",
      onpointerdown: (event: PointerEvent) => {
        if (this.drag) return;
        this.drag = { startY: event.clientY, startHeight: this.height };
        try {
          (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
        } catch {
          // pointer already gone
        }
      },
      onpointermove: (event: PointerEvent) => {
        if (!this.drag) return;
        const dy = event.clientY - this.drag.startY;
        const vhPerPx = 100 / window.innerHeight;
        this.height = clampDrawersHeight(this.drag.startHeight - dy * vhPerPx);
        this.applyHeight();
      },
      onpointerup: () => {
        this.drag = null;
      },
      onpointercancel: () => {
        this.drag = null;
      },
    });
    const row = h(
      "div",
      { class: "drawer-row" },
      this.renderLogDrawer(model, handlers),
      this.renderInspectorDrawer(model, handlers),
    );
    return h("div", { class: "drawers" }, handle, row);
  }

  private renderLogDrawer(model: DrawersModel, handlers: DrawersHandlers): HTMLElement {
    const lines = model.log.length > 0 ? model.log.join("\n") : "- no log lines yet -";
    return h(
      "div",
      { class: "log-drawer" + (model.logOpen ? " log-open" : "") },
      h(
        "button",
        { class: "drawer-bar", onclick: () => handlers.onToggleLog() },
        `log (${model.log.length}) ${model.logOpen ? "▾" : "▴"}`,
      ),
      model.logOpen
        ? h("pre", { class: "log-lines", style: `height:${this.height}vh` }, lines)
        : null,
    );
  }

  private renderInspectorDrawer(
    model: DrawersModel,
    handlers: DrawersHandlers,
  ): HTMLElement {
    return h(
      "div",
      { class: "inspector-drawer" + (model.inspectorOpen ? " inspector-open" : "") },
      h(
        "button",
        { class: "drawer-bar", onclick: () => handlers.onToggleInspector() },
        `state ${model.inspectorOpen ? "▾" : "▴"}`,
      ),
      model.inspectorOpen
        ? h(
            "pre",
            { class: "inspector-channels", style: `height:${this.height}vh` },
            model.inspectorJson,
          )
        : null,
    );
  }

  private applyHeight(): void {
    const height = `${this.height}vh`;
    for (const body of document.querySelectorAll<HTMLElement>(
      ".log-lines, .inspector-channels",
    )) {
      body.style.height = height;
    }
  }
}
