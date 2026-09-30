import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT || 8787);
const rooms = new Map();
const mimeTypes = { ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml" };

function serveFile(request, response) {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);
  const pathname = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
  const relativePath = normalize(decodeURIComponent(pathname)).replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = join(root, relativePath);
  if (!filePath.startsWith(root) || !existsSync(filePath) || !statSync(filePath).isFile()) { response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); response.end("Not found"); return; }
  response.writeHead(200, { "cache-control": "no-store", "content-type": mimeTypes[extname(filePath)] || "application/octet-stream" });
  createReadStream(filePath).pipe(response);
}

const server = createServer(serveFile);
const wss = new WebSocketServer({ server, path: "/ws" });
function sanitizeRoomId(value) { const roomId = String(value || "").replace(/\D/g, "").slice(0, 6); return roomId.length === 6 ? roomId : null; }
function sanitizeName(value) { return String(value || "Гость").trim().slice(0, 32) || "Гость"; }
function sanitizeVideoUrl(value) { try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) ? url.href : null; } catch { return null; } }
function roomUsers(room) { return [...room.users.values()].map(({ userId, name, isHost, telemetry }) => ({ userId, name, isHost, telemetry: telemetry || null })); }
function send(socket, payload) { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload)); }
function broadcast(room, payload, except = null) { for (const user of room.users.values()) if (user.socket !== except) send(user.socket, payload); }
function removeFromRoom(socket) {
  const room = rooms.get(socket.roomId); if (!room || !socket.userId) return;
  room.users.delete(socket);
  if (room.users.size === 0) rooms.delete(socket.roomId); else broadcast(room, { type: "USERS", users: roomUsers(room) });
}
function roomState(room, socket) {
  return { type: "ROOM_STATE", roomId: room.id, isHost: socket.isHost === true, videoUrl: room.videoUrl, playback: room.playback, users: roomUsers(room) };
}
function handleCreate(socket, message) {
  const roomId = sanitizeRoomId(message.roomId); const userId = String(message.userId || "").slice(0, 80); const videoUrl = sanitizeVideoUrl(message.videoUrl); const hostToken = String(message.hostToken || "").slice(0, 120);
  if (!roomId || !userId || !videoUrl || hostToken.length < 20) { send(socket, { type: "ERROR", code: "INVALID_CREATE", message: "Проверьте имя и ссылку на фильм" }); return; }
  if (rooms.has(roomId)) { send(socket, { type: "ERROR", code: "ROOM_EXISTS", message: "Такой код уже занят, создаю другой" }); return; }
  removeFromRoom(socket);
  const room = { id: roomId, hostToken, users: new Map(), videoUrl, playback: { playing: false, position: 0, updatedAt: Date.now(), revision: 0 } };
  rooms.set(roomId, room); socket.roomId = roomId; socket.userId = userId; socket.isHost = true;
  room.users.set(socket, { userId, name: sanitizeName(message.name), isHost: true, telemetry: null, socket });
  send(socket, roomState(room, socket));
}
function handleJoin(socket, message) {
  const roomId = sanitizeRoomId(message.roomId); const userId = String(message.userId || "").slice(0, 80);
  if (!roomId || !userId) { send(socket, { type: "ERROR", message: "Некорректная комната или пользователь" }); return; }
  const room = rooms.get(roomId);
  if (!room) { send(socket, { type: "ERROR", code: "ROOM_NOT_FOUND", message: "Комната не найдена или уже закрыта" }); return; }
  removeFromRoom(socket); socket.roomId = roomId; socket.userId = userId; socket.isHost = String(message.hostToken || "") === room.hostToken;
  room.users.set(socket, { userId, name: sanitizeName(message.name), isHost: socket.isHost, telemetry: null, socket });
  send(socket, roomState(room, socket));
  broadcast(room, { type: "USERS", users: roomUsers(room) }, socket);
}
function handleSetVideo(socket, message) {
  const room = rooms.get(socket.roomId); const videoUrl = sanitizeVideoUrl(message.videoUrl);
  if (!room || !videoUrl) { send(socket, { type: "ERROR", message: "Некорректная ссылка на фильм" }); return; }
  if (!socket.isHost) { send(socket, { type: "ERROR", code: "HOST_ONLY", message: "Ссылку может менять только создатель комнаты" }); return; }
  room.videoUrl = videoUrl; room.playback = { playing: false, position: 0, updatedAt: Date.now(), revision: room.playback.revision + 1 };
  broadcast(room, { type: "VIDEO_SET", videoUrl, playback: room.playback });
}
function handlePlayerEvent(socket, message) {
  const room = rooms.get(socket.roomId); const event = message.event || {};
  if (!room || !["play", "pause", "seek"].includes(event.action)) return;
  const position = Number(event.position); if (!Number.isFinite(position) || position < 0) return;
  const playing = event.action === "play" ? true : event.action === "pause" ? false : room.playback.playing;
  room.playback = { playing, position, updatedAt: Date.now(), revision: room.playback.revision + 1 };
  broadcast(room, { type: "PLAYER_COMMAND", playback: room.playback }, socket);
}
function finiteNumber(value, fallback = null, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}
function handleTelemetry(socket, message) {
  const room = rooms.get(socket.roomId); const user = room?.users.get(socket); const input = message.telemetry || {};
  if (!room || !user) return;
  user.telemetry = {
    position: finiteNumber(input.position, 0, 0, 60 * 60 * 24),
    duration: finiteNumber(input.duration, null, 0, 60 * 60 * 24),
    paused: Boolean(input.paused),
    buffering: Boolean(input.buffering),
    readyState: finiteNumber(input.readyState, 0, 0, 4),
    bufferAhead: finiteNumber(input.bufferAhead, 0, 0, 60 * 60),
    ping: finiteNumber(input.ping, null, 0, 60_000),
    downlink: finiteNumber(input.downlink, null, 0, 10_000),
    effectiveType: String(input.effectiveType || "").slice(0, 12) || null,
    droppedFrames: finiteNumber(input.droppedFrames, null, 0),
    totalFrames: finiteNumber(input.totalFrames, null, 0),
    updatedAt: Date.now()
  };
  broadcast(room, { type: "TELEMETRY", userId: user.userId, telemetry: user.telemetry });
}
wss.on("connection", (socket) => {
  socket.isAlive = true; socket.on("pong", () => { socket.isAlive = true; });
  socket.on("message", (buffer) => {
    let message; try { message = JSON.parse(buffer.toString()); } catch { send(socket, { type: "ERROR", message: "Некорректный JSON" }); return; }
    if (message.type === "CREATE") handleCreate(socket, message);
    else if (message.type === "JOIN") handleJoin(socket, message);
    else if (message.type === "SET_VIDEO") handleSetVideo(socket, message);
    else if (message.type === "PLAYER_EVENT") handlePlayerEvent(socket, message);
    else if (message.type === "TELEMETRY") handleTelemetry(socket, message);
    else if (message.type === "PING") send(socket, { type: "PONG", sentAt: finiteNumber(message.sentAt, Date.now(), 0) });
  });
  socket.on("close", () => removeFromRoom(socket));
});
const heartbeat = setInterval(() => { for (const socket of wss.clients) { if (!socket.isAlive) { socket.terminate(); continue; } socket.isAlive = false; socket.ping(); } }, 30_000);
server.on("close", () => clearInterval(heartbeat));
server.listen(port, "0.0.0.0", () => console.log(`Kult Watch Party: http://127.0.0.1:${port}`));
