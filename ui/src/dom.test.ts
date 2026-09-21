/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import { h } from "./dom";
import { useDom } from "./test-dom";

useDom();

describe("h", () => {
  it("turns a key prop into the data-key attribute", () => {
    const row = h("li", { key: "ticket-7", class: "row" }, "seven");
    expect(row.getAttribute("data-key")).toBe("ticket-7");
    expect(row.hasAttribute("key")).toBe(false);
    expect(row.className).toBe("row");
  });

  it("sets value on a form control as the live property, not an attribute", () => {
    const input = h("input", { value: "draft" });
    const area = h("textarea", { value: "notes" });
    expect(input.value).toBe("draft");
    expect(area.value).toBe("notes");
    expect(input.getAttribute("value")).toBeNull();
    expect(area.getAttribute("value")).toBeNull();
  });

  it("keeps value as an attribute on anything that is not a form control", () => {
    const li = h("li", { value: "3" });
    expect(li.getAttribute("value")).toBe("3");
  });
});
