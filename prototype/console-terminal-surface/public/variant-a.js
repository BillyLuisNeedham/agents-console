// PROTOTYPE — throwaway, issue #29 terminal-surface exploration
export function mountVariantA(container, ctx) {
  const card = document.createElement("div");
  card.className = "va-card";

  const header = document.createElement("div");
  header.className = "va-header";
  header.innerHTML = `
    <span class="va-kanban">Ticket #29</span>
    <span class="va-title">North Star — interactable terminal</span>
  `;

  const status = document.createElement("div");
  status.className = "va-status";
  status.innerHTML = `
    <span class="va-status-label">Attempt #3</span>
    <span class="va-dot va-dot-running"></span>
    <span class="va-status-running">running</span>
    <span class="va-status-type">Terminal-backed (herdr pane w:p)</span>
  `;

  const peek = document.createElement("div");
  peek.className = "va-peek";
  peek.innerHTML = `
    <div class="va-peek-bar">
      <span class="va-peek-label">pane peek</span>
      <span class="va-peek-rev">rev —</span>
    </div>
    <pre class="va-peek-body"><span class="va-peek-placeholder">waiting for pane…</span></pre>
    <div class="va-peek-foot">read-only viewport · live input happens in herdr</div>
  `;

  const peekBody = peek.querySelector(".va-peek-body");
  const peekRev = peek.querySelector(".va-peek-rev");

  const action = document.createElement("div");
  action.className = "va-action";
  const focusBtn = document.createElement("button");
  focusBtn.className = "va-focus";
  focusBtn.type = "button";
  focusBtn.textContent = "Open in herdr ➚";

  const chip = document.createElement("div");
  chip.className = "va-chip";
  const chipCode = document.createElement("code");
  chipCode.className = "va-chip-code";
  chipCode.textContent = "herdr agent attach ";
  const chipPane = document.createElement("span");
  chipPane.className = "va-chip-pane";
  const copyBtn = document.createElement("button");
  copyBtn.className = "va-copy";
  copyBtn.type = "button";
  copyBtn.textContent = "copy";
  chip.append(chipCode, chipPane, copyBtn);

  const hint = document.createElement("div");
  hint.className = "va-hint";
  hint.innerHTML = `<span class="va-hint-caret">▍</span><span class="va-hint-text">type here…</span><span class="va-hint-arrow">input happens in herdr →</span>`;

  action.append(focusBtn, chip, hint);
  card.append(header, status, peek, action);

  const empty = document.createElement("div");
  empty.className = "va-empty";
  empty.innerHTML = `
    <div class="va-empty-title">no running attempt</div>
    <div class="va-empty-sub">nothing attached yet — spawn a throwaway herdr pane to explore the surface.</div>
  `;
  const spawnBtn = document.createElement("button");
  spawnBtn.className = "va-spawn";
  spawnBtn.type = "button";
  spawnBtn.textContent = "Spawn fake agent (prototype)";
  empty.append(spawnBtn);

  let toast = null;
  function showToast(text) {
    if (toast) toast.remove();
    toast = document.createElement("div");
    toast.className = "va-toast";
    toast.textContent = text;
    document.body.appendChild(toast);
    setTimeout(() => {
      if (toast) {
        toast.remove();
        toast = null;
      }
    }, 4000);
  }

  async function focusPane() {
    try {
      await fetch("/api/focus", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pane_id: ctx.paneId }),
      });
      showToast(`Focused pane ${ctx.paneId} in herdr — look at your terminal`);
    } catch {
      showToast("focus failed — is the server up?");
    }
  }

  async function copyCmd() {
    const cmd = `herdr agent attach ${ctx.paneId}`;
    try {
      await navigator.clipboard.writeText(cmd);
      copyBtn.textContent = "copied";
      setTimeout(() => {
        copyBtn.textContent = "copy";
      }, 1500);
    } catch {
      showToast("copy blocked — select the command manually");
    }
  }

  let pollTimer = null;
  let alive = true;

  function stopPoll() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function renderPeek(text, revision, truncated) {
    peekBody.textContent = text;
    if (revision != null) {
      peekRev.textContent = `rev ${revision}${truncated ? " · truncated" : ""}`;
    }
  }

  function startPoll() {
    if (!ctx.paneId) return;
    stopPoll();
    async function tick() {
      if (!alive) return;
      try {
        const r = await fetch(`/api/peek?pane_id=${encodeURIComponent(ctx.paneId)}&lines=8`);
        const j = await r.json();
        if (alive) renderPeek(j.text || "", j.revision, !!j.truncated);
      } catch {
        if (alive) renderPeek("peek unavailable — server not running?", null, false);
      }
    }
    tick();
    pollTimer = setInterval(tick, 2000);
  }

  function renderCard() {
    chipPane.textContent = ctx.paneId || "";
    copyBtn.style.display = ctx.paneId ? "" : "none";
    focusBtn.disabled = !ctx.paneId;
  }

  async function spawn() {
    spawnBtn.disabled = true;
    spawnBtn.textContent = "spawning…";
    try {
      const r = await fetch("/api/spawn-fake-agent", { method: "POST" });
      const j = await r.json();
      if (j.pane_id) {
        ctx.paneId = j.pane_id;
        ctx.persistPane(j.pane_id);
        container.innerHTML = "";
        mountVariantA(container, ctx);
      } else {
        spawnBtn.textContent = "spawn failed — no pane_id";
      }
    } catch {
      spawnBtn.textContent = "spawn failed — is the server up?";
    }
  }

  focusBtn.addEventListener("click", focusPane);
  copyBtn.addEventListener("click", copyCmd);
  spawnBtn.addEventListener("click", spawn);

  if (ctx.paneId) {
    renderCard();
    container.append(card);
    startPoll();
  } else {
    container.append(empty);
  }

  return {
    dispose() {
      alive = false;
      stopPoll();
      if (toast) toast.remove();
    },
  };
}