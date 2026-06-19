const PRODUCT_LINK_SELECTOR = 'a[href*="/product/"]';
const SEARCH_INPUT_SELECTORS = [
  'input[name="text"]',
  'input[type="search"]',
  'input[inputmode="search"]',
  'input[placeholder*="поиск" i]',
  'input[placeholder*="искать" i]',
  'input[aria-label*="поиск" i]',
];
const BRAND_FILTER_INPUT_SELECTORS = [
  'input[placeholder*="найти" i]',
  'input[aria-label*="найти" i]',
  'input[placeholder*="бренд" i]',
  'input[aria-label*="бренд" i]',
];
const BRAND_SECTION_TEXTS = ["бренды", "бренд"];
const SEARCH_RESULTS_READY_TIMEOUT_MS = 4500;
const BRAND_FILTER_READY_TIMEOUT_MS = 3500;
const MATCH_RETRY_TIMEOUT_MS = 5000;
const LOGIN_PAGE_PATH_PATTERNS = [
  /\/login/i,
  /\/signin/i,
  /\/auth/i,
  /\/my\/login/i,
  /\/ozonid/i,
  /\/sso/i,
];
const PHONE_INPUT_SELECTORS = [
  'input[autocomplete="tel"]',
  'input[autocomplete="tel-national"]',
  'input[inputmode="tel"]',
  'input[name*="login" i]',
  'input[name*="phone" i]',
  'input[id*="login" i]',
  'input[id*="phone" i]',
  'input[placeholder*="тел" i]',
  'input[aria-label*="тел" i]',
  'input[type="text"]',
  'input[type="tel"]',
  'input[type="email"]',
  'input[autocomplete="username"]',
  'input[name*="email" i]',
  'input[id*="email" i]',
  'input[placeholder*="логин" i]',
  'input[placeholder*="почт" i]',
];
const PASSWORD_INPUT_SELECTORS = [
  'input[type="password"]',
  'input[name*="password" i]',
  'input[id*="password" i]',
];
const CODE_INPUT_SELECTORS = [
  'input[autocomplete="one-time-code"]',
  'input[name*="code" i]',
  'input[id*="code" i]',
  'input[placeholder*="код" i]',
  'input[aria-label*="код" i]',
];
const SUBMIT_BUTTON_SELECTORS = [
  'button[type="submit"]',
  'input[type="submit"]',
  'button[aria-label*="войти" i]',
  'button[aria-label*="login" i]',
  'button[name*="login" i]',
];
const SIGN_IN_TRIGGER_SELECTORS = [
  'a[href*="login" i]',
  'a[href*="ozonid" i]',
  'a[href*="signin" i]',
  'a[href*="auth" i]',
  'button[aria-label*="войти" i]',
  'a[aria-label*="войти" i]',
  'a[title*="войти" i]',
  'button[title*="войти" i]',
  '[data-widget*="profile" i] a',
  '[data-widget*="profile" i] button',
  'header a[href]',
  'header button',
];
const LOGIN_CTA_TEXTS = [
  "войти или зарегистрироваться",
  "войти",
  "зарегистрироваться",
  "sign in",
  "log in",
];
const LOGOUT_TEXTS = [
  "выйти",
  "выход",
  "logout",
  "log out",
  "sign out",
];
const PERSONAL_CABINET_TEXTS = [
  "личный кабинет",
];
const ACCOUNT_RECORD_TEXTS = [
  "моя учетная запись",
];
const ACCOUNT_LOGOUT_TEXTS = [
  "выйти из аккаунта",
];
const CONNECTION_ERROR_TEXTS = [
  "похоже, нет соединения",
  "нет соединения",
  "выключите vpn",
  "подключитесь к другой сети",
  "обновить страницу",
];

let isProcessingRun = false;
let lastActionSignature = "";
let lastAppliedBrandFilterKey = "";
const APPLIED_BRAND_FILTER_STORAGE_KEY = "ozon_helper_applied_brand_filter_key";

const getStoredAppliedBrandFilterKey = () => {
  try {
    return String(window.sessionStorage.getItem(APPLIED_BRAND_FILTER_STORAGE_KEY) || "");
  } catch (error) {
    return "";
  }
};

const setStoredAppliedBrandFilterKey = (key) => {
  try {
    if (key) {
      window.sessionStorage.setItem(APPLIED_BRAND_FILTER_STORAGE_KEY, key);
      return;
    }

    window.sessionStorage.removeItem(APPLIED_BRAND_FILTER_STORAGE_KEY);
  } catch (error) {
    // Ignore storage issues and keep runtime state only.
  }
};

const normalizeText = (value) => String(value || "").replace(/\s+/g, " ").trim();

const isProductPage = () => /\/product\//i.test(window.location.pathname);
const hasPasswordField = () => document.querySelector(PASSWORD_INPUT_SELECTORS.join(", ")) !== null;
const looksLikeLoginPath = () => LOGIN_PAGE_PATH_PATTERNS.some((pattern) => pattern.test(window.location.pathname));
const isLoginPage = () => looksLikeLoginPath() || hasPasswordField();
const hasProductListing = () => document.querySelector(PRODUCT_LINK_SELECTOR) !== null;
const isSearchReadyPage = () => !isLoginPage() && !isProductPage() && getSearchInput() !== null;
const isListingPage = () => !isProductPage() && (
  /\/search\//i.test(window.location.pathname)
  || /\/category\//i.test(window.location.pathname)
  || hasProductListing()
);
const isOzonConnectionErrorPage = () => {
  const bodyText = normalizeText(document.body?.innerText || "").toLowerCase();

  if (!bodyText) {
    return false;
  }

  return CONNECTION_ERROR_TEXTS.filter((text) => bodyText.includes(text)).length >= 2;
};

const isPrivacyInterstitialPage = () => {
  const bodyText = normalizeText(document.body?.innerText || "").toLowerCase();

  if (!bodyText) {
    return false;
  }

  return (
    bodyText.includes("подключение не защищено")
    || bodyText.includes("ошибка нарушения конфиденциальности")
    || bodyText.includes("net::err_cert_")
    || bodyText.includes("net::err_ssl_")
  );
};

const getPageType = () => {
  if (isLoginPage()) {
    return "login";
  }

  if (isProductPage()) {
    return "product";
  }

  if (isListingPage() || isSearchReadyPage()) {
    return "search";
  }

  return "other";
};

const delay = (ms) => new Promise((resolve) => {
  window.setTimeout(resolve, ms);
});

const waitForCondition = async (getValue, timeoutMs = 10000, stepMs = 120) => {
  const startedAt = Date.now();

  while (Date.now() - startedAt <= timeoutMs) {
    const value = getValue();

    if (value) {
      return value;
    }

    await delay(stepMs);
  }

  return null;
};

const forceElementToSameTab = (element) => {
  if (!(element instanceof HTMLElement)) {
    return;
  }

  const anchor = element instanceof HTMLAnchorElement
    ? element
    : element.closest("a");

  if (!(anchor instanceof HTMLAnchorElement)) {
    return;
  }

  anchor.target = "_self";
  anchor.rel = "noreferrer";
};

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

const getFirstInput = (selectors, { allowPassword = false } = {}) => {
  for (const selector of selectors) {
    const inputs = document.querySelectorAll(selector);

    for (const input of inputs) {
      if (!(input instanceof HTMLInputElement)) {
        continue;
      }

      if (!allowPassword && input.type === "password") {
        continue;
      }

      if (input.type === "hidden") {
        continue;
      }

      if (input.disabled || input.readOnly) {
        continue;
      }

      const rect = input.getBoundingClientRect();

      if (rect.width === 0 || rect.height === 0) {
        continue;
      }

      return input;
    }
  }

  return null;
};

const waitForFirstInput = async (selectors, options = {}, timeoutMs = 10000) => (
  waitForCondition(() => getFirstInput(selectors, options), timeoutMs)
);

const setNativeInputValue = (input, value) => {
  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;

  input.focus();
  nativeSetter?.call(input, value);

  if (input.value !== value) {
    input.value = value;
  }

  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
};

const getOnlyDigits = (value) => String(value || "").replace(/\D+/g, "");

const clearInputCompletely = (input) => {
  input.focus();
  input.select?.();

  for (const key of ["Backspace", "Delete"]) {
    input.dispatchEvent(new KeyboardEvent("keydown", {
      key,
      code: key,
      bubbles: true,
    }));
    input.dispatchEvent(new KeyboardEvent("keyup", {
      key,
      code: key,
      bubbles: true,
    }));
  }

  setNativeInputValue(input, "");
  input.blur();
  input.focus();
};

const dispatchTextKeyEvents = (input, key) => {
  input.dispatchEvent(new KeyboardEvent("keydown", {
    key,
    code: key.length === 1 ? `Digit${key}` : key,
    bubbles: true,
  }));
  input.dispatchEvent(new KeyboardEvent("keypress", {
    key,
    code: key.length === 1 ? `Digit${key}` : key,
    bubbles: true,
  }));
};

const dispatchTextKeyUp = (input, key) => {
  input.dispatchEvent(new KeyboardEvent("keyup", {
    key,
    code: key.length === 1 ? `Digit${key}` : key,
    bubbles: true,
  }));
};

const setInputWithRangeText = (input, value) => {
  input.focus();

  if (typeof input.setSelectionRange === "function") {
    input.setSelectionRange(0, input.value.length);
  }

  if (typeof input.setRangeText === "function") {
    input.setRangeText(String(value || ""), 0, input.value.length, "end");
  } else {
    setNativeInputValue(input, value);
    return;
  }

  input.dispatchEvent(new InputEvent("input", {
    bubbles: true,
    data: String(value || ""),
    inputType: "insertText",
  }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
};

const typeInputValueSlowly = async (input, value) => {
  clearInputCompletely(input);
  input.focus();

  for (const char of String(value || "")) {
    dispatchTextKeyEvents(input, char);

    if (typeof document.execCommand === "function") {
      document.execCommand("insertText", false, char);
    } else if (typeof input.setRangeText === "function") {
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? input.value.length;
      input.setRangeText(char, start, end, "end");
      input.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        data: char,
        inputType: "insertText",
      }));
    } else {
      setNativeInputValue(input, `${input.value}${char}`);
    }

    dispatchTextKeyUp(input, char);
    await delay(40);
  }

  input.dispatchEvent(new Event("change", { bubbles: true }));
};

const buildPhoneInputVariants = (phone) => {
  const trimmedPhone = String(phone || "").trim();
  const digits = getOnlyDigits(trimmedPhone);
  const variants = [];

  const pushVariant = (value) => {
    const normalizedValue = String(value || "").trim();

    if (!normalizedValue) {
      return;
    }

    if (!variants.includes(normalizedValue)) {
      variants.push(normalizedValue);
    }
  };

  pushVariant(trimmedPhone);
  pushVariant(digits);

  if (digits.startsWith("374") && digits.length > 3) {
    pushVariant(digits.slice(3));
  }

  if (digits.startsWith("0") && digits.length > 1) {
    pushVariant(digits.slice(1));
  }

  if (digits.length > 8) {
    pushVariant(digits.slice(-8));
  }

  if (digits.length > 10) {
    pushVariant(digits.slice(-10));
  }

  return variants;
};

const matchesPhoneVariant = (inputValue, variant) => {
  const actualDigits = getOnlyDigits(inputValue);
  const variantDigits = getOnlyDigits(variant);

  if (!variantDigits) {
    return normalizeText(inputValue) === normalizeText(variant);
  }

  return (
    actualDigits === variantDigits
    || actualDigits.endsWith(variantDigits)
    || variantDigits.endsWith(actualDigits)
  );
};

const fillPhoneInputRobustly = async (input, phone) => {
  const variants = buildPhoneInputVariants(phone);

  for (const variant of variants) {
    clearInputCompletely(input);
    setNativeInputValue(input, variant);
    await delay(120);

    if (matchesPhoneVariant(input.value, variant)) {
      return true;
    }
  }

  for (const variant of variants) {
    clearInputCompletely(input);
    setInputWithRangeText(input, variant);
    await delay(150);

    if (matchesPhoneVariant(input.value, variant)) {
      return true;
    }
  }

  for (const variant of variants) {
    await typeInputValueSlowly(input, variant);
    await delay(180);

    if (matchesPhoneVariant(input.value, variant)) {
      return true;
    }
  }

  clearInputCompletely(input);
  return false;
};

const getSubmitControl = (preferredForm) => {
  const allSelectors = `${SUBMIT_BUTTON_SELECTORS.join(", ")}, button, [role="button"], input[type="button"]`;

  const findByText = (root) => {
    const candidates = Array.from(root.querySelectorAll(allSelectors));

    for (const candidate of candidates) {
      if (!(candidate instanceof HTMLElement)) {
        continue;
      }

      const text = normalizeText(
        candidate instanceof HTMLInputElement ? candidate.value : candidate.textContent,
      ).toLowerCase();

      if (!text) {
        continue;
      }

      if (text.includes("войти") || text.includes("получить код") || text.includes("continue")) {
        return candidate;
      }
    }

    return null;
  };

  if (preferredForm) {
    const formSubmitter = findByText(preferredForm)
      || preferredForm.querySelector(SUBMIT_BUTTON_SELECTORS.join(", "));

    if (formSubmitter instanceof HTMLElement) {
      return formSubmitter;
    }
  }

  const globalSubmitter = findByText(document)
    || document.querySelector(SUBMIT_BUTTON_SELECTORS.join(", "));
  return globalSubmitter instanceof HTMLElement ? globalSubmitter : null;
};

const getPrimaryLoginSubmitButton = () => {
  const buttons = Array.from(document.querySelectorAll("button, input[type=\"submit\"], [role=\"button\"]"));
  let bestMatch = null;
  let bestScore = -1;

  for (const candidate of buttons) {
    if (!(candidate instanceof HTMLElement)) {
      continue;
    }

    const rect = candidate.getBoundingClientRect();

    if (rect.width === 0 || rect.height === 0) {
      continue;
    }

    const text = normalizeText(
      candidate instanceof HTMLInputElement ? candidate.value : candidate.textContent,
    ).toLowerCase();

    if (!text.includes("войти") && !text.includes("login") && !text.includes("sign in")) {
      continue;
    }

    let score = 0;

    if (text === "войти") {
      score += 150;
    }

    if (rect.width > 180) {
      score += 40;
    }

    if (rect.top > 300 && rect.top < 760) {
      score += 40;
    }

    if (candidate.className && String(candidate.className).toLowerCase().includes("button")) {
      score += 10;
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = candidate;
    }
  }

  return bestMatch;
};

const getVisibleActionByText = (texts) => {
  const candidates = Array.from(document.querySelectorAll("a, button, [role=\"button\"], input[type=\"button\"], input[type=\"submit\"]"));

  for (const candidate of candidates) {
    if (!(candidate instanceof HTMLElement)) {
      continue;
    }

    const rect = candidate.getBoundingClientRect();

    if (rect.width === 0 || rect.height === 0) {
      continue;
    }

    const text = normalizeText(
      candidate instanceof HTMLInputElement ? candidate.value : candidate.textContent,
    ).toLowerCase();

    if (!text) {
      continue;
    }

    if (texts.some((value) => text.includes(value))) {
      return candidate;
    }
  }

  return null;
};

const getExactActionByText = (texts) => {
  const normalizedTargets = texts.map((text) => normalizeText(text).toLowerCase());
  const candidates = Array.from(document.querySelectorAll("a, button, [role=\"button\"], span, div, p"));

  for (const candidate of candidates) {
    if (!(candidate instanceof HTMLElement)) {
      continue;
    }

    const rect = candidate.getBoundingClientRect();

    if (rect.width === 0 || rect.height === 0) {
      continue;
    }

    const text = normalizeText(candidate.textContent || "").toLowerCase();

    if (!text || !normalizedTargets.includes(text)) {
      continue;
    }

    const clickableTarget = candidate.closest("a, button, [role=\"button\"]") || candidate;

    if (clickableTarget instanceof HTMLElement) {
      return clickableTarget;
    }
  }

  return null;
};

const getInteractiveAncestor = (element) => {
  let current = element;
  let depth = 0;

  while (current instanceof HTMLElement && depth < 8) {
    const tagName = current.tagName.toLowerCase();
    const role = normalizeText(current.getAttribute("role") || "").toLowerCase();
    const tabIndex = current.getAttribute("tabindex");
    const href = current instanceof HTMLAnchorElement ? normalizeText(current.getAttribute("href") || "") : "";
    const cursor = window.getComputedStyle(current).cursor;
    const hasOnClick = typeof current.onclick === "function" || current.hasAttribute("onclick");

    if (
      tagName === "a"
      || tagName === "button"
      || role === "button"
      || hasOnClick
      || href
      || tabIndex === "0"
      || cursor === "pointer"
    ) {
      return current;
    }

    current = current.parentElement;
    depth += 1;
  }

  return element;
};

const getDeepExactTextElement = (texts) => {
  const normalizedTargets = texts.map((text) => normalizeText(text).toLowerCase());
  const candidates = Array.from(document.querySelectorAll("body *"));

  for (const candidate of candidates) {
    if (!(candidate instanceof HTMLElement)) {
      continue;
    }

    const rect = candidate.getBoundingClientRect();

    if (rect.width === 0 || rect.height === 0) {
      continue;
    }

    const text = normalizeText(candidate.innerText || candidate.textContent || "").toLowerCase();

    if (!text || !normalizedTargets.includes(text)) {
      continue;
    }

    const childWithSameText = Array.from(candidate.children).some((child) => (
      child instanceof HTMLElement
      && normalizeText(child.innerText || child.textContent || "").toLowerCase() === text
    ));

    if (childWithSameText) {
      continue;
    }

    return getInteractiveAncestor(candidate.closest("a, button, [role=\"button\"]") || candidate);
  }

  return null;
};

const getLoginCtaButton = () => getVisibleActionByText(LOGIN_CTA_TEXTS);
const getLogoutButton = () => getVisibleActionByText(LOGOUT_TEXTS);
const getPersonalCabinetButton = () => getVisibleActionByText(PERSONAL_CABINET_TEXTS);
const getAccountRecordButton = () => getVisibleActionByText(ACCOUNT_RECORD_TEXTS);
const getAccountLogoutButton = () => (
  getDeepExactTextElement(ACCOUNT_LOGOUT_TEXTS)
  || getExactActionByText(ACCOUNT_LOGOUT_TEXTS)
  || getVisibleActionByText(ACCOUNT_LOGOUT_TEXTS)
);

const getActionTargetCandidates = (element) => {
  const candidates = [];

  const pushCandidate = (candidate) => {
    if (!(candidate instanceof HTMLElement)) {
      return;
    }

    const duplicate = candidates.some((existing) => existing === candidate);

    if (!duplicate) {
      candidates.push(candidate);
    }
  };

  pushCandidate(element);
  pushCandidate(getInteractiveAncestor(element));
  pushCandidate(element.closest("a, button, [role=\"button\"]"));
  pushCandidate(element.parentElement);
  pushCandidate(element.parentElement ? getInteractiveAncestor(element.parentElement) : null);

  let current = element.parentElement;
  let depth = 0;

  while (current instanceof HTMLElement && depth < 6) {
    pushCandidate(current);
    current = current.parentElement;
    depth += 1;
  }

  return candidates.filter((candidate) => {
    const rect = candidate.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
};

const clickElementRobustly = (element) => {
  forceElementToSameTab(element);
  const rect = element.getBoundingClientRect();
  const clientX = rect.left + (rect.width / 2);
  const clientY = rect.top + (rect.height / 2);
  const pointTarget = document.elementFromPoint(clientX, clientY);
  const target = pointTarget instanceof HTMLElement ? pointTarget : element;

  target.dispatchEvent(new MouseEvent("mouseover", {
    bubbles: true,
    clientX,
    clientY,
  }));
  target.dispatchEvent(new MouseEvent("mousedown", {
    bubbles: true,
    clientX,
    clientY,
  }));
  target.dispatchEvent(new MouseEvent("mouseup", {
    bubbles: true,
    clientX,
    clientY,
  }));
  target.click();
};

const clickElementDirectly = (element) => {
  forceElementToSameTab(element);
  const rect = element.getBoundingClientRect();
  const clientX = rect.left + (rect.width / 2);
  const clientY = rect.top + (rect.height / 2);

  for (const eventName of ["pointerover", "pointerdown", "pointerup"]) {
    const EventConstructor = window.PointerEvent || window.MouseEvent;
    element.dispatchEvent(new EventConstructor(eventName, {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
      view: window,
      pointerType: "mouse",
      isPrimary: true,
    }));
  }

  for (const eventName of ["mouseover", "mousedown", "mouseup", "click"]) {
    element.dispatchEvent(new MouseEvent(eventName, {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
      view: window,
    }));
  }

  element.click();
};

const activateElementWithKeyboard = (element) => {
  element.focus();

  for (const key of ["Enter", " "]) {
    element.dispatchEvent(new KeyboardEvent("keydown", {
      key,
      code: key === " " ? "Space" : key,
      bubbles: true,
    }));
    element.dispatchEvent(new KeyboardEvent("keyup", {
      key,
      code: key === " " ? "Space" : key,
      bubbles: true,
    }));
  }
};

const scrollToAndClick = async (element) => {
  element.scrollIntoView({
    block: "center",
    inline: "nearest",
  });
  await delay(250);
  clickElementRobustly(element);

  if (element instanceof HTMLAnchorElement && element.href) {
    await delay(150);
    element.click();
  }
};

const scrollPageForElement = async (getElement, {
  maxSteps = 8,
  stepPx = 700,
  waitMs = 160,
} = {}) => {
  const initialMatch = getElement();

  if (initialMatch) {
    return initialMatch;
  }

  for (let step = 0; step < maxSteps; step += 1) {
    const previousScrollY = window.scrollY;
    window.scrollBy(0, stepPx);
    await delay(waitMs);

    const match = getElement();

    if (match) {
      return match;
    }

    if (window.scrollY === previousScrollY) {
      break;
    }
  }

  return null;
};

const scrollPageDownUntilElement = async (getElement, {
  maxSteps = 10,
  stepPx = 700,
  waitMs = 180,
} = {}) => {
  for (let step = 0; step < maxSteps; step += 1) {
    const match = getElement();

    if (match) {
      return match;
    }

    const previousScrollY = window.scrollY;
    window.scrollBy(0, stepPx);
    await delay(waitMs);

    if (window.scrollY === previousScrollY) {
      break;
    }
  }

  return getElement();
};

const navigateToUrlReliably = (targetUrl) => {
  const normalizedUrl = String(targetUrl || "").trim();

  if (!normalizedUrl) {
    return;
  }

  const fallbackAnchor = document.createElement("a");
  fallbackAnchor.href = normalizedUrl;
  fallbackAnchor.target = "_self";
  fallbackAnchor.rel = "noreferrer";
  fallbackAnchor.style.display = "none";
  document.body.appendChild(fallbackAnchor);

  fallbackAnchor.click();

  try {
    window.location.assign(normalizedUrl);
  } catch (error) {
    // Ignore and try fallback below.
  }

  window.setTimeout(() => {
    if (window.location.href !== normalizedUrl && /\/product\//i.test(window.location.pathname)) {
      window.location.replace(normalizedUrl);
    }
  }, 700);

  window.setTimeout(() => {
    fallbackAnchor.remove();
  }, 1500);
};

const tryActivateActionCandidates = async (element) => {
  const candidates = getActionTargetCandidates(element);

  for (const candidate of candidates) {
    candidate.scrollIntoView({
      block: "center",
      inline: "nearest",
    });
    await delay(250);

    clickElementDirectly(candidate);
    await delay(250);

    clickElementRobustly(candidate);
    await delay(250);

    activateElementWithKeyboard(candidate);
    await delay(650);

    if (!/\/ozonid/i.test(window.location.pathname) || isLoginPage()) {
      return true;
    }
  }

  return false;
};

const isAddressModalOpen = () => {
  const nodes = Array.from(document.querySelectorAll("h1, h2, h3, h4, p, div, span, button"));

  return nodes.some((node) => (
    node instanceof HTMLElement
    && normalizeText(node.textContent || "").toLowerCase().includes("выберите адрес доставки")
  ));
};

const closeAddressModal = async () => {
  document.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Escape",
    code: "Escape",
    bubbles: true,
  }));
  document.dispatchEvent(new KeyboardEvent("keyup", {
    key: "Escape",
    code: "Escape",
    bubbles: true,
  }));
  await delay(250);
};

const getExactTopRightSignInTargets = () => {
  const candidates = Array.from(document.querySelectorAll("a, button, [role=\"button\"], span, div"));
  const targets = [];

  for (const candidate of candidates) {
    if (!(candidate instanceof HTMLElement)) {
      continue;
    }

    const text = normalizeText(candidate.textContent || "").toLowerCase();

    if (text !== "войти") {
      continue;
    }

    const rect = candidate.getBoundingClientRect();

    if (rect.width === 0 || rect.height === 0) {
      continue;
    }

    if (rect.top > 220 || rect.left < window.innerWidth * 0.68) {
      continue;
    }

    const possibleTargets = [
      candidate,
      candidate.closest("a, button, [role=\"button\"]"),
      candidate.parentElement,
      candidate.parentElement?.closest("a, button, [role=\"button\"]"),
    ];

    for (const possibleTarget of possibleTargets) {
      if (!(possibleTarget instanceof HTMLElement)) {
        continue;
      }

      const targetRect = possibleTarget.getBoundingClientRect();

      if (targetRect.width === 0 || targetRect.height === 0) {
        continue;
      }

      if (targetRect.top > 240 || targetRect.left < window.innerWidth * 0.66) {
        continue;
      }

      const duplicate = targets.some((target) => target === possibleTarget);

      if (!duplicate) {
        targets.push(possibleTarget);
      }
    }
  }

  targets.sort((left, right) => {
    const leftRect = left.getBoundingClientRect();
    const rightRect = right.getBoundingClientRect();
    const leftScore = Math.abs(leftRect.left - (window.innerWidth * 0.74)) + Math.abs(leftRect.top - 140);
    const rightScore = Math.abs(rightRect.left - (window.innerWidth * 0.74)) + Math.abs(rightRect.top - 140);

    return leftScore - rightScore;
  });

  return targets;
};

const isExcludedHeaderAction = (element) => {
  const href = element instanceof HTMLAnchorElement ? (element.getAttribute("href") || "") : "";
  const ariaLabel = normalizeText(element.getAttribute("aria-label") || "").toLowerCase();
  const title = normalizeText(element.getAttribute("title") || "").toLowerCase();
  const text = normalizeText(
    element instanceof HTMLInputElement ? element.value : element.textContent,
  ).toLowerCase();
  const combined = `${href} ${ariaLabel} ${title} ${text}`.toLowerCase();

  return [
    "заказы",
    "избран",
    "корзин",
    "адрес",
    "достав",
    "location",
    "catalog",
    "каталог",
    "фото",
    "image",
    "camera",
    "камера",
    "search by photo",
  ].some((value) => combined.includes(value));
};

const getTopBarSignInTrigger = () => {
  const candidates = Array.from(document.querySelectorAll("a[href], button, [role=\"button\"]"));
  let bestMatch = null;
  let bestScore = -1;

  for (const candidate of candidates) {
    if (!(candidate instanceof HTMLElement)) {
      continue;
    }

    if (isExcludedHeaderAction(candidate)) {
      continue;
    }

    const rect = candidate.getBoundingClientRect();

    if (rect.width === 0 || rect.height === 0) {
      continue;
    }

    if (rect.top > 220 || rect.left < window.innerWidth * 0.68) {
      continue;
    }

    const text = normalizeText(candidate.textContent || "").toLowerCase();
    const ariaLabel = normalizeText(candidate.getAttribute("aria-label") || "").toLowerCase();
    const title = normalizeText(candidate.getAttribute("title") || "").toLowerCase();
    const href = candidate instanceof HTMLAnchorElement ? (candidate.getAttribute("href") || "").toLowerCase() : "";
    const combined = `${text} ${ariaLabel} ${title} ${href}`.toLowerCase();

    if (!combined.includes("войти") && !combined.includes("login") && !combined.includes("sign in")) {
      continue;
    }

    let score = 0;

    if (text === "войти") {
      score += 120;
    }

    if (combined.includes("войти")) {
      score += 80;
    }

    if (combined.includes("login") || combined.includes("sign in")) {
      score += 50;
    }

    if (rect.left > window.innerWidth * 0.76) {
      score += 20;
    }

    if (rect.width < 120 && rect.height < 80) {
      score += 15;
    }

    if (score > bestScore) {
      bestMatch = candidate;
      bestScore = score;
    }
  }

  return bestMatch;
};

const getAccountIconTrigger = () => {
  const searchInput = getSearchInput();
  const searchRect = searchInput?.getBoundingClientRect();
  const minLeft = searchRect ? searchRect.right + 48 : window.innerWidth * 0.62;
  const maxTop = searchRect ? searchRect.bottom + 50 : 240;
  const candidates = Array.from(document.querySelectorAll("a[href], button, [role=\"button\"]"));
  const headerIcons = [];

  for (const candidate of candidates) {
    if (!(candidate instanceof HTMLElement)) {
      continue;
    }

    if (isExcludedHeaderAction(candidate)) {
      continue;
    }

    const rect = candidate.getBoundingClientRect();

    if (rect.width === 0 || rect.height === 0) {
      continue;
    }

    if (rect.top > maxTop || rect.left < minLeft) {
      continue;
    }

    if (searchRect && rect.left <= searchRect.right + 40) {
      continue;
    }

    if (rect.width > 120 || rect.height > 120) {
      continue;
    }

    headerIcons.push(candidate);
  }

  headerIcons.sort((left, right) => {
    const leftRect = left.getBoundingClientRect();
    const rightRect = right.getBoundingClientRect();

    if (Math.abs(leftRect.top - rightRect.top) > 12) {
      return leftRect.top - rightRect.top;
    }

    return leftRect.left - rightRect.left;
  });

  return headerIcons[0] || null;
};

const scoreSignInTrigger = (element) => {
  const rect = element.getBoundingClientRect();

  if (rect.width === 0 || rect.height === 0) {
    return -1;
  }

  const href = element instanceof HTMLAnchorElement ? (element.getAttribute("href") || "") : "";
  const ariaLabel = normalizeText(element.getAttribute("aria-label") || "").toLowerCase();
  const title = normalizeText(element.getAttribute("title") || "").toLowerCase();
  const text = normalizeText(
    element instanceof HTMLInputElement ? element.value : element.textContent,
  ).toLowerCase();

  const combined = `${href} ${ariaLabel} ${title} ${text}`.toLowerCase();
  let score = 0;

  if (combined.includes("ozonid")) {
    score += 80;
  }

  if (combined.includes("login") || combined.includes("signin") || combined.includes("auth")) {
    score += 60;
  }

  if (combined.includes("войти") || combined.includes("login") || combined.includes("sign in")) {
    score += 70;
  }

  if (combined.includes("profile") || combined.includes("account") || combined.includes("кабинет")) {
    score += 30;
  }

  if (combined.includes("заказы") || combined.includes("избран") || combined.includes("корзин")) {
    score -= 80;
  }

  if (combined.includes("адрес") || combined.includes("достав") || combined.includes("location")) {
    score -= 120;
  }

  if (rect.top < 220) {
    score += 25;
  }

  if (rect.left > window.innerWidth * 0.55) {
    score += 20;
  }

  if (rect.left > window.innerWidth * 0.72) {
    score += 20;
  }

  return score;
};

const getHeaderSignInTrigger = () => {
  let bestMatch = null;
  let bestScore = -1;

  for (const selector of SIGN_IN_TRIGGER_SELECTORS) {
    const candidates = document.querySelectorAll(selector);

    for (const candidate of candidates) {
      if (!(candidate instanceof HTMLElement)) {
        continue;
      }

      const score = scoreSignInTrigger(candidate);

      if (score > bestScore) {
        bestMatch = candidate;
        bestScore = score;
      }
    }
  }

  if (bestMatch && bestScore >= 20) {
    return bestMatch;
  }

  return null;
};

const openLoginPage = async () => {
  const directLoginCta = getLoginCtaButton();

  if (directLoginCta) {
    clickElementRobustly(directLoginCta);
    return true;
  }

  const exactTopRightSignInTargets = getExactTopRightSignInTargets();

  for (const signInTarget of exactTopRightSignInTargets) {
    clickElementRobustly(signInTarget);
    await delay(450);

    if (isAddressModalOpen()) {
      await closeAddressModal();
      continue;
    }

    const popupLoginCta = getLoginCtaButton();

    if (popupLoginCta) {
      clickElementRobustly(popupLoginCta);
      return true;
    }
  }

  const topBarSignInTrigger = getTopBarSignInTrigger();

  if (topBarSignInTrigger) {
    clickElementRobustly(topBarSignInTrigger);
    await delay(500);

    const popupLoginCta = getLoginCtaButton();

    if (popupLoginCta) {
      clickElementRobustly(popupLoginCta);
    }

    return true;
  }

  const accountIconTrigger = getAccountIconTrigger();

  if (accountIconTrigger) {
    clickElementRobustly(accountIconTrigger);
    await delay(500);

    const popupLoginCta = getLoginCtaButton();

    if (popupLoginCta) {
      clickElementRobustly(popupLoginCta);
      return true;
    }

    return true;
  }

  const headerTrigger = getHeaderSignInTrigger();

  if (headerTrigger) {
    headerTrigger.click();
    await delay(500);

    const popupLoginCta = getLoginCtaButton();

    if (popupLoginCta) {
      popupLoginCta.click();
      return true;
    }

    return true;
  }

  for (const selector of SIGN_IN_TRIGGER_SELECTORS) {
    const trigger = document.querySelector(selector);

    if (trigger instanceof HTMLElement) {
      clickElementRobustly(trigger);
      await delay(500);

      const popupLoginCta = getLoginCtaButton();

      if (popupLoginCta) {
        clickElementRobustly(popupLoginCta);
        return true;
      }

      return true;
    }
  }

  const signInAction = getVisibleActionByText(["войти", "login", "sign in"]);

  if (signInAction) {
    clickElementRobustly(signInAction);
    await delay(500);

    const popupLoginCta = getLoginCtaButton();

    if (popupLoginCta) {
      clickElementRobustly(popupLoginCta);
      return true;
    }

    return true;
  }

  return false;
};

const submitLoginForm = (triggerInput, submitControl) => {
  const form = triggerInput?.form || submitControl?.closest("form");

  if (submitControl instanceof HTMLButtonElement || submitControl instanceof HTMLInputElement) {
    submitControl.click();
    return;
  }

  if (form) {
    form.requestSubmit();
    return;
  }

  triggerInput?.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Enter",
    code: "Enter",
    bubbles: true,
  }));
  triggerInput?.dispatchEvent(new KeyboardEvent("keyup", {
    key: "Enter",
    code: "Enter",
    bubbles: true,
  }));
};

const getLoginFormSignature = () => {
  const phoneInput = getFirstInput(PHONE_INPUT_SELECTORS);
  const passwordInput = getFirstInput(PASSWORD_INPUT_SELECTORS, { allowPassword: true });

  return [
    window.location.pathname,
    phoneInput?.type || "no-phone",
    phoneInput?.name || phoneInput?.id || phoneInput?.autocomplete || "phone-field",
    passwordInput ? "has-password" : "no-password",
  ].join(":");
};

const getLoginPageState = () => {
  const codeInput = getFirstInput(CODE_INPUT_SELECTORS);

  if (codeInput) {
    return "code";
  }

  const passwordInput = getFirstInput(PASSWORD_INPUT_SELECTORS, { allowPassword: true });

  if (passwordInput) {
    return "password";
  }

  const phoneInput = getFirstInput(PHONE_INPUT_SELECTORS);

  if (phoneInput) {
    return "phone";
  }

  return "other";
};

const getCurrentSearchText = () => {
  const urlText = new URL(window.location.href).searchParams.get("text");

  if (urlText) {
    return normalizeText(urlText);
  }

  const input = getSearchInput();
  return normalizeText(input?.value || "");
};

const setInputTextValue = (input, term) => {
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;

  input.focus();
  nativeInputValueSetter?.call(input, term);

  if (input.value !== term) {
    input.value = term;
  }

  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
};

const submitSearchTerm = async (term) => {
  const input = getSearchInput();

  if (!input) {
    throw new Error("Не удалось найти строку поиска Ozon.");
  }

  setInputTextValue(input, term);

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

const isVisibleElement = (element) => {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
};

const getBrandSectionRoots = () => {
  const roots = [];
  const headings = Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, label, span, div, p, strong"));

  const pushRoot = (candidate) => {
    if (!(candidate instanceof HTMLElement)) {
      return;
    }

    const duplicate = roots.some((root) => root === candidate);

    if (!duplicate) {
      roots.push(candidate);
    }
  };

  for (const heading of headings) {
    if (!isVisibleElement(heading)) {
      continue;
    }

    const text = normalizeText(heading.textContent || "").toLowerCase();

    if (!BRAND_SECTION_TEXTS.includes(text)) {
      continue;
    }

    let current = heading;
    let depth = 0;

    while (current instanceof HTMLElement && depth < 6) {
      const hasBrandInput = current.querySelector(BRAND_FILTER_INPUT_SELECTORS.join(", ")) instanceof HTMLInputElement;
      const hasBrandOptions = current.querySelector('input[type="checkbox"], input[type="radio"], [role="checkbox"]') instanceof HTMLElement;

      if (hasBrandInput || hasBrandOptions) {
        pushRoot(current);
      }

      current = current.parentElement;
      depth += 1;
    }
  }

  if (!roots.length) {
    const fallbackInputs = Array.from(document.querySelectorAll(BRAND_FILTER_INPUT_SELECTORS.join(", ")));

    for (const input of fallbackInputs) {
      if (!(input instanceof HTMLInputElement) || !isVisibleElement(input)) {
        continue;
      }

      let current = input.parentElement;
      let depth = 0;

      while (current instanceof HTMLElement && depth < 6) {
        const hasBrandOptions = current.querySelector('input[type="checkbox"], input[type="radio"], [role="checkbox"]') instanceof HTMLElement;

        if (hasBrandOptions) {
          pushRoot(current);
          break;
        }

        current = current.parentElement;
        depth += 1;
      }
    }
  }

  return roots;
};

const getBrandVerificationState = (roots, brand) => {
  for (const root of roots) {
    const option = findBrandOption(root, brand);

    if (!option) {
      continue;
    }

    return {
      root,
      option,
      selected: isBrandOptionSelected(option),
    };
  }

  return {
    root: null,
    option: null,
    selected: false,
  };
};

const getBrandOptionTarget = (candidate) => {
  if (!(candidate instanceof HTMLElement)) {
    return null;
  }

  if (candidate instanceof HTMLInputElement && (candidate.type === "checkbox" || candidate.type === "radio")) {
    return candidate.closest("label") || candidate;
  }

  const preciseTarget = candidate.closest('label, [role="checkbox"], [role="radio"], button, a');

  if (preciseTarget instanceof HTMLElement) {
    return preciseTarget;
  }

  return candidate;
};

const getBrandToggleCandidates = (option) => {
  if (!(option instanceof HTMLElement)) {
    return [];
  }

  const candidates = [];

  const pushCandidate = (candidate) => {
    if (!(candidate instanceof HTMLElement) || !isVisibleElement(candidate)) {
      return;
    }

    if (!candidates.includes(candidate)) {
      candidates.push(candidate);
    }
  };

  pushCandidate(option.querySelector('input[type="checkbox"], input[type="radio"]'));
  pushCandidate(option.closest('label, [role="checkbox"], [role="button"], button'));
  pushCandidate(option.querySelector('label, [role="checkbox"], [role="button"], button'));

  for (const candidate of getActionTargetCandidates(option)) {
    pushCandidate(candidate);
  }

  pushCandidate(option);

  return candidates;
};

const getScrollableContainers = (root) => {
  const containers = [];
  let current = root instanceof HTMLElement ? root : null;
  let depth = 0;

  while (current instanceof HTMLElement && depth < 6) {
    if (current.scrollHeight > current.clientHeight + 20) {
      containers.push(current);
    }

    current = current.parentElement;
    depth += 1;
  }

  return containers;
};

const getBrandFilterInput = (root) => {
  if (!(root instanceof HTMLElement)) {
    return null;
  }

  const inputs = Array.from(root.querySelectorAll(BRAND_FILTER_INPUT_SELECTORS.join(", ")));

  for (const input of inputs) {
    if (input instanceof HTMLInputElement && isVisibleElement(input)) {
      return input;
    }
  }

  return null;
};

const normalizeBrandIdentity = (value) => normalizeText(value || "")
  .toLowerCase()
  .replace(/^бренд:\s*/i, "")
  .replace(/\s+/g, " ")
  .trim();

const getSelectedBrandChipEntries = () => {
  const entries = [];
  const candidates = Array.from(document.querySelectorAll("a, button, [role=\"button\"], span, div"));

  for (const candidate of candidates) {
    if (!(candidate instanceof HTMLElement) || !isVisibleElement(candidate)) {
      continue;
    }

    const text = normalizeText(candidate.innerText || candidate.textContent || "");

    if (!text || !/^бренд:\s*/i.test(text)) {
      continue;
    }

    const normalizedBrand = normalizeBrandIdentity(text);

    if (!normalizedBrand) {
      continue;
    }

    const target = getInteractiveAncestor(candidate.closest("a, button, [role=\"button\"]") || candidate);

    if (!(target instanceof HTMLElement)) {
      continue;
    }

    if (!entries.some((entry) => entry.element === target && entry.brand === normalizedBrand)) {
      entries.push({
        brand: normalizedBrand,
        element: target,
      });
    }
  }

  return entries;
};

const clearUnexpectedSelectedBrands = async (targetBrand) => {
  const normalizedTargetBrand = normalizeBrandIdentity(targetBrand);
  const selectedBrandEntries = getSelectedBrandChipEntries();

  if (!selectedBrandEntries.length) {
    return false;
  }

  const selectedBrands = selectedBrandEntries.map((entry) => entry.brand);
  const hasOnlyTargetBrand = selectedBrands.length === 1 && selectedBrands[0] === normalizedTargetBrand;

  if (hasOnlyTargetBrand) {
    return false;
  }

  const clearAllAction = getExactActionByText(["очистить всё", "очистить все"]);
  const previousListingSnapshot = getListingSnapshot();

  if (clearAllAction) {
    await scrollToAndClick(clearAllAction);
  } else {
    for (const entry of selectedBrandEntries) {
      await scrollToAndClick(entry.element);
      await delay(160);
    }
  }

  await waitForSearchResultsReady({
    previousSnapshot: previousListingSnapshot,
    timeoutMs: BRAND_FILTER_READY_TIMEOUT_MS,
  }).catch(() => {});

  return true;
};

const isBrandOptionSelected = (element) => {
  let current = element;
  let depth = 0;

  while (current instanceof HTMLElement && depth < 6) {
    const ariaChecked = normalizeText(current.getAttribute("aria-checked") || "").toLowerCase();
    const ariaPressed = normalizeText(current.getAttribute("aria-pressed") || "").toLowerCase();
    const className = normalizeText(current.className || "").toLowerCase();
    const checkedInput = current.querySelector('input[type="checkbox"]:checked, input[type="radio"]:checked');

    if (ariaChecked === "true" || ariaPressed === "true" || checkedInput) {
      return true;
    }

    if (
      className.includes("selected")
      || className.includes("checked")
      || className.includes("active")
      || className.includes("current")
    ) {
      return true;
    }

    current = current.parentElement;
    depth += 1;
  }

  return false;
};

const findBrandOption = (root, brand) => {
  if (!(root instanceof HTMLElement) || !brand) {
    return null;
  }

  const normalizedBrand = normalizeText(brand).toLowerCase();
  const preferredSelectors = [
    "label",
    "[role=\"checkbox\"]",
    "[role=\"radio\"]",
    "input[type=\"checkbox\"]",
    "input[type=\"radio\"]",
    "button",
    "a",
  ];
  const candidates = Array.from(root.querySelectorAll(preferredSelectors.join(", ")));
  let bestMatch = null;
  let bestScore = -Infinity;

  for (const candidate of candidates) {
    if (!(candidate instanceof HTMLElement) || !isVisibleElement(candidate)) {
      continue;
    }

    const target = getBrandOptionTarget(candidate);

    if (!(target instanceof HTMLElement) || !isVisibleElement(target)) {
      continue;
    }

    const text = normalizeText(target.innerText || target.textContent || "").toLowerCase();
    const normalizedCandidateBrand = normalizeBrandIdentity(text);
    const containsCheckbox = target.querySelector('input[type="checkbox"], input[type="radio"]');
    const isStructuredOption = target.tagName.toLowerCase() === "label"
      || target.getAttribute("role") === "checkbox"
      || target.getAttribute("role") === "radio"
      || Boolean(containsCheckbox);

    if (!text || !normalizedCandidateBrand.includes(normalizedBrand)) {
      continue;
    }

    if (text.length > Math.max(normalizedBrand.length * 4, normalizedBrand.length + 40)) {
      continue;
    }

    let score = 0;

    if (normalizedCandidateBrand === normalizedBrand) {
      score += 180;
    } else if (
      normalizedCandidateBrand.startsWith(`${normalizedBrand} `)
      || normalizedCandidateBrand.endsWith(` ${normalizedBrand}`)
    ) {
      score += 120;
    } else if (new RegExp(`\\b${normalizedBrand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(normalizedCandidateBrand)) {
      score += 90;
    } else {
      score += 20;
    }

    score -= Math.abs(normalizedCandidateBrand.length - normalizedBrand.length);

    if (!isStructuredOption) {
      score -= 200;
    }

    if (containsCheckbox) {
      score += 25;
    }

    if (target.getAttribute("role") === "checkbox" || target.getAttribute("role") === "radio") {
      score += 20;
    }

    if (target instanceof HTMLElement && score > bestScore) {
      bestMatch = target;
      bestScore = score;
    }
  }

  return bestMatch;
};

const findBrandOptionWithScroll = async (root, brand) => {
  const immediateMatch = findBrandOption(root, brand);

  if (immediateMatch) {
    return immediateMatch;
  }

  const scrollContainers = getScrollableContainers(root);

  for (const container of scrollContainers) {
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    const step = Math.max(220, Math.floor(container.clientHeight * 0.75));
    let scrollTop = 0;

    while (scrollTop <= maxScrollTop) {
      container.scrollTop = scrollTop;
      await delay(120);

      const scrolledMatch = findBrandOption(root, brand);

      if (scrolledMatch) {
        return scrolledMatch;
      }

      if (scrollTop === maxScrollTop) {
        break;
      }

      scrollTop = Math.min(maxScrollTop, scrollTop + step);
    }

    container.scrollTop = 0;
    await delay(120);
  }

  return null;
};

const ensureBrandFilterApplied = async (brand) => {
  const normalizedBrand = normalizeText(brand).toLowerCase();

  if (!normalizedBrand) {
    return false;
  }

  await clearUnexpectedSelectedBrands(brand);

  let roots = getBrandSectionRoots();
  let verificationState = getBrandVerificationState(roots, normalizedBrand);

  if (verificationState.selected) {
    return false;
  }

  const listingSnapshotBeforeBrand = getListingSnapshot();
  const filterInputs = roots
    .map((root) => getBrandFilterInput(root))
    .filter((input, index, inputs) => input instanceof HTMLInputElement && inputs.indexOf(input) === index);

  for (const filterInput of filterInputs) {
    if (normalizeText(filterInput.value || "").toLowerCase() === normalizedBrand) {
      continue;
    }

    setInputTextValue(filterInput, brand);
    await waitForCondition(() => {
      roots = getBrandSectionRoots();
      verificationState = getBrandVerificationState(roots, normalizedBrand);
      return verificationState.option || normalizeText(filterInput.value || "").toLowerCase() === normalizedBrand;
    }, BRAND_FILTER_READY_TIMEOUT_MS, 150);
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    roots = getBrandSectionRoots();
    verificationState = getBrandVerificationState(roots, normalizedBrand);

    if (verificationState.selected) {
      return false;
    }

    if (!verificationState.option) {
      for (const root of roots) {
        const scrolledOption = await findBrandOptionWithScroll(root, normalizedBrand);

        if (scrolledOption) {
          verificationState = {
            root,
            option: scrolledOption,
            selected: isBrandOptionSelected(scrolledOption),
          };
          break;
        }
      }
    }

    if (!verificationState.option) {
      await delay(200);
      continue;
    }

    const toggleCandidates = getBrandToggleCandidates(verificationState.option);

    for (const toggleCandidate of toggleCandidates) {
      await scrollToAndClick(toggleCandidate);

      let selectedOption = await waitForCondition(() => {
        roots = getBrandSectionRoots();
        verificationState = getBrandVerificationState(roots, normalizedBrand);
        return verificationState.selected ? verificationState.option : null;
      }, 1100, 160);

      if (!selectedOption) {
        activateElementWithKeyboard(toggleCandidate);
        selectedOption = await waitForCondition(() => {
          roots = getBrandSectionRoots();
          verificationState = getBrandVerificationState(roots, normalizedBrand);
          return verificationState.selected ? verificationState.option : null;
        }, 1100, 160);
      }

      if (selectedOption) {
        await waitForSearchResultsReady({
          previousSnapshot: listingSnapshotBeforeBrand,
          timeoutMs: BRAND_FILTER_READY_TIMEOUT_MS,
        }).catch(() => {});
        return true;
      }
    }
  }

  throw new Error(`Не удалось выбрать бренд "${brand}" в фильтрах Ozon.`);
};

const canSearchForArticle = () => getSearchInput() !== null;

const getVisibleProductLinks = () => Array.from(document.querySelectorAll(PRODUCT_LINK_SELECTOR))
  .filter((link) => link instanceof HTMLAnchorElement && isVisibleElement(link));

const resetResultsViewport = async () => {
  window.scrollTo({
    top: 0,
    left: 0,
    behavior: "auto",
  });

  const searchInput = getSearchInput();

  if (searchInput instanceof HTMLElement) {
    searchInput.scrollIntoView({
      block: "start",
      inline: "nearest",
    });
  }

  await delay(220);
};

const getListingSnapshot = () => getVisibleProductLinks()
  .slice(0, 8)
  .map((link) => {
    const href = normalizeText(link.getAttribute("href") || "");
    const text = normalizeText(link.textContent || "").slice(0, 80);
    return `${href}|${text}`;
  })
  .join("||");

const waitForSearchResultsReady = async ({
  expectedSearchText = "",
  previousSnapshot = "",
  article = "",
  timeoutMs = SEARCH_RESULTS_READY_TIMEOUT_MS,
} = {}) => {
  const normalizedExpectedSearchText = normalizeText(expectedSearchText);

  return Boolean(await waitForCondition(() => {
    if (!isListingPage() && !isSearchReadyPage()) {
      return false;
    }

    const currentSearchText = getCurrentSearchText();

    if (normalizedExpectedSearchText && currentSearchText !== normalizedExpectedSearchText) {
      return false;
    }

    if (article && findMatchingProduct(article)) {
      return true;
    }

    const currentSnapshot = getListingSnapshot();

    if (previousSnapshot && currentSnapshot && currentSnapshot !== previousSnapshot) {
      return true;
    }

    return !previousSnapshot && currentSnapshot.length > 0;
  }, timeoutMs, 160));
};

const normalizeCommandSearchTerms = (command) => {
  const fromCommand = Array.isArray(command?.searchTerms)
    ? command.searchTerms.map((value) => String(value || "").trim()).filter(Boolean)
    : [];

  if (fromCommand.length) {
    return fromCommand;
  }

  const fallback = String(command?.searchTerm || command?.brand || "").trim();
  return fallback ? [fallback] : [];
};

const buildSearchTermAttemptPlan = (command) => {
  const searchTerms = normalizeCommandSearchTerms(command);
  const startIndex = Math.max(
    0,
    Math.min(
      searchTerms.length - 1,
      Number.parseInt(String(command?.searchTermIndex || 0), 10) || 0,
    ),
  );

  if (!searchTerms.length) {
    return [];
  }

  const orderedTerms = searchTerms
    .slice(startIndex)
    .concat(searchTerms.slice(0, startIndex));

  return orderedTerms.map((term, index) => ({
    term,
    retries: index === 0 ? 2 : 1,
  }));
};

const submitTermAndWaitUntilReady = async ({ runId, term, article }) => {
  const normalizedTerm = normalizeText(term);
  const previousListingSnapshot = getListingSnapshot();

  await submitSearchTerm(term);
  await sendRuntimeMessage({
    type: "OZON_SEARCH_SUBMITTED",
    runId,
  }).catch(() => {});
  await waitForSearchResultsReady({
    expectedSearchText: normalizedTerm,
    previousSnapshot: previousListingSnapshot,
    article,
  });
};

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

  await delay(280);

  return {
    previousScrollY,
    previousScrollHeight,
    currentScrollY: window.scrollY,
    currentScrollHeight: getDocumentScrollHeight(),
  };
};

const waitForMatchingProduct = async (article, timeoutMs = 8000) => {
  const startedAt = Date.now();
  let noMoreScrollAttempts = 0;

  await resetResultsViewport();

  while (Date.now() - startedAt <= timeoutMs) {
    if (isOzonConnectionErrorPage()) {
      throw new Error("Ozon page says there is no connection.");
    }

    if (isPrivacyInterstitialPage()) {
      throw new Error("Chrome opened a privacy/certificate warning page.");
    }

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

    await delay(180);
  }

  throw new Error(`Артикул ${article} не найден среди текущих результатов.`);
};

const didReachProductUrl = (targetUrl = "") => {
  if (isProductPage()) {
    return true;
  }

  const target = parseHref(targetUrl);
  const current = parseHref(window.location.href);

  if (!target || !current) {
    return false;
  }

  return current.pathname === target.pathname && /\/product\//i.test(current.pathname);
};

const waitForProductNavigation = async (targetUrl, timeoutMs = 550) => Boolean(await waitForCondition(
  () => didReachProductUrl(targetUrl),
  timeoutMs,
  50,
));

const openProductLinkReliably = async (productLink) => {
  const targetUrl = productLink?.href || "";
  forceElementToSameTab(productLink);

  if (targetUrl) {
    navigateToUrlReliably(targetUrl);
    return true;
  }

  return false;
};

const submitArticleSearch = async (article) => submitSearchTerm(article);

const handleOpenProduct = async (command) => {
  const actionSignature = `${command.runId}:open:${command.currentCycle}:${command.searchTerm || ""}:${command.brandFilter || ""}:${window.location.href}:${getCurrentSearchText()}`;

  if (lastActionSignature === actionSignature) {
    return;
  }

  lastActionSignature = actionSignature;

  if (command.delayMs) {
    await delay(command.delayMs);
  }

  const searchTerm = String(command.searchTerm || command.brand || "").trim();
  const brandFilter = String(command.brandFilter || "").trim();
  const brandFilterKey = brandFilter
    ? `${command.runId}:${command.currentCycle}:${normalizeText(brandFilter).toLowerCase()}`
    : "";
  const normalizedSearchTerm = normalizeText(searchTerm);
  const currentSearchText = getCurrentSearchText();
  const searchAttemptPlan = buildSearchTermAttemptPlan(command);

  if (normalizedSearchTerm && canSearchForArticle() && currentSearchText !== normalizedSearchTerm) {
    await submitTermAndWaitUntilReady({
      runId: command.runId,
      term: searchTerm,
      article: command.article,
    });
  }

  if (!normalizedSearchTerm && canSearchForArticle() && getCurrentSearchText() !== normalizeText(command.article)) {
    await submitTermAndWaitUntilReady({
      runId: command.runId,
      term: command.article,
      article: command.article,
    });
  }

  const ensureBrandFilterMetrics = async () => {
    if (!brandFilter) {
      return false;
    }

    const rememberedBrandFilterKey = lastAppliedBrandFilterKey || getStoredAppliedBrandFilterKey();

    if (brandFilterKey && rememberedBrandFilterKey === brandFilterKey) {
      lastAppliedBrandFilterKey = "";
      setStoredAppliedBrandFilterKey("");
      return false;
    }

    const brandApplied = await ensureBrandFilterApplied(brandFilter);

    if (brandFilterKey) {
      lastAppliedBrandFilterKey = brandFilterKey;
      setStoredAppliedBrandFilterKey(brandFilterKey);
    }

    if (brandApplied) {
      await sendRuntimeMessage({
        type: "OZON_BRAND_FILTER_APPLIED",
        runId: command.runId,
      }).catch(() => {});
    }

    return brandApplied;
  };

  const brandAppliedNow = await ensureBrandFilterMetrics();

  if (brandAppliedNow) {
    lastActionSignature = "";
    window.setTimeout(() => {
      processRun().catch(() => {});
    }, 450);
    return;
  }

  let match = null;
  let lastMatchError = null;

  if (searchAttemptPlan.length) {
    for (let termIndex = 0; termIndex < searchAttemptPlan.length; termIndex += 1) {
      const attempt = searchAttemptPlan[termIndex];
      const attemptTerm = String(attempt.term || "").trim();
      const normalizedAttemptTerm = normalizeText(attemptTerm);

      if (attemptTerm && canSearchForArticle() && getCurrentSearchText() !== normalizedAttemptTerm) {
        await submitTermAndWaitUntilReady({
          runId: command.runId,
          term: attemptTerm,
          article: command.article,
        });
        await ensureBrandFilterMetrics();
      }

      for (let retryIndex = 0; retryIndex < attempt.retries; retryIndex += 1) {
        try {
          match = await waitForMatchingProduct(
            command.article,
            termIndex === 0 && retryIndex === 0 ? 8000 : MATCH_RETRY_TIMEOUT_MS,
          );
          break;
        } catch (error) {
          lastMatchError = error;

          if (retryIndex < attempt.retries - 1 && attemptTerm && canSearchForArticle()) {
            await submitTermAndWaitUntilReady({
              runId: command.runId,
              term: attemptTerm,
              article: command.article,
            });
            await ensureBrandFilterMetrics();
          }
        }
      }

      if (match) {
        break;
      }
    }
  } else {
    try {
      match = await waitForMatchingProduct(command.article);
    } catch (error) {
      lastMatchError = error;
    }
  }

  if (!match) {
    throw lastMatchError || new Error(`Артикул ${command.article} не найден среди текущих результатов.`);
  }

  const response = await sendRuntimeMessage({
    type: "OZON_PRODUCT_OPENING",
    runId: command.runId,
    url: match.href,
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Не удалось подтвердить открытие товара.");
  }

  const didOpenProduct = await openProductLinkReliably(match);

  if (!didOpenProduct) {
    lastActionSignature = "";
    throw new Error(`Не удалось открыть товар ${command.article} после поиска.`);
  }
};

const handleGoBack = async (command) => {
  const actionSignature = `${command.runId}:back:${command.currentCycle}:${window.location.href}`;

  if (lastActionSignature === actionSignature) {
    return;
  }

  lastActionSignature = actionSignature;
  lastAppliedBrandFilterKey = "";
  setStoredAppliedBrandFilterKey("");

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

  window.history.back();

  if (command.returnUrl) {
    window.setTimeout(() => {
      if (isProductPage()) {
        window.location.assign(command.returnUrl);
      }
    }, 1200);
  }
};

const handlePerformLogin = async (command) => {
  const phoneInput = await waitForFirstInput(PHONE_INPUT_SELECTORS, {}, 12000);
  const activeInput = phoneInput
    || await waitForFirstInput(PASSWORD_INPUT_SELECTORS, { allowPassword: true }, 3000);

  if (!activeInput) {
    lastActionSignature = "";
    await delay(1000);
    processRun().catch(() => {});
    return;
  }

  const actionSignature = [
    command.runId,
    "login",
    command.accountIndex || 0,
    command.phone || "",
    command.attempt || 0,
    getLoginFormSignature(),
  ].join(":");

  if (lastActionSignature === actionSignature) {
    return;
  }

  lastActionSignature = actionSignature;

  const submitControl = await waitForCondition(
    () => getPrimaryLoginSubmitButton()
      || getSubmitControl(activeInput?.form || phoneInput?.form || null),
    8000,
    250,
  );

  if (phoneInput && command.phone) {
    const didFillPhone = await fillPhoneInputRobustly(phoneInput, command.phone);

    if (!didFillPhone) {
      lastActionSignature = "";
      throw new Error("Не удалось автоматически заменить номер телефона на странице входа.");
    }
  }

  if (submitControl) {
    clickElementRobustly(submitControl);

    await delay(300);

    if (getLoginPageState() === "phone") {
      submitControl.click();
      await delay(300);
    }

    if (getLoginPageState() === "phone") {
      submitLoginForm(activeInput, submitControl);
    }
  } else {
    submitLoginForm(activeInput, submitControl);
  }

  const response = await sendRuntimeMessage({
    type: "OZON_LOGIN_SUBMITTED",
    runId: command.runId,
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Не удалось подтвердить отправку формы входа.");
  }

  await delay(1200);
  processRun().catch(() => {});
};

const handleOpenLogin = async (command) => {
  const actionSignature = `${command.runId}:open-login:${window.location.href}`;

  if (lastActionSignature === actionSignature) {
    return;
  }

  lastActionSignature = actionSignature;
  const didClick = await openLoginPage();

  if (!didClick) {
    throw new Error("Не удалось найти кнопку входа на текущей странице Ozon.");
  }
};

const handleReturnToListing = async (command) => {
  const actionSignature = `${command.runId}:return:${command.returnUrl}:${window.location.href}`;

  if (lastActionSignature === actionSignature) {
    return;
  }

  lastActionSignature = actionSignature;

  if (!command.returnUrl) {
    throw new Error("Не удалось определить страницу, куда нужно вернуться после входа.");
  }

  window.location.assign(command.returnUrl);
};

const handleLogout = async (command) => {
  if (getLoginPageState() === "phone") {
    lastActionSignature = "";
    await delay(300);
    processRun().catch(() => {});
    return;
  }

  const logoutStage = [
    getAccountLogoutButton() ? "account-logout" : "",
    getAccountRecordButton() ? "account-record" : "",
    getPersonalCabinetButton() ? "personal-cabinet" : "",
    /\/my\/main/i.test(window.location.pathname) ? "my-main" : "",
    /\/ozonid/i.test(window.location.pathname) ? "ozonid" : "",
  ].find(Boolean) || "open-profile";
  const actionSignature = `${command.runId}:logout:${command.attempt || 0}:${logoutStage}:${window.location.href}`;

  if (lastActionSignature === actionSignature) {
    return;
  }

  lastActionSignature = actionSignature;

  if (isAddressModalOpen()) {
    await closeAddressModal();
  }

  if (/\/product\//i.test(window.location.pathname)) {
    const navigateResponse = await sendRuntimeMessage({
      type: "OZON_NAVIGATE_TAB",
      runId: command.runId,
      url: `${window.location.origin}/ozonid`,
    }).catch(() => null);

    if (navigateResponse?.ok) {
      return;
    }

    navigateToUrlReliably(`${window.location.origin}/ozonid`);
    return;
  }

  if (/\/ozonid/i.test(window.location.pathname)) {
    const ozonIdLogoutButton = await scrollPageDownUntilElement(
      () => getAccountLogoutButton(),
      { maxSteps: 12, stepPx: Math.max(500, Math.floor(window.innerHeight * 0.8)), waitMs: 450 },
    );

    if (ozonIdLogoutButton) {
      ozonIdLogoutButton.scrollIntoView({
        block: "center",
        inline: "nearest",
      });
      await delay(300);
      clickElementDirectly(ozonIdLogoutButton);
      await delay(300);
      clickElementRobustly(ozonIdLogoutButton);
      await delay(250);
      activateElementWithKeyboard(ozonIdLogoutButton);
      return;
    }
  }

  const directAccountLogoutButton = await scrollPageForElement(
    () => getAccountLogoutButton(),
    /\/ozonid/i.test(window.location.pathname)
      ? { maxSteps: 10, stepPx: Math.max(500, Math.floor(window.innerHeight * 0.8)), waitMs: 400 }
      : undefined,
  );

  if (directAccountLogoutButton) {
    await scrollToAndClick(directAccountLogoutButton);
    return;
  }

  const accountRecordButton = getAccountRecordButton();

  if (accountRecordButton) {
    await scrollToAndClick(accountRecordButton);
    return;
  }

  const personalCabinetButton = getPersonalCabinetButton();

  if (personalCabinetButton) {
    await scrollToAndClick(personalCabinetButton);
    return;
  }

  const directLogoutButton = getLogoutButton();

  if (directLogoutButton) {
    await scrollToAndClick(directLogoutButton);
    return;
  }

  const accountTrigger = getAccountIconTrigger() || getVisibleActionByText(["профиль", "кабинет", "account", "profile", "науқ"]);

  if (accountTrigger) {
    clickElementRobustly(accountTrigger);
    await delay(600);
  }

  const nextLogoutTarget = await waitForCondition(
    () => getPersonalCabinetButton() || getAccountRecordButton() || getAccountLogoutButton() || getLogoutButton(),
    5000,
    250,
  );

  if (!nextLogoutTarget) {
    throw new Error("Не удалось выполнить цепочку выхода из аккаунта Ozon.");
  }

  await scrollToAndClick(nextLogoutTarget);
};

const processRun = async () => {
  if (isProcessingRun) {
    return;
  }

  isProcessingRun = true;

  try {
    if (isOzonConnectionErrorPage()) {
      await sendRuntimeMessage({
        type: "OZON_PROXY_PAGE_FAILED",
        pageUrl: window.location.href,
        errorText: "Ozon page says there is no connection.",
      }).catch(() => {});
      return;
    }

    if (isPrivacyInterstitialPage()) {
      await sendRuntimeMessage({
        type: "OZON_SKIP_CYCLE",
        pageUrl: window.location.href,
        reason: "Chrome opened a privacy/certificate warning page.",
      }).catch(() => {});
      return;
    }

    const command = await sendRuntimeMessage({
      type: "GET_OZON_RUN_COMMAND",
      pageType: getPageType(),
      pageUrl: window.location.href,
      loginState: isLoginPage() ? getLoginPageState() : "other",
    });

    if (!command?.ok || ["idle", "wait", "finish", "stop"].includes(command.action)) {
      if (command?.pollAfterMs) {
        window.setTimeout(() => {
          processRun().catch(() => {});
        }, command.pollAfterMs);
      }

      return;
    }

    if (command.action === "performLogin") {
      await handlePerformLogin(command);
      return;
    }

    if (command.action === "openLogin") {
      await handleOpenLogin(command);
      return;
    }

    if (command.action === "returnToListing") {
      await handleReturnToListing(command);
      return;
    }

    if (command.action === "logout") {
      await handleLogout(command);
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
    const errorMessage = error?.message || "Не удалось выполнить шаг цикла.";
    const normalizedErrorMessage = normalizeText(errorMessage).toLowerCase();

    if (
      normalizedErrorMessage.includes("не найден среди текущих результатов")
      || normalizedErrorMessage.includes("there is no connection")
      || normalizedErrorMessage.includes("privacy/certificate warning")
      || normalizedErrorMessage.includes("net::err_cert_")
      || normalizedErrorMessage.includes("net::err_ssl_")
    ) {
      lastActionSignature = "";
      await sendRuntimeMessage({
        type: "OZON_SKIP_CYCLE",
        pageUrl: window.location.href,
        reason: errorMessage,
      }).catch(() => {});
    } else {
      await sendRuntimeMessage({
        type: "OZON_RUN_FAILED",
        runId: lastActionSignature.split(":")[0] || "",
        error: errorMessage,
      }).catch(() => {});
    }
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
