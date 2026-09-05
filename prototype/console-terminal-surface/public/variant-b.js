// PROTOTYPE — throwaway, issue #29 terminal-surface exploration (surface B).
// An embedded xterm.js terminal the operator can read and type into, wired to
// a real herdr pane through the bridge server. State is in-memory only.
//
// xterm + the fit addon are loaded from a CDN as classic scripts (the shared
// index.html does not reference them), then mountVariantB wires everything up.

const TERM_READ_POLL_MS = 500;
const TERM_READ_LINES = 500;
const PEEK_LINES = 12;
const MAX_DIFF_CHARS = 4000;
const READ_AFTER_SEND_DEBOUNCE_MS = 60;

const XTERM_JS = "https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js";
const XTERM_CSS = "https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.css";
const FIT_JS = "https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js";
const VARIANT_CSS = "/variant-b.css";

// herdr key names for input herdr cannot receive as pasted text. Key syntax
// per herdr: plain keys, ctrl/shift/alt/cmd/super modifiers, and special keys
// like enter/tab/esc/left/right/up/down.
const ESCAPE_KEYS = {
  "\u001b[A": "up",
  "\u001b[B": "down",
  "\u001b[C": "right",
  "\u001b[D": "left",
  "\u001bOA": "up",
  "\u001bOB": "down",
  "\u001bOC": "right",
  "\u001bOD": "left",
  "\u001b[H": "home",
  "\u001b[F": "end",
  "\u001b[1~": "home",
  "\u001b[4~": "end",
  "\u001b[5~": "pageup",
  "\u001b[6~": "pagedown",
  "\u001b[3~": "delete",
};

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function post(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.error || `${res.status} from ${url}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

// ---------------------------------------------------------------- CDN deps
let depsPromise = null;

function loadScript(src) {
  if (document.querySelector(`script[src="${src}"]`)) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.async = false;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(s);
  });
}

function loadCss(href) {
  if (document.querySelector(`link[href="${href}"]`)) return Promise.resolve();
  return new Promise((resolve) => {
    const l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = href;
    l.onload = () => resolve();
    l.onerror = () => resolve();
    document.head.appendChild(l);
  });
}

function ensureDeps() {
  if (!depsPromise) {
    depsPromise = Promise.all([loadCss(XTERM_CSS), loadCss(VARIANT_CSS), loadScript(XTERM_JS)])
      .then(() => loadScript(FIT_JS))
      .catch((err) => {
        depsPromise = null;
        throw err;
      });
  }
  return depsPromise;
}

// ------------------------------------------------------------------- mount
export function mountVariantB(container, ctx) {
  const paneId = (ctx && ctx.paneId) || null;

  // The wrapper. .varb-root fills the shell; the shared .surface padding and
  // centering are overridden via .surface:has(.varb-root) in variant-b.css.
  const root = el("div", "varb-root");

  // ------------------------------------------------------------------ header
  const header = el("header", "varb-header");
  const title = el("span", "varb-header-title", "Attempt #3 · Terminal-backed");
  const paneTag = el("span", "varb-header-pane", paneId ? `pane ${paneId}` : "no pane");
  const conn = el("span", "varb-header-conn", "idle");
  const popout = el("button", "varb-header-pop", "Pop out to herdr ↗");
  popout.type = "button";
  header.append(title, paneTag, conn, popout);
  root.append(header);

  // ------------------------------------------------------------------- body
  const body = el("div", "varb-body");
  root.append(body);

  // Thin banner for read-only / refused panes (a pane this server didn't spawn).
  const banner = el("div", "varb-banner");
  banner.hidden = true;
  const bannerMsg = el(
    "span",
    "varb-banner-msg",
    "This pane was not spawned by this server — input is refused (safety guard for live agent panes).",
  );
  const bannerSpawn = el("button", "varb-banner-btn", "Spawn fresh fake agent");
  bannerSpawn.type = "button";
  bannerSpawn.addEventListener("click", () => {
    bannerSpawn.disabled = true;
    bannerSpawn.textContent = "Spawning…";
    doSpawn()
      .then(() => startPolling())
      .catch((err) => {
        bannerSpawn.disabled = false;
        bannerSpawn.textContent = "Spawn fresh fake agent";
        renderStatus(`spawn failed: ${err.message}`);
      });
  });
  banner.append(bannerMsg, bannerSpawn);
  root.append(banner);

  // Small status line — prototype rule: surface the state.
  const status = el("div", "varb-status");
  const statusText = el("span", "varb-status-text", "·");
  status.append(statusText);
  root.append(status);

  container.append(root);

  // ------------------------------------------------------------------ state
  let currentPaneId = paneId;
  let lastText = null;
  let pollTimer = null;
  let readTimer = null;
  let disposed = false;
  let term = null;
  let fit = null;
  let sendQueue = Promise.resolve();
  let readOnly = false;

  function setConn(text, cls) {
    conn.textContent = text;
    conn.className = "varb-header-conn" + (cls ? " " + cls : "");
  }

  function renderStatus(extra) {
    if (disposed) return;
    const pieces = [];
    if (currentPaneId) pieces.push(`pane ${currentPaneId}`);
    if (extra) pieces.push(extra);
    statusText.textContent = pieces.join("  ·  ");
  }

  function doSpawn() {
    return post("/api/spawn-fake-agent", {}).then((d) => setPane(d.pane_id));
  }

  function setPane(id) {
    currentPaneId = id;
    lastText = null;
    readOnly = false;
    if (ctx && ctx.persistPane) ctx.persistPane(id);
    paneTag.textContent = `pane ${id}`;
    setConn("polling", "polling");
    banner.hidden = true;
    ensureTerminal();
    void readOnce().catch(() => {});
  }

  // ------------------------------------------------------------------ output
  async function readOnce() {
    if (disposed || !currentPaneId) return;
    const started = performance.now();
    const url = `/api/terminal/read?pane_id=${encodeURIComponent(currentPaneId)}&lines=${TERM_READ_LINES}`;
    const res = await fetch(url);
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      throw Object.assign(new Error(json.error || `read ${res.status}`), { status: res.status });
    }
    const data = await res.json();
    if (disposed || !currentPaneId) return;
    const latency = Math.round(performance.now() - started);
    if (typeof data.text === "string") {
      redraw(data.text);
      renderStatus(
        `rev ${data.revision ?? "?"}  truncated ${data.truncated ? "yes" : "no"}  last poll ${latency}ms`,
      );
      if (!readOnly) setConn(data.truncated ? "live · capped" : "live", "live");
    }
    return data;
  }

  function redraw(text) {
    if (!term) return;
    if (text === lastText) return;
    // Cheap incremental: when the new text is the old text plus a suffix,
    // append only the difference. Otherwise (truncated window rewound, or the
    // buffer was reset) do a full reset + rewrite — it is a prototype.
    if (lastText !== null && text.startsWith(lastText) && text.length > lastText.length) {
      const suffix = text.slice(lastText.length);
      if (suffix.length <= MAX_DIFF_CHARS) {
        term.write(suffix);
        lastText = text;
        return;
      }
    }
    term.reset();
    term.write(text);
    lastText = text;
  }

  function poll() {
    if (disposed || !currentPaneId) return;
    readOnce().catch((err) => {
      if (disposed) return;
      if (err && err.status) {
        setConn("exited", "idle");
        renderStatus(`read failed (${err.status}): ${err.message}`);
      } else {
        setConn("polling", "polling");
      }
    });
  }

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(poll, TERM_READ_POLL_MS);
  }

  // ------------------------------------------------------------------- input
  // Every printable char is sent to the real pane immediately; the real PTY
  // echoes it back and the next poll shows it — the operator feels like they
  // own the actual terminal. Enter / arrows / backspace / ctrl+c ride on
  // `keys` (herdr treats a literal "\r" in pasted text as data and does NOT
  // submit the line — verified against a spawned pane).
  function doSend(op) {
    if (!currentPaneId) return Promise.resolve();
    return post("/api/terminal/send", { pane_id: currentPaneId, ...op })
      .then(() => scheduleRead())
      .catch((err) => {
        if (disposed) return;
        if (err && err.status === 403) {
          enterReadOnly();
        } else {
          renderStatus(`send failed: ${err.message}`);
        }
      });
  }

  function enqueueSend(op) {
    sendQueue = sendQueue.then(() => doSend(op));
    return sendQueue;
  }

  function sendKeys(keys) {
    enqueueSend({ keys });
  }

  function translateChunk(chunk) {
    const ops = [];
    let run = "";
    const flush = () => {
      if (run) {
        ops.push({ text: run });
        run = "";
      }
    };
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i];
      const code = c.charCodeAt(0);
      if (c === "\r" || c === "\n") {
        flush();
        ops.push({ keys: ["Enter"] });
      } else if (c === "\x7f") {
        flush();
        ops.push({ keys: ["backspace"] });
      } else if (c === "\t") {
        flush();
        ops.push({ keys: ["tab"] });
      } else if (c === "\x1b") {
        flush();
        let seq = c;
        if (chunk[i + 1] === "[") {
          let j = i + 2;
          while (j < chunk.length && !/[A-Za-z~]/.test(chunk[j])) j++;
          seq = chunk.slice(i, j + 1);
        } else if (chunk[i + 1] === "O") {
          seq = chunk.slice(i, i + 3);
        } else {
          seq = chunk.slice(i, i + 2);
        }
        const key = ESCAPE_KEYS[seq];
        if (key) ops.push({ keys: [key] });
        i += seq.length - 1;
      } else if (c === "\x03") {
        flush();
        ops.push({ keys: ["ctrl+c"] });
      } else if (code < 32) {
        // Other raw control chars: drop rather than paste garbage.
        flush();
      } else {
        run += c;
      }
    }
    flush();
    return ops;
  }

  function onData(data) {
    if (!currentPaneId || disposed) return;
    for (const op of translateChunk(data)) enqueueSend(op);
  }

  function enterReadOnly() {
    readOnly = true;
    setConn("read-only", "idle");
    renderStatus("this pane was not spawned by this server — input refused (safety guard)");
    banner.hidden = false;
  }

  // ------------------------------------------------------------- xterm mount
  function ensureTerminal() {
    ensureDeps()
      .then(() => {
        if (disposed || term) return;
        body.innerHTML = "";
        const holder = el("div", "varb-term");
        body.append(holder);

        const t = new window.Terminal({
          cursorBlink: true,
          fontSize: 13,
          fontFamily:
            'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
          theme: {
            background: "#0d1119",
            foreground: "#d4dae4",
            cursor: "#4cc2ff",
            cursorAccent: "#0d1119",
          },
          scrollback: 2000,
        });
        const f = new window.FitAddon.FitAddon();
        t.loadAddon(f);
        t.open(holder);
        f.fit();
        t.onData(onData);
        term = t;
        fit = f;
        if (lastText !== null) t.write(lastText);
      })
      .catch((err) => {
        if (!disposed) renderStatus(`terminal deps failed: ${err.message}`);
      });
  }

  function onResize() {
    if (fit && !disposed) fit.fit();
  }
  window.addEventListener("resize", onResize);

  // A poll right after a send burst, debounced, so typing feels snappy.
  function scheduleRead() {
    if (readTimer) clearTimeout(readTimer);
    readTimer = setTimeout(() => {
      readTimer = null;
      void readOnce().catch(() => {});
    }, READ_AFTER_SEND_DEBOUNCE_MS);
  }

  // ------------------------------------------------------------------- start
  if (currentPaneId) {
    setConn("polling", "polling");
    ensureTerminal();
    void readOnce().then(startPolling).catch(() => startPolling());
  } else {
    const launch = el("div", "varb-launch");
    const card = el("div", "varb-launch-card");
    const heading = el("div", "varb-launch-title", "Spawn a fake agent");
    const sub = el(
      "div",
      "varb-launch-sub",
      "Creates a new herdr pane (pane.split, focus:false, in this worktree) " +
        "running a colourful agent-like loop that occasionally pauses for " +
        "approval input — so you can safely try typing, Enter, and Ctrl+C. " +
        "It never touches a live agent pane.",
    );
    const btn = el("button", "varb-launch-btn", "Spawn fake agent");
    btn.type = "button";
    btn.addEventListener("click", () => {
      btn.disabled = true;
      btn.textContent = "Spawning…";
      doSpawn()
        .then(() => startPolling())
        .catch((err) => {
          btn.disabled = false;
          btn.textContent = "Spawn fake agent";
          renderStatus(`spawn failed: ${err.message}`);
        });
    });
    card.append(heading, sub, btn);
    launch.append(card);
    body.append(launch);
    setConn("no pane", "idle");
  }

  popout.addEventListener("click", () => {
    if (!currentPaneId) return;
    post("/api/focus", { pane_id: currentPaneId })
      .then(() => renderStatus("focused in herdr"))
      .catch((err) => renderStatus(`focus failed: ${err.message}`));
  });

  // Read-only preview flavour (variant A's read path), surfaced here too.
  const peek = el("button", "varb-status-peek", "peek");
  peek.type = "button";
  peek.addEventListener("click", () => {
    if (!currentPaneId) return;
    fetch(`/api/peek?pane_id=${encodeURIComponent(currentPaneId)}&lines=${PEEK_LINES}`)
      .then((r) => r.json())
      .then((d) => {
        const short = (d.text || "").split("\n").slice(-PEEK_LINES).join("\n");
        renderStatus(`peek (${(d.text || "").length} chars): ${short}`);
      })
      .catch((err) => renderStatus(`peek failed: ${err.message}`));
  });
  status.append(peek);

  return {
    dispose() {
      disposed = true;
      if (pollTimer) clearInterval(pollTimer);
      if (readTimer) clearTimeout(readTimer);
      window.removeEventListener("resize", onResize);
      if (term) term.dispose();
      term = null;
      fit = null;
      root.remove();
    },
  };
}