const form = document.querySelector("#find-form");
const brandInput = document.querySelector("#brand-input");
const articleInput = document.querySelector("#article-input");
const cycleInput = document.querySelector("#cycle-input");
const durationInput = document.querySelector("#duration-input");
const scheduleSummary = document.querySelector("#schedule-summary");
const statusMessage = document.querySelector("#status-message");
const progressMessage = document.querySelector("#progress-message");
const startButton = document.querySelector("#start-button");
const stopButton = document.querySelector("#stop-button");

let statusPollTimer = null;
let statusLockUntil = 0;
const DEFAULT_DURATION_MS = 30 * 60 * 1000;

const setStatus = (message) => {
  statusMessage.textContent = message;
};

const setProgress = (message = "") => {
  progressMessage.textContent = message;
};

const setScheduleSummary = (message = "") => {
  scheduleSummary.textContent = message;
};

const setControls = ({ running }) => {
  startButton.disabled = running;
  stopButton.disabled = !running;
  brandInput.disabled = running;
  articleInput.disabled = running;
  cycleInput.disabled = running;
  durationInput.disabled = running;
};

const getCycleCount = () => {
  const parsedValue = Number.parseInt(cycleInput.value, 10);

  if (Number.isNaN(parsedValue) || parsedValue < 1) {
    return 1;
  }

  return parsedValue;
};

const getDurationMs = () => {
  const parsedValue = Number.parseInt(durationInput.value, 10);

  if (Number.isNaN(parsedValue) || parsedValue < 1) {
    return DEFAULT_DURATION_MS;
  }

  return parsedValue;
};

const formatNumber = (value) => {
  if (!Number.isFinite(value)) {
    return "0";
  }

  return new Intl.NumberFormat("ru-RU", {
    maximumFractionDigits: value < 10 ? 1 : 0,
  }).format(value);
};

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

  const totalHours = durationMs / (60 * 60 * 1000);
  return `${formatNumber(totalHours)} ч`;
};

const renderScheduleSummary = () => {
  const cycles = getCycleCount();
  const durationMs = getDurationMs();
  const intervalMs = durationMs / cycles;

  setScheduleSummary(`${cycles} цикл(ов) за ${formatDuration(durationMs)}: 1 цикл каждые ${formatDuration(intervalMs)}.`);
};

const sendRuntimeMessage = (payload) => chrome.runtime.sendMessage(payload);

const loadLastValues = async () => {
  const result = await chrome.storage.local.get(["lastBrand", "lastArticle", "lastCycleCount", "lastDurationMs"]);

  if (result.lastBrand) {
    brandInput.value = result.lastBrand;
  }

  if (result.lastArticle) {
    articleInput.value = result.lastArticle;
  }

  if (result.lastCycleCount) {
    cycleInput.value = String(result.lastCycleCount);
  }

  if (result.lastDurationMs) {
    durationInput.value = String(result.lastDurationMs);
  }

  renderScheduleSummary();
};

const renderStatus = (result) => {
  const isStatusLocked = Date.now() < statusLockUntil;

  if (!result?.ok) {
    setControls({ running: false });
    setProgress("");
    if (!isStatusLocked) {
      setStatus(result?.error || result?.message || "Не удалось получить статус.");
    }
    return;
  }

  if (result.running) {
    statusLockUntil = 0;
    setControls({ running: true });
    setProgress(`Прогресс: ${result.completedCycles || 0} / ${result.cycles || 0}`);
    setStatus(result.step || result.message || "Циклы выполняются...");
    if (result.durationMs && result.cycles) {
      const intervalMs = (result.cycleIntervalMs || result.durationMs / result.cycles);
      setScheduleSummary(
        `${result.cycles} цикл(ов) за ${formatDuration(result.durationMs)}: 1 цикл каждые ${formatDuration(intervalMs)}.`,
      );
    }
    return;
  }

  setControls({ running: false });

  if (result.status === "completed") {
    setProgress(`Прогресс: ${result.completedCycles || 0} / ${result.cycles || 0}`);
  } else {
    setProgress("");
  }

  if (!isStatusLocked) {
    setStatus(result.message || "Готово к запуску.");
  }
};

const refreshStatus = async () => {
  const result = await sendRuntimeMessage({ type: "GET_OZON_RUN_STATUS" });
  renderStatus(result);
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
      setStatus(error.message || "Не удалось обновить статус.");
    });
  }, 1000);
};

const startCycles = async (brand, article, cycles, durationMs) => {
  return sendRuntimeMessage({
    type: "START_OZON_CYCLES",
    brand,
    article,
    cycles,
    durationMs,
  });
};

const stopCycles = async () => {
  return sendRuntimeMessage({
    type: "STOP_OZON_CYCLES",
  });
};

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const brand = brandInput.value.trim();
  const article = articleInput.value.trim();
  const cycles = getCycleCount();
  const durationMs = getDurationMs();

  if (!article) {
    setStatus("Сначала введите артикул.");
    return;
  }

  setControls({ running: true });
  setProgress(`Прогресс: 0 / ${cycles}`);
  setStatus(`Запускаю ${cycles} цикл(ов) для артикула ${article} на ${formatDuration(durationMs)}...`);
  renderScheduleSummary();

  try {
    await chrome.storage.local.set({
      lastBrand: brand,
      lastArticle: article,
      lastCycleCount: cycles,
      lastDurationMs: durationMs,
    });

    const result = await startCycles(brand, article, cycles, durationMs);

    if (!result?.ok) {
      throw new Error(result?.error || "Не удалось запустить циклы.");
    }

    statusLockUntil = 0;
    setStatus(result.message || "Циклы запущены.");
    await refreshStatus();
  } catch (error) {
    setControls({ running: false });
    setProgress("");
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

cycleInput.addEventListener("input", renderScheduleSummary);
cycleInput.addEventListener("change", () => {
  cycleInput.value = String(getCycleCount());
  renderScheduleSummary();
});
durationInput.addEventListener("change", renderScheduleSummary);

window.addEventListener("beforeunload", () => {
  if (statusPollTimer) {
    window.clearInterval(statusPollTimer);
  }
});

Promise.all([loadLastValues(), refreshStatus()])
  .then(() => {
    startStatusPolling();
  })
  .catch((error) => {
    setControls({ running: false });
    setProgress("");
    lockStatusTemporarily(error.message || "Готово к поиску.");
    startStatusPolling();
  });
