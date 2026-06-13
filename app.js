class Stack {
  constructor() {
    this.items = [];
  }

  push(value) {
    this.items.unshift(value);
  }

  pop() {
    return this.items.shift() ?? null;
  }

  peek() {
    return this.items[0] ?? null;
  }

  clear() {
    this.items = [];
  }

  isEmpty() {
    return this.items.length === 0;
  }

  toArray() {
    return [...this.items];
  }
}

const state = {
  currentPage: "Стартовая страница",
  backPages: new Stack(),
  nextPages: new Stack(),
};

const cycleStepDelayMs = 700;
const closeAfterLastCycleMs = 250;

const elements = {
  form: document.querySelector("#visit-form"),
  siteInput: document.querySelector("#site-input"),
  searchInput: document.querySelector("#search-input"),
  articleInput: document.querySelector("#article-input"),
  cycleCount: document.querySelector("#cycle-count"),
  submitButton: document.querySelector('button[type="submit"]'),
  backButton: document.querySelector("#back-button"),
  forwardButton: document.querySelector("#forward-button"),
  resetButton: document.querySelector("#reset-button"),
  openSearchButton: document.querySelector("#open-search-button"),
  statusMessage: document.querySelector("#status-message"),
  loadingPanel: document.querySelector("#loading-panel"),
  loadingTitle: document.querySelector("#loading-title"),
  loadingCurrent: document.querySelector("#loading-current"),
  loadingTotal: document.querySelector("#loading-total"),
  loadingStep: document.querySelector("#loading-step"),
  progressFill: document.querySelector("#progress-fill"),
};

let isRunningCycles = false;
let fallbackSearchUrl = "";

const normalizeUrl = (value) => {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  if (/^[^\s]+\.[^\s]+$/.test(trimmed)) {
    return `https://${trimmed}`;
  }

  return null;
};

const setStatus = (message) => {
  elements.statusMessage.textContent = message;
};

const normalizeSiteUrl = (value) => {
  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  try {
    const parsedUrl = new URL(withProtocol);
    return parsedUrl.origin;
  } catch (error) {
    return null;
  }
};

const getCycleCount = () => {
  const parsedValue = Number.parseInt(elements.cycleCount.value, 10);

  if (Number.isNaN(parsedValue) || parsedValue < 1) {
    return 1;
  }

  return parsedValue;
};

const setControlsDisabled = (disabled) => {
  elements.submitButton.disabled = disabled;
  elements.siteInput.disabled = disabled;
  elements.searchInput.disabled = disabled;
  elements.articleInput.disabled = disabled;
  elements.cycleCount.disabled = disabled;
  elements.backButton.disabled = disabled || state.backPages.isEmpty();
  elements.forwardButton.disabled = disabled || state.nextPages.isEmpty();
  elements.resetButton.disabled = disabled;
  elements.openSearchButton.disabled = disabled;
};

const setFallbackSearchUrl = (url) => {
  fallbackSearchUrl = url || "";

  if (fallbackSearchUrl) {
    elements.openSearchButton.classList.remove("hidden");
  } else {
    elements.openSearchButton.classList.add("hidden");
  }
};

const showLoadingPanel = ({ title, total, current, step }) => {
  const safeTotal = Math.max(total, 1);
  const safeCurrent = Math.min(Math.max(current, 0), safeTotal);
  const percent = (safeCurrent / safeTotal) * 100;

  elements.loadingPanel.classList.remove("hidden");
  elements.loadingTitle.textContent = title;
  elements.loadingCurrent.textContent = String(safeCurrent);
  elements.loadingTotal.textContent = String(total);
  elements.loadingStep.textContent = step;
  elements.progressFill.style.width = `${percent}%`;
};

const hideLoadingPanel = () => {
  elements.loadingPanel.classList.add("hidden");
  elements.loadingTitle.textContent = "Подготовка запуска";
  elements.loadingCurrent.textContent = "0";
  elements.loadingTotal.textContent = "0";
  elements.loadingStep.textContent = "Ожидание запуска";
  elements.progressFill.style.width = "0%";
};

const startCycleProgress = (title, total) => {
  isRunningCycles = true;
  setControlsDisabled(true);
  showLoadingPanel({
    title,
    total,
    current: 0,
    step: "Запуск цикла...",
  });
};

const updateCycleProgress = (title, current, total) => {
  showLoadingPanel({
    title,
    total,
    current,
    step: `Завершено циклов: ${current} из ${total}`,
  });
};

const finishCycleProgress = (title, total) => {
  showLoadingPanel({
    title,
    total,
    current: total,
    step: `Готово. Выполнено циклов: ${total}`,
  });

  window.setTimeout(() => {
    isRunningCycles = false;
    hideLoadingPanel();
    render();
  }, 900);
};

const stopCycleProgress = (title, current, total, step) => {
  showLoadingPanel({
    title,
    total,
    current,
    step,
  });

  window.setTimeout(() => {
    isRunningCycles = false;
    hideLoadingPanel();
    render();
  }, 900);
};

const render = () => {
  setControlsDisabled(isRunningCycles);
};

const runVisitCycles = (targetUrl, statusPrefix) => {
  const url = normalizeUrl(targetUrl);

  if (!url) {
    setStatus(`${statusPrefix} Это не ссылка, поэтому вкладка не открывалась.`);
    return false;
  }

  const cycleCount = getCycleCount();
  const progressTitle = "Автоматическое открытие";
  const previewTab = window.open("", "_blank");

  if (!previewTab) {
    setStatus(`${statusPrefix} Браузер заблокировал временную вкладку.`);
    return false;
  }

  startCycleProgress(progressTitle, cycleCount);

  const closePreviewTab = () => {
    try {
      if (!previewTab.closed) {
        previewTab.close();
      }
    } catch (error) {
      // Some sites isolate the new tab and prevent reliable programmatic closing.
    }
  };

  previewTab.document.write("<title>Открытие...</title><p style=\"font-family: sans-serif; padding: 24px;\">Открытие страницы...</p>");
  previewTab.document.close();

  let currentCycle = 0;

  const runNextCycle = () => {
    if (previewTab.closed) {
      setStatus(`${statusPrefix} Временная вкладка закрылась до завершения всех циклов.`);
      stopCycleProgress(progressTitle, currentCycle, cycleCount, "Вкладка закрылась раньше времени");
      window.focus();
      return;
    }

    currentCycle += 1;

    try {
      previewTab.location.replace(url);
    } catch (error) {
      previewTab.location.href = url;
    }

    updateCycleProgress(progressTitle, currentCycle, cycleCount);

    if (currentCycle < cycleCount) {
      setStatus(`${statusPrefix} Автоматический цикл ${currentCycle} из ${cycleCount}.`);
      window.setTimeout(runNextCycle, cycleStepDelayMs);
      return;
    }

    setStatus(`${statusPrefix} Финальный цикл ${currentCycle} из ${cycleCount}.`);

    window.setTimeout(() => {
      closePreviewTab();
      setStatus(`${statusPrefix} Выполнено циклов: ${cycleCount}.`);
      finishCycleProgress(progressTitle, cycleCount);
      window.focus();
    }, closeAfterLastCycleMs);
  };

  runNextCycle();

  window.focus();
  return true;
};

const openResolvedTarget = async (site, searchText, article, actionLabel) => {
  const siteUrl = normalizeSiteUrl(site);

  if (!siteUrl) {
    setStatus("Введите корректный адрес сайта.");
    return false;
  }

  const trimmedSearchText = searchText.trim();
  const trimmedArticle = article.trim();

  if (!trimmedSearchText) {
    setStatus("Введите текст для поиска.");
    return false;
  }

  if (!trimmedArticle) {
    setStatus("Введите артикул товара.");
    return false;
  }

  setStatus(`Ищу товар "${trimmedSearchText}" и артикул "${trimmedArticle}" на ${siteUrl}...`);
  showLoadingPanel({
    title: "Поиск товара",
    total: 1,
    current: 0,
    step: `Поиск "${trimmedSearchText}"...`,
  });

  try {
    const response = await fetch(
      `/resolve-product?site=${encodeURIComponent(siteUrl)}&searchText=${encodeURIComponent(trimmedSearchText)}&article=${encodeURIComponent(trimmedArticle)}`,
    );
    const rawText = await response.text();
    let result;

    try {
      result = JSON.parse(rawText);
    } catch (error) {
      result = { error: rawText || "Неизвестная ошибка сервера." };
    }

    hideLoadingPanel();

    if (!response.ok || !result.url) {
      setFallbackSearchUrl(result.searchUrl || "");
      const errorMessage = result.error || "Не удалось получить ссылку на товар.";
      setStatus(errorMessage);
      return false;
    }

    setFallbackSearchUrl("");

    const statusPrefix = `${actionLabel} товар с артикулом "${trimmedArticle}" по запросу "${trimmedSearchText}".`;

    return runVisitCycles(result.url, statusPrefix) ? result.url : false;
  } catch (error) {
    hideLoadingPanel();
    setFallbackSearchUrl("");
    setStatus("Не удалось выполнить поиск товара.");
    return false;
  }
};

elements.cycleCount.addEventListener("change", () => {
  elements.cycleCount.value = String(getCycleCount());
});

const visitPage = (page) => {
  state.backPages.push(state.currentPage);
  state.currentPage = page;
  state.nextPages.clear();
  render();
};

const goBack = () => {
  if (state.backPages.isEmpty()) {
    setStatus("История назад пуста.");
    render();
    return;
  }

  state.nextPages.push(state.currentPage);
  state.currentPage = state.backPages.pop();
  render();
  runVisitCycles(state.currentPage, `Переход назад к "${state.currentPage}".`);
};

const goForward = () => {
  if (state.nextPages.isEmpty()) {
    setStatus("История вперед пуста.");
    render();
    return;
  }

  state.backPages.push(state.currentPage);
  state.currentPage = state.nextPages.pop();
  render();
  runVisitCycles(state.currentPage, `Переход вперед к "${state.currentPage}".`);
};

const resetHistory = () => {
  state.currentPage = "Стартовая страница";
  state.backPages.clear();
  state.nextPages.clear();
  elements.siteInput.value = "";
  elements.searchInput.value = "";
  elements.articleInput.value = "";
  setFallbackSearchUrl("");
  setStatus("История навигации сброшена.");
  render();
};

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const site = elements.siteInput.value.trim();
  const searchText = elements.searchInput.value.trim();
  const article = elements.articleInput.value.trim();

  if (!site) {
    setStatus("Сначала введите сайт.");
    return;
  }

  if (!searchText) {
    setStatus("Сначала введите текст для поиска.");
    return;
  }

  if (!article) {
    setStatus("Сначала введите артикул товара.");
    return;
  }

  const resolvedTarget = await openResolvedTarget(site, searchText, article, "Открыт");

  if (resolvedTarget) {
    visitPage(resolvedTarget);
  }

  elements.articleInput.focus();
});

elements.backButton.addEventListener("click", goBack);
elements.forwardButton.addEventListener("click", goForward);
elements.resetButton.addEventListener("click", resetHistory);
elements.openSearchButton.addEventListener("click", () => {
  if (!fallbackSearchUrl) {
    return;
  }

  window.location.assign(fallbackSearchUrl);
});

render();
