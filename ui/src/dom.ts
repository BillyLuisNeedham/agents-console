/**
 * The one DOM builder the view modules share: an element from a tag, props,
 * and children. `class` sets className, `checked`/`disabled`/`on*` set
 * properties, everything else becomes an attribute; null children drop out.
 */

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...kids: (Node | string | null)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null) continue;
    if (key === "class") node.className = String(value);
    else if (key === "checked" || key === "disabled" || key.startsWith("on")) {
      (node as unknown as Record<string, unknown>)[key] = value;
    } else {
      node.setAttribute(key, String(value));
    }
  }
  for (const kid of kids) {
    if (kid == null) continue;
    node.appendChild(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return node;
}
