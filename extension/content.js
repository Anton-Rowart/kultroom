(() => {
  const bridgeVersion = "0.4.1";

  if (globalThis.__kultPlayerBridgeInstalled === bridgeVersion) {
    return;
  }

  globalThis.__kultPlayerBridgeInstalled = bridgeVersion;

  const unlockButtonId = "kult-player-bridge-unlock";
  const observedVideos = new WeakSet();
  let applyingRemoteCommand = 0;
  let suppressEventsUntil = 0;
  const playControlSelectors = [
    "button[data-allplay='play']",
    ".allplay__control--overlaid",
    "button[aria-label*='play' i]",
    "button[aria-label*='воспроизвести' i]",
    "button[title*='play' i]",
    "[role='button'][aria-label*='play' i]",
    "[data-plyr='play']",
    ".vjs-big-play-button",
    ".vjs-play-control",
    ".plyr__control--overlaid",
    ".jw-icon-playback",
    ".jw-display-icon-container",
    ".video-js .vjs-play-control",
    ".play-button",
    ".button-play",
    ".btn-play",
    "[class*='play-button' i]",
    "[class*='playButton' i]",
    "[data-testid*='play' i]"
  ];

  function collectVideos(root = document) {
    const videos = [...root.querySelectorAll("video")];

    for (const element of root.querySelectorAll("*")) {
      if (element.shadowRoot) {
        videos.push(...collectVideos(element.shadowRoot));
      }
    }

    return [...new Set(videos)];
  }

  function describeVideo(video) {
    return {
      currentTime: Number(video.currentTime.toFixed(3)),
      duration: Number.isFinite(video.duration) ? Number(video.duration.toFixed(3)) : null,
      paused: video.paused,
      readyState: video.readyState,
      src: video.currentSrc || video.src || null
    };
  }

  function emitPlayerEvent(action, video) {
    if (applyingRemoteCommand > 0 || Date.now() < suppressEventsUntil) {
      return;
    }

    const event = {
      action,
      href: location.href,
      title: document.title,
      position: Number(video.currentTime.toFixed(3)),
      duration: Number.isFinite(video.duration) ? Number(video.duration.toFixed(3)) : null,
      paused: video.paused,
      playbackRate: video.playbackRate,
      emittedAt: Date.now()
    };

    chrome.storage.local.set({ lastPlayerEvent: event }).catch(() => {
      // Контекст расширения мог обновиться вместе с расширением.
    });

    chrome.runtime.sendMessage({
      source: "kult-player-bridge",
      type: "player-event",
      event
    }).catch(() => {
      // Контекст расширения мог обновиться вместе с расширением.
    });
  }

  function observeVideo(video) {
    if (observedVideos.has(video)) {
      return;
    }

    observedVideos.add(video);
    video.addEventListener("play", () => emitPlayerEvent("play", video));
    video.addEventListener("pause", () => emitPlayerEvent("pause", video));
    video.addEventListener("seeked", () => emitPlayerEvent("seek", video));
    video.addEventListener("ratechange", () => emitPlayerEvent("ratechange", video));
  }

  function observeAllVideos() {
    const videos = collectVideos();

    for (const video of videos) {
      observeVideo(video);
    }

    if (window !== window.top && videos.length > 0 && navigator.userActivation?.hasBeenActive !== true) {
      showUnlockButton();
    }
  }

  function runAsRemoteCommand(callback) {
    applyingRemoteCommand += 1;
    suppressEventsUntil = Date.now() + 500;

    return Promise.resolve()
      .then(callback)
      .finally(() => {
        applyingRemoteCommand = Math.max(0, applyingRemoteCommand - 1);
        suppressEventsUntil = Date.now() + 500;
      });
  }

  function getTargetVideos() {
    const videos = collectVideos();
    const initialized = videos.filter((video) => video.currentSrc || video.src || video.readyState > 0);
    return initialized.length > 0 ? initialized : videos;
  }

  function isVisible(element) {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }

  function findPlayControls() {
    return [...new Set(playControlSelectors.flatMap((selector) => [...document.querySelectorAll(selector)]))]
      .filter((element) => element.id !== unlockButtonId)
      .sort((left, right) => Number(isVisible(right)) - Number(isVisible(left)));
  }

  function describeControl(element) {
    return {
      tag: element.tagName.toLowerCase(),
      id: element.id || null,
      className: typeof element.className === "string" ? element.className : null,
      ariaLabel: element.getAttribute("aria-label"),
      title: element.getAttribute("title"),
      text: element.textContent?.trim().slice(0, 80) || null,
      visible: isVisible(element)
    };
  }

  function clickPlayerPlayControl() {
    const control = findPlayControls().find(isVisible) || findPlayControls()[0];

    if (!control) {
      return false;
    }

    const isPlaying = getTargetVideos().some((video) => !video.paused);

    if (!isPlaying) {
      control.click();
    }

    return true;
  }

  function clickPlayerPauseControl() {
    const control = findPlayControls().find(isVisible) || findPlayControls()[0];

    if (!control) {
      return false;
    }

    const isPlaying = getTargetVideos().some((video) => !video.paused)
      || control.getAttribute("aria-pressed") === "true"
      || /пауза|pause/i.test(control.getAttribute("aria-label") || "");

    if (isPlaying) {
      control.click();
    }

    return true;
  }

  function waitForPlaybackState(shouldPlay, timeoutMs) {
    const startedAt = Date.now();

    return new Promise((resolve, reject) => {
      const check = () => {
        const videos = getTargetVideos();
        const matches = shouldPlay
          ? videos.some((video) => video.readyState >= 2 && !video.paused)
          : videos.length > 0 && videos.every((video) => video.paused);

        if (matches) {
          resolve();
          return;
        }

        if (Date.now() - startedAt >= timeoutMs) {
          reject(new DOMException("Плеер не начал загрузку потока", "TimeoutError"));
          return;
        }

        setTimeout(check, 100);
      };

      check();
    });
  }

  function withTimeout(promise, timeoutMs) {
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        setTimeout(() => reject(new DOMException("Плеер не начал загрузку потока", "TimeoutError")), timeoutMs);
      })
    ]);
  }

  function getState() {
    const videos = getTargetVideos();

    return {
      ok: true,
      href: location.href,
      title: document.title,
      videoCount: videos.length,
      userActivation: {
        hasBeenActive: navigator.userActivation?.hasBeenActive ?? null,
        isActive: navigator.userActivation?.isActive ?? null
      },
      playControls: findPlayControls().slice(0, 8).map(describeControl),
      videos: videos.map(describeVideo)
    };
  }

  function showUnlockButton() {
    if (document.getElementById(unlockButtonId)) {
      return;
    }

    const videos = getTargetVideos();

    if (videos.length === 0 || !document.body) {
      return;
    }

    const button = document.createElement("button");
    button.id = unlockButtonId;
    button.type = "button";
    button.textContent = "▶ Активировать видео для синхронизации";
    button.setAttribute("aria-label", "Активировать видео для совместного просмотра");
    button.style.cssText = [
      "position:fixed",
      "left:50%",
      "top:50%",
      "transform:translate(-50%,-50%)",
      "z-index:2147483647",
      "min-width:260px",
      "min-height:54px",
      "padding:14px 20px",
      "border:1px solid rgba(255,255,255,.24)",
      "border-radius:14px",
      "background:linear-gradient(135deg,#7c3aed,#c026d3)",
      "box-shadow:0 18px 50px rgba(0,0,0,.55)",
      "color:#fff",
      "font:700 15px system-ui,-apple-system,sans-serif",
      "cursor:pointer"
    ].join(";");

    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      button.disabled = true;
      button.textContent = "Подготавливаю плеер…";

      applyingRemoteCommand += 1;
      suppressEventsUntil = Date.now() + 1500;

      try {
        const hasPlayerControl = findPlayControls().length > 0;
        const videos = getTargetVideos();

        if (hasPlayerControl) {
          clickPlayerPlayControl();
        } else {
          await Promise.all(videos.map((video) => video.play()));
        }

        await waitForPlaybackState(true, 5000);

        if (hasPlayerControl) {
          clickPlayerPauseControl();
        } else {
          for (const video of videos) video.pause();
        }

        await waitForPlaybackState(false, 1800);
        button.remove();
      } catch (error) {
        button.disabled = false;
        button.textContent = `Не получилось: ${error?.message || String(error)}`;
      } finally {
        applyingRemoteCommand = Math.max(0, applyingRemoteCommand - 1);
        suppressEventsUntil = Date.now() + 700;
      }
    });

    document.body.append(button);
  }

  async function executeCommand(commandInput) {
    return runAsRemoteCommand(async () => {
      const command = typeof commandInput === "string"
        ? { action: commandInput }
        : commandInput || {};
      const videos = getTargetVideos();
      const hasPlayerControl = findPlayControls().length > 0;

      if (videos.length === 0 && !hasPlayerControl) {
        return {
          ...getState(),
          ok: false,
          error: "В этом фрейме элемент <video> не найден"
        };
      }

      if (Number.isFinite(command.position)) {
        for (const video of videos) {
          if (Math.abs(video.currentTime - command.position) > 0.35) {
            video.currentTime = Math.max(0, command.position);
          }
        }
      }

      if (command.action === "seek") {
        return getState();
      }

      if (command.action === "pause") {
        if (hasPlayerControl) {
          clickPlayerPauseControl();
        } else {
          for (const video of videos) {
            video.pause();
          }
        }
        await waitForPlaybackState(false, 1500);
      }

      if (command.action === "play") {
        if (hasPlayerControl) {
          clickPlayerPlayControl();
          try {
            await waitForPlaybackState(true, 4000);
          } catch (error) {
            showUnlockButton();

            return {
              ...getState(),
              ok: false,
              userGestureRequired: true,
              error: error?.message || String(error)
            };
          }
        } else {
          let rejected;

          try {
            const results = await withTimeout(Promise.allSettled(videos.map((video) => video.play())), 2500);
            rejected = results.find((result) => result.status === "rejected")?.reason;
          } catch (error) {
            rejected = error;
          }

          if (rejected) {
            showUnlockButton();

            return {
              ...getState(),
              ok: false,
              userGestureRequired: rejected?.name === "NotAllowedError" || rejected?.name === "TimeoutError",
              error: rejected?.message || String(rejected)
            };
          }
        }
      }

      return getState();
    });
  }

  observeAllVideos();

  const videoObserver = new MutationObserver(() => {
    observeAllVideos();
  });

  videoObserver.observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  if (window === window.top) {
    function announceBridge() {
      chrome.runtime.sendMessage({
        source: "kult-player-bridge",
        type: "site-probe"
      }).then((status) => {
        window.postMessage({
          source: "kult-extension",
          type: "bridge-ready",
          status
        }, location.origin);
      }).catch(() => {
        window.postMessage({
          source: "kult-extension",
          type: "bridge-ready",
          status: { playerConnected: false, missingOrigins: [] }
        }, location.origin);
      });
    }

    window.addEventListener("message", (event) => {
      if (event.source !== window || event.origin !== location.origin) {
        return;
      }

      if (event.data?.source === "kult-site" && event.data.type === "remote-command") {
        chrome.runtime.sendMessage({
          source: "kult-player-bridge",
          type: "site-command",
          command: event.data.command
        }).catch(() => {});
      }

      if (event.data?.source === "kult-site" && event.data.type === "bridge-ping") {
        announceBridge();
      }
    });

    announceBridge();
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.source !== "kult-player-bridge") {
      return undefined;
    }

    if (message.type === "ping") {
      sendResponse(getState());
      return undefined;
    }

    if (message.type === "command") {
      executeCommand(message.command)
        .then(sendResponse)
        .catch((error) => {
          sendResponse({
            ...getState(),
            ok: false,
            error: error?.message || String(error)
          });
        });

      return true;
    }

    if (message.type === "forward-player-event" && window === window.top) {
      window.postMessage({
        source: "kult-extension",
        type: "player-event",
        event: message.event
      }, location.origin);
      sendResponse({ ok: true });
      return undefined;
    }

    return undefined;
  });
})();
