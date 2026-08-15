const NODES = [
  "grill",
  "writeSpec",
  "approveSpec",
  "schedule",
  "implementTicket",
  "review",
];

const nodesEl = document.getElementById("nodes");
const ticketsEl = document.getElementById("tickets");
const packetEl = document.getElementById("packet");
const specEl = document.getElementById("spec");
const interruptEl = document.getElementById("interrupt");
const logEl = document.getElementById("log");
const metaEl = document.getElementById("meta");

async function tick() {
  const res = await fetch("/api/state");
  if (!res.ok) {
    metaEl.textContent = `state ${res.status}`;
    return;
  }
  const data = await res.json();
  const next = new Set(data.next ?? []);
  nodesEl.replaceChildren(
    ...NODES.map((name) => {
      const el = document.createElement("span");
      el.className = next.has(name) ? "node next" : "node";
      el.textContent = name;
      return el;
    }),
  );

  const tickets = data.values?.tickets ?? [];
  ticketsEl.replaceChildren(
    ...tickets.map((ticket) => {
      const row = document.createElement("div");
      row.className = "ticket";
      const left = document.createElement("span");
      left.textContent = `${ticket.id} ${ticket.title}`;
      const right = document.createElement("span");
      right.className = ticket.status;
      right.textContent =
        ticket.status +
        (ticket.blockedBy?.length ? ` ← ${ticket.blockedBy.join(",")}` : "");
      row.append(left, right);
      return row;
    }),
  );
  if (tickets.length === 0) ticketsEl.textContent = "none yet";

  packetEl.textContent = data.values?.packet || "—";
  specEl.textContent = data.values?.spec || "—";

  const interrupts = (data.tasks ?? []).flatMap((task) =>
    (task.interrupts ?? []).map((item) => ({ node: task.name, ...item })),
  );
  interruptEl.textContent = interrupts.length
    ? JSON.stringify(interrupts, null, 2)
    : "none";

  const log = data.values?.log ?? [];
  logEl.replaceChildren(
    ...log.slice(-20).map((line) => {
      const li = document.createElement("li");
      li.textContent = line;
      return li;
    }),
  );

  const status = data.values?.grillStatus ?? "idle";
  metaEl.textContent = `thread ${data.threadId} · grill ${status} · next ${
    next.size ? [...next].join(", ") : "—"
  }`;
}

tick();
setInterval(tick, 800);
