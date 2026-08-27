// MP_Tetris server: static frontend + WebSocket relay on one port (default 6000).
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, normalize, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import type { ClientMsg, RoundRecord } from "../../shared/protocol.js";
import { RoomManager } from "./rooms.js";
import { ScoreStore } from "./scores.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// dist layout: dist-server/server/src/index.js  |  dist-client/ (vite build)
// __dirname = <root>/dist-server/server/src  ->  root is three levels up
const ROOT = join(__dirname, "..", "..", "..");
const DIST_CLIENT = process.env.DIST_CLIENT ?? join(ROOT, "dist-client");
const DATA_DIR = process.env.DATA_DIR ?? join(ROOT, "data");
const PORT = Number(process.env.PORT ?? 6000);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const httpServer = createServer((req, res) => {
  const url = (req.url ?? "/").split("?")[0];
  if (url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  let filePath = url === "/" ? "/index.html" : url;
  const abs = normalize(join(DIST_CLIENT, filePath));
  if (!abs.startsWith(normalize(DIST_CLIENT)) || !existsSync(abs) || !statSync(abs).isFile()) {
    // SPA fallback for unknown non-asset paths
    const index = join(DIST_CLIENT, "index.html");
    if (existsSync(index) && !/\.[a-z0-9]+$/i.test(url)) {
      res.writeHead(200, { "content-type": MIME[".html"] });
      res.end(readFileSync(index));
      return;
    }
    res.writeHead(404);
    res.end("not found");
    return;
  }
  const ext = extname(abs).toLowerCase();
  res.writeHead(200, {
    "content-type": MIME[ext] ?? "application/octet-stream",
    "cache-control": ext === ".html" ? "no-cache" : "public, max-age=3600",
  });
  res.end(readFileSync(abs));
});

const wss = new WebSocketServer({ noServer: true });
const rooms = new RoomManager();
const scores = new ScoreStore(join(DATA_DIR, "scores.json"));
rooms.setRecorder((round: RoundRecord) => {
  const top = scores.addRound(round);
  // broadcast the updated board to everyone in every room
  for (const ws of wss.clients) if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: "scores", rounds: top }));
});

httpServer.on("upgrade", (req, socket, head) => {
  if ((req.url ?? "") !== "/ws") { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (ws: WebSocket) => {
  // Keepalive: ping every 20s; the 'close' event handles cleanup for dead sockets.
  const keepAlive = setInterval(() => {
    try { ws.ping(); } catch { /* closed */ }
  }, 20_000);

  ws.on("close", () => {
    clearInterval(keepAlive);
    rooms.removePlayer(ws, true);
  });
  ws.on("error", () => { /* handled via close */ });

  ws.on("message", (data) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(String(data)) as ClientMsg;
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object" || !("t" in msg)) return;
    rooms.handle(ws, msg);
  });
});

httpServer.listen(PORT, () => {
  console.log(`[mp-tetris] listening on :${PORT} (client dir: ${DIST_CLIENT})`);
});
