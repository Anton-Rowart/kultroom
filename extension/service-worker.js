const staticObserverOrigins = new Set([
  "https://bulkikim.lol/*",
  "https://theatre.stravers.live/*"
]);

function isKultSiteUrl(urlString) {
  try {
    const url = new URL(urlString);
    return url.protocol === "http:" && url.host === "194.226.165.6:8787";
  } catch {
    return false;
  }
}

async function setActionState(tabId, state) {
  const states = {
    off: { text: "", color: "#64748b", title: "Kult Player Bridge · неактивно" },
    ready: { text: "ON", color: "#10b981", title: "Kult Player Bridge · плеер подключён" },
    waiting: { text: "…", color: "#8b5cf6", title: "Kult Player Bridge · ожидает плеер" },
    permission: { text: "!", color: "#f59e0b", title: "Kult Player Bridge · требуется разрешение" }
  };
  const value = states[state] || states.off;
  await Promise.allSettled([
    state === "off" ? chrome.action.disable(tabId) : chrome.action.enable(tabId),
    chrome.action.setBadgeText({ tabId, text: value.text }),
    chrome.action.setBadgeBackgroundColor({ tabId, color: value.color }),
    chrome.action.setTitle({ tabId, title: value.title })
  ]);
}

async function inspectTabBridge(tabId, topUrl) {
  if (!isKultSiteUrl(topUrl)) {
    await setActionState(tabId, "off");
    return { active: false, playerConnected: false, missingOrigins: [] };
  }

  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  const nestedOrigins = [...new Set(frames
    .filter((frame) => frame.frameId !== 0)
    .map((frame) => {
      try { const url = new URL(frame.url); return /^https?:$/.test(url.protocol) ? `${url.origin}/*` : null; }
      catch { return null; }
    })
    .filter((origin) => origin && staticObserverOrigins.has(origin)))];
  const missingOrigins = [];
  for (const origin of nestedOrigins) {
    if (!(await chrome.permissions.contains({ origins: [origin] }))) missingOrigins.push(origin);
  }

  if (missingOrigins.length > 0) {
    await setActionState(tabId, "permission");
    return { active: true, playerConnected: false, missingOrigins };
  }

  const results = await Promise.allSettled(frames.map((frame) => chrome.tabs.sendMessage(
    tabId,
    { source: "kult-player-bridge", type: "ping" },
    { frameId: frame.frameId }
  )));
  const playerConnected = results.some((result) => result.status === "fulfilled" && result.value?.videoCount > 0);
  const activationRequired = results.some((result) => result.status === "fulfilled"
    && result.value?.videoCount > 0
    && result.value?.userActivation?.hasBeenActive === false);
  await setActionState(tabId, activationRequired ? "permission" : playerConnected ? "ready" : "waiting");
  return { active: true, playerConnected, activationRequired, missingOrigins: [] };
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.disable().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  chrome.action.disable().catch(() => {});
});

async function forwardCommandToFrames(tabId, command) {
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  const playerFrames = frames.filter((frame) => {
    try { return staticObserverOrigins.has(`${new URL(frame.url).origin}/*`); }
    catch { return false; }
  });
  const results = await Promise.allSettled(playerFrames.map((frame) => chrome.tabs.sendMessage(
    tabId,
    {
      source: "kult-player-bridge",
      type: "command",
      command
    },
    { frameId: frame.frameId }
  )));

  return results.some((result) => result.status === "fulfilled" && result.value?.videoCount > 0);
}

async function handlePlayerEvent(message, sender) {
  const tabId = sender.tab?.id;
  if (tabId == null || !isKultSiteUrl(sender.tab?.url)) {
    return { ok: false, ignored: true, reason: "outside-kult" };
  }

  const event = { ...message.event, tabId, frameId: sender.frameId ?? null, receivedAt: Date.now() };
  const tasks = [
    chrome.storage.local.set({ lastPlayerEvent: event }),
    chrome.tabs.sendMessage(tabId, {
      source: "kult-player-bridge",
      type: "forward-player-event",
      event
    }, { frameId: 0 })
  ];
  await Promise.allSettled(tasks);
  return { ok: true };
}

async function handleTelemetry(message, sender) {
  const tabId = sender.tab?.id;
  if (tabId == null || !isKultSiteUrl(sender.tab?.url)) return { ok: false, ignored: true };
  await chrome.tabs.sendMessage(tabId, {
    source: "kult-player-bridge",
    type: "forward-telemetry",
    telemetry: message.telemetry
  }, { frameId: 0 });
  return { ok: true };
}

chrome.webNavigation.onCommitted?.addListener((details) => {
  if (details.frameId === 0) setActionState(details.tabId, isKultSiteUrl(details.url) ? "waiting" : "off");
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.source !== "kult-player-bridge") {
    return undefined;
  }

  if (message.type === "player-event") {
    handlePlayerEvent(message, sender).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message.type === "telemetry") {
    handleTelemetry(message, sender).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message.type === "context-check") {
    sendResponse({ active: isKultSiteUrl(sender.tab?.url) });
    return undefined;
  }

  if (message.type === "site-probe" && sender.tab?.id != null) {
    inspectTabBridge(sender.tab.id, sender.tab.url)
      .then(sendResponse)
      .catch((error) => sendResponse({ active: true, playerConnected: false, missingOrigins: [], error: error?.message || String(error) }));
    return true;
  }

  if (message.type === "site-command" && sender.tab?.id != null) {
    forwardCommandToFrames(sender.tab.id, message.command)
      .then((applied) => sendResponse({ ok: applied }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  return undefined;
});
