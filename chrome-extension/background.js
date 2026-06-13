const activeRuns = new Map();
const lastRunStates = new Map();
const DEFAULT_DURATION_MS = 30 * 60 * 1000;
const GO_BACK_DELAY_MS = 1200;

const isOzonResultsUrl = (url) => {
  try {
    const parsedUrl = new URL(url || "");

    if (!/ozon\.(com|ru)$/i.test(parsedUrl.hostname)) {
      return false;
    }

    if (/\/product\//i.test(parsedUrl.pathname)) {
      return false;
    }

    return /\/search\//i.test(parsedUrl.pathname) || /\/category\//i.test(parsedUrl.pathname);
  } catch (error) {
    return false;
  }
};

const isOzonTab = (url) => {
  try {
    const parsedUrl = new URL(url || "");
    return /ozon\.(com|ru)$/i.test(parsedUrl.hostname);
  } catch (error) {
    return false;
  }
};

const buildRunSnapshot = (run) => ({
  ok: true,
  running: run.status === "running",
  status: run.status,
  tabId: run.tabId,
  brand: run.brand,
  article: run.article,
  startUrl: run.startUrl,
  listingUrl: run.listingUrl,
  cycles: run.cycles,
  durationMs: run.durationMs,
  cycleIntervalMs: run.cycleIntervalMs,
  completedCycles: run.completedCycles,
  currentCycle: run.currentCycle,
  step: run.step,
  message: run.message,
});

const formatNumber = (value) => new Intl.NumberFormat("ru-RU", {
  maximumFractionDigits: value < 10 ? 1 : 0,
}).format(value);

const formatDuration = (durationMs) => {
  if (durationMs < 1000) {
    return `${formatNumber(durationMs)} мс`;
  }

  const totalSeconds = durationMs / 1000;

  if (totalSeconds < 60) {
    return `${formatNumber(totalSeconds)} сек`;
  }

  const totalMinutes = durationMs / (60 * 1000);

  if (totalMinutes < 60) {
    return `${formatNumber(totalMinutes)} мин`;
  }

  return `${formatNumber(durationMs / (60 * 60 * 1000))} ч`;
};

const parseDurationMs = (value) => {
  const parsedValue = Number.parseInt(String(value || DEFAULT_DURATION_MS), 10);

  if (Number.isNaN(parsedValue) || parsedValue < 1) {
    return DEFAULT_DURATION_MS;
  }

  return parsedValue;
};

const calculateCycleIntervalMs = (durationMs, cycles) => Math.max(0, Math.floor(durationMs / cycles));

const rememberRunState = (run) => {
  lastRunStates.set(run.tabId, {
    ...buildRunSnapshot(run),
    updatedAt: Date.now(),
  });
};

const updateRun = (run, patch) => {
  Object.assign(run, patch);
  rememberRunState(run);
};

const finishRun = (run, status, message) => {
  updateRun(run, {
    status,
    step: message,
    message,
  });

  activeRuns.delete(run.tabId);
};

const cancelRunByTabId = (tabId, reason = "Циклы остановлены.") => {
  const run = activeRuns.get(tabId);

  if (!run) {
    return false;
  }

  finishRun(run, "stopped", reason);
  return true;
};

const getWindowTabs = async () => chrome.tabs.query({ currentWindow: true });

const getSearchTab = async () => {
  const tabs = await getWindowTabs();
  const activeTab = tabs.find((tab) => tab.active);

  if (activeTab && isOzonResultsUrl(activeTab.url)) {
    return activeTab;
  }

  return tabs.find((tab) => isOzonResultsUrl(tab.url)) || null;
};

const getStatusTab = async () => {
  const tabs = await getWindowTabs();
  const activeTab = tabs.find((tab) => tab.active);

  if (activeTab?.id && (activeRuns.has(activeTab.id) || lastRunStates.has(activeTab.id))) {
    return activeTab;
  }

  const runTab = tabs.find((tab) => tab.id && (activeRuns.has(tab.id) || lastRunStates.has(tab.id)));

  if (runTab) {
    return runTab;
  }

  if (activeTab && isOzonTab(activeTab.url)) {
    return activeTab;
  }

  return tabs.find((tab) => isOzonTab(tab.url)) || null;
};

const ensureContentScript = async (tabId) => {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "PING_OZON_HELPER" });
    return;
  } catch (error) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
  }
};

const wakeTab = async (tabId) => {
  try {
    await ensureContentScript(tabId);
    await chrome.tabs.sendMessage(tabId, { type: "OZON_RUN_WAKE" });
  } catch (error) {
    // Ignore wake failures; the content script will also re-check on load.
  }
};

const startRun = async (brand, article, cycles, durationMs) => {
  const tab = await getSearchTab();

  if (!tab?.id) {
    throw new Error("Сначала откройте страницу с результатами или категорией Ozon в любой вкладке этого окна.");
  }

  cancelRunByTabId(tab.id, "Предыдущий запуск заменен новым.");

  const run = {
    runId: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    tabId: tab.id,
    brand,
    article,
    startUrl: tab.url || "",
    listingUrl: tab.url || "",
    cycles,
    durationMs,
    cycleIntervalMs: calculateCycleIntervalMs(durationMs, cycles),
    completedCycles: 0,
    currentCycle: 1,
    nextCycleDelayMs: 0,
    phase: "search",
    status: "running",
    step: `Ищу товар: цикл 1 из ${cycles}.`,
    message: `Выполнено 0 из ${cycles}. Интервал между циклами: ${formatDuration(calculateCycleIntervalMs(durationMs, cycles))}.`,
  };

  activeRuns.set(tab.id, run);
  rememberRunState(run);
  await chrome.tabs.update(tab.id, { active: true });
  await wakeTab(tab.id);

  return {
    ok: true,
    running: true,
    message: brand
      ? `Запущено ${cycles} цикл(ов) для бренда ${brand} и артикула ${article} на ${formatDuration(durationMs)}.`
      : `Запущено ${cycles} цикл(ов) для артикула ${article} на ${formatDuration(durationMs)}.`,
  };
};

const getRunStatus = async () => {
  const tab = await getStatusTab();

  if (!tab?.id) {
    return {
      ok: true,
      running: false,
      status: "idle",
      message: "Готово к запуску.",
    };
  }

  const activeRun = activeRuns.get(tab.id);

  if (activeRun) {
    return buildRunSnapshot(activeRun);
  }

  const lastRun = lastRunStates.get(tab.id);

  if (lastRun) {
    return lastRun;
  }

  return {
    ok: true,
    running: false,
    status: "idle",
    message: "Готово к запуску.",
  };
};

const stopRun = async () => {
  const tab = await getStatusTab();

  if (!tab?.id) {
    return {
      ok: true,
      message: "Активных циклов нет.",
    };
  }

  const stopped = cancelRunByTabId(tab.id, "Циклы остановлены пользователем.");

  return {
    ok: true,
    message: stopped ? "Циклы остановлены." : "Активных циклов нет.",
  };
};

const getRunCommand = (tabId, pageType, pageUrl) => {
  const run = activeRuns.get(tabId);

  if (!run) {
    return {
      ok: true,
      action: "idle",
    };
  }

  if ((run.phase === "search" || run.phase === "opening") && pageType === "search") {
    const delayMs = run.nextCycleDelayMs || 0;

    updateRun(run, {
      currentCycle: run.completedCycles + 1,
      listingUrl: pageUrl || run.listingUrl,
      phase: "opening",
      step: delayMs > 0
        ? `Жду ${formatDuration(delayMs)} перед циклом ${run.completedCycles + 1} из ${run.cycles}.`
        : `Ищу товар: цикл ${run.completedCycles + 1} из ${run.cycles}.`,
      message: `Выполнено ${run.completedCycles} из ${run.cycles}.`,
    });

    return {
      ok: true,
      action: "openProduct",
      runId: run.runId,
      brand: run.brand,
      article: run.article,
      currentCycle: run.currentCycle,
      cycles: run.cycles,
      delayMs,
    };
  }

  if (pageType === "product") {
    updateRun(run, {
      phase: "product",
      step: `Жду ${formatDuration(Math.max(GO_BACK_DELAY_MS, run.cycleIntervalMs))} на товаре: цикл ${run.currentCycle} из ${run.cycles}.`,
      message: `Выполнено ${run.completedCycles} из ${run.cycles}.`,
    });

    return {
      ok: true,
      action: "goBack",
      runId: run.runId,
      currentCycle: run.currentCycle,
      cycles: run.cycles,
      delayMs: Math.max(GO_BACK_DELAY_MS, run.cycleIntervalMs),
      returnUrl: run.listingUrl || run.startUrl,
    };
  }

  if (run.phase === "returning" && pageType === "search") {
    const completedCycles = run.completedCycles + 1;

    if (completedCycles >= run.cycles) {
      updateRun(run, {
        completedCycles: run.cycles,
        currentCycle: run.cycles,
      });
      finishRun(run, "completed", `Готово. Выполнено ${run.cycles} циклов за ${formatDuration(run.durationMs)}.`);
      return {
        ok: true,
        action: "finish",
      };
    }

    updateRun(run, {
      completedCycles,
      currentCycle: completedCycles + 1,
      phase: "search",
      nextCycleDelayMs: 0,
      step: `Ищу товар: цикл ${completedCycles + 1} из ${run.cycles}.`,
      message: `Выполнено ${completedCycles} из ${run.cycles}.`,
    });

    return {
      ok: true,
      action: "openProduct",
      runId: run.runId,
      brand: run.brand,
      article: run.article,
      currentCycle: run.currentCycle,
      cycles: run.cycles,
      delayMs: 0,
    };
  }

  return {
    ok: true,
    action: "wait",
    runId: run.runId,
  };
};

const markProductOpening = (tabId, runId, productUrl) => {
  const run = activeRuns.get(tabId);

  if (!run || run.runId !== runId) {
    return {
      ok: false,
      error: "Запуск уже неактивен.",
    };
  }

  updateRun(run, {
    phase: "product",
    step: `Открываю товар: цикл ${run.currentCycle} из ${run.cycles}.`,
    message: `Выполнено ${run.completedCycles} из ${run.cycles}.`,
    lastProductUrl: productUrl,
    nextCycleDelayMs: 0,
  });

  return {
    ok: true,
  };
};

const markGoingBack = (tabId, runId) => {
  const run = activeRuns.get(tabId);

  if (!run || run.runId !== runId) {
    return {
      ok: false,
      error: "Запуск уже неактивен.",
    };
  }

  updateRun(run, {
    phase: "returning",
    step: `Возвращаюсь назад: цикл ${run.currentCycle} из ${run.cycles}.`,
    message: `Выполнено ${run.completedCycles} из ${run.cycles}.`,
  });

  return {
    ok: true,
  };
};

const failRun = (tabId, runId, errorMessage) => {
  const run = activeRuns.get(tabId);

  if (!run || run.runId !== runId) {
    return {
      ok: false,
      error: "Запуск уже неактивен.",
    };
  }

  finishRun(run, "error", errorMessage || "Не удалось выполнить циклы.");
  return {
    ok: true,
  };
};

chrome.tabs.onRemoved.addListener((tabId) => {
  cancelRunByTabId(tabId, "Вкладка была закрыта.");
  lastRunStates.delete(tabId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "START_OZON_CYCLES") {
    const brand = String(message.brand || "").trim();
    const article = String(message.article || "").trim();
    const cycles = Math.max(1, Number.parseInt(String(message.cycles || "1"), 10) || 1);
    const durationMs = parseDurationMs(message.durationMs);

    if (!article) {
      sendResponse({
        ok: false,
        error: "Артикул пустой.",
      });
      return false;
    }

    startRun(brand, article, cycles, durationMs)
      .then(sendResponse)
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error.message || "Не удалось запустить циклы.",
        });
      });

    return true;
  }

  if (message?.type === "GET_OZON_RUN_STATUS") {
    getRunStatus()
      .then(sendResponse)
      .catch((error) => {
        sendResponse({
          ok: false,
          running: false,
          status: "error",
          message: error.message || "Не удалось получить статус.",
        });
      });

    return true;
  }

  if (message?.type === "STOP_OZON_CYCLES") {
    stopRun()
      .then(sendResponse)
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error.message || "Не удалось остановить циклы.",
        });
      });

    return true;
  }

  if (message?.type === "GET_OZON_RUN_COMMAND") {
    const tabId = sender.tab?.id;

    if (!tabId) {
      sendResponse({
        ok: false,
        action: "idle",
        error: "Не удалось определить вкладку.",
      });
      return false;
    }

    sendResponse(getRunCommand(tabId, message.pageType, String(message.pageUrl || "")));
    return false;
  }

  if (message?.type === "OZON_PRODUCT_OPENING") {
    const tabId = sender.tab?.id;

    if (!tabId) {
      sendResponse({
        ok: false,
        error: "Не удалось определить вкладку.",
      });
      return false;
    }

    sendResponse(markProductOpening(tabId, message.runId, message.url));
    return false;
  }

  if (message?.type === "OZON_GOING_BACK") {
    const tabId = sender.tab?.id;

    if (!tabId) {
      sendResponse({
        ok: false,
        error: "Не удалось определить вкладку.",
      });
      return false;
    }

    sendResponse(markGoingBack(tabId, message.runId));
    return false;
  }

  if (message?.type === "OZON_RUN_FAILED") {
    const tabId = sender.tab?.id;

    if (!tabId) {
      sendResponse({
        ok: false,
        error: "Не удалось определить вкладку.",
      });
      return false;
    }

    sendResponse(failRun(tabId, message.runId, message.error));
    return false;
  }

  return false;
});
