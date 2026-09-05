// PROTOTYPE — throwaway, issue #29 terminal-surface exploration
const VARIANTS = [
  { key: "a", name: "Open in herdr" },
  { key: "b", name: "Embedded terminal" },
];

const params = new URLSearchParams(location.search);
let current = params.get("surface") === "b" ? "b" : "a";

function paneId() {
  const p = new URLSearchParams(location.search).get("pane");
  if (p) return p;
  return localStorage.getItem("console-pane-id") || null;
}

function persistPane(id) {
  localStorage.setItem("console-pane-id", id);
  const u = new URLSearchParams(location.search);
  u.set("pane", id);
  history.replaceState(null, "", `${location.pathname}?${u}`);
}

let currentHandle = null;
let currentSwitcher = null;

async function mount() {
  const container = document.getElementById("surface");
  container.innerHTML = "";

  if (currentHandle && typeof currentHandle.dispose === "function") {
    currentHandle.dispose();
  }
  if (currentSwitcher && typeof currentSwitcher.dispose === "function") {
    currentSwitcher.dispose();
  }

  const mod = await import(`./variant-${current}.js`);
  const mountFn = current === "a" ? mod.mountVariantA : mod.mountVariantB;

  const ctx = { paneId: paneId(), persistPane };

  const switcherMod = await import("./switcher.js");
  const switcher = switcherMod.mountSwitcher(container, {
    current,
    variants: VARIANTS,
    onSelect(next) {
      if (next === current) return;
      current = next;
      const u = new URLSearchParams(location.search);
      u.set("surface", current);
      history.replaceState(null, "", `${location.pathname}?${u}`);
      mount();
    },
  });
  currentSwitcher = switcher;

  currentHandle = mountFn(container, ctx);
  document.body.appendChild(switcher.el);
}

mount();
