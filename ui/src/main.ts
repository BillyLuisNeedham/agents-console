/**
 * Console: the pool rendered as node cards on a canvas. One Bun server per
 * pool serves the built SPA with the first snapshot embedded in it, and one
 * WebSocket over which it pushes every change and answers every request
 * (issue #161, ADR-0032). The UI renders from that snapshot only; ticket
 * cards and their blocked-by edges render the thread. This file is the
 * page's own part: the socket's URL, the tab title and favicon, the restart
 * probe and the version reload. console.ts composes the rest.
 */

import "./styles.css";
import { EMBED_ELEMENT_ID, WS_PATH } from "../../protocol/protocol.ts";
import { readEmbeddedBoot } from "./protocol";
import { createConsole } from "./console";
import { POOL_TAB_COLORS, poolTabTitle } from "./project";
import type { ConsoleSession } from "./session";
import { reloadForVersion, windowNameStore } from "./socket";

const appRoot = document.getElementById("app");
if (!appRoot) throw new Error("#app not found");
const root: HTMLElement = appRoot;

// The favicon: one reused link element whose href is a canvas-drawn dot in
// the pool status color. The idle grey dot stands from page load, before the
// first snapshot lands; every applied snapshot swaps the dot on the title's
// cadence.
const faviconLink = document.createElement("link");
faviconLink.rel = "icon";
document.head.appendChild(faviconLink);
let faviconColor = "";

function setFavicon(color: string): void {
  if (color === faviconColor) return;
  faviconColor = color;
  const canvas = document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(16, 16, 14, 0, Math.PI * 2);
  ctx.fill();
  faviconLink.href = canvas.toDataURL("image/png");
}

setFavicon(POOL_TAB_COLORS.idle);

/** The tab title and favicon follow the latest snapshot's pool status; the
 *  session computes it, the DOM write is the page's. They are written on
 *  every session change, not left to the render loop's frame: a hidden tab
 *  gets no frames, and the tab strip is exactly where an operator on
 *  another tab watches the pool's status. */
function updateTab(session: ConsoleSession): void {
  const status = session.tabStatus;
  if (status && session.poolName) {
    const title = poolTabTitle(session.poolName, status);
    if (document.title !== title) document.title = title;
    setFavicon(status.color);
  }
}

/** The socket's URL: the page's own origin, over ws or wss to match. */
function socketUrl(): string {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location.host}${WS_PATH}`;
}

/** The port this page is served from, the scheme's default when implicit. */
function currentPort(): string {
  if (location.port) return location.port;
  return location.protocol === "https:" ? "443" : "80";
}

/**
 * Whether a server is answering on a port, for the relaunch poll after a
 * Restart. A restart that changed the port makes this a cross-origin
 * request, and the pool server sends no CORS headers, so the response would
 * be unreadable; `no-cors` asks for an opaque one instead, which is all the
 * probe needs. Resolving at all means something accepted the connection;
 * nothing listening rejects. It stays HTTP: it runs only after a Restart,
 * against a port with no socket yet.
 */
async function probeServer(port: number): Promise<boolean> {
  const url = `${location.protocol}//${location.hostname}:${port}/api/state`;
  try {
    await fetch(url, { mode: "no-cors", cache: "no-store" });
    return true;
  } catch {
    return false;
  }
}

/**
 * The relaunched server is up: hand the page over to it. A new port is a new
 * origin, so the page goes there. The same port reloads rather than leaning
 * on the socket's own retry, because a Restart is the moment Boot rebuilds a
 * stale UI: the bytes this page is running may be the ones it just replaced,
 * and only a reload picks up the new ones.
 */
function handOverTo(port: number): void {
  if (String(port) !== currentPort()) {
    location.assign(`${location.protocol}//${location.hostname}:${port}${location.pathname}`);
    return;
  }
  location.reload();
}

/** The session's storage, or null where reading it throws. */
function sessionStore(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

const app = createConsole({
  root,
  openSocket: () => new WebSocket(socketUrl()),
  boot: readEmbeddedBoot(document.getElementById(EMBED_ELEMENT_ID)?.textContent),
  visibility: document,
  probeServer,
  onRelaunched: handOverTo,
  // A page built for another protocol version reloads for the UI the server
  // now serves, once: a second mismatch inside the guard window shows the
  // banner instead of looping.
  onVersionMismatch: () =>
    reloadForVersion(
      sessionStore(),
      Date.now(),
      () => location.reload(),
      windowNameStore(window),
    ),
  onSessionChange: updateTab,
});

// On a dev HMR re-execution this module runs again and builds a fresh
// Console; dispose the old one or its socket and timers double up.
import.meta.hot?.dispose(() => app.dispose());

app.start();
