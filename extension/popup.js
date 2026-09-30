const kultOrigin = "http://194.226.165.6:8787";
const playerOrigins = new Set(["https://bulkikim.lol", "https://theatre.stravers.live"]);
const statusElement = document.querySelector("#status");
const detailElement = document.querySelector("#detail");
const dotElement = document.querySelector("#dot");

function setStatus(status, detail, state = "idle") {
  statusElement.textContent = status;
  detailElement.textContent = detail;
  dotElement.className = `dot${state === "idle" ? "" : ` ${state}`}`;
}

async function inspect() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let origin = "";
  try { origin = new URL(tab?.url || "").origin; } catch {}

  if (!tab?.id || origin !== kultOrigin) {
    setStatus("Расширение неактивно", "Откройте комнату Kult", "error");
    return;
  }

  const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
  const playerFrames = frames.filter((frame) => {
    try { return playerOrigins.has(new URL(frame.url).origin); } catch { return false; }
  });
  const responses = await Promise.allSettled(playerFrames.map((frame) => chrome.tabs.sendMessage(
    tab.id,
    { source: "kult-player-bridge", type: "ping" },
    { frameId: frame.frameId }
  )));
  const players = responses
    .filter((response) => response.status === "fulfilled" && response.value?.videoCount > 0)
    .map((response) => response.value);

  if (players.length === 0) {
    setStatus("Плеер загружается", "Расширение уже подключено");
    return;
  }

  const activating = players.some((player) => player.activationState === "activating");
  if (activating) {
    setStatus("Активируем плеер", "Останавливаем видео на 00:00");
    return;
  }

  const needsActivation = players.some((player) => player.activationState !== "active");
  if (needsActivation) {
    setStatus("Нужна активация", "Нажмите кнопку внутри плеера");
    return;
  }

  setStatus("Плеер готов", "Синхронизация работает", "ok");
}

inspect().catch(() => setStatus("Не удалось проверить", "Обновите страницу комнаты", "error"));
