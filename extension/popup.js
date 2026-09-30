const elements = {
  connect: document.querySelector("#connect"),
  details: document.querySelector("#details"),
  dot: document.querySelector("#dot"),
  lastEvent: document.querySelector("#last-event"),
  origins: document.querySelector("#origins"),
  rescan: document.querySelector("#rescan"),
  status: document.querySelector("#status")
};

let activeTab = null;
let frames = [];
let controllableFrames = [];
const kultSiteOrigin = "http://194.226.165.6:8787";
const allowedOrigins = new Set([
  `${kultSiteOrigin}/*`,
  "https://bulkikim.lol/*",
  "https://theatre.stravers.live/*"
]);

function isKultSiteUrl(urlString) {
  try { return new URL(urlString).origin === kultSiteOrigin; }
  catch { return false; }
}

function toOriginPattern(urlString) {
  try {
    const url = new URL(urlString);

    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return null;
    }

    return `${url.origin}/*`;
  } catch {
    return null;
  }
}

function uniqueOriginPatterns(frameList) {
  return [...new Set(frameList.map((frame) => toOriginPattern(frame.url)).filter((origin) => allowedOrigins.has(origin)))];
}

async function getMissingOrigins(origins) {
  const missing = [];

  for (const origin of origins) {
    const granted = await chrome.permissions.contains({ origins: [origin] });

    if (!granted) {
      missing.push(origin);
    }
  }

  return missing;
}

function setStatus(text, state = "idle") {
  elements.status.textContent = text;
  elements.dot.classList.toggle("ok", state === "ok");
  elements.dot.classList.toggle("error", state === "error");
}

function setControlsEnabled(enabled) {
  return enabled;
}

function renderPlayerEvent(event) {
  if (!event) {
    elements.lastEvent.textContent = "Событий плеера пока не было";
    return;
  }

  const labels = {
    play: "▶ Воспроизведение",
    pause: "Ⅱ Пауза",
    seek: "↔ Перемотка",
    ratechange: "× Скорость"
  };
  const position = Number.isFinite(event.position) ? `${event.position.toFixed(1)} сек` : "—";
  elements.lastEvent.textContent = `${labels[event.action] || event.action} · ${position}`;
}

async function loadLastPlayerEvent() {
  const { lastPlayerEvent } = await chrome.storage.local.get("lastPlayerEvent");
  renderPlayerEvent(lastPlayerEvent);
}

function renderOrigins() {
  const origins = uniqueOriginPatterns(frames);
  elements.origins.replaceChildren();

  if (origins.length === 0) {
    const message = document.createElement("span");
    message.className = "muted";
    message.textContent = "HTTP/HTTPS iframe пока не найдены";
    elements.origins.append(message);
    return;
  }

  for (const origin of origins) {
    const badge = document.createElement("span");
    badge.className = "origin";
    badge.title = origin;
    badge.textContent = origin.replace("/*", "");
    elements.origins.append(badge);
  }
}

function showDetails(data) {
  elements.details.hidden = false;
  elements.details.textContent = JSON.stringify(data, null, 2);
}

async function loadFrames() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.id) {
    throw new Error("Не удалось определить активную вкладку");
  }

  if (!isKultSiteUrl(tab.url)) {
    throw new Error("Расширение работает только на 194.226.165.6:8787");
  }

  activeTab = tab;
  frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
  renderOrigins();
  return frames;
}

async function hasOriginAccess(url) {
  const pattern = toOriginPattern(url);

  if (!pattern) {
    return false;
  }

  return chrome.permissions.contains({ origins: [pattern] });
}

async function injectIntoGrantedFrames() {
  const grantedFrames = [];
  const errors = [];

  for (const frame of frames) {
    if (!allowedOrigins.has(toOriginPattern(frame.url))) {
      continue;
    }

    if (!(await hasOriginAccess(frame.url))) {
      continue;
    }

    try {
      await chrome.scripting.executeScript({
        target: {
          tabId: activeTab.id,
          frameIds: [frame.frameId]
        },
        files: ["content.js"]
      });

      grantedFrames.push(frame);
    } catch (error) {
      errors.push({
        frameId: frame.frameId,
        url: frame.url,
        error: error?.message || String(error)
      });
    }
  }

  controllableFrames = grantedFrames;
  return { errors, grantedFrames };
}

async function sendToFrame(frameId, message) {
  try {
    return await chrome.tabs.sendMessage(activeTab.id, message, { frameId });
  } catch (error) {
    return {
      ok: false,
      videoCount: 0,
      error: error?.message || String(error)
    };
  }
}

async function inspectPlayers() {
  const results = [];

  for (const frame of controllableFrames) {
    const response = await sendToFrame(frame.frameId, {
      source: "kult-player-bridge",
      type: "ping"
    });

    results.push({
      frameId: frame.frameId,
      frameUrl: frame.url,
      ...response
    });
  }

  const playerFrames = results.filter((result) => result.videoCount > 0);
  setControlsEnabled(playerFrames.length > 0);

  if (playerFrames.length > 0) {
    const videoCount = playerFrames.reduce((sum, frame) => sum + frame.videoCount, 0);
    setStatus(`Плеер подключён · видео: ${videoCount}`, "ok");

    const videos = playerFrames.flatMap((frame) => frame.videos || []);
    const activeVideo = videos.find((video) => video.readyState > 0 && !video.paused)
      || videos.find((video) => video.readyState > 0)
      || videos[0];

    if (activeVideo) {
      renderPlayerEvent({
        action: activeVideo.paused ? "pause" : "play",
        position: activeVideo.currentTime
      });
    }
  } else if (controllableFrames.length > 0) {
    setStatus("Доступ есть, но <video> пока не найден", "error");
  } else {
    setStatus("Нет доступных фреймов", "error");
  }

  showDetails(results);
  return results;
}

async function restoreConnection() {
  elements.connect.disabled = true;
  setControlsEnabled(false);
  setStatus("Восстанавливаю подключение…");

  try {
    await loadFrames();
    const origins = uniqueOriginPatterns(frames);

    if (origins.length === 0) {
      throw new Error("На вкладке не найдено ни одного HTTP/HTTPS-фрейма");
    }

    const missingOrigins = await getMissingOrigins(origins);
    await injectIntoGrantedFrames();
    const players = await inspectPlayers();
    const hasPlayer = players.some((result) => result.videoCount > 0);

    if (missingOrigins.length > 0) {
      elements.connect.hidden = false;
      elements.connect.textContent = hasPlayer
        ? `Разрешить новые домены (${missingOrigins.length})`
        : `Разрешить доступ (${missingOrigins.length})`;
    } else {
      elements.connect.hidden = hasPlayer;
      elements.connect.textContent = "Подключить плеер";
    }

    return { missingOrigins, players };
  } catch (error) {
    elements.connect.hidden = false;
    setStatus(error?.message || String(error), "error");
    showDetails({ error: error?.message || String(error) });
    return null;
  } finally {
    elements.connect.disabled = false;
  }
}

async function connect() {
  elements.connect.disabled = true;
  setControlsEnabled(false);
  setStatus("Запрашиваю доступ к найденным доменам…");

  try {
    await loadFrames();
    const origins = uniqueOriginPatterns(frames);

    if (origins.length === 0) {
      throw new Error("На вкладке не найдено ни одного HTTP/HTTPS-фрейма");
    }

    const missingOrigins = await getMissingOrigins(origins);
    if (missingOrigins.length > 0) throw new Error("Перезагрузите расширение, чтобы применить доступ к плееру");

    setStatus("Подключаю скрипт к iframe…");
    const injection = await injectIntoGrantedFrames();
    const players = await inspectPlayers();
    const hasPlayer = players.some((result) => result.videoCount > 0);
    elements.connect.hidden = hasPlayer;
    elements.connect.textContent = "Подключить плеер";
    showDetails({ injection, players });
  } catch (error) {
    setStatus(error?.message || String(error), "error");
    showDetails({ error: error?.message || String(error) });
  } finally {
    elements.connect.disabled = false;
  }
}

elements.connect.addEventListener("click", connect);
elements.rescan.addEventListener("click", async () => {
  await restoreConnection();
});

async function initializePopup() {
  await loadLastPlayerEvent().catch(() => {});
  await restoreConnection();
}

initializePopup();

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes.lastPlayerEvent) {
    renderPlayerEvent(changes.lastPlayerEvent.newValue);
  }
});
