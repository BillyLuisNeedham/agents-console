// PROTOTYPE — throwaway, issue #29 terminal-surface exploration
export function mountSwitcher(container, opts) {
  const pill = document.createElement("div");
  pill.className = "switcher";

  const prev = document.createElement("button");
  prev.className = "switcher-arrow";
  prev.type = "button";
  prev.setAttribute("aria-label", "Previous surface");
  prev.textContent = "◀";

  const label = document.createElement("span");
  label.className = "switcher-label";

  const next = document.createElement("button");
  next.className = "switcher-arrow";
  next.type = "button";
  next.setAttribute("aria-label", "Next surface");
  next.textContent = "▶";

  const tag = document.createElement("span");
  tag.className = "switcher-tag";
  tag.textContent = "PROTOTYPE — throwaway";

  pill.append(prev, label, next, tag);

  function select(v) {
    opts.onSelect(v);
  }

  function step(dir) {
    const keys = opts.variants.map((v) => v.key);
    const i = keys.indexOf(opts.current);
    const n = (i + dir + keys.length) % keys.length;
    select(keys[n]);
  }

  function render() {
    const v = opts.variants.find((v) => v.key === opts.current);
    label.textContent = `${v.key.toUpperCase()} · ${v.name}`;
  }
  render();

  prev.addEventListener("click", () => step(-1));
  next.addEventListener("click", () => step(1));

  function isTypingTarget(el) {
    if (!el) return false;
    if (el.closest(".xterm")) return true;
    const t = el.tagName;
    if (t === "INPUT" || t === "TEXTAREA") return true;
    if (el.isContentEditable) return true;
    return false;
  }

  function onKeydown(e) {
    if (isTypingTarget(document.activeElement)) return;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      step(-1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      step(1);
    }
  }

  window.addEventListener("keydown", onKeydown);

  return {
    el: pill,
    dispose() {
      window.removeEventListener("keydown", onKeydown);
      pill.remove();
    },
  };
}
