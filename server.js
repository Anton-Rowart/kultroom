import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT || 8787);
const rooms = new Map();
const testReactionChannels = new Map();
const allowedReactions = new Set(["🤡", "❤️", "😱", "🔥", "🤟", "😢", "🏳️‍🌈"]);
const mimeTypes = {
	".css": "text/css; charset=utf-8",
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".png": "image/png",
	".svg": "image/svg+xml",
	".webp": "image/webp",
};

function serveFile(request, response) {
	const requestUrl = new URL(request.url, `http://${request.headers.host}`);
	const pathname = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
	const relativePath = normalize(decodeURIComponent(pathname)).replace(/^(\.\.(\/|\\|$))+/, "");
	const filePath = join(root, relativePath);
	if (!filePath.startsWith(root) || !existsSync(filePath) || !statSync(filePath).isFile()) {
		response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
		response.end("Not found");
		return;
	}
	response.writeHead(200, {
		"cache-control": "no-store",
		"content-type": mimeTypes[extname(filePath)] || "application/octet-stream",
	});
	createReadStream(filePath).pipe(response);
}

function sendJson(response, status, payload, origin = "*") {
	response.writeHead(status, {
		"access-control-allow-origin": origin,
		"cache-control": "no-store",
		"content-type": "application/json; charset=utf-8",
	});
	response.end(JSON.stringify(payload));
}

function providerConfig(html) {
	const token = html.match(/'DLE-API-TOKEN':'([^']+)'/)?.[1];
	const requestId = html.match(/'Iframe-Request-Id':'([^']+)'/)?.[1];
	const baseUrl = html.match(/window\.ENV_BASE_URL='([^']+)'/)?.[1];
	if (!token || !requestId || !baseUrl) throw new Error("Источник не вернул параметры доступа");
	return { token, requestId, baseUrl };
}

async function checkedFetch(url, options = {}) {
	const response = await fetch(url, { ...options, signal: AbortSignal.timeout(20_000) });
	if (!response.ok) throw new Error(`${new URL(url).hostname}: HTTP ${response.status}`);
	return response;
}

async function serveTestPlayer(request, response, requestUrl) {
	const origin = request.headers.origin || "*";
	if (request.method === "OPTIONS") {
		response.writeHead(204, {
			"access-control-allow-headers": "content-type",
			"access-control-allow-methods": "GET, OPTIONS",
			"access-control-allow-origin": origin,
		});
		response.end();
		return;
	}
	if (request.method !== "GET") {
		sendJson(response, 405, { error: "Method not allowed" }, origin);
		return;
	}

	const kinopoiskId = requestUrl.searchParams.get("kinopoisk") || "467293";
	if (kinopoiskId !== "467293") {
		sendJson(response, 400, { error: "В тестовом endpoint разрешён только фильм 467293" }, origin);
		return;
	}

	try {
		const playersResponse = await checkedFetch(`https://fbphdplay.top/api/players?kinopoisk=${kinopoiskId}`);
		const players = await playersResponse.json();
		const source = players.data?.find((item) => item.type === "Veoveo" && item.iframeUrl);
		if (!source) throw new Error("Для фильма не найден совместимый источник");

		const iframeUrl = new URL(source.iframeUrl);
		const movieId = iframeUrl.searchParams.get("movie_id");
		if (!movieId) throw new Error("Источник не вернул ID фильма");

		const iframeResponse = await checkedFetch(iframeUrl);
		const config = providerConfig(await iframeResponse.text());
		const upstreamOrigin = request.headers.origin || `http://${request.headers.host}`;
		const headers = {
			"CDC-FRIENDLY": "true",
			"DLE-API-TOKEN": config.token,
			"Iframe-Request-Id": config.requestId,
			"X-Ancestor-Origin": upstreamOrigin,
			"X-Has-Token": "true",
			"X-Parent-Referrer": request.headers.referer || upstreamOrigin,
		};
		const catalogUrl = `${config.baseUrl}/catalog-api`;
		const [movieResponse, episodesResponse] = await Promise.all([
			checkedFetch(`${catalogUrl}/contents/${encodeURIComponent(movieId)}`, { headers }),
			checkedFetch(`${catalogUrl}/episodes?content-id=${encodeURIComponent(movieId)}`, { headers }),
		]);
		const [movie, episodes] = await Promise.all([movieResponse.json(), episodesResponse.json()]);
		const variants = episodes.flatMap((episode) => episode.episodeVariants || []).filter((variant) => variant.filepath);
		const variant = variants.find((item) => /дуб|многоголос/i.test(item.title || "")) || variants[0];
		if (!variant) throw new Error("Источник не вернул видеопоток");

		const expiresAt = Number(variant.filepath.match(/\/content-router\/r\/(\d+)\//)?.[1] || 0) * 1000 || null;
		sendJson(
			response,
			200,
			{
				movie: {
					contentType: movie.contentType ? { name: movie.contentType.name } : null,
					kinopoiskId: movie.kinopoiskId,
					posterUrl: movie.posterUrl,
					title: movie.title,
					year: movie.year,
				},
				variant: {
					duration: variant.duration,
					filepath: variant.filepath,
					previewImageFilepath: variant.previewImageFilepath,
					title: variant.title,
				},
				expiresAt,
			},
			origin,
		);
	} catch (error) {
		console.error("Test player resolver:", error);
		sendJson(response, 502, { error: error?.message || String(error) }, origin);
	}
}

function upstreamMediaUrl(value) {
	const url = new URL(value);
	if (url.protocol !== "https:" || url.hostname !== "gorodyshka.link" || !url.pathname.startsWith("/content-router/r/")) {
		throw new Error("Недопустимый адрес тестового медиапотока");
	}
	return url;
}

function nestedMediaUrl(value, base) {
	const candidate = new URL(value, base);
	if (candidate.hostname === "gorodyshka.link" && /^\/\d+\//.test(candidate.pathname)) {
		candidate.pathname = `/content-router/r${candidate.pathname}`;
	}
	return upstreamMediaUrl(candidate);
}

function proxyMediaUrl(url, request) {
	const protocol = String(request.headers["x-forwarded-proto"] || "http")
		.split(",")[0]
		.trim();
	const proxy = new URL("/api/test-player/media", `${protocol}://${request.headers.host}`);
	proxy.searchParams.set("url", url.href);
	return proxy.href;
}

function rewriteManifest(text, upstreamUrl, request) {
	return text
		.split(/\r?\n/)
		.map((line) => {
			if (!line) return line;
			if (!line.startsWith("#")) return proxyMediaUrl(nestedMediaUrl(line, upstreamUrl), request);
			return line.replace(
				/URI="([^"]+)"/g,
				(_match, value) => `URI="${proxyMediaUrl(nestedMediaUrl(value, upstreamUrl), request)}"`,
			);
		})
		.join("\n");
}

async function fetchMedia(url, options = {}) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(new DOMException("Медиаисточник не ответил вовремя", "TimeoutError")), 30_000);
	try {
		// Таймаут нужен только до получения ответа. Ограничивать им чтение всего
		// фильма нельзя: большой медиапоток закономерно загружается дольше 30 секунд.
		return await fetch(url, { ...options, signal: controller.signal });
	} finally {
		clearTimeout(timeout);
	}
}

async function sendMediaBody(body, response) {
	const reader = body.getReader();
	let cancelPromise;
	const cancel = () => {
		cancelPromise ||= reader.cancel().catch(() => {});
		return cancelPromise;
	};
	response.once("close", cancel);
	try {
		while (!response.destroyed && !response.writableEnded) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!response.write(value)) {
				await new Promise((resolve) => {
					const finish = () => {
						response.off("drain", finish);
						response.off("close", finish);
						response.off("error", finish);
						resolve();
					};
					response.once("drain", finish);
					response.once("close", finish);
					response.once("error", finish);
				});
			}
		}
		if (!response.destroyed && !response.writableEnded) response.end();
	} finally {
		response.off("close", cancel);
		await cancel();
		reader.releaseLock();
	}
}

async function serveTestMedia(request, response, requestUrl) {
	const origin = request.headers.origin || "*";
	if (request.method !== "GET") {
		sendJson(response, 405, { error: "Method not allowed" }, origin);
		return;
	}
	try {
		const upstreamUrl = upstreamMediaUrl(requestUrl.searchParams.get("url") || "");
		const headers = {};
		if (request.headers.range) headers.range = request.headers.range;
		const upstream = await fetchMedia(upstreamUrl, { headers });
		if (!upstream.ok) throw new Error(`Медиаисточник: HTTP ${upstream.status}`);
		const contentType = upstream.headers.get("content-type") || "application/octet-stream";
		if (/mpegurl|m3u8/i.test(contentType) || upstreamUrl.pathname.endsWith(".m3u8")) {
			const manifest = rewriteManifest(await upstream.text(), upstreamUrl, request);
			response.writeHead(200, {
				"access-control-allow-origin": origin,
				"cache-control": "no-store",
				"content-type": "application/vnd.apple.mpegurl",
			});
			response.end(manifest);
			return;
		}
		const responseHeaders = {
			"access-control-allow-origin": origin,
			"cache-control": "no-store",
			"content-type": contentType,
		};
		for (const name of ["accept-ranges", "content-length", "content-range"]) {
			const value = upstream.headers.get(name);
			if (value) responseHeaders[name] = value;
		}
		if (!upstream.body) throw new Error("Медиаисточник вернул пустой поток");
		response.writeHead(upstream.status, responseHeaders);
		await sendMediaBody(upstream.body, response);
	} catch (error) {
		const clientClosed = response.destroyed || request.destroyed;
		if (clientClosed) return;
		console.error("Test media proxy:", error);
		if (response.headersSent) {
			// Заголовки/часть сегмента уже могли уйти в браузер. В этом случае
			// нельзя отправлять второй HTTP-ответ — закрываем только этот запрос.
			if (!response.writableEnded) response.destroy();
			return;
		}
		sendJson(response, 502, { error: error?.message || String(error) }, origin);
	}
}

const server = createServer((request, response) => {
	const requestUrl = new URL(request.url, `http://${request.headers.host}`);
	if (requestUrl.pathname === "/api/test-player/media") {
		serveTestMedia(request, response, requestUrl);
		return;
	}
	if (requestUrl.pathname === "/api/test-player") {
		serveTestPlayer(request, response, requestUrl);
		return;
	}
	serveFile(request, response);
});
const wss = new WebSocketServer({ server, path: "/ws" });
function sanitizeRoomId(value) {
	const roomId = String(value || "")
		.replace(/\D/g, "")
		.slice(0, 6);
	return roomId.length === 6 ? roomId : null;
}
function sanitizeName(value) {
	return (
		String(value || "Гость")
			.trim()
			.slice(0, 32) || "Гость"
	);
}
function sanitizeVideoUrl(value) {
	try {
		const url = new URL(value);
		return ["https:", "http:"].includes(url.protocol) ? url.href : null;
	} catch {
		return null;
	}
}
function roomUsers(room) {
	return [...room.users.values()].map(({ userId, name, isHost, telemetry }) => ({
		userId,
		name,
		isHost,
		telemetry: telemetry || null,
	}));
}
function send(socket, payload) {
	if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}
function broadcast(room, payload, except = null) {
	for (const user of room.users.values()) if (user.socket !== except) send(user.socket, payload);
}
function removeFromRoom(socket) {
	const room = rooms.get(socket.roomId);
	if (!room || !socket.userId) return;
	room.users.delete(socket);
	if (room.users.size === 0) rooms.delete(socket.roomId);
	else broadcast(room, { type: "USERS", users: roomUsers(room) });
}
function roomState(room, socket) {
	return {
		type: "ROOM_STATE",
		roomId: room.id,
		isHost: socket.isHost === true,
		videoUrl: room.videoUrl,
		playback: room.playback,
		users: roomUsers(room),
	};
}
function handleCreate(socket, message) {
	const roomId = sanitizeRoomId(message.roomId);
	const userId = String(message.userId || "").slice(0, 80);
	const videoUrl = sanitizeVideoUrl(message.videoUrl);
	const hostToken = String(message.hostToken || "").slice(0, 120);
	if (!roomId || !userId || !videoUrl || hostToken.length < 20) {
		send(socket, { type: "ERROR", code: "INVALID_CREATE", message: "Проверьте имя и ссылку на фильм" });
		return;
	}
	if (rooms.has(roomId)) {
		send(socket, { type: "ERROR", code: "ROOM_EXISTS", message: "Такой код уже занят, создаю другой" });
		return;
	}
	removeFromRoom(socket);
	const room = {
		id: roomId,
		hostToken,
		users: new Map(),
		videoUrl,
		playback: { playing: false, position: 0, updatedAt: Date.now(), revision: 0 },
	};
	rooms.set(roomId, room);
	socket.roomId = roomId;
	socket.userId = userId;
	socket.isHost = true;
	room.users.set(socket, { userId, name: sanitizeName(message.name), isHost: true, telemetry: null, socket });
	send(socket, roomState(room, socket));
}
function handleJoin(socket, message) {
	const roomId = sanitizeRoomId(message.roomId);
	const userId = String(message.userId || "").slice(0, 80);
	if (!roomId || !userId) {
		send(socket, { type: "ERROR", message: "Некорректная комната или пользователь" });
		return;
	}
	const room = rooms.get(roomId);
	if (!room) {
		send(socket, { type: "ERROR", code: "ROOM_NOT_FOUND", message: "Комната не найдена или уже закрыта" });
		return;
	}
	removeFromRoom(socket);
	socket.roomId = roomId;
	socket.userId = userId;
	socket.isHost = String(message.hostToken || "") === room.hostToken;
	room.users.set(socket, { userId, name: sanitizeName(message.name), isHost: socket.isHost, telemetry: null, socket });
	send(socket, roomState(room, socket));
	broadcast(room, { type: "USERS", users: roomUsers(room) }, socket);
}
function handleSetVideo(socket, message) {
	const room = rooms.get(socket.roomId);
	const videoUrl = sanitizeVideoUrl(message.videoUrl);
	if (!room || !videoUrl) {
		send(socket, { type: "ERROR", message: "Некорректная ссылка на фильм" });
		return;
	}
	if (!socket.isHost) {
		send(socket, { type: "ERROR", code: "HOST_ONLY", message: "Ссылку может менять только создатель комнаты" });
		return;
	}
	room.videoUrl = videoUrl;
	room.playback = { playing: false, position: 0, updatedAt: Date.now(), revision: room.playback.revision + 1 };
	broadcast(room, { type: "VIDEO_SET", videoUrl, playback: room.playback });
}
function handlePlayerEvent(socket, message) {
	const room = rooms.get(socket.roomId);
	const event = message.event || {};
	if (!room || !["play", "pause", "seek"].includes(event.action)) return;
	const position = Number(event.position);
	if (!Number.isFinite(position) || position < 0) return;
	const playing = event.action === "play" ? true : event.action === "pause" ? false : room.playback.playing;
	room.playback = { playing, position, updatedAt: Date.now(), revision: room.playback.revision + 1 };
	broadcast(room, { type: "PLAYER_COMMAND", playback: room.playback }, socket);
}
function finiteNumber(value, fallback = null, min = 0, max = Number.MAX_SAFE_INTEGER) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}
function handleTelemetry(socket, message) {
	const room = rooms.get(socket.roomId);
	const user = room?.users.get(socket);
	const input = message.telemetry || {};
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
		updatedAt: Date.now(),
	};
	broadcast(room, { type: "TELEMETRY", userId: user.userId, telemetry: user.telemetry });
}

function leaveTestReactionChannel(socket) {
	const channel = testReactionChannels.get(socket.testReactionChannel);
	if (!channel) return;
	channel.delete(socket);
	if (channel.size === 0) testReactionChannels.delete(socket.testReactionChannel);
	socket.testReactionChannel = null;
}

function handleTestReactionJoin(socket, message) {
	const channelId = String(message.channelId || "")
		.replace(/[^a-zA-Z0-9_-]/g, "")
		.slice(0, 48);
	if (!channelId) return;
	leaveTestReactionChannel(socket);
	const channel = testReactionChannels.get(channelId) || new Set();
	testReactionChannels.set(channelId, channel);
	socket.testReactionChannel = channelId;
	socket.testReactionUserId = String(message.userId || "").slice(0, 80);
	socket.testReactionName = sanitizeName(message.name);
	channel.add(socket);
	send(socket, { type: "TEST_REACTION_JOINED", channelId });
}

function handleTestReaction(socket, message) {
	const channel = testReactionChannels.get(socket.testReactionChannel);
	if (!channel || !allowedReactions.has(message.emoji)) return;
	const now = Date.now();
	if (now - (socket.lastTestReactionAt || 0) < 500) return;
	socket.lastTestReactionAt = now;
	const payload = {
		type: "TEST_REACTION",
		id: `${now}-${Math.random().toString(36).slice(2, 9)}`,
		userId: socket.testReactionUserId,
		name: socket.testReactionName,
		emoji: message.emoji,
		createdAt: now,
	};
	for (const client of channel) send(client, payload);
}

function handleTestPlayerAction(socket, message) {
	const channel = testReactionChannels.get(socket.testReactionChannel);
	if (!channel || !["play", "pause"].includes(message.action)) return;
	const now = Date.now();
	if (now - (socket.lastTestPlayerActionAt || 0) < 250) return;
	socket.lastTestPlayerActionAt = now;
	const payload = {
		type: "TEST_PLAYER_ACTION",
		action: message.action,
		userId: socket.testReactionUserId,
		name: socket.testReactionName || "Пользователь",
		createdAt: now,
	};
	for (const client of channel) send(client, payload);
}

wss.on("connection", (socket) => {
	socket.isAlive = true;
	socket.on("pong", () => {
		socket.isAlive = true;
	});
	socket.on("message", (buffer) => {
		let message;
		try {
			message = JSON.parse(buffer.toString());
		} catch {
			send(socket, { type: "ERROR", message: "Некорректный JSON" });
			return;
		}
		if (message.type === "CREATE") handleCreate(socket, message);
		else if (message.type === "JOIN") handleJoin(socket, message);
		else if (message.type === "SET_VIDEO") handleSetVideo(socket, message);
		else if (message.type === "PLAYER_EVENT") handlePlayerEvent(socket, message);
		else if (message.type === "TELEMETRY") handleTelemetry(socket, message);
		else if (message.type === "TEST_REACTION_JOIN") handleTestReactionJoin(socket, message);
		else if (message.type === "TEST_REACTION") handleTestReaction(socket, message);
		else if (message.type === "TEST_PLAYER_ACTION") handleTestPlayerAction(socket, message);
		else if (message.type === "PING") send(socket, { type: "PONG", sentAt: finiteNumber(message.sentAt, Date.now(), 0) });
	});
	socket.on("close", () => {
		removeFromRoom(socket);
		leaveTestReactionChannel(socket);
	});
});
const heartbeat = setInterval(() => {
	for (const socket of wss.clients) {
		if (!socket.isAlive) {
			socket.terminate();
			continue;
		}
		socket.isAlive = false;
		socket.ping();
	}
}, 30_000);
server.on("close", () => clearInterval(heartbeat));
server.listen(port, "0.0.0.0", () => console.log(`Kult Watch Party: http://127.0.0.1:${port}`));
