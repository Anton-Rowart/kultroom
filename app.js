const elements = {
  applyUrl: document.querySelector("#apply-url"), connection: document.querySelector("#connection"), connectionText: document.querySelector("#connection-text"),
  createVideoField: document.querySelector("#create-video-field"), createVideoUrl: document.querySelector("#create-video-url"), frame: document.querySelector("#movie-frame"),
  guestVideoLink: document.querySelector("#guest-video-link"), hostVideoControl: document.querySelector("#host-video-control"), lobbyDescription: document.querySelector("#lobby-description"),
  lobbyError: document.querySelector("#lobby-error"), lobbyForm: document.querySelector("#lobby-form"), lobbySubmit: document.querySelector("#lobby-submit"),
  lobbyTitle: document.querySelector("#lobby-title"), participants: document.querySelector("#participants"), participantCount: document.querySelector("#participant-count"),
  playerStatus: document.querySelector("#player-status"), roomCode: document.querySelector("#room-code"), sessionName: document.querySelector("#session-name"),
  shareRoom: document.querySelector("#share-room"), toast: document.querySelector("#toast"), toggle: document.querySelector("#panel-toggle"),
  urlError: document.querySelector("#url-error"), videoUrl: document.querySelector("#video-url")
};

const query = new URLSearchParams(location.search);
let roomId = normalizeRoomId(query.get("room"));
const userId = getOrCreateUserId();
let userName = sessionStorage.getItem("kult-session-name") || "";
let hostToken = roomId ? sessionStorage.getItem(`kult-host-token:${roomId}`) || "" : "";
let isHost = false;
let socket = null;
let reconnectTimer = null;
let joinTimer = null;
let reconnectAttempt = 0;
let roomJoined = false;
let pendingEntrance = null;
let currentVideoUrl = "";
let lastRemoteRevision = 0;
let toastTimer = null;
let extensionBridgeReady = false;
let lastBridgeNotice = "";

function normalizeRoomId(value) {
  const normalized = String(value || "").replace(/\D/g, "").slice(0, 6);
  return normalized.length === 6 ? normalized : "";
}

function createRoomId() {
  const bytes = crypto.getRandomValues(new Uint32Array(1));
  return String(100000 + (bytes[0] % 900000));
}

function getOrCreateUserId() {
  let value = sessionStorage.getItem("kult-user-id");
  if (!value) {
    value = crypto.randomUUID();
    sessionStorage.setItem("kult-user-id", value);
  }
  return value;
}

function parseVideoUrl(value) {
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol)) throw new Error();
    return url.href;
  } catch {
    return null;
  }
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => elements.toast.classList.remove("visible"), 2600);
}

function setConnection(state, text) {
  elements.connection.dataset.state = state;
  elements.connectionText.textContent = text;
}

function configureLobby() {
  elements.sessionName.value = userName;
  const joining = Boolean(roomId);
  elements.lobbyTitle.textContent = joining ? `Войти в комнату ${roomId}` : "Создать комнату";
  elements.lobbyDescription.textContent = joining
    ? "Введите имя для этой сессии. После входа вы увидите фильм и участников."
    : "Назовитесь, добавьте ссылку на фильм и отправьте комнату друзьям.";
  elements.createVideoField.hidden = joining;
  elements.createVideoUrl.required = !joining;
  elements.lobbySubmit.textContent = joining ? "Войти в комнату" : "Создать комнату";
}

function setRoomUrl() {
  const url = new URL(location.href);
  url.searchParams.set("room", roomId);
  history.replaceState(null, "", url);
  elements.roomCode.textContent = roomId;
}

function enterRoomView() {
  document.body.dataset.view = "room";
  setRoomUrl();
}

function renderVideoUrl(url) {
  const parsed = parseVideoUrl(url);
  if (!parsed) return false;
  const changed = parsed !== currentVideoUrl;
  currentVideoUrl = parsed;
  elements.videoUrl.value = parsed;
  elements.guestVideoLink.href = parsed;
  elements.guestVideoLink.textContent = parsed;
  if (changed) {
    elements.frame.src = parsed;
    elements.playerStatus.textContent = "Плеер загружается…";
  }
  return true;
}

function renderRole() {
  elements.hostVideoControl.hidden = !isHost;
  elements.guestVideoLink.hidden = isHost;
}

function renderParticipants(users) {
  elements.participants.replaceChildren();
  elements.participantCount.textContent = String(users.length);
  for (const user of users) {
    const item = document.createElement("li");
    item.className = "participant";
    const avatar = document.createElement("span");
    avatar.className = "participant__avatar";
    avatar.textContent = user.name.slice(0, 1).toUpperCase();
    const name = document.createElement("span");
    name.className = "participant__name";
    name.textContent = user.name;
    const badges = document.createElement("span");
    badges.className = "participant__badges";
    if (user.isHost) {
      const host = document.createElement("span");
      host.className = "participant__badge participant__badge--host";
      host.textContent = "создатель";
      badges.append(host);
    }
    if (user.userId === userId) {
      const you = document.createElement("span");
      you.className = "participant__badge";
      you.textContent = "это вы";
      badges.append(you);
    }
    item.append(avatar, name, badges);
    elements.participants.append(item);
  }
}

function websocketUrl() {
  const override = query.get("socket");
  if (override) return override;
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const host = location.port === "8787" ? location.host : `${location.hostname}:8787`;
  return `${protocol}//${host}/ws`;
}

function send(message) {
  if (!message || socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
}

function entranceMessage() {
  if (roomJoined) return { type: "JOIN", roomId, userId, name: userName, hostToken };
  return pendingEntrance;
}

function connectSocket() {
  clearTimeout(reconnectTimer);
  setConnection("connecting", "Подключение к комнате…");
  socket = new WebSocket(websocketUrl());
  socket.addEventListener("open", () => {
    reconnectAttempt = 0;
    setConnection("connecting", "Вхожу в комнату…");
    send(entranceMessage());
    clearTimeout(joinTimer);
    joinTimer = setTimeout(() => { if (!roomJoined) socket?.close(); }, 5000);
  });
  socket.addEventListener("message", (event) => {
    try { handleMessage(JSON.parse(event.data)); }
    catch (error) { console.error("Некорректное сообщение сервера", error); }
  });
  socket.addEventListener("close", () => {
    clearTimeout(joinTimer);
    if (!pendingEntrance && !roomJoined) return;
    setConnection("offline", "Соединение потеряно · переподключаюсь");
    const delay = Math.min(1000 * 2 ** reconnectAttempt, 8000);
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(connectSocket, delay);
  });
  socket.addEventListener("error", () => socket.close());
}

function currentPlaybackPosition(playback) {
  return playback?.playing
    ? (playback.position || 0) + Math.max(0, (Date.now() - playback.updatedAt) / 1000)
    : playback?.position || 0;
}

function applyRoomPlayback(playback) {
  if (!playback || playback.revision <= lastRemoteRevision) return;
  lastRemoteRevision = playback.revision;
  window.postMessage({ source: "kult-site", type: "remote-command", command: {
    action: playback.playing ? "play" : "pause",
    position: currentPlaybackPosition(playback), revision: playback.revision
  } }, location.origin);
}

function handleMessage(message) {
  if (message.type === "ROOM_STATE") {
    clearTimeout(joinTimer);
    roomJoined = true;
    pendingEntrance = null;
    isHost = message.isHost === true;
    setConnection("online", "Комната подключена");
    enterRoomView();
    renderRole();
    renderParticipants(message.users || []);
    if (message.videoUrl) renderVideoUrl(message.videoUrl);
    applyRoomPlayback(message.playback);
    pingExtensionBridge();
  }
  if (message.type === "USERS") renderParticipants(message.users || []);
  if (message.type === "VIDEO_SET") {
    renderVideoUrl(message.videoUrl);
    showToast("Создатель изменил ссылку на фильм");
  }
  if (message.type === "PLAYER_COMMAND") applyRoomPlayback(message.playback);
  if (message.type === "ERROR") {
    if (message.code === "ROOM_EXISTS" && pendingEntrance?.type === "CREATE") {
      roomId = createRoomId();
      pendingEntrance.roomId = roomId;
      sessionStorage.setItem(`kult-host-token:${roomId}`, hostToken);
      send(pendingEntrance);
      return;
    }
    elements.lobbySubmit.disabled = false;
    elements.lobbyError.textContent = message.message || "Ошибка комнаты";
    if (roomJoined) showToast(message.message || "Ошибка комнаты");
  }
}

function sendPlayerEvent(event) {
  if (!roomJoined || !["play", "pause", "seek"].includes(event.action)) return;
  const position = Number(event.position) || 0;
  elements.playerStatus.textContent = event.action === "play"
    ? `Воспроизведение · ${position.toFixed(1)} сек`
    : event.action === "pause" ? `Пауза · ${position.toFixed(1)} сек` : `Перемотка · ${position.toFixed(1)} сек`;
  send({ type: "PLAYER_EVENT", roomId, event: { action: event.action, position, emittedAt: event.emittedAt || Date.now() } });
}

window.addEventListener("message", (event) => {
  if (event.source !== window || event.origin !== location.origin) return;
  if (event.data?.source === "kult-extension" && event.data.type === "bridge-ready") {
    extensionBridgeReady = true;
    const status = event.data.status || {};
    if (status.missingOrigins?.length) {
      elements.playerStatus.textContent = "Расширению нужен доступ к видеоплееру";
      if (lastBridgeNotice !== "permission") showToast("Откройте расширение и разрешите доступ к плееру");
      lastBridgeNotice = "permission";
    } else if (status.activationRequired) {
      elements.playerStatus.textContent = "Нажмите «Активировать видео» внутри плеера";
      if (lastBridgeNotice !== "activation") showToast("Один раз активируйте видео в плеере");
      lastBridgeNotice = "activation";
    } else if (status.playerConnected) {
      elements.playerStatus.textContent = "Расширение и плеер подключены";
      lastBridgeNotice = "ready";
    } else {
      elements.playerStatus.textContent = "Расширение подключено · плеер загружается";
    }
  }
  if (event.data?.source === "kult-extension" && event.data.type === "player-event") sendPlayerEvent(event.data.event);
});

elements.lobbyForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = elements.sessionName.value.trim();
  if (!name) { elements.lobbyError.textContent = "Введите имя"; return; }
  userName = name.slice(0, 32);
  sessionStorage.setItem("kult-session-name", userName);
  elements.lobbyError.textContent = "";
  elements.lobbySubmit.disabled = true;

  if (roomId) {
    pendingEntrance = { type: "JOIN", roomId, userId, name: userName, hostToken };
  } else {
    const videoUrl = parseVideoUrl(elements.createVideoUrl.value.trim());
    if (!videoUrl) {
      elements.lobbyError.textContent = "Введите корректную ссылку на фильм";
      elements.lobbySubmit.disabled = false;
      return;
    }
    roomId = createRoomId();
    hostToken = crypto.randomUUID();
    sessionStorage.setItem(`kult-host-token:${roomId}`, hostToken);
    pendingEntrance = { type: "CREATE", roomId, userId, name: userName, videoUrl, hostToken };
  }
  connectSocket();
});

elements.toggle.addEventListener("click", () => {
  const collapsed = document.body.classList.toggle("panel-collapsed");
  elements.toggle.setAttribute("aria-expanded", String(!collapsed));
  elements.toggle.setAttribute("aria-label", collapsed ? "Открыть комнату" : "Скрыть комнату");
});

function applyVideoUrl() {
  if (!isHost) return;
  const parsed = parseVideoUrl(elements.videoUrl.value.trim());
  if (!parsed) { elements.urlError.textContent = "Введите корректную HTTP/HTTPS-ссылку"; return; }
  elements.urlError.textContent = "";
  send({ type: "SET_VIDEO", roomId, videoUrl: parsed });
}

elements.applyUrl.addEventListener("click", applyVideoUrl);
elements.videoUrl.addEventListener("keydown", (event) => { if (event.key === "Enter") applyVideoUrl(); });

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return true; } catch {}
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.cssText = "position:fixed;left:-9999px;top:0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  return copied;
}

elements.shareRoom.addEventListener("click", async () => {
  const roomUrl = new URL(location.href);
  roomUrl.searchParams.set("room", roomId);
  roomUrl.searchParams.delete("socket");
  showToast(await copyText(roomUrl.href) ? "Ссылка на комнату скопирована" : "Не удалось скопировать ссылку");
});

function pingExtensionBridge() {
  if (document.body.dataset.view === "room") window.postMessage({ source: "kult-site", type: "bridge-ping" }, location.origin);
}

setInterval(pingExtensionBridge, 1500);
setTimeout(() => {
  if (roomJoined && !extensionBridgeReady) elements.playerStatus.textContent = "Расширение не подключено · установите или обновите его";
}, 4000);

configureLobby();
