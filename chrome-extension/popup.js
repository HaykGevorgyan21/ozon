const form = document.querySelector("#find-form");
const brandInput = document.querySelector("#brand-input");
const searchTermList = document.querySelector("#search-term-list");
const addSearchTermButton = document.querySelector("#add-search-term-button");
const articleInput = document.querySelector("#article-input");
const cycleInput = document.querySelector("#cycle-input");
const statusMessage = document.querySelector("#status-message");
const progressMessage = document.querySelector("#progress-message");
const metricsMessage = document.querySelector("#metrics-message");
const startButton = document.querySelector("#start-button");
const stopButton = document.querySelector("#stop-button");
const nextProxyButton = document.querySelector("#next-proxy-button");
const disableProxyButton = document.querySelector("#disable-proxy-button");
const proxyMessage = document.querySelector("#proxy-message");

let statusPollTimer = null;
let statusLockUntil = 0;
let proxyConfigured = false;
let runIsActive = false;

const getSearchTermInputs = () => Array.from(document.querySelectorAll(".search-term-input"));

const setStatus = (message) => {
  statusMessage.textContent = message;
};

const setProgress = (message = "") => {
  progressMessage.textContent = message;
};

const setMetrics = (message = "") => {
  metricsMessage.textContent = message;
};

const setProxyMessage = (message = "") => {
  proxyMessage.textContent = message;
};

const formatMetricDuration = (durationMs = 0) => {
  const safeValue = Math.max(0, Number.parseInt(String(durationMs || 0), 10) || 0);

  if (safeValue < 1000) {
    return `${safeValue} мс`;
  }

  return `${(safeValue / 1000).toFixed(1)} сек`;
};

const buildMetricsSummary = (result) => {
  const metrics = result?.metrics;

  if (!metrics) {
    return "";
  }

  const completedCycles = Math.max(0, Number.parseInt(String(result?.completedCycles || 0), 10) || 0);
  const productVisits = Math.max(0, Number.parseInt(String(metrics.productVisits || 0), 10) || 0);
  const productOpenSignals = Math.max(0, Number.parseInt(String(metrics.productOpenSignals || 0), 10) || 0);
  const backNavigations = Math.max(0, Number.parseInt(String(metrics.backNavigations || 0), 10) || 0);
  const searchSubmissions = Math.max(0, Number.parseInt(String(metrics.searchSubmissions || 0), 10) || 0);
  const proxyRotations = Math.max(0, Number.parseInt(String(metrics.proxyRotations || 0), 10) || 0);
  const proxyRecoveries = Math.max(0, Number.parseInt(String(metrics.proxyRecoveries || 0), 10) || 0);
  const proxyFallbackCycles = Math.max(0, Number.parseInt(String(metrics.proxyFallbackCycles || 0), 10) || 0);
  const failedCycles = Math.max(0, Number.parseInt(String(metrics.failedCycles || 0), 10) || 0);
  const totalProductHoldMs = Math.max(0, Number.parseInt(String(metrics.totalProductHoldMs || 0), 10) || 0);
  const averageHoldMs = productVisits ? Math.round(totalProductHoldMs / productVisits) : 0;

  return [
    `Метрики: открытий товара ${productOpenSignals}, визитов ${productVisits}, возвратов ${backNavigations}.`,
    `Поисков ${searchSubmissions}, proxy rotations ${proxyRotations}.`,
    `Proxy recoveries ${proxyRecoveries}, fallback cycles ${proxyFallbackCycles}, failed cycles ${failedCycles}.`,
    `Среднее время на товаре ${formatMetricDuration(averageHoldMs)}, завершено циклов ${completedCycles}.`,
  ].join(" ");
};

const createSearchTermRow = (value = "") => {
  const row = document.createElement("div");
  row.className = "search-term-row";

  const input = document.createElement("input");
  input.type = "text";
  input.autocomplete = "off";
  input.placeholder = "Еще одно название товара";
  input.className = "search-term-input";
  input.value = value;

  const removeButton = document.createElement("button");
  removeButton.type = "button";
  removeButton.className = "secondary-button search-term-remove-button";
  removeButton.textContent = "-";
  removeButton.setAttribute("aria-label", "Удалить это название товара");
  removeButton.addEventListener("click", () => {
    row.remove();
  });

  row.append(input, removeButton);
  return row;
};

const clearExtraSearchTermRows = () => {
  Array.from(searchTermList.querySelectorAll(".search-term-row")).slice(1).forEach((row) => {
    row.remove();
  });
};

const setSearchTerms = (values = []) => {
  const normalizedValues = Array.isArray(values)
    ? values.map((value) => String(value || "").trim())
    : [];
  const [firstValue = "", ...restValues] = normalizedValues;

  brandInput.value = firstValue;
  clearExtraSearchTermRows();
  restValues.forEach((value) => {
    searchTermList.append(createSearchTermRow(value));
  });
};

const getSearchTerms = () => getSearchTermInputs()
  .map((input) => String(input.value || "").trim())
  .filter(Boolean);

const setControls = ({ running }) => {
  runIsActive = running;
  startButton.disabled = running;
  stopButton.disabled = !running;
  getSearchTermInputs().forEach((input) => {
    input.disabled = running;
  });
  addSearchTermButton.disabled = running;
  Array.from(document.querySelectorAll(".search-term-remove-button")).forEach((button) => {
    button.disabled = running;
  });
  articleInput.disabled = running;
  cycleInput.disabled = running;
  nextProxyButton.disabled = running || !proxyConfigured;
  disableProxyButton.disabled = running;
};

const getCycleCount = () => {
  const parsedValue = Number.parseInt(cycleInput.value, 10);

  if (Number.isNaN(parsedValue) || parsedValue < 1) {
    return 1;
  }

  return parsedValue;
};

const sendRuntimeMessage = (payload) => chrome.runtime.sendMessage(payload);

const getProxyStatus = async () => sendRuntimeMessage({ type: "GET_OZON_PROXY_STATUS" });

const rotateProxy = async () => sendRuntimeMessage({ type: "ROTATE_OZON_PROXY" });

const clearProxy = async () => sendRuntimeMessage({ type: "CLEAR_OZON_PROXY" });

const loadLastValues = async () => {
  const result = await chrome.storage.local.get([
    "lastBrand",
    "lastSearchTerms",
    "lastArticle",
    "lastCycleCount",
  ]);

  if (Array.isArray(result.lastSearchTerms) && result.lastSearchTerms.length) {
    setSearchTerms(result.lastSearchTerms);
  } else if (result.lastBrand) {
    brandInput.value = result.lastBrand;
  }

  if (result.lastArticle) {
    articleInput.value = result.lastArticle;
  }

  if (result.lastCycleCount) {
    cycleInput.value = String(result.lastCycleCount);
  }
};

const renderStatus = (result) => {
  const isStatusLocked = Date.now() < statusLockUntil;

  if (!result?.ok) {
    setControls({ running: false });
    setProgress("");
    setMetrics("");
    if (!isStatusLocked) {
      setStatus(result?.error || result?.message || "Не удалось получить статус.");
    }
    return;
  }

  if (result.running) {
    statusLockUntil = 0;
    setControls({ running: true });
    setProgress(`Прогресс: ${result.completedCycles || 0} / ${result.cycles || 0}`);
    setMetrics(buildMetricsSummary(result));
    setStatus(result.step || result.message || "Циклы выполняются...");
    if (result.proxyCycleMessage) {
      setProxyMessage(result.proxyCycleMessage);
    }
    return;
  }

  setControls({ running: false });

  if (result.status === "completed") {
    setProgress(`Прогресс: ${result.completedCycles || 0} / ${result.cycles || 0}`);
  } else {
    setProgress("");
  }

  setMetrics(buildMetricsSummary(result));

  if (!isStatusLocked) {
    setStatus(result.message || "Готово к запуску.");
  }

  if (result.proxyCycleMessage) {
    setProxyMessage(result.proxyCycleMessage);
  }
};

const renderProxyStatus = (result) => {
  if (!result?.ok) {
    proxyConfigured = false;
    nextProxyButton.disabled = true;
    setProxyMessage(result?.message || "Не удалось получить статус proxy.");
    return;
  }

  proxyConfigured = Boolean(result.hasProxies);
  nextProxyButton.disabled = runIsActive || !proxyConfigured;
  disableProxyButton.disabled = runIsActive;
  setProxyMessage(result.message || "Proxy не задан.");
};

const refreshStatus = async () => {
  const result = await sendRuntimeMessage({ type: "GET_OZON_RUN_STATUS" });
  renderStatus(result);
};

const refreshProxyStatus = async () => {
  const result = await getProxyStatus();
  renderProxyStatus(result);
};

const lockStatusTemporarily = (message, durationMs = 6000) => {
  statusLockUntil = Date.now() + durationMs;
  setStatus(message);
};

const startStatusPolling = () => {
  if (statusPollTimer) {
    window.clearInterval(statusPollTimer);
  }

  statusPollTimer = window.setInterval(() => {
    refreshStatus().catch((error) => {
      setControls({ running: false });
      setProgress("");
      setMetrics("");
      setStatus(error.message || "Не удалось обновить статус.");
    });
  }, 1000);
};

const startCycles = async (searchTerms, article, cycles) => {
  return sendRuntimeMessage({
    type: "START_OZON_CYCLES",
    brand: Array.isArray(searchTerms) ? String(searchTerms[0] || "").trim() : "",
    searchTerms,
    brandFilter: "",
    article,
    cycles,
  });
};

const stopCycles = async () => {
  return sendRuntimeMessage({
    type: "STOP_OZON_CYCLES",
  });
};

addSearchTermButton.addEventListener("click", () => {
  searchTermList.append(createSearchTermRow(""));
  const inputs = getSearchTermInputs();
  inputs.at(-1)?.focus();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const searchTerms = getSearchTerms();
  const article = articleInput.value.trim();
  const cycles = getCycleCount();

  if (!article) {
    setStatus("Сначала введите артикул.");
    return;
  }

  setControls({ running: true });
  setProgress(`Прогресс: 0 / ${cycles}`);
  setMetrics("");
  setStatus(`Запускаю поиск и открытие товара: цикл 1 из ${cycles}.`);

  try {
    await chrome.storage.local.set({
      lastBrand: searchTerms[0] || "",
      lastSearchTerms: searchTerms,
      lastArticle: article,
      lastCycleCount: cycles,
    });

    const result = await startCycles(searchTerms, article, cycles);

    if (!result?.ok) {
      throw new Error(result?.error || "Не удалось запустить циклы.");
    }

    statusLockUntil = 0;
    setStatus(result.message || "Циклы запущены.");
    await refreshStatus();
  } catch (error) {
    setControls({ running: false });
    setProgress("");
    setMetrics("");
    lockStatusTemporarily(error.message || "Не удалось запустить циклы.");
  }
});

stopButton.addEventListener("click", async () => {
  try {
    const result = await stopCycles();
    setControls({ running: false });
    setProgress("");
    setStatus(result?.message || "Циклы остановлены.");
  } catch (error) {
    setStatus(error.message || "Не удалось остановить циклы.");
  }
});

nextProxyButton.addEventListener("click", async () => {
  setProxyMessage("Переключаю proxy...");
  nextProxyButton.disabled = true;

  try {
    const result = await rotateProxy();

    if (!result?.ok) {
      throw new Error(result?.message || "Не удалось переключить proxy.");
    }

    renderProxyStatus(result);
  } catch (error) {
    proxyConfigured = false;
    nextProxyButton.disabled = true;
    setProxyMessage(error.message || "Не удалось переключить proxy.");
  }
});

disableProxyButton.addEventListener("click", async () => {
  setProxyMessage("Отключаю proxy...");
  nextProxyButton.disabled = true;
  disableProxyButton.disabled = true;

  try {
    const result = await clearProxy();

    if (!result?.ok) {
      throw new Error(result?.message || "Не удалось отключить proxy.");
    }

    renderProxyStatus(result);
  } catch (error) {
    disableProxyButton.disabled = runIsActive;
    nextProxyButton.disabled = runIsActive || !proxyConfigured;
    setProxyMessage(error.message || "Не удалось отключить proxy.");
  }
});

cycleInput.addEventListener("change", () => {
  cycleInput.value = String(getCycleCount());
});

window.addEventListener("beforeunload", () => {
  if (statusPollTimer) {
    window.clearInterval(statusPollTimer);
  }
});

Promise.all([loadLastValues(), refreshStatus()])
  .then(() => {
    return refreshProxyStatus();
  })
  .then(() => {
    startStatusPolling();
  })
  .catch((error) => {
    setControls({ running: false });
    setProgress("");
    setMetrics("");
    lockStatusTemporarily(error.message || "Готово к поиску.");
    refreshProxyStatus().catch(() => {
      setProxyMessage("Proxy не задан. Расширение работает без proxy.");
    });
    startStatusPolling();
  });
