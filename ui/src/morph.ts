/**
 * Morph one built tree into another in place. The renderers stay pure
 * functions of the projected model that build a fresh tree with `h` on every
 * pass; instead of swapping that tree in wholesale, the composition root
 * morphs the tree already on the page to match it. Every node that still has
 * a counterpart is kept, so scroll positions, focus and caret, hover, and
 * in-flight pointer captures survive a render without anyone rescuing them.
 *
 * The contract: `morph(from, to)` returns the node now standing where `from`
 * stood. That is `from` itself when the two share a tag, patched to match
 * `to`; when the tags differ `from` is replaced by `to` in its parent and
 * `to` is returned, so a caller keeps whatever comes back. Attributes are
 * matched one for one. Props `h` set as properties (`checked`, `disabled`,
 * `value`, every `on*` handler) are re-applied from what `h` recorded on the
 * new node, so a handler always closes over the latest render and one that
 * disappeared is cleared. Children are matched by `data-key` when a child
 * carries one, else by position among the unkeyed siblings and by tag, so
 * keyed and unkeyed children may interleave and reorder freely; a duplicate
 * key among siblings is a renderer bug, warned about and matched by
 * position. Text nodes get their data rewritten only when it changed. `to`
 * is consumed: its nodes may be moved into `from`. Properties are applied
 * before children, so a `<select>` whose `<option>`s change in the same
 * render would take its `value` against the old options; nothing renders one
 * today.
 */

import { isProperty, propsOf, rememberProps } from "./dom";

/**
 * Commit a render: build the tree and morph the one on the page to match
 * it, or mount it when the page is empty. A morph that throws part way
 * leaves the page half-patched, and the next tick would patch that, so the
 * fallback is the old commit, a fresh tree swapped in whole: one render's
 * scroll and focus lost rather than a tree nobody can trust. `build` runs
 * again for the fallback because the first tree was consumed by the morph.
 */
export function commit(root: Element, build: () => Element): void {
  const shell = root.firstElementChild;
  if (!shell) {
    root.replaceChildren(build());
    return;
  }
  try {
    morph(shell, build());
  } catch (error) {
    console.error("morph failed; replacing the tree", error);
    root.replaceChildren(build());
  }
}

export function morph(from: Element, to: Element): Element {
  if (!sameKind(from, to)) {
    from.replaceWith(to);
    return to;
  }
  morphAttributes(from, to);
  morphProperties(from, to);
  morphChildren(from, to);
  return from;
}

function sameKind(a: Element, b: Element): boolean {
  return a.tagName === b.tagName && a.namespaceURI === b.namespaceURI;
}

function morphAttributes(from: Element, to: Element): void {
  for (const { name, value } of Array.from(to.attributes)) {
    if (from.getAttribute(name) !== value) from.setAttribute(name, value);
  }
  for (const { name } of Array.from(from.attributes)) {
    if (!to.hasAttribute(name)) from.removeAttribute(name);
  }
}

function morphProperties(from: Element, to: Element): void {
  const tag = to.tagName.toLowerCase();
  const next = propsOf(to);
  const prev = propsOf(from);
  const target = from as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(next)) {
    if (!isProperty(tag, key)) continue;
    if (key === "value" && target.value === value) continue;
    target[key] = value;
  }
  for (const key of Object.keys(prev)) {
    if (key in next || !isProperty(tag, key)) continue;
    target[key] = key === "value" ? "" : key.startsWith("on") ? null : false;
  }
  rememberProps(from, next);
}

function morphChildren(from: Element, to: Element): void {
  // Partition what is on the page: keyed children wait to be claimed by key,
  // unkeyed ones by position among themselves, so an unkeyed node keeps its
  // identity however the keyed ones around it move. Whatever neither claims
  // is stale.
  const byKey = new Map<string, Element>();
  const unkeyed: ChildNode[] = [];
  for (const child of Array.from(from.childNodes)) {
    const key = child instanceof Element ? child.getAttribute("data-key") : null;
    if (child instanceof Element && key != null && !byKey.has(key)) byKey.set(key, child);
    else unkeyed.push(child);
  }
  const claimed = new Set<string>();
  // `cursor` is the node standing where the next wanted child belongs; a
  // claimed node is moved in front of it, so everything before the cursor is
  // already in the wanted order.
  let cursor: ChildNode | null = from.firstChild;
  for (const want of Array.from(to.childNodes)) {
    let key = want instanceof Element ? want.getAttribute("data-key") : null;
    if (key != null && claimed.has(key)) {
      console.warn(`morph: duplicate key "${key}" among siblings; matching it by position`);
      key = null;
    }
    let match: ChildNode | null = null;
    if (key != null) {
      claimed.add(key);
      match = byKey.get(key) ?? null;
      byKey.delete(key);
    } else {
      // Positional among the unkeyed siblings: the next unclaimed one stands
      // in this slot. If its shape differs it is the slot's stale node and
      // goes now, so the ones after it keep their places and their nodes.
      const head = unkeyed.shift() ?? null;
      if (head && matches(head, want)) {
        match = head;
      } else if (head) {
        if (head === cursor) cursor = cursor.nextSibling;
        head.remove();
      }
    }
    if (!match) {
      from.insertBefore(want, cursor);
    } else if (match === cursor) {
      cursor = cursor.nextSibling;
      patchNode(match, want);
    } else {
      from.insertBefore(match, cursor);
      patchNode(match, want);
    }
  }
  for (const stale of byKey.values()) stale.remove();
  for (const stale of unkeyed) stale.remove();
}

/** An unkeyed child stands in for a wanted one when they are the same shape. */
function matches(have: ChildNode, want: ChildNode): boolean {
  if (have instanceof Element && want instanceof Element) return sameKind(have, want);
  return have.nodeType === want.nodeType && !(have instanceof Element);
}

function patchNode(have: ChildNode, want: ChildNode): void {
  if (have instanceof Element && want instanceof Element) {
    morph(have, want);
  } else if (have.nodeValue !== want.nodeValue) {
    have.nodeValue = want.nodeValue;
  }
}
