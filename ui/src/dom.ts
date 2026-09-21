/**
 * The one DOM builder the view modules share: an element from a tag, props,
 * and children. `class` sets className, `key` becomes the `data-key`
 * attribute a morph matches siblings by, `checked`/`disabled`/`on*` set
 * properties, `value` on a form control sets the live property, everything
 * else becomes an attribute; null children drop out.
 *
 * Every prop `h` set is remembered against the element (`propsOf`) so the
 * morph can diff two builds property by property, including a handler that
 * disappeared, instead of guessing from the live node.
 */

const props = new WeakMap<Element, Record<string, unknown>>();

/** The props `h` set on an element; empty for a node `h` did not build. */
export function propsOf(node: Element): Record<string, unknown> {
  return props.get(node) ?? {};
}

/** Carry a record across to a node that now stands for the one `h` built. */
export function rememberProps(node: Element, set: Record<string, unknown>): void {
  props.set(node, set);
}

/** Whether a prop is written as a property rather than an attribute. */
export function isProperty(tag: string, key: string): boolean {
  if (key === "checked" || key === "disabled" || key.startsWith("on")) return true;
  return key === "value" && (tag === "input" || tag === "textarea" || tag === "select");
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> = {},
  ...kids: (Node | string | null)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  const set: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null) continue;
    set[key] = value;
    if (key === "class") node.className = String(value);
    else if (key === "key") node.setAttribute("data-key", String(value));
    else if (isProperty(tag, key)) {
      (node as unknown as Record<string, unknown>)[key] = value;
    } else {
      node.setAttribute(key, String(value));
    }
  }
  props.set(node, set);
  for (const kid of kids) {
    if (kid == null) continue;
    node.appendChild(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return node;
}
