const PRODUCT_LINK_SELECTOR = 'a[href*="/product/"]';
const SEARCH_INPUT_SELECTORS = [
  'input[name="text"]',
  'input[type="search"]',
  'input[placeholder*="поиск" i]',
  'input[placeholder*="искать" i]',
  'input[aria-label*="поиск" i]',
];

let isProcessingRun = false;
let lastActionSignature = "";

const normalizeText = (value) => String(value || "").replace(/\s+/g, " ").trim();

const isProductPage = () => /\/product\//i.test(window.location.pathname);
const hasProductListing = () => document.querySelector(PRODUCT_LINK_SELECTOR) !== null;
const isListingPage = () => !isProductPage() && (
  /\/search\//i.test(window.location.pathname)
  || /\/category\//i.test(window.location.pathname)
  || hasProductListing()
);

const getPageType = () => {
  if (isProductPage()) {
    return "product";
  }

  if (isListingPage()) {
    return "search";
  }

  return "other";
};

const delay = (ms) => new Promise((resolve) => {
  window.setTimeout(resolve, ms);
});

const sendRuntimeMessage = (payload) => chrome.runtime.sendMessage(payload);

const getDocumentScrollHeight = () => Math.max(
  document.body?.scrollHeight || 0,
  document.documentElement?.scrollHeight || 0,
);

const parseHref = (href) => {
  try {
    return new URL(href, window.location.origin);
  } catch (error) {
    return null;
  }
};

const isCanonicalProductPath = (pathname) => /\/product\/[^/]+-\d+\/?$/i.test(pathname);
const isReviewProductPath = (pathname) => /\/product\/.+\/reviews\/?$/i.test(pathname);

const scoreProductLink = (link, article) => {
  const href = link.getAttribute("href") || "";
  const parsedUrl = parseHref(href);

  if (!parsedUrl) {
    return -1;
  }

  const normalizedArticle = normalizeText(article);
  const text = normalizeText(link.textContent);
  const cardText = normalizeText(link.closest("article, div, li")?.textContent || "");

  let score = 0;

  if (parsedUrl.pathname.includes(normalizedArticle)) {
    score += 10;
  }

  if (text.includes(normalizedArticle)) {
    score += 4;
  }

  if (cardText.includes(normalizedArticle)) {
    score += 3;
  }

  if (isCanonicalProductPath(parsedUrl.pathname)) {
    score += 20;
  }

  if (isReviewProductPath(parsedUrl.pathname)) {
    score -= 10;
  }

  if (parsedUrl.hash) {
    score -= 2;
  }

  if (parsedUrl.search) {
    score -= 1;
  }

  return score;
};

const getSearchInput = () => {
  for (const selector of SEARCH_INPUT_SELECTORS) {
    const input = document.querySelector(selector);

    if (input instanceof HTMLInputElement) {
      return input;
    }
  }

  return null;
};

const getCurrentSearchText = () => {
  const urlText = new URL(window.location.href).searchParams.get("text");

  if (urlText) {
    return normalizeText(urlText);
  }

  const input = getSearchInput();
  return normalizeText(input?.value || "");
};

const submitSearchTerm = async (term) => {
  const input = getSearchInput();

  if (!input) {
    throw new Error("Не удалось найти строку поиска Ozon.");
  }

  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;

  input.focus();
  nativeInputValueSetter?.call(input, term);
  if (input.value !== term) {
    input.value = term;
  }
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));

  const form = input.closest("form");

  if (form) {
    form.requestSubmit();
    return;
  }

  input.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Enter",
    code: "Enter",
    bubbles: true,
  }));
  input.dispatchEvent(new KeyboardEvent("keypress", {
    key: "Enter",
    code: "Enter",
    bubbles: true,
  }));
  input.dispatchEvent(new KeyboardEvent("keyup", {
    key: "Enter",
    code: "Enter",
    bubbles: true,
  }));
};

const canSearchForArticle = () => getSearchInput() !== null;

const findMatchingProduct = (article) => {
  const productLinks = Array.from(document.querySelectorAll(PRODUCT_LINK_SELECTOR));
  let bestMatch = null;
  let bestScore = -1;

  for (const link of productLinks) {
    const href = link.getAttribute("href") || "";
    const text = normalizeText(link.textContent);
    const cardText = normalizeText(link.closest("article, div, li")?.textContent || "");

    if (href.includes(article) || text.includes(article) || cardText.includes(article)) {
      const score = scoreProductLink(link, article);

      if (score > bestScore) {
        bestMatch = link;
        bestScore = score;
      }
    }
  }

  return bestMatch;
};

const scrollForMoreProducts = async () => {
  const productLinks = Array.from(document.querySelectorAll(PRODUCT_LINK_SELECTOR));
  const lastProductLink = productLinks.at(-1);
  const previousScrollY = window.scrollY;
  const previousScrollHeight = getDocumentScrollHeight();

  if (lastProductLink instanceof HTMLElement) {
    lastProductLink.scrollIntoView({
      block: "end",
      inline: "nearest",
    });
  } else {
    window.scrollBy(0, Math.max(window.innerHeight * 0.85, 600));
  }

  await delay(900);

  return {
    previousScrollY,
    previousScrollHeight,
    currentScrollY: window.scrollY,
    currentScrollHeight: getDocumentScrollHeight(),
  };
};

const waitForMatchingProduct = async (article, timeoutMs = 20000) => {
  const startedAt = Date.now();
  let noMoreScrollAttempts = 0;

  while (Date.now() - startedAt <= timeoutMs) {
    const match = findMatchingProduct(article);

    if (match) {
      return match;
    }

    if (isListingPage()) {
      const scrollState = await scrollForMoreProducts();
      const didMove = scrollState.currentScrollY > scrollState.previousScrollY;
      const didGrow = scrollState.currentScrollHeight > scrollState.previousScrollHeight;

      if (!didMove && !didGrow) {
        noMoreScrollAttempts += 1;
      } else {
        noMoreScrollAttempts = 0;
      }

      if (noMoreScrollAttempts >= 3) {
        break;
      }

      continue;
    }

    await delay(500);
  }

  throw new Error(`Артикул ${article} не найден среди текущих результатов.`);
};

const submitArticleSearch = async (article) => submitSearchTerm(article);

const handleOpenProduct = async (command) => {
  const actionSignature = `${command.runId}:open:${command.currentCycle}:${window.location.href}`;

  if (lastActionSignature === actionSignature) {
    return;
  }

  lastActionSignature = actionSignature;

  if (command.delayMs) {
    await delay(command.delayMs);
  }

  const matchingProduct = findMatchingProduct(command.article);
  const normalizedBrand = normalizeText(command.brand || "");

  if (!matchingProduct) {
    const currentSearchText = getCurrentSearchText();

    if (normalizedBrand && canSearchForArticle() && currentSearchText !== normalizedBrand) {
      await submitSearchTerm(command.brand);
      return;
    }

    if (!normalizedBrand && canSearchForArticle() && currentSearchText !== normalizeText(command.article)) {
      await submitArticleSearch(command.article);
      return;
    }
  }

  const match = await waitForMatchingProduct(command.article);
  const response = await sendRuntimeMessage({
    type: "OZON_PRODUCT_OPENING",
    runId: command.runId,
    url: match.href,
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Не удалось подтвердить открытие товара.");
  }

  window.location.assign(match.href);
};

const handleGoBack = async (command) => {
  const actionSignature = `${command.runId}:back:${command.currentCycle}:${window.location.href}`;

  if (lastActionSignature === actionSignature) {
    return;
  }

  lastActionSignature = actionSignature;

  if (command.delayMs) {
    await delay(command.delayMs);
  }

  const response = await sendRuntimeMessage({
    type: "OZON_GOING_BACK",
    runId: command.runId,
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Не удалось подтвердить возврат назад.");
  }

  if (command.returnUrl) {
    window.location.assign(command.returnUrl);
    return;
  }

  window.history.back();
};

const processRun = async () => {
  if (isProcessingRun) {
    return;
  }

  isProcessingRun = true;

  try {
    const command = await sendRuntimeMessage({
      type: "GET_OZON_RUN_COMMAND",
      pageType: getPageType(),
      pageUrl: window.location.href,
    });

    if (!command?.ok || ["idle", "wait", "finish", "stop"].includes(command.action)) {
      return;
    }

    if (command.action === "openProduct") {
      await handleOpenProduct(command);
      return;
    }

    if (command.action === "goBack") {
      await handleGoBack(command);
    }
  } catch (error) {
    await sendRuntimeMessage({
      type: "OZON_RUN_FAILED",
      runId: lastActionSignature.split(":")[0] || "",
      error: error.message || "Не удалось выполнить шаг цикла.",
    }).catch(() => {});
  } finally {
    isProcessingRun = false;
  }
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "PING_OZON_HELPER") {
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "OZON_RUN_WAKE") {
    processRun().catch(() => {});
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type !== "GET_OZON_PRODUCT_URL") {
    return false;
  }

  const article = normalizeText(message.article);

  if (!article) {
    sendResponse({
      ok: false,
      error: "Артикул пустой.",
    });
    return false;
  }

  if (!isListingPage()) {
    sendResponse({
      ok: false,
      error: "Сначала откройте страницу с результатами или категорией Ozon в этой вкладке.",
    });
    return false;
  }

  const matchingLink = findMatchingProduct(article);

  if (!matchingLink) {
    sendResponse({
      ok: false,
      error: `Артикул ${article} не найден среди текущих результатов.`,
    });
    return false;
  }

  sendResponse({
    ok: true,
    url: matchingLink.href,
    message: `Артикул ${article} найден.`,
  });
  return false;
});

window.addEventListener("pageshow", () => {
  processRun().catch(() => {});
});

window.addEventListener("popstate", () => {
  processRun().catch(() => {});
});

processRun().catch(() => {});
