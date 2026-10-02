/// <reference types="bun" />

import { describe, expect, it, spyOn } from "bun:test";
import { h } from "./dom";
import { commit, KEEP_CHILDREN, morph } from "./morph";
import { useDom } from "./test-dom";

useDom();

/** A page root holding one built tree, the way the composition root does. */
function mounted(tree: Element): { root: HTMLElement; tree: Element } {
  const root = document.createElement("div");
  document.body.appendChild(root);
  root.appendChild(tree);
  return { root, tree };
}

describe("morph", () => {
  it("keeps the same-tag node and rewrites only the text that changed", () => {
    const { tree } = mounted(h("div", {}, h("span", {}, "3s ago")));
    const span = tree.firstElementChild!;
    const text = span.firstChild!;
    const kept = morph(tree, h("div", {}, h("span", {}, "5s ago")));
    expect(kept).toBe(tree);
    expect(tree.firstElementChild).toBe(span);
    expect(span.firstChild).toBe(text);
    expect(span.textContent).toBe("5s ago");
  });

  it("replaces a node whose tag changed and returns the node now in place", () => {
    const { root, tree } = mounted(h("div", { class: "a" }));
    const next = h("section", { class: "a" });
    const inPlace = morph(tree, next);
    expect(inPlace).toBe(next);
    expect(root.firstElementChild).toBe(next);
    expect(tree.parentNode).toBeNull();
  });

  it("adds, updates and removes attributes to match", () => {
    const { tree } = mounted(
      h("div", { class: "card", title: "old", "data-key": "k1", hidden: "" }),
    );
    morph(tree, h("div", { class: "card selected", title: "new", "data-key": "k1" }));
    expect(tree.className).toBe("card selected");
    expect(tree.getAttribute("title")).toBe("new");
    expect(tree.getAttribute("data-key")).toBe("k1");
    expect(tree.hasAttribute("hidden")).toBe(false);
  });

  it("re-points a handler at the latest render and clears one that disappeared", () => {
    const fired: string[] = [];
    const { tree } = mounted(
      h("div", {}, h("button", { onclick: () => fired.push("old") }, "go")),
    );
    const button = tree.firstElementChild as HTMLButtonElement;
    morph(tree, h("div", {}, h("button", { onclick: () => fired.push("new") }, "go")));
    button.click();
    expect(fired).toEqual(["new"]);
    morph(tree, h("div", {}, h("button", {}, "go")));
    button.click();
    expect(fired).toEqual(["new"]);
    expect(button.onclick).toBeNull();
  });

  it("re-applies checked and disabled, and clears them when dropped", () => {
    const { tree } = mounted(h("div", {}, h("input", { type: "checkbox" })));
    const box = tree.firstElementChild as HTMLInputElement;
    morph(tree, h("div", {}, h("input", { type: "checkbox", checked: true, disabled: true })));
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(true);
    morph(tree, h("div", {}, h("input", { type: "checkbox" })));
    expect(box.checked).toBe(false);
    expect(box.disabled).toBe(false);
  });

  it("leaves a focused field's value and caret alone when the render agrees", () => {
    const { tree } = mounted(h("div", {}, h("textarea", { value: "hello" })));
    const area = tree.firstElementChild as HTMLTextAreaElement;
    area.focus();
    area.setSelectionRange(2, 3);
    morph(tree, h("div", {}, h("textarea", { value: "hello" }), h("span", {}, "tick")));
    expect(document.activeElement).toBe(area);
    expect(area.value).toBe("hello");
    expect([area.selectionStart, area.selectionEnd]).toEqual([2, 3]);
  });

  it("writes a focused field's value when the render disagrees", () => {
    const { tree } = mounted(h("div", {}, h("input", { value: "draft" })));
    const input = tree.firstElementChild as HTMLInputElement;
    input.focus();
    morph(tree, h("div", {}, h("input", { value: "" })));
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("");
  });

  it("matches keyed siblings by key: moves the kept ones, drops the missing, inserts the new", () => {
    const rows = (...keys: string[]) =>
      h("ul", {}, ...keys.map((k) => h("li", { key: k }, k)));
    const { tree } = mounted(rows("a", "b", "c"));
    const [a, b, c] = Array.from(tree.children);
    morph(tree, rows("c", "d", "a"));
    expect(Array.from(tree.children).map((n) => n.textContent)).toEqual(["c", "d", "a"]);
    expect(tree.children[0]).toBe(c!);
    expect(tree.children[2]).toBe(a!);
    expect(b!.parentNode).toBeNull();
  });

  it("matches unkeyed siblings by position and tag, growing and shrinking the list", () => {
    const { tree } = mounted(h("div", {}, h("p", {}, "one")));
    const one = tree.firstElementChild!;
    morph(tree, h("div", {}, h("p", {}, "one"), h("p", {}, "two"), "tail"));
    expect(tree.childNodes.length).toBe(3);
    expect(tree.firstElementChild).toBe(one);
    expect(tree.lastChild!.nodeValue).toBe("tail");
    morph(tree, h("div", {}));
    expect(tree.childNodes.length).toBe(0);
    morph(tree, h("div", {}, h("em", {}, "back")));
    expect(tree.firstElementChild!.tagName).toBe("EM");
  });

  it("replaces an unkeyed sibling whose tag changed without disturbing the rest", () => {
    const { tree } = mounted(h("div", {}, h("p", {}, "x"), h("p", {}, "y")));
    const y = tree.children[1]!;
    morph(tree, h("div", {}, h("h2", {}, "x"), h("p", {}, "y")));
    expect(tree.children[0]!.tagName).toBe("H2");
    expect(tree.children[1]).toBe(y);
  });

  it("leaves an unchanged subtree's nodes untouched", () => {
    const { tree } = mounted(
      h("div", {}, h("section", { class: "detail" }, h("pre", {}, "log")), h("span", {}, "1s")),
    );
    const section = tree.firstElementChild!;
    const pre = section.firstElementChild!;
    const log = pre.firstChild!;
    morph(
      tree,
      h("div", {}, h("section", { class: "detail" }, h("pre", {}, "log")), h("span", {}, "2s")),
    );
    expect(tree.firstElementChild).toBe(section);
    expect(section.firstElementChild).toBe(pre);
    expect(pre.firstChild).toBe(log);
  });

  it("keeps a scrolled region's scrollTop while a sibling changes", () => {
    const { tree } = mounted(
      h("div", {}, h("div", { class: "detail-open" }, "body"), h("span", {}, "1s")),
    );
    const region = tree.firstElementChild as HTMLElement;
    region.scrollTop = 120;
    morph(tree, h("div", {}, h("div", { class: "detail-open" }, "body"), h("span", {}, "2s")));
    expect(tree.firstElementChild).toBe(region);
    expect(region.scrollTop).toBe(120);
  });

  it("patches namespaced elements by attribute and keeps them when the namespace matches", () => {
    const SVG = "http://www.w3.org/2000/svg";
    const edges = (points: string) => {
      const svg = document.createElementNS(SVG, "svg");
      svg.setAttribute("class", "canvas-edges");
      const line = document.createElementNS(SVG, "polyline");
      line.setAttribute("points", points);
      svg.appendChild(line);
      return svg;
    };
    const { tree } = mounted(h("div", {}, edges("0,0 1,1")));
    const svg = tree.firstElementChild!;
    const line = svg.firstElementChild!;
    morph(tree, h("div", {}, edges("0,0 2,2")));
    expect(tree.firstElementChild).toBe(svg);
    expect(svg.firstElementChild).toBe(line);
    expect(line.getAttribute("points")).toBe("0,0 2,2");
    expect(svg.namespaceURI).toBe(SVG);
  });

  it("keeps an unkeyed sibling ahead of keyed ones that reorder", () => {
    const list = (order: string[]) =>
      h("ul", {}, h("li", { class: "svg-stand-in" }), ...order.map((k) => h("li", { key: k }, k)));
    const { tree } = mounted(list(["a", "b"]));
    const [first, a, b] = Array.from(tree.children);
    morph(tree, list(["b", "a"]));
    expect(tree.children[0]).toBe(first);
    expect(tree.children[1]).toBe(b);
    expect(tree.children[2]).toBe(a);
  });

  it("keeps an unkeyed sibling that sits between keyed ones when they swap", () => {
    const list = (order: string[]) =>
      h("ul", {}, h("li", { key: order[0] }, order[0]), h("li", {}, "form"), h("li", { key: order[1] }, order[1]));
    const { tree } = mounted(list(["a", "b"]));
    const [a, form, b] = Array.from(tree.children);
    morph(tree, list(["b", "a"]));
    expect(tree.children[0]).toBe(b);
    expect(tree.children[1]).toBe(form);
    expect(tree.children[2]).toBe(a);
    expect(tree.textContent).toBe("bforma");
  });

  it("commits by morphing, and falls back to a fresh tree when the morph throws", () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const root = document.createElement("div");
      document.body.appendChild(root);
      let renders = 0;
      const build = () => {
        renders += 1;
        return h("div", { class: "shell" }, h("button", { onclick: () => {} }, `render ${renders}`));
      };
      commit(root, build);
      const shell = root.firstElementChild!;
      const button = shell.firstElementChild!;
      commit(root, build);
      expect(root.firstElementChild).toBe(shell);
      expect(shell.textContent).toBe("render 2");
      // A patch that cannot land: the live node refuses the handler write.
      Object.defineProperty(button, "onclick", {
        set() {
          throw new Error("refused");
        },
      });
      commit(root, build);
      expect(error).toHaveBeenCalledTimes(1);
      expect(root.firstElementChild).not.toBe(shell);
      expect(root.firstElementChild!.textContent).toBe("render 4");
      expect(root.childNodes.length).toBe(1);
    } finally {
      error.mockRestore();
    }
  });

  it("warns on a duplicate key and matches the second occurrence by position", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { tree } = mounted(h("ul", {}, h("li", { key: "a" }, "a"), h("li", { key: "b" }, "b")));
      const [a, b] = Array.from(tree.children);
      morph(
        tree,
        h("ul", {}, h("li", { key: "a" }, "a"), h("li", { key: "a" }, "a2"), h("li", { key: "b" }, "b")),
      );
      expect(tree.children[0]).toBe(a);
      expect(tree.children[2]).toBe(b);
      expect(Array.from(tree.children).map((c) => c.textContent)).toEqual(["a", "a2", "b"]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('"a"');
    } finally {
      warn.mockRestore();
    }
  });

  it("leaves markup built from unchanged html alone, and patches it when the html moves (#157)", () => {
    const { tree } = mounted(h("div", { html: "<p>one</p><pre>code</pre>" }));
    const pre = tree.querySelector("pre")!;
    // Something only the live page holds: a walk of the subtree would see
    // it differs from the fresh build and undo it.
    pre.setAttribute("data-seen", "yes");
    morph(tree, h("div", { html: "<p>one</p><pre>code</pre>" }));
    expect(tree.querySelector("pre")).toBe(pre);
    expect(pre.getAttribute("data-seen")).toBe("yes");
    morph(tree, h("div", { html: "<p>two</p><pre>code</pre>" }));
    expect(tree.querySelector("p")!.textContent).toBe("two");
    expect(tree.querySelector("pre")).toBe(pre);
    expect(pre.hasAttribute("data-seen")).toBe(false);
  });

  it("keeps the children of an element marked as owning them, and patches the element itself (#157)", () => {
    const { tree } = mounted(h("div", {}, h("div", { class: "layer", [KEEP_CHILDREN]: "" })));
    const layer = tree.firstElementChild!;
    const drawn = document.createElement("span");
    layer.appendChild(drawn);
    morph(tree, h("div", {}, h("div", { class: "layer moved", [KEEP_CHILDREN]: "" })));
    expect(tree.firstElementChild).toBe(layer);
    expect(layer.className).toBe("layer moved");
    expect(layer.firstChild).toBe(drawn);
  });
});
