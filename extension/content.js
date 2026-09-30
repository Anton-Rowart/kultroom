(() => {
  const bridgeVersion = "0.5.0";

  if (globalThis.__kultPlayerBridgeInstalled === bridgeVersion) {
    return;
  }

  globalThis.__kultPlayerBridgeInstalled = bridgeVersion;

  const unlockButtonId = "kult-player-bridge-unlock";
  const observedVideos = new WeakSet();
  const playbackHealth = new WeakMap();
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
    playbackHealth.set(video, { buffering: video.readyState < 2 });
    video.addEventListener("play", () => emitPlayerEvent("play", video));
    video.addEventListener("pause", () => emitPlayerEvent("pause", video));
    video.addEventListener("seeked", () => emitPlayerEvent("seek", video));
    video.addEventListener("ratechange", () => emitPlayerEvent("ratechange", video));
    video.addEventListener("waiting", () => { playbackHealth.get(video).buffering = true; });
    video.addEventListener("stalled", () => { playbackHealth.get(video).buffering = true; });
    video.addEventListener("playing", () => { playbackHealth.get(video).buffering = false; });
    video.addEventListener("canplay", () => { playbackHealth.get(video).buffering = false; });
  }

  function primaryVideo() {
    const videos = getTargetVideos();
    return videos.find((video) => !video.paused && video.readyState > 0)
      || videos.find((video) => video.readyState > 0)
      || videos[0];
  }

  function bufferAhead(video) {
    if (!video.buffered) return 0;
    for (let index = 0; index < video.buffered.length; index += 1) {
      if (video.buffered.start(index) <= video.currentTime && video.buffered.end(index) >= video.currentTime) {
        return Math.max(0, video.buffered.end(index) - video.currentTime);
      }
    }
    return 0;
  }

  function emitTelemetry() {
    const video = primaryVideo();
    if (!video) return;
    const quality = typeof video.getVideoPlaybackQuality === "function" ? video.getVideoPlaybackQuality() : null;
    chrome.runtime.sendMessage({
      source: "kult-player-bridge",
      type: "telemetry",
      telemetry: {
        position: Number(video.currentTime.toFixed(3)),
        duration: Number.isFinite(video.duration) ? Number(video.duration.toFixed(3)) : null,
        paused: video.paused,
        buffering: playbackHealth.get(video)?.buffering === true,
        readyState: video.readyState,
        bufferAhead: Number(bufferAhead(video).toFixed(2)),
        downlink: Number.isFinite(navigator.connection?.downlink) ? navigator.connection.downlink : null,
        effectiveType: navigator.connection?.effectiveType || null,
        droppedFrames: quality?.droppedVideoFrames ?? null,
        totalFrames: quality?.totalVideoFrames ?? null,
        emittedAt: Date.now()
      }
    }).catch(() => {});
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
    if (navigator.userActivation?.hasBeenActive === true || document.getElementById(unlockButtonId)) {
      return;
    }

    const videos = getTargetVideos();

    if (videos.length === 0 || !document.body) {
      return;
    }

    const button = document.createElement("button");
    button.id = unlockButtonId;
    button.type = "button";
    button.innerHTML = "<span style=\"display:grid;gap:8px;max-width:360px;padding:22px 26px;border:1px solid rgba(255,255,255,.22);border-radius:22px;background:rgba(20,20,22,.82);box-shadow:0 24px 80px rgba(0,0,0,.38);color:#fff;text-align:center\"><strong style=\"font-size:16px;letter-spacing:-.01em\">Активировать плеер</strong><small style=\"color:rgba(255,255,255,.62);font:13px/1.4 system-ui\">Один клик — и синхронизация готова</small></span>";
    button.setAttribute("aria-label", "Активировать видео для совместного просмотра");
    button.style.cssText = [
      "position:fixed",
      "inset:0",
      "z-index:2147483647",
      "display:grid",
      "width:100%",
      "height:100%",
      "padding:24px",
      "place-items:center",
      "border:0",
      "background:rgba(6,6,8,.32)",
      "backdrop-filter:blur(22px) saturate(.75)",
      "-webkit-backdrop-filter:blur(22px) saturate(.75)",
      "cursor:pointer"
    ].join(";");

    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      button.disabled = true;
      button.innerHTML = "<span style=\"padding:16px 20px;border-radius:18px;background:rgba(20,20,22,.82);color:#fff;font:600 14px system-ui\">Подготавливаем видео…</span>";

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

        const startedAt = Date.now();
        while (videos.every((video) => video.paused) && Date.now() - startedAt < 2000) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }

        if (hasPlayerControl) {
          clickPlayerPauseControl();
        }

        for (const video of videos) {
          video.pause();
          try { video.currentTime = 0; } catch {}
        }

        button.remove();
      } catch (error) {
        button.disabled = false;
        button.innerHTML = `<span style="padding:16px 20px;border-radius:18px;background:rgba(20,20,22,.88);color:#fff;font:600 14px system-ui">Не получилось. Нажмите ещё раз</span>`;
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

  const videoObserver = new MutationObserver(() => {
    observeAllVideos();
  });

  chrome.runtime.sendMessage({
    source: "kult-player-bridge",
    type: "context-check"
  }).then((status) => {
    if (!status?.active) return;
    observeAllVideos();
    videoObserver.observe(document.documentElement, { childList: true, subtree: true });
    emitTelemetry();
    setInterval(emitTelemetry, 1000);
  }).catch(() => {});

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

    if (message.type === "forward-telemetry" && window === window.top) {
      window.postMessage({ source: "kult-extension", type: "telemetry", telemetry: message.telemetry }, location.origin);
      sendResponse({ ok: true });
      return undefined;
    }

    return undefined;
  });
})();
