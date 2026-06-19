const activeRuns = new Map();
const lastRunStates = new Map();
const DEFAULT_DURATION_MS = 0;
const GO_BACK_DELAY_MS = 1400;
const RETURN_PAGE_SETTLE_MS = 1200;
const LOGIN_TIMEOUT_MS = 2 * 60 * 1000;
const LOGIN_NAVIGATION_WAIT_MS = 15000;
const LOGIN_RETRY_WAIT_MS = 2500;
const LOGIN_TAB_ADOPT_WINDOW_MS = 30000;
const LOGOUT_TIMEOUT_MS = 30000;
const PROXY_STATE_STORAGE_KEY = "ozonHelperActiveProxy";
const PROXY_BYPASS_LIST = ["<local>"];
const PROXY_FAILOVER_COOLDOWN_MS = 100;
const PROXY_RECOVERY_WATCHDOG_MS = 1200;
const PROXY_PREFLIGHT_SETTLE_MS = 60;
const PROXY_PREFLIGHT_TIMEOUT_MS = 650;
const PROXY_IP_CHECK_TIMEOUT_MS = 900;
const PROXY_IP_CHANGE_SETTLE_MS = 1800;
const PROXY_IP_CHANGE_RETRY_DELAY_MS = 1200;
const PROXY_IP_CHANGE_MAX_ATTEMPTS = 3;
const SINGLE_PROXY_RECOVERY_ATTEMPTS = 8;
const PROXY_PREFLIGHT_MIN_WORKING = 1;
const PROXY_PREFLIGHT_MAX_START_CHECKS = 12;
const PROXY_PREFLIGHT_MAX_RECOVERY_CHECKS = 18;
const PROXY_PREFLIGHT_TEST_URLS = ["https://www.ozon.ru/"];
const PROXY_IP_CHECK_URLS = [
  "https://api64.ipify.org?format=json",
  "https://api.ipify.org?format=json",
];
const PROXY_FAILOVER_ERRORS = [
  "ERR_PROXY_CONNECTION_FAILED",
  "ERR_SOCKS_CONNECTION_FAILED",
  "ERR_TUNNEL_CONNECTION_FAILED",
  "ERR_CONNECTION_TIMED_OUT",
  "ERR_TIMED_OUT",
  "ERR_ADDRESS_UNREACHABLE",
  "ERR_CONNECTION_CLOSED",
  "ERR_CONNECTION_RESET",
  "ERR_CERT_AUTHORITY_INVALID",
  "ERR_CERT_COMMON_NAME_INVALID",
  "ERR_CERT_DATE_INVALID",
  "ERR_SSL_PROTOCOL_ERROR",
  "ERR_SSL_VERSION_OR_CIPHER_MISMATCH",
];
const ERROR_PAGE_TITLE_FRAGMENTS = [
  "похоже, нет соединения",
  "нет соединения",
  "ошибка нарушения конфиденциальности",
  "подключение не защищено",
];
let runtimeConfigPromise = null;
let activeProxyState = null;
let preparedProxyPool = null;
let startupPreparationState = null;

const getConfigPhones = (config) => {
  if (!config || typeof config !== "object") {
    return [];
  }

  if (Array.isArray(config.phones)) {
    return config.phones
      .map((phone) => String(phone || "").trim())
      .filter(Boolean);
  }

  const singlePhone = String(config.phone || "").trim();
  return singlePhone ? [singlePhone] : [];
};

const getProxyRecords = (config) => {
  if (Array.isArray(config)) {
    return config;
  }

  if (!config || typeof config !== "object") {
    return [];
  }

  if (Array.isArray(config.proxies)) {
    return config.proxies;
  }

  if (Array.isArray(config.proxyList)) {
    return config.proxyList;
  }

  return [];
};

const detectProxyConfigProblem = (records) => {
  if (!Array.isArray(records) || !records.length) {
    return "";
  }

  const sample = records.find((record) => record && typeof record === "object");

  if (!sample) {
    return "Proxy JSON список пуст или поврежден.";
  }

  if (
    Object.prototype.hasOwnProperty.call(sample, "vpn_servers")
    && Object.prototype.hasOwnProperty.call(sample, "__0")
    && !Object.prototype.hasOwnProperty.call(sample, "port")
    && !Object.prototype.hasOwnProperty.call(sample, "protocol")
    && !Object.prototype.hasOwnProperty.call(sample, "scheme")
  ) {
    return "Текущий JSON не является списком HTTP/SOCKS proxy. Это VPN server list (`vpn_servers`, `__0` ...), и в нем нет обязательных полей `port` и `scheme/protocol`.";
  }

  return "Proxy список найден, но записи не содержат обязательные поля `ip/host`, `port`, `scheme/protocol`.";
};

const getProxyConfigSummary = (config) => {
  const records = getProxyRecords(config);
  const proxies = records
    .map((proxy, index) => {
      if (!proxy || typeof proxy !== "object") {
        return null;
      }

      const protocolFromList = Array.isArray(proxy.protocols) && proxy.protocols.length
        ? String(proxy.protocols[0] || "").trim().toLowerCase()
        : "";
      const scheme = String(proxy.scheme || proxy.protocol || protocolFromList || "http").trim().toLowerCase();
      const host = String(proxy.host || proxy.ip || "").trim();
      const port = Number.parseInt(String(proxy.port || ""), 10);
      const label = String(proxy.label || "").trim();
      const username = String(proxy.username || "").trim();
      const password = String(proxy.password || "");
      const bypassList = Array.isArray(proxy.bypassList)
        ? proxy.bypassList.map((value) => String(value || "").trim()).filter(Boolean)
        : PROXY_BYPASS_LIST;

      if (!["http", "https", "socks4", "socks5"].includes(scheme)) {
        return null;
      }

      if (!host || Number.isNaN(port) || port < 1 || port > 65535) {
        return null;
      }

      return {
        label: label || [proxy.country, `${scheme}://${host}:${port}`].filter(Boolean).join(" "),
        scheme,
        host,
        port,
        username,
        password,
        bypassList: bypassList.length ? bypassList : PROXY_BYPASS_LIST,
        configIndex: index,
      };
    })
    .filter(Boolean);

  return {
    records,
    proxies,
    error: records.length > 0 && proxies.length === 0 ? detectProxyConfigProblem(records) : "",
  };
};

const getConfigProxies = (config) => {
  return getProxyConfigSummary(config).proxies;
};

const buildProxyIdentity = (proxy) => (
  [
    String(proxy?.scheme || "").trim().toLowerCase(),
    String(proxy?.host || "").trim().toLowerCase(),
    String(proxy?.port || "").trim(),
    String(proxy?.username || "").trim(),
  ].join("|")
);

const buildProxyPoolCacheKey = (proxies) => (
  Array.isArray(proxies)
    ? proxies.map((proxy) => buildProxyIdentity(proxy)).join(";;")
    : ""
);

const clearPreparedProxyPool = () => {
  preparedProxyPool = null;
};

const getPreparedProxyPool = (rawProxies) => {
  if (!preparedProxyPool || !Array.isArray(rawProxies) || !rawProxies.length) {
    return null;
  }

  return preparedProxyPool.key === buildProxyPoolCacheKey(rawProxies)
    ? preparedProxyPool
    : null;
};

const savePreparedProxyPool = (rawProxies, workingProxies, meta = {}) => {
  const rawCount = Array.isArray(rawProxies) ? rawProxies.length : 0;
  const checkedCount = Math.min(
    Math.max(Number.parseInt(String(meta.checkedCount ?? workingProxies.length), 10) || 0, 0),
    rawCount,
  );
  const nextUncheckedIndex = Math.min(
    Math.max(Number.parseInt(String(meta.nextUncheckedIndex ?? checkedCount), 10) || 0, 0),
    rawCount,
  );

  preparedProxyPool = {
    key: buildProxyPoolCacheKey(rawProxies),
    rawCount,
    proxies: workingProxies.map((proxy) => ({ ...proxy })),
    filteredOut: Math.max(checkedCount - workingProxies.length, 0),
    checkedCount,
    nextUncheckedIndex,
    checkedAt: Date.now(),
  };
};

const removeProxyFromPreparedPool = (proxyLike) => {
  if (!preparedProxyPool?.proxies?.length) {
    return;
  }

  const failedIdentity = buildProxyIdentity(proxyLike);

  if (!failedIdentity) {
    return;
  }

  const nextProxies = preparedProxyPool.proxies.filter((proxy) => buildProxyIdentity(proxy) !== failedIdentity);

  preparedProxyPool = {
    ...preparedProxyPool,
    proxies: nextProxies,
    filteredOut: Math.max((preparedProxyPool.checkedCount || 0) - nextProxies.length, 0),
    checkedAt: Date.now(),
  };
};

const setStartupPreparationState = (patch) => {
  startupPreparationState = {
    ok: true,
    running: true,
    status: "preparing",
    completedCycles: 0,
    currentCycle: 0,
    step: "Проверяю proxy перед запуском...",
    message: "Подготавливаю список рабочих proxy.",
    ...startupPreparationState,
    ...patch,
  };
};

const clearStartupPreparationState = () => {
  startupPreparationState = null;
};

const getActiveProxyConfigSummary = (config) => {
  const baseSummary = getProxyConfigSummary(config);

  if (!baseSummary.proxies.length) {
    return {
      ...baseSummary,
      rawProxyCount: 0,
      filteredOutCount: 0,
      prepared: false,
    };
  }

  const preparedPool = getPreparedProxyPool(baseSummary.proxies);

  if (!preparedPool) {
    return {
      ...baseSummary,
      rawProxyCount: baseSummary.proxies.length,
      filteredOutCount: 0,
      checkedProxyCount: 0,
      uncheckedCount: baseSummary.proxies.length,
      prepared: false,
    };
  }

  const filteredProxies = preparedPool.proxies.map((proxy) => ({ ...proxy }));
  const checkedProxyCount = Math.min(preparedPool.checkedCount || 0, preparedPool.rawCount);
  const uncheckedCount = Math.max(preparedPool.rawCount - checkedProxyCount, 0);
  const noWorkingProxyError = filteredProxies.length || uncheckedCount > 0
    ? ""
    : `После проверки не найдено ни одного рабочего proxy из ${preparedPool.rawCount}.`;

  return {
    ...baseSummary,
    proxies: filteredProxies,
    error: noWorkingProxyError || baseSummary.error,
    rawProxyCount: preparedPool.rawCount,
    filteredOutCount: preparedPool.filteredOut,
    checkedProxyCount,
    uncheckedCount,
    prepared: true,
  };
};

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

const isLoginUrl = (url) => {
  try {
    const parsedUrl = new URL(url || "");

    if (!/ozon\.(com|ru)$/i.test(parsedUrl.hostname)) {
      return false;
    }

    return [
      /\/login/i,
      /\/signin/i,
      /\/auth/i,
      /\/ozonid/i,
      /\/sso/i,
    ].some((pattern) => pattern.test(parsedUrl.pathname));
  } catch (error) {
    return false;
  }
};

const isLoggedOutPage = (pageType, pageUrl, loginState = "other") => {
  if (pageType === "login" && loginState !== "other") {
    return true;
  }

  return isLoginUrl(pageUrl) && loginState !== "other";
};

const isLogoutFlowUrl = (url) => {
  try {
    const parsedUrl = new URL(url || "");

    if (!/ozon\.(com|ru)$/i.test(parsedUrl.hostname)) {
      return false;
    }

    return /\/my\/main/i.test(parsedUrl.pathname) || /\/ozonid/i.test(parsedUrl.pathname);
  } catch (error) {
    return false;
  }
};

const getRunElapsedMs = (run, endedAt = Date.now()) => {
  const startedAt = Number.parseInt(String(run?.startedAt || 0), 10) || 0;
  const safeEndedAt = Number.parseInt(String(endedAt || Date.now()), 10) || Date.now();

  if (!startedAt) {
    return 0;
  }

  return Math.max(0, safeEndedAt - startedAt);
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
  elapsedMs: getRunElapsedMs(run, run.status === "running" ? Date.now() : (run.finishedAt || Date.now())),
  cycleIntervalMs: run.cycleIntervalMs,
  completedCycles: run.completedCycles,
  currentCycle: run.currentCycle,
  accountCount: run.accountPhones?.length || 0,
  currentAccountIndex: run.currentAccountIndex || 0,
  step: run.step,
  message: run.message,
  proxyCycleMessage: run.proxyCycleMessage || "",
  lastKnownProxyIp: run.lastKnownProxyIp || "",
  proxyBypassedForRun: Boolean(run.proxyBypassedForRun),
  metrics: {
    searchSubmissions: run.metrics?.searchSubmissions || 0,
    brandFilterApplied: run.metrics?.brandFilterApplied || 0,
    productOpenSignals: run.metrics?.productOpenSignals || 0,
    productVisits: run.metrics?.productVisits || 0,
    backNavigations: run.metrics?.backNavigations || 0,
    proxyRotations: run.metrics?.proxyRotations || 0,
    proxyRecoveries: run.metrics?.proxyRecoveries || 0,
    proxyFallbackCycles: run.metrics?.proxyFallbackCycles || 0,
    failedCycles: run.metrics?.failedCycles || 0,
    totalProductHoldMs: run.metrics?.totalProductHoldMs || 0,
  },
});

const normalizeOptionalUrl = (value) => {
  const trimmed = String(value || "").trim();

  if (!trimmed) {
    return "";
  }

  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
};

const isHttpUrl = (value) => /^https?:\/\//i.test(String(value || "").trim());

const delay = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

const callChromeApi = (callbackInvoker) => new Promise((resolve, reject) => {
  callbackInvoker(() => {
    if (chrome.runtime.lastError) {
      reject(new Error(chrome.runtime.lastError.message));
      return;
    }

    resolve();
  });
});

const buildProxyTestUrl = (baseUrl) => {
  const divider = baseUrl.includes("?") ? "&" : "?";
  return `${baseUrl}${divider}ozon_proxy_probe=${Date.now()}_${Math.random().toString(16).slice(2)}`;
};

const buildForcedRunNavigationUrl = (baseUrl) => {
  const normalizedUrl = normalizeOptionalUrl(baseUrl);
  return normalizedUrl ? buildProxyTestUrl(normalizedUrl) : "";
};

const fetchWithTimeout = async (url, timeoutMs) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      cache: "no-store",
      redirect: "follow",
      credentials: "omit",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
};

const isAcceptableProxyResponse = (response) => {
  if (!response) {
    return false;
  }

  if ([407, 502, 503, 504].includes(response.status)) {
    return false;
  }

  return true;
};

const parseIpCheckResponse = async (response) => {
  if (!response || !response.ok) {
    return "";
  }

  const contentType = String(response.headers.get("content-type") || "").toLowerCase();

  if (contentType.includes("application/json")) {
    const payload = await response.json().catch(() => null);
    const ip = String(payload?.ip || payload?.origin || "").trim();
    return ip;
  }

  return String(await response.text().catch(() => "")).trim();
};

const probeCurrentExitIp = async () => {
  for (const url of PROXY_IP_CHECK_URLS) {
    try {
      const response = await fetchWithTimeout(buildProxyTestUrl(url), PROXY_IP_CHECK_TIMEOUT_MS);
      const ip = await parseIpCheckResponse(response);

      if (ip) {
        return ip;
      }
    } catch (error) {
      // Try the next IP check endpoint.
    }
  }

  return "";
};

const probeCurrentExitIpWithRetry = async (previousIp = "") => {
  const normalizedPreviousIp = String(previousIp || "").trim();
  let lastIp = "";

  await delay(PROXY_IP_CHANGE_SETTLE_MS);

  for (let attempt = 0; attempt < PROXY_IP_CHANGE_MAX_ATTEMPTS; attempt += 1) {
    const ip = String(await probeCurrentExitIp().catch(() => "") || "").trim();

    if (ip) {
      lastIp = ip;

      if (!normalizedPreviousIp || ip !== normalizedPreviousIp) {
        return ip;
      }
    }

    if (attempt < PROXY_IP_CHANGE_MAX_ATTEMPTS - 1) {
      await delay(PROXY_IP_CHANGE_RETRY_DELAY_MS);
    }
  }

  return lastIp;
};

const buildProxyCycleMessage = ({
  cycle,
  requested,
  label = "",
  ip = "",
  changed = null,
  checked = false,
  sessionChanged = false,
}) => {
  if (!requested) {
    return `Цикл ${cycle}: запрос к proxy не отправлялся. Proxy не используется.`;
  }

  const proxyLabel = label ? ` (${label})` : "";
  const sessionNote = sessionChanged ? " Сессия proxy обновлена." : "";

  if (!checked) {
    return `Цикл ${cycle}: запрос к proxy отправлен${proxyLabel}.${sessionNote} Проверяю, сменился ли IP...`;
  }

  if (!ip) {
    return `Цикл ${cycle}: запрос к proxy отправлен${proxyLabel}.${sessionNote} Проверить IP не удалось.`;
  }

  if (changed === null) {
    return `Цикл ${cycle}: запрос к proxy отправлен${proxyLabel}.${sessionNote} Exit IP: ${ip}. Это первая проверка IP.`;
  }

  return changed
    ? `Цикл ${cycle}: запрос к proxy отправлен${proxyLabel}.${sessionNote} Exit IP: ${ip}. IP сменился.`
    : `Цикл ${cycle}: запрос к proxy отправлен${proxyLabel}.${sessionNote} Exit IP: ${ip}. IP не сменился.`;
};

const buildProxySessionId = (cycleSeed = 0) => (
  `${Date.now().toString(36)}${Math.max(0, Number.parseInt(String(cycleSeed || 0), 10) || 0)}${Math.random().toString(36).slice(2, 8)}`
);

const buildProxyBypassMessage = (cycle) => (
  `Цикл ${cycle}: proxy временно отключен. Продолжаю цикл без proxy.`
);

const applySessionToProxyUsername = (username, sessionId) => {
  const normalizedUsername = String(username || "").trim();

  if (!normalizedUsername || !sessionId) {
    return {
      username: normalizedUsername,
      sessionChanged: false,
    };
  }

  const knownPattern = /(^|;)(anon|session|sessid|sid)\.[^;]*/i;

  if (knownPattern.test(normalizedUsername)) {
    return {
      username: normalizedUsername.replace(knownPattern, `$1$2.${sessionId}`),
      sessionChanged: true,
    };
  }

  return {
    username: `${normalizedUsername};session.${sessionId}`,
    sessionChanged: true,
  };
};

const loadStoredProxyState = async () => {
  if (activeProxyState) {
    return activeProxyState;
  }

  const stored = await chrome.storage.local.get([PROXY_STATE_STORAGE_KEY]);
  const proxyState = stored[PROXY_STATE_STORAGE_KEY];

  activeProxyState = proxyState && typeof proxyState === "object" ? proxyState : null;
  return activeProxyState;
};

const saveProxyState = async (proxyState) => {
  activeProxyState = proxyState;
  await chrome.storage.local.set({
    [PROXY_STATE_STORAGE_KEY]: proxyState,
  });
};

const clearStoredProxyState = async () => {
  activeProxyState = null;
  await chrome.storage.local.remove(PROXY_STATE_STORAGE_KEY);
};

const buildProxyStatusPayload = (proxyState, proxyCount) => {
  if (!proxyState) {
    return {
      ok: true,
      hasProxies: proxyCount > 0,
      enabled: false,
      message: proxyCount > 0
        ? "Proxy список найден, но активный proxy еще не применен."
        : "Proxy не задан. Расширение работает без proxy.",
    };
  }

  return {
    ok: true,
    hasProxies: proxyCount > 0,
    enabled: true,
    index: proxyState.index,
    total: proxyCount,
    label: proxyState.label,
    message: proxyCount > 1
      ? `Активный proxy ${proxyState.index + 1} из ${proxyCount}: ${proxyState.label}`
      : `Активный proxy: ${proxyState.label}`,
  };
};

const applyProxySettings = async (proxy, index, total, options = {}) => {
  const sessionId = String(options.sessionId || "").trim();
  const sessionRotation = applySessionToProxyUsername(proxy.username, sessionId);

  await callChromeApi((done) => {
    chrome.proxy.settings.set({
      value: {
        mode: "fixed_servers",
        rules: {
          singleProxy: {
            scheme: proxy.scheme,
            host: proxy.host,
            port: proxy.port,
          },
          bypassList: proxy.bypassList,
        },
      },
      scope: "regular",
    }, done);
  });

  const proxyState = {
    index,
    total,
    label: proxy.label,
    scheme: proxy.scheme,
    host: proxy.host,
    port: proxy.port,
    username: sessionRotation.username,
    password: proxy.password,
    bypassList: proxy.bypassList,
    sessionId,
    sessionChanged: sessionRotation.sessionChanged,
  };

  await saveProxyState(proxyState);
  return {
    ...buildProxyStatusPayload(proxyState, total),
    sessionChanged: sessionRotation.sessionChanged,
    sessionId,
  };
};

const clearProxySettings = async () => {
  await callChromeApi((done) => {
    chrome.proxy.settings.clear({ scope: "regular" }, done);
  });

  await clearStoredProxyState();
  return buildProxyStatusPayload(null, 0);
};

const clearProxySettingsPreservingState = async () => {
  await callChromeApi((done) => {
    chrome.proxy.settings.clear({ scope: "regular" }, done);
  });
};

const testSingleProxy = async (proxy, index, total) => {
  await applyProxySettings(proxy, index, total);
  await delay(PROXY_PREFLIGHT_SETTLE_MS);

  for (const testUrl of PROXY_PREFLIGHT_TEST_URLS) {
    try {
      const response = await fetchWithTimeout(buildProxyTestUrl(testUrl), PROXY_PREFLIGHT_TIMEOUT_MS);

      if (isAcceptableProxyResponse(response)) {
        return true;
      }
    } catch (error) {
      // Try the next probe URL before declaring the proxy dead.
    }
  }

  return false;
};

const extendPreparedProxyPool = async (config, options = {}) => {
  const baseSummary = getProxyConfigSummary(config);

  if (!baseSummary.proxies.length) {
    if (baseSummary.error) {
      throw new Error(baseSummary.error);
    }

    clearPreparedProxyPool();
    return {
      ...getActiveProxyConfigSummary(config),
      checkedNow: 0,
    };
  }

  const existingPool = getPreparedProxyPool(baseSummary.proxies);
  const workingProxies = existingPool?.proxies?.map((proxy) => ({ ...proxy })) || [];
  let checkedCount = Math.min(existingPool?.checkedCount || 0, baseSummary.proxies.length);
  let nextUncheckedIndex = Math.min(existingPool?.nextUncheckedIndex || checkedCount, baseSummary.proxies.length);
  const alreadyWorking = workingProxies.length;
  const minimumWorking = Math.max(
    1,
    Number.parseInt(String(options.minimumWorking ?? alreadyWorking + 1), 10) || 1,
  );
  const maxChecks = Math.max(
    1,
    Number.parseInt(String(options.maxChecks ?? PROXY_PREFLIGHT_MAX_RECOVERY_CHECKS), 10) || 1,
  );
  const cycles = Number.parseInt(String(options.cycles || 0), 10) || 0;
  let checkedNow = 0;

  try {
    while (
      nextUncheckedIndex < baseSummary.proxies.length
      && checkedNow < maxChecks
      && workingProxies.length < minimumWorking
    ) {
      if (options.updateStartupState && startupPreparationState?.cancelled) {
        throw new Error("Подготовка proxy остановлена пользователем.");
      }

      const currentIndex = nextUncheckedIndex;
      const proxy = baseSummary.proxies[currentIndex];
      nextUncheckedIndex += 1;
      checkedCount += 1;
      checkedNow += 1;

      if (options.updateStartupState) {
        setStartupPreparationState({
          cycles,
          completedCycles: 0,
          currentCycle: 0,
          step: `Быстро проверяю proxy ${checkedCount} из ${baseSummary.proxies.length} перед запуском.`,
          message: `Уже найдено ${workingProxies.length} рабочих proxy. Останавливаюсь, как только будет достаточно для старта.`,
        });
      }

      const isWorking = await testSingleProxy(proxy, currentIndex, baseSummary.proxies.length);

      if (isWorking) {
        workingProxies.push(proxy);
      }
    }
  } finally {
    await clearProxySettings();
  }

  savePreparedProxyPool(baseSummary.proxies, workingProxies, {
    checkedCount,
    nextUncheckedIndex,
  });

  if (options.updateStartupState) {
    setStartupPreparationState({
      cycles,
      completedCycles: 0,
      currentCycle: 0,
      step: workingProxies.length
        ? `Быстрая проверка завершена: рабочих proxy ${workingProxies.length}, проверено ${checkedCount} из ${baseSummary.proxies.length}.`
        : `Быстрая проверка пока не нашла рабочий proxy: проверено ${checkedCount} из ${baseSummary.proxies.length}.`,
      message: workingProxies.length
        ? `Запускаю циклы сразу, а остальные proxy будут проверяться только при необходимости.`
        : `Пробую другие proxy, пока не найду рабочий.`,
    });
  }

  return {
    ...getActiveProxyConfigSummary(config),
    checkedNow,
  };
};

const prepareWorkingProxiesForRun = async (config, cycles) => {
  const baseSummary = getProxyConfigSummary(config);

  if (!baseSummary.proxies.length) {
    if (baseSummary.error) {
      throw new Error(baseSummary.error);
    }

    clearPreparedProxyPool();
    return {
      proxies: [],
      rawProxyCount: 0,
      filteredOutCount: 0,
      prepared: false,
    };
  }

  clearPreparedProxyPool();

  setStartupPreparationState({
    cycles,
    completedCycles: 0,
    currentCycle: 0,
    step: `Быстро проверяю первые proxy перед запуском.`,
    message: `Нужно найти хотя бы ${PROXY_PREFLIGHT_MIN_WORKING} рабочий proxy, чтобы сразу запустить циклы.`,
  });

  let preparedSummary = await extendPreparedProxyPool(config, {
    minimumWorking: PROXY_PREFLIGHT_MIN_WORKING,
    maxChecks: Math.min(baseSummary.proxies.length, PROXY_PREFLIGHT_MAX_START_CHECKS),
    cycles,
    updateStartupState: true,
  });

  while (!preparedSummary.proxies.length && preparedSummary.uncheckedCount > 0) {
    preparedSummary = await extendPreparedProxyPool(config, {
      minimumWorking: 1,
      maxChecks: Math.min(preparedSummary.uncheckedCount, PROXY_PREFLIGHT_MAX_START_CHECKS),
      cycles,
      updateStartupState: true,
    });
  }

  if (!preparedSummary.proxies.length) {
    throw new Error(`После быстрой проверки не найдено ни одного рабочего proxy из ${baseSummary.proxies.length}.`);
  }

  setStartupPreparationState({
    cycles,
    completedCycles: 0,
    currentCycle: 0,
    step: `Первый рабочий proxy найден. Запускаю циклы.`,
    message: preparedSummary.checkedProxyCount > 1
      ? `Проверено ${preparedSummary.checkedProxyCount} из ${preparedSummary.rawProxyCount}. Для старта этого уже достаточно. Остальные proxy будут проверяться только при необходимости.`
      : `Найден рабочий proxy, поэтому циклы стартуют сразу без ожидания дополнительной проверки списка.`,
  });

  return preparedSummary;
};

const prepareProxyPoolForUsage = async (
  config,
  {
    minimumWorking = 1,
    maxChecksPerBatch = PROXY_PREFLIGHT_MAX_RECOVERY_CHECKS,
  } = {},
) => {
  let summary = getActiveProxyConfigSummary(config);

  if (!summary.proxies.length && summary.error) {
    return summary;
  }

  if (!summary.prepared) {
    const initialMaxChecks = summary.rawProxyCount
      ? Math.min(summary.rawProxyCount, maxChecksPerBatch)
      : maxChecksPerBatch;

    summary = await extendPreparedProxyPool(config, {
      minimumWorking,
      maxChecks: initialMaxChecks,
    });
  }

  while (!summary.proxies.length && summary.prepared && summary.uncheckedCount > 0) {
    summary = await extendPreparedProxyPool(config, {
      minimumWorking: 1,
      maxChecks: Math.min(summary.uncheckedCount, maxChecksPerBatch),
    });
  }

  return summary;
};

const getStoredProxyIndex = (proxies, storedState) => {
  if (!Array.isArray(proxies) || !proxies.length || !storedState) {
    return -1;
  }

  const storedIdentity = buildProxyIdentity(storedState);

  if (storedIdentity) {
    const identityIndex = proxies.findIndex((proxy) => buildProxyIdentity(proxy) === storedIdentity);

    if (identityIndex >= 0) {
      return identityIndex;
    }
  }

  if (Number.isInteger(storedState.index)) {
    return Math.min(Math.max(storedState.index, 0), proxies.length - 1);
  }

  return -1;
};

const ensureProxyFromConfig = async (config) => {
  const summary = await prepareProxyPoolForUsage(config, {
    minimumWorking: 1,
    maxChecksPerBatch: PROXY_PREFLIGHT_MAX_RECOVERY_CHECKS,
  });

  const { proxies, error } = summary;

  if (!proxies.length) {
    if (error) {
      throw new Error(error);
    }
    return clearProxySettings();
  }

  const storedState = await loadStoredProxyState();
  const nextIndex = Math.max(getStoredProxyIndex(proxies, storedState), 0);

  return applyProxySettings(proxies[nextIndex], nextIndex, proxies.length);
};

const rotateProxyFromConfig = async (config, options = {}) => {
  const summary = options.allowUnchecked
    ? getProxyConfigSummary(config)
    : await prepareProxyPoolForUsage(config, {
      minimumWorking: 1,
      maxChecksPerBatch: PROXY_PREFLIGHT_MAX_RECOVERY_CHECKS,
    });

  const { proxies, error } = summary;

  if (!proxies.length) {
    if (error) {
      throw new Error(error);
    }
    return clearProxySettings();
  }

  const storedState = await loadStoredProxyState();
  const currentIndex = getStoredProxyIndex(proxies, storedState);
  const nextIndex = (currentIndex + 1) % proxies.length;

  return applyProxySettings(proxies[nextIndex], nextIndex, proxies.length, {
    sessionId: options.sessionId,
  });
};

const rotateProxyForRun = async (run) => {
  if (!run?.pendingProxyRotation) {
    return null;
  }

  if (run.proxyBypassedForRun) {
    await clearProxySettings();
    updateRun(run, {
      pendingProxyRotation: false,
      proxyCycleMessage: buildProxyBypassMessage(run.currentCycle),
      message: "Proxy временно отключен для этого запуска. Циклы продолжаются без proxy.",
    });
    return null;
  }

  const config = await loadRuntimeConfig();
  const proxies = getProxyConfigSummary(config).proxies;

  if (!proxies.length) {
    updateRun(run, {
      pendingProxyRotation: false,
      proxyCycleMessage: buildProxyCycleMessage({
        cycle: run.currentCycle,
        requested: false,
      }),
    });
    return null;
  }

  const proxyStatus = await rotateProxyFromConfig(config, {
    allowUnchecked: true,
    sessionId: buildProxySessionId(run.currentCycle),
  });
  updateRun(run, {
    pendingProxyRotation: false,
    message: proxyStatus?.message || run.message,
    metrics: {
      ...run.metrics,
      proxyRotations: (run.metrics?.proxyRotations || 0) + 1,
    },
  });

  const runId = run.runId;
  const cycle = run.currentCycle;
  const previousIp = String(run.lastKnownProxyIp || "").trim();
  const tabId = run.tabId;

  probeCurrentExitIpWithRetry(previousIp)
    .then((ip) => {
      const currentRun = activeRuns.get(tabId);

      if (!currentRun || currentRun.runId !== runId || currentRun.currentCycle !== cycle) {
        return;
      }

      const normalizedIp = String(ip || "").trim();
      const didChange = previousIp
        ? normalizedIp
          ? normalizedIp !== previousIp
          : null
        : null;

      updateRun(currentRun, {
        lastKnownProxyIp: normalizedIp || currentRun.lastKnownProxyIp || "",
        proxyCycleMessage: buildProxyCycleMessage({
          cycle,
          requested: true,
          label: proxyStatus?.label || "",
          ip: normalizedIp,
          changed: didChange,
          checked: true,
          sessionChanged: Boolean(proxyStatus?.sessionChanged),
        }),
      });
    })
    .catch(() => {
      const currentRun = activeRuns.get(tabId);

      if (!currentRun || currentRun.runId !== runId || currentRun.currentCycle !== cycle) {
        return;
      }

      updateRun(currentRun, {
        proxyCycleMessage: buildProxyCycleMessage({
          cycle,
          requested: true,
          label: proxyStatus?.label || "",
          ip: "",
          changed: null,
          checked: true,
          sessionChanged: Boolean(proxyStatus?.sessionChanged),
        }),
      });
    });

  return proxyStatus;
};

const continueRunWithoutProxy = async (run, retryUrl, reason = "") => {
  const forcedRetryUrl = buildForcedRunNavigationUrl(retryUrl) || normalizeOptionalUrl(retryUrl);

  await clearProxySettingsPreservingState();

  updateRun(run, {
    proxyFailureCount: 0,
    pendingProxyRotation: false,
    proxyRecoveryInFlight: false,
    proxyBypassedForRun: true,
    lastRequestedUrl: forcedRetryUrl,
    step: "Proxy отключен только для текущего цикла, продолжаю без него...",
    message: reason || "Proxy нестабилен в этом цикле, поэтому продолжаю его без proxy.",
    proxyCycleMessage: buildProxyBypassMessage(run.currentCycle),
    metrics: {
      ...run.metrics,
      proxyFallbackCycles: (run.metrics?.proxyFallbackCycles || 0) + 1,
    },
  });

  await chrome.tabs.update(run.tabId, { url: forcedRetryUrl });
};

const getResumeUrlForRun = (run) => {
  const candidates = [
    normalizeOptionalUrl(run?.listingUrl),
    normalizeOptionalUrl(run?.startUrl),
    normalizeOptionalUrl(run?.lastRequestedUrl),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (isOzonResultsUrl(candidate)) {
      return candidate;
    }
  }

  for (const candidate of candidates) {
    if (isOzonTab(candidate)) {
      try {
        const parsedUrl = new URL(candidate);
        return `${parsedUrl.origin}/`;
      } catch (error) {
        return candidate;
      }
    }
  }

  return PROXY_PREFLIGHT_TEST_URLS[0];
};

const skipCurrentCycleAfterConnectionError = async (run, reason = "") => {
  if (!run || run.cycleSkipInFlight) {
    return;
  }

  updateRun(run, {
    cycleSkipInFlight: true,
  });
  clearProxyRecoveryWatchdog(run);

  const skippedCycle = Math.max(
    1,
    Number.parseInt(String(run.currentCycle || (run.completedCycles || 0) + 1), 10) || 1,
  );
  const completedCycles = Math.max(run.completedCycles || 0, skippedCycle);
  const nextCycle = completedCycles + 1;
  const resumeUrl = getResumeUrlForRun(run);
  const forcedResumeUrl = buildForcedRunNavigationUrl(resumeUrl) || resumeUrl;
  const nextSearchTerm = getCycleSearchTerm(run, nextCycle);
  const nextStep = nextSearchTerm
    ? `Ищу товар по запросу "${nextSearchTerm}": цикл ${nextCycle} из ${run.cycles}.`
    : `Ищу товар: цикл ${nextCycle} из ${run.cycles}.`;
  const failureMessage = reason || "Ozon открыл страницу без соединения, поэтому пропускаю текущий цикл.";

  updateRun(run, {
    completedCycles,
    currentCycle: Math.min(nextCycle, run.cycles),
    currentSearchTerm: nextSearchTerm,
    phase: "search",
    nextCycleDelayMs: 0,
    pendingProxyRotation: completedCycles < run.cycles,
    proxyFailureCount: 0,
    lastProxyFailureAt: 0,
    proxyRecoveryInFlight: false,
    proxyBypassedForRun: false,
    lastRequestedUrl: forcedResumeUrl,
    step: completedCycles < run.cycles
      ? `Пропускаю цикл ${skippedCycle} после ошибки страницы. Перехожу к следующему.`
      : `Пропускаю цикл ${skippedCycle} после ошибки страницы и завершаю запуск.`,
    message: completedCycles < run.cycles
      ? `${failureMessage} Выполнено ${completedCycles} из ${run.cycles}.`
      : `${failureMessage} Это был последний цикл.`,
    proxyCycleMessage: `Цикл ${skippedCycle}: страница Ozon не открылась. Пропускаю этот цикл.`,
    metrics: {
      ...run.metrics,
      failedCycles: (run.metrics?.failedCycles || 0) + 1,
    },
  });

  try {
    await clearProxySettingsPreservingState();
  } catch (error) {
    // Ignore proxy cleanup failures so the run can still advance.
  }

  if (completedCycles >= run.cycles) {
    finishRun(
      run,
      "completed",
      `Готово. Выполнено ${run.cycles} циклов за ${formatDuration(getRunElapsedMs(run))}. Последний цикл пропущен из-за ошибки соединения.`,
    );
    return;
  }

  updateRun(run, {
    cycleSkipInFlight: false,
    step: nextStep,
    message: `Выполнено ${completedCycles} из ${run.cycles}. Цикл ${skippedCycle} пропущен из-за ошибки соединения.`,
  });

  await chrome.tabs.update(run.tabId, { url: forcedResumeUrl });
};

const isRetryableProxyError = (errorText) => {
  const normalizedError = String(errorText || "").toUpperCase();
  return PROXY_FAILOVER_ERRORS.some((code) => normalizedError.includes(code));
};

const isSkippableProxyError = (errorText) => {
  const normalizedError = String(errorText || "").toUpperCase();
  return [
    "ERR_CERT_AUTHORITY_INVALID",
    "ERR_CERT_COMMON_NAME_INVALID",
    "ERR_CERT_DATE_INVALID",
    "ERR_SSL_PROTOCOL_ERROR",
    "ERR_SSL_VERSION_OR_CIPHER_MISMATCH",
    "PRIVACY/ERROR PAGE",
  ].some((code) => normalizedError.includes(code));
};

const getRetryUrlForRun = (run, failedUrl = "") => {
  const candidates = [
    failedUrl,
    run.lastRequestedUrl,
    run.lastProductUrl,
    run.listingUrl,
    run.startUrl,
    run.loginUrl,
  ];

  for (const candidate of candidates) {
    const normalized = normalizeOptionalUrl(candidate);

    if (isHttpUrl(normalized)) {
      return normalized;
    }
  }

  return "";
};

const shouldRecoverNativeErrorPage = (run, tabUrl = "", pendingUrl = "") => {
  const candidates = [
    String(tabUrl || "").trim(),
    String(pendingUrl || "").trim(),
    String(run?.lastRequestedUrl || "").trim(),
    String(run?.lastProductUrl || "").trim(),
    String(run?.listingUrl || "").trim(),
    String(run?.startUrl || "").trim(),
  ].filter(Boolean);

  return candidates.some((value) => isOzonTab(value));
};

const isKnownBrokenPageTitle = (title = "") => {
  const normalizedTitle = String(title || "").trim().toLowerCase();

  if (!normalizedTitle) {
    return false;
  }

  return ERROR_PAGE_TITLE_FRAGMENTS.some((fragment) => normalizedTitle.includes(fragment));
};

const getProxyStatus = async (config) => {
  const fullSummary = getProxyConfigSummary(config);
  const {
    proxies,
    error,
    rawProxyCount,
    filteredOutCount,
    checkedProxyCount,
    uncheckedCount,
    prepared,
  } = getActiveProxyConfigSummary(config);
  const storedState = await loadStoredProxyState();

  if (!proxies.length) {
    if (error) {
      if (storedState) {
        await clearProxySettings();
      }

      return {
        ok: true,
        hasProxies: false,
        enabled: false,
        message: error,
      };
    }

    if (storedState) {
      return clearProxySettings();
    }

    return buildProxyStatusPayload(null, 0);
  }

  if (!storedState) {
    const idlePayload = buildProxyStatusPayload(null, proxies.length);

    if (prepared) {
      idlePayload.message = uncheckedCount > 0
        ? `Быстрая проверка: найдено ${proxies.length} рабочих proxy после проверки ${checkedProxyCount} из ${rawProxyCount}. Остальные proxy будут проверяться только по мере необходимости.`
        : `Проверка завершена: найдено ${proxies.length} рабочих proxy из ${rawProxyCount}.`;
    }

    return idlePayload;
  }

  const clampedIndex = Math.min(Math.max(storedState.index || 0, 0), proxies.length - 1);
  const fullIndex = Math.max(getStoredProxyIndex(fullSummary.proxies, storedState), 0);
  const proxy = fullSummary.proxies[fullIndex] || proxies[clampedIndex];

  const statusPayload = buildProxyStatusPayload({
    ...storedState,
    index: fullIndex,
    label: proxy.label,
    scheme: proxy.scheme,
    host: proxy.host,
    port: proxy.port,
  }, fullSummary.proxies.length || proxies.length);

  if (prepared) {
    statusPayload.message = uncheckedCount > 0
      ? `${statusPayload.message}. Уже проверено ${checkedProxyCount} из ${rawProxyCount}, отсеяно ${filteredOutCount}. Остальные proxy будут подхватываться только если текущие закончатся или умрут.`
      : filteredOutCount > 0
        ? `${statusPayload.message}. Отфильтровано ${filteredOutCount} нерабочих proxy.`
        : `${statusPayload.message}. Список уже проверен.`;
  }

  return statusPayload;
};

const loadRuntimeConfig = async () => {
  if (runtimeConfigPromise) {
    return runtimeConfigPromise;
  }

  runtimeConfigPromise = fetch(chrome.runtime.getURL("user-config.json"), {
    cache: "no-store",
  })
    .then(async (response) => {
      if (!response.ok) {
        return {};
      }

      const parsedConfig = await response.json();
      return parsedConfig && typeof parsedConfig === "object" ? parsedConfig : {};
    })
    .catch(() => ({}))
    .finally(() => {
      runtimeConfigPromise = null;
    });

  return runtimeConfigPromise;
};

chrome.webRequest.onAuthRequired.addListener(
  async (details, callback) => {
    try {
      if (!details.isProxy) {
        callback({});
        return;
      }

      const proxyState = await loadStoredProxyState();

      if (!proxyState?.username) {
        callback({});
        return;
      }

      const challengerHost = String(details.challenger?.host || "").trim().toLowerCase();
      const challengerPort = Number.parseInt(String(details.challenger?.port || ""), 10);

      if (
        challengerHost
        && challengerHost !== String(proxyState.host || "").trim().toLowerCase()
      ) {
        callback({});
        return;
      }

      if (!Number.isNaN(challengerPort) && proxyState.port && challengerPort !== proxyState.port) {
        callback({});
        return;
      }

      callback({
        authCredentials: {
          username: proxyState.username,
          password: proxyState.password || "",
        },
      });
    } catch (error) {
      callback({});
    }
  },
  { urls: ["<all_urls>"] },
  ["asyncBlocking"],
);

const buildDefaultLoginUrl = () => "https://www.ozon.ru/my/login";

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

const normalizeSearchTerms = (values) => (
  Array.isArray(values)
    ? values.map((value) => String(value || "").trim()).filter(Boolean)
    : []
);

const getCycleSearchTerm = (run, cycleNumber = 1) => {
  const searchTerms = normalizeSearchTerms(run?.searchTerms);

  if (!searchTerms.length) {
    return String(run?.brand || "").trim();
  }

  const safeCycleNumber = Math.max(1, Number.parseInt(String(cycleNumber || 1), 10) || 1);
  return searchTerms[(safeCycleNumber - 1) % searchTerms.length] || "";
};

const getCycleSearchTermIndex = (run, cycleNumber = 1) => {
  const searchTerms = normalizeSearchTerms(run?.searchTerms);

  if (!searchTerms.length) {
    return 0;
  }

  const safeCycleNumber = Math.max(1, Number.parseInt(String(cycleNumber || 1), 10) || 1);
  return (safeCycleNumber - 1) % searchTerms.length;
};

const createRunMetrics = () => ({
  searchSubmissions: 0,
  brandFilterApplied: 0,
  productOpenSignals: 0,
  productVisits: 0,
  backNavigations: 0,
  proxyRotations: 0,
  proxyRecoveries: 0,
  proxyFallbackCycles: 0,
  failedCycles: 0,
  totalProductHoldMs: 0,
});

const buildSearchPhaseCommand = (run, pageUrl, delayMs = 0) => {
  const nextCycle = run.completedCycles + 1;
  const searchTerm = getCycleSearchTerm(run, nextCycle);
  const searchTermIndex = getCycleSearchTermIndex(run, nextCycle);

  updateRun(run, {
    cycleSkipInFlight: false,
    currentCycle: nextCycle,
    currentSearchTerm: searchTerm,
    listingUrl: pageUrl || run.listingUrl,
    pendingProxyRotation: false,
    phase: "opening",
    step: delayMs > 0
      ? `Жду ${formatDuration(delayMs)} перед циклом ${nextCycle} из ${run.cycles}.`
      : searchTerm
        ? `Ищу товар по запросу "${searchTerm}": цикл ${nextCycle} из ${run.cycles}.`
        : `Ищу товар: цикл ${nextCycle} из ${run.cycles}.`,
    message: `Выполнено ${run.completedCycles} из ${run.cycles}.`,
  });

  return {
    ok: true,
    action: "openProduct",
    runId: run.runId,
    brand: run.brand,
    brandFilter: run.brandFilter,
    searchTerm,
    searchTermIndex,
    searchTerms: normalizeSearchTerms(run.searchTerms),
    article: run.article,
    currentCycle: run.currentCycle,
    cycles: run.cycles,
    delayMs,
  };
};

const rememberRunState = (run) => {
  lastRunStates.set(run.tabId, {
    ...buildRunSnapshot(run),
    updatedAt: Date.now(),
  });
};

const transferRunToTab = (run, nextTab) => {
  if (!run || !nextTab?.id || run.tabId === nextTab.id) {
    return run;
  }

  activeRuns.delete(run.tabId);
  lastRunStates.delete(run.tabId);

  run.tabId = nextTab.id;
  run.windowId = nextTab.windowId ?? run.windowId;

  if (nextTab.url && isOzonTab(nextTab.url)) {
    if (run.phase === "login" || run.phase === "loginReturn") {
      run.loginUrl = nextTab.url;
    }

    if (run.phase !== "product") {
      run.startUrl = run.startUrl || nextTab.url;
    }
  }

  activeRuns.set(run.tabId, run);
  rememberRunState(run);
  return run;
};

const maybeAdoptRunForTab = (tab, pageType) => {
  if (!tab?.id || activeRuns.has(tab.id) || !isOzonTab(tab.url)) {
    return null;
  }

  const candidateRuns = Array.from(activeRuns.values()).filter((run) => (
    run.windowId === tab.windowId
    && (
      (run.phase === "login" && (Date.now() - run.loginStartedAt) <= LOGIN_TAB_ADOPT_WINDOW_MS)
      || (run.phase === "logout" && run.logoutStartedAt && (Date.now() - run.logoutStartedAt) <= LOGOUT_TIMEOUT_MS)
    )
  ));

  if (candidateRuns.length !== 1) {
    return null;
  }

  const [run] = candidateRuns;

  if (run.phase === "login" && pageType !== "login" && !isLoginUrl(tab.url)) {
    return null;
  }

  if (run.phase === "logout" && !isLogoutFlowUrl(tab.url) && !isLoginUrl(tab.url)) {
    return null;
  }

  return transferRunToTab(run, tab);
};

const updateRun = (run, patch) => {
  Object.assign(run, patch);
  rememberRunState(run);
};

const clearProxyRecoveryWatchdog = (run) => {
  if (!run?.proxyRecoveryWatchdogId) {
    return;
  }

  clearTimeout(run.proxyRecoveryWatchdogId);
  run.proxyRecoveryWatchdogId = 0;
};

const scheduleProxyRecoveryWatchdog = (run, retryUrl) => {
  clearProxyRecoveryWatchdog(run);

  const runId = run.runId;
  const targetUrl = String(retryUrl || "");

  run.proxyRecoveryWatchdogId = setTimeout(() => {
    const currentRun = activeRuns.get(run.tabId);

    if (!currentRun || currentRun.runId !== runId) {
      return;
    }

    if (targetUrl && currentRun.lastRequestedUrl && currentRun.lastRequestedUrl !== targetUrl) {
      return;
    }

    recoverRunAfterProxyFailure(
      currentRun.tabId,
      targetUrl || currentRun.lastRequestedUrl || currentRun.startUrl || "",
      "Proxy watchdog timeout",
    ).catch(() => {});
  }, PROXY_RECOVERY_WATCHDOG_MS);
};

const clearProxyIfNoActiveRuns = async () => {
  if (activeRuns.size > 0) {
    return;
  }

  try {
    await clearProxySettings();
  } catch (error) {
    // Ignore cleanup failures so finished runs do not flip back to error state.
  }
};

const finishRun = (run, status, message) => {
  clearProxyRecoveryWatchdog(run);
  const finishedAt = Date.now();
  updateRun(run, {
    status,
    finishedAt,
    step: message,
    message,
    metrics: {
      ...run.metrics,
      failedCycles: (run.metrics?.failedCycles || 0) + (status === "error" ? 1 : 0),
    },
  });

  activeRuns.delete(run.tabId);
  clearProxyIfNoActiveRuns().catch(() => {});
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

const getStartTab = async () => {
  const tabs = await getWindowTabs();
  const activeTab = tabs.find((tab) => tab.active);

  if (activeTab && isOzonTab(activeTab.url)) {
    return activeTab;
  }

  const resultsTab = tabs.find((tab) => isOzonResultsUrl(tab.url));

  if (resultsTab) {
    return resultsTab;
  }

  return tabs.find((tab) => isOzonTab(tab.url)) || null;
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
    return true;
  } catch (error) {
    return false;
  }
};

const startRun = async (_loginUrl, _phones, searchTermsInput, brandFilterInput, article, cycles, durationMs) => {
  const tab = await getStartTab();

  if (!tab?.id) {
    throw new Error("Сначала откройте любую страницу Ozon в текущем окне.");
  }

  const loginEnabled = false;
  const effectiveCycles = cycles;
  const searchTerms = normalizeSearchTerms(searchTermsInput);
  const primarySearchTerm = searchTerms[0] || "";
  const brandFilter = String(brandFilterInput || "").trim();

  cancelRunByTabId(tab.id, "Предыдущий запуск заменен новым.");

  const run = {
    runId: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    tabId: tab.id,
    windowId: tab.windowId,
    loginEnabled,
    logoutAfterRun: false,
    loginUrl: "",
    phone: "",
    accountPhones: [],
    currentAccountIndex: 0,
    loginStartedAt: 0,
    loginPageVisited: false,
    loginNavigationRequestedAt: 0,
    lastLoginSubmitAt: 0,
    loginSubmitAttempts: 0,
    logoutStartedAt: 0,
    logoutAttempts: 0,
    brand: primarySearchTerm,
    brandFilter,
    searchTerms,
    article,
    startedAt: Date.now(),
    finishedAt: 0,
    startUrl: tab.url || "",
    listingUrl: tab.url || "",
    cycles: effectiveCycles,
    durationMs,
    cycleIntervalMs: calculateCycleIntervalMs(durationMs, effectiveCycles),
    completedCycles: 0,
    currentCycle: 1,
    nextCycleDelayMs: 0,
    pendingProxyRotation: true,
    phase: "search",
    status: "running",
    currentSearchTerm: getCycleSearchTerm({ brand: primarySearchTerm, searchTerms }, 1),
    step: primarySearchTerm
      ? `Ищу товар по запросу "${primarySearchTerm}": цикл 1 из ${effectiveCycles}.`
      : `Ищу товар: цикл 1 из ${effectiveCycles}.`,
    message: `Выполнено 0 из ${effectiveCycles}. Интервал между циклами: ${formatDuration(calculateCycleIntervalMs(durationMs, effectiveCycles))}.`,
    lastRequestedUrl: tab.url || "",
    lastProductUrl: "",
    proxyFailureCount: 0,
    lastProxyFailureAt: 0,
    proxyRecoveryInFlight: false,
    proxyRecoveryWatchdogId: 0,
    cycleSkipInFlight: false,
    proxyCycleMessage: "",
    lastKnownProxyIp: "",
    proxyBypassedForRun: false,
    productPageEnteredAt: 0,
    metrics: createRunMetrics(),
  };

  activeRuns.set(tab.id, run);
  rememberRunState(run);
  await chrome.tabs.update(tab.id, { active: true });

  await wakeTab(tab.id);

  return {
    ok: true,
    running: true,
    message: searchTerms.length > 1
      ? `Запущено ${effectiveCycles} цикл(ов) для артикула ${article} с ${searchTerms.length} поисковыми названиями по очереди${brandFilter ? ` и брендом "${brandFilter}"` : ""}.`
      : primarySearchTerm
        ? `Запущено ${effectiveCycles} цикл(ов) для запроса "${primarySearchTerm}" и артикула ${article}${brandFilter ? ` с брендом "${brandFilter}"` : ""} на ${formatDuration(durationMs)}.`
        : `Запущено ${effectiveCycles} цикл(ов) для артикула ${article}${brandFilter ? ` с брендом "${brandFilter}"` : ""} на ${formatDuration(durationMs)}.`,
  };
};

const getRunStatus = async () => {
  if (startupPreparationState?.running) {
    return {
      ...startupPreparationState,
    };
  }

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
  if (startupPreparationState?.running) {
    startupPreparationState = {
      ...startupPreparationState,
      cancelled: true,
      message: "Останавливаю подготовку proxy...",
      step: "Подготовка proxy остановлена пользователем.",
    };

    return {
      ok: true,
      message: "Подготовка proxy остановлена.",
    };
  }

  const tab = await getStatusTab();

  if (!tab?.id) {
    await clearProxyIfNoActiveRuns();
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

const recoverRunAfterProxyFailure = async (tabId, failedUrl, errorText) => {
  const run = activeRuns.get(tabId);

  if (!run) {
    return;
  }

  const now = Date.now();

  if (run.proxyRecoveryInFlight) {
    return;
  }

  if (run.lastProxyFailureAt && (now - run.lastProxyFailureAt) < PROXY_FAILOVER_COOLDOWN_MS) {
    return;
  }

  updateRun(run, {
    proxyRecoveryInFlight: true,
    lastProxyFailureAt: now,
    step: "Proxy не отвечает, быстро переключаюсь на следующий...",
    message: "Текущий proxy не сработал. Пробую следующий из списка.",
  });

  try {
    const config = await loadRuntimeConfig();
    const proxySummary = getProxyConfigSummary(config);
    const proxies = proxySummary.proxies;

    if (!proxies.length) {
      throw new Error("Proxy список пуст. Добавьте рабочие proxy или отключите proxy режим.");
    }

    const nextFailureCount = (run.proxyFailureCount || 0) + 1;
    const maxRecoveryAttempts = proxies.length <= 1
      ? SINGLE_PROXY_RECOVERY_ATTEMPTS
      : Math.max(proxies.length * 2, 3);

    const retryUrl = getRetryUrlForRun(run, failedUrl);

    if (!retryUrl) {
      throw new Error("Не удалось определить адрес для повторной попытки после смены proxy.");
    }

    if (nextFailureCount > maxRecoveryAttempts) {
      await continueRunWithoutProxy(
        run,
        retryUrl,
        "Proxy слишком часто срывает загрузку, поэтому продолжаю текущий запуск без proxy.",
      );
      return;
    }

    const failedProxyState = await loadStoredProxyState();

    if (failedProxyState && proxies.length > 1) {
      removeProxyFromPreparedPool(failedProxyState);
    }

    const proxyStatus = await rotateProxyFromConfig(config, {
      allowUnchecked: true,
      sessionId: buildProxySessionId(`${run.currentCycle}-retry-${nextFailureCount}`),
    });

    updateRun(run, {
      proxyFailureCount: nextFailureCount,
      pendingProxyRotation: false,
      proxyRecoveryInFlight: false,
      lastRequestedUrl: retryUrl,
      step: `Proxy упал, переключаюсь и повторяю попытку ${nextFailureCount}...`,
      message: proxyStatus?.message || "Proxy переключен. Повторяю открытие страницы.",
      metrics: {
        ...run.metrics,
        proxyRecoveries: (run.metrics?.proxyRecoveries || 0) + 1,
      },
    });

    scheduleProxyRecoveryWatchdog(run, retryUrl);
    await chrome.tabs.update(tabId, { url: buildForcedRunNavigationUrl(retryUrl) || retryUrl });
  } catch (error) {
    const retryUrl = getRetryUrlForRun(run, failedUrl);

    if (retryUrl) {
      await continueRunWithoutProxy(
        run,
        retryUrl,
        error.message || "Не удалось быстро переключить proxy после ошибки соединения. Продолжаю без proxy.",
      );
      return;
    }

    finishRun(
      run,
      "error",
      error.message || "Не удалось быстро переключить proxy после ошибки соединения.",
    );
  } finally {
    const currentRun = activeRuns.get(tabId);

    if (currentRun) {
      updateRun(currentRun, {
        proxyRecoveryInFlight: false,
      });
    }
  }
};

const getRunCommand = async (tabId, pageType, pageUrl, loginState = "other") => {
  const run = activeRuns.get(tabId);

  if (!run) {
    return {
      ok: true,
      action: "idle",
    };
  }

  if (run.phase === "login") {
    if (Date.now() - run.loginStartedAt > LOGIN_TIMEOUT_MS) {
      finishRun(run, "error", "Автоматический вход не завершился вовремя. Проверьте страницу входа и данные.");
      return {
        ok: true,
        action: "stop",
      };
    }

    if (pageType === "login") {
      if (loginState === "code" || loginState === "password") {
        updateRun(run, {
          loginPageVisited: true,
          loginNavigationRequestedAt: 0,
          step: "Жду завершения входа...",
          message: loginState === "code"
            ? "Код уже запрошен. Если Ozon попросит подтверждение, завершите вход вручную."
            : "Форма входа изменилась. Если Ozon просит пароль или подтверждение, завершите вход вручную.",
        });

        return {
          ok: true,
          action: "wait",
          runId: run.runId,
          pollAfterMs: 1500,
        };
      }

      if (run.lastLoginSubmitAt) {
        const elapsedSinceSubmit = Date.now() - run.lastLoginSubmitAt;

        if (elapsedSinceSubmit < LOGIN_RETRY_WAIT_MS) {
          updateRun(run, {
            loginPageVisited: true,
            loginNavigationRequestedAt: 0,
            step: "Проверяю переход после нажатия Войти...",
            message: "Страница входа еще открыта, жду реакцию Ozon.",
          });

          return {
            ok: true,
            action: "wait",
            runId: run.runId,
            pollAfterMs: 1500,
          };
        }

        updateRun(run, {
          loginPageVisited: true,
          loginNavigationRequestedAt: 0,
          step: "Повторно нажимаю Войти...",
          message: "Страница входа все еще открыта, повторяю отправку номера телефона.",
        });

        return {
          ok: true,
          action: "performLogin",
          runId: run.runId,
          accountIndex: run.currentAccountIndex || 0,
          phone: run.phone,
          attempt: run.loginSubmitAttempts + 1,
        };
      }

      updateRun(run, {
        loginPageVisited: true,
        loginNavigationRequestedAt: 0,
        step: "Заполняю номер телефона на странице Ozon.",
        message: "Номер телефона будет введен автоматически.",
      });

      return {
        ok: true,
        action: "performLogin",
        runId: run.runId,
        accountIndex: run.currentAccountIndex || 0,
        phone: run.phone,
        attempt: run.loginSubmitAttempts + 1,
      };
    }

    if (!run.loginPageVisited) {
      const waitingForLoginPage = run.loginNavigationRequestedAt
        && (Date.now() - run.loginNavigationRequestedAt) < LOGIN_NAVIGATION_WAIT_MS;

      if (waitingForLoginPage) {
        updateRun(run, {
          step: "Жду открытия страницы входа...",
          message: "Страница входа уже открывается, жду завершения перехода.",
        });

        return {
          ok: true,
          action: "wait",
          runId: run.runId,
          pollAfterMs: 1500,
        };
      }

      updateRun(run, {
        loginNavigationRequestedAt: Date.now(),
        step: "Открываю страницу входа...",
        message: "Перехожу на страницу входа Ozon перед запуском поиска.",
      });

      return {
        ok: true,
        action: "openLogin",
        runId: run.runId,
        loginUrl: run.loginUrl,
      };
    }

    if (pageUrl && pageUrl !== run.listingUrl) {
      updateRun(run, {
        phase: "loginReturn",
        step: "Возвращаюсь на страницу выдачи после входа.",
        message: "Вход выполнен, возвращаюсь к поисковой выдаче.",
      });

      return {
        ok: true,
        action: "returnToListing",
        runId: run.runId,
        returnUrl: run.listingUrl,
      };
    }

    updateRun(run, {
      phase: "search",
      step: `Ищу товар: цикл ${run.completedCycles + 1} из ${run.cycles}.`,
      message: `Выполнено ${run.completedCycles} из ${run.cycles}.`,
    });
  }

  if (run.phase === "loginReturn") {
    if (pageUrl && pageUrl !== run.listingUrl) {
      return {
        ok: true,
        action: "returnToListing",
        runId: run.runId,
        returnUrl: run.listingUrl,
      };
    }

    updateRun(run, {
      phase: "search",
      step: `Ищу товар: цикл ${run.completedCycles + 1} из ${run.cycles}.`,
      message: `Выполнено ${run.completedCycles} из ${run.cycles}.`,
    });
  }

  if (run.phase === "logout") {
    if (run.logoutStartedAt && (Date.now() - run.logoutStartedAt) > LOGOUT_TIMEOUT_MS) {
      finishRun(run, "error", "Автоматический выход из аккаунта не завершился вовремя.");
      return {
        ok: true,
        action: "stop",
      };
    }

    if (isLoggedOutPage(pageType, pageUrl, loginState)) {
      const nextAccountIndex = (run.currentAccountIndex || 0) + 1;

      if (nextAccountIndex < (run.accountPhones?.length || 0)) {
        updateRun(run, {
          completedCycles: Math.max(run.completedCycles || 0, nextAccountIndex),
          currentCycle: nextAccountIndex + 1,
          currentAccountIndex: nextAccountIndex,
          phone: run.accountPhones[nextAccountIndex],
          phase: "login",
          loginStartedAt: Date.now(),
          loginPageVisited: pageType === "login",
          loginNavigationRequestedAt: 0,
          lastLoginSubmitAt: 0,
          loginSubmitAttempts: 0,
          logoutStartedAt: 0,
          logoutAttempts: 0,
          step: `Перехожу к аккаунту ${nextAccountIndex + 1} из ${run.accountPhones.length}.`,
          message: `Выполнено ${nextAccountIndex} из ${run.accountPhones.length}. Теперь вхожу в аккаунт ${nextAccountIndex + 1} из ${run.accountPhones.length}.`,
        });

        return getRunCommand(tabId, pageType, pageUrl, loginState);
      }

      const finishedCycles = Math.max(run.completedCycles || 0, 1);
      finishRun(
        run,
        "completed",
        run.accountPhones?.length > 1
          ? `Готово. Все ${run.accountPhones.length} аккаунта(ов) последовательно выполнили вход, открытие товара и выход из аккаунта.`
          : `Готово. Открыт товар, выполнено ${finishedCycles} цикл(ов), затем выполнен выход из аккаунта.`,
      );
      return {
        ok: true,
        action: "finish",
      };
    }

    updateRun(run, {
      logoutAttempts: (run.logoutAttempts || 0) + 1,
      step: "Выхожу из аккаунта...",
      message: "Циклы завершены, выполняю выход из аккаунта Ozon.",
    });

    return {
      ok: true,
      action: "logout",
      runId: run.runId,
      attempt: run.logoutAttempts,
      pollAfterMs: 1500,
    };
  }

  if ((run.phase === "search" || run.phase === "opening") && pageType === "search") {
    if (run.pendingProxyRotation) {
      try {
        await rotateProxyForRun(run);
      } catch (error) {
        finishRun(run, "error", error.message || "Не удалось переключить proxy перед новым циклом.");
        return {
          ok: true,
          action: "stop",
        };
      }
    }

    const delayMs = run.nextCycleDelayMs || 0;
    return buildSearchPhaseCommand(run, pageUrl, delayMs);
  }

  if (pageType === "product") {
    const hasRecordedProductVisit = run.phase === "product" && run.productPageEnteredAt;

    if (!hasRecordedProductVisit) {
      updateRun(run, {
        productPageEnteredAt: Date.now(),
        metrics: {
          ...run.metrics,
          productVisits: (run.metrics?.productVisits || 0) + 1,
        },
      });
    }

    if (run.logoutAfterRun) {
        updateRun(run, {
          completedCycles: Math.max(run.completedCycles, run.currentCycle),
          phase: "logout",
          logoutStartedAt: run.logoutStartedAt || Date.now(),
          logoutAttempts: 1,
          step: "Товар открыт, выхожу из аккаунта...",
          message: "Товар уже открыт, теперь выполняю выход из аккаунта Ozon.",
        });

        return {
          ok: true,
          action: "logout",
          runId: run.runId,
          attempt: 1,
        };
      }

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

      if (run.logoutAfterRun) {
        updateRun(run, {
          phase: "logout",
          logoutStartedAt: Date.now(),
          step: "Подготавливаю выход из аккаунта...",
          message: "Циклы завершены, сейчас выполню выход из аккаунта Ozon.",
        });

        return {
          ok: true,
          action: "logout",
          runId: run.runId,
        };
      }

      finishRun(
        run,
        "completed",
        `Готово. Выполнено ${run.cycles} циклов за ${formatDuration(getRunElapsedMs(run))}.`,
      );
      return {
        ok: true,
        action: "finish",
      };
    }

    updateRun(run, {
      completedCycles,
      currentCycle: completedCycles + 1,
      pendingProxyRotation: true,
      phase: "search",
      nextCycleDelayMs: 0,
      proxyFailureCount: 0,
      proxyBypassedForRun: false,
      step: `Ищу товар: цикл ${completedCycles + 1} из ${run.cycles}.`,
      message: `Выполнено ${completedCycles} из ${run.cycles}.`,
    });

    try {
      await rotateProxyForRun(run);
    } catch (error) {
      finishRun(run, "error", error.message || "Не удалось переключить proxy перед новым циклом.");
      return {
        ok: true,
        action: "stop",
      };
    }

    return buildSearchPhaseCommand(run, pageUrl, RETURN_PAGE_SETTLE_MS);
  }

  return {
    ok: true,
    action: "wait",
    runId: run.runId,
    pollAfterMs: run.phase === "login" || run.phase === "loginReturn" || run.phase === "logout" ? 1500 : 0,
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
    phase: "opening",
    step: `Открываю товар: цикл ${run.currentCycle} из ${run.cycles}.`,
    message: `Выполнено ${run.completedCycles} из ${run.cycles}.`,
    lastProductUrl: productUrl,
    lastRequestedUrl: productUrl,
    nextCycleDelayMs: 0,
    metrics: {
      ...run.metrics,
      productOpenSignals: (run.metrics?.productOpenSignals || 0) + 1,
    },
  });

  return {
    ok: true,
  };
};

const markLoginSubmitted = (tabId, runId) => {
  const run = activeRuns.get(tabId);

  if (!run || run.runId !== runId) {
    return {
      ok: false,
      error: "Запуск уже неактивен.",
    };
  }

  updateRun(run, {
    lastLoginSubmitAt: Date.now(),
    loginSubmitAttempts: (run.loginSubmitAttempts || 0) + 1,
    step: "Форма входа отправлена.",
    message: "Жду завершения авторизации.",
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
    metrics: {
      ...run.metrics,
      backNavigations: (run.metrics?.backNavigations || 0) + 1,
      totalProductHoldMs: (run.metrics?.totalProductHoldMs || 0) + Math.max(
        0,
        Date.now() - (run.productPageEnteredAt || Date.now()),
      ),
    },
    productPageEnteredAt: 0,
  });

  return {
    ok: true,
  };
};

const markSearchSubmitted = (tabId, runId) => {
  const run = activeRuns.get(tabId);

  if (!run || run.runId !== runId) {
    return {
      ok: false,
      error: "Запуск уже неактивен.",
    };
  }

  updateRun(run, {
    metrics: {
      ...run.metrics,
      searchSubmissions: (run.metrics?.searchSubmissions || 0) + 1,
    },
  });

  return {
    ok: true,
  };
};

const markBrandFilterApplied = (tabId, runId) => {
  const run = activeRuns.get(tabId);

  if (!run || run.runId !== runId) {
    return {
      ok: false,
      error: "Запуск уже неактивен.",
    };
  }

  updateRun(run, {
    metrics: {
      ...run.metrics,
      brandFilterApplied: (run.metrics?.brandFilterApplied || 0) + 1,
    },
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

const navigateRunTab = async (tabId, runId, nextUrl) => {
  const run = activeRuns.get(tabId);

  if (!run || run.runId !== runId) {
    return {
      ok: false,
      error: "Запуск уже неактивен.",
    };
  }

  const normalizedUrl = normalizeOptionalUrl(nextUrl);
  const forcedUrl = buildForcedRunNavigationUrl(normalizedUrl) || normalizedUrl;

  if (!normalizedUrl || !isOzonTab(normalizedUrl)) {
    return {
      ok: false,
      error: "Не удалось определить корректную страницу Ozon для перехода.",
    };
  }

  updateRun(run, {
    lastRequestedUrl: forcedUrl,
  });

  await chrome.tabs.update(tabId, { url: forcedUrl });

  return {
    ok: true,
  };
};

chrome.tabs.onRemoved.addListener((tabId) => {
  cancelRunByTabId(tabId, "Вкладка была закрыта.");
  lastRunStates.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") {
    return;
  }

  const tabUrl = String(changeInfo.url || tab?.url || "");
  const pendingUrl = String(tab?.pendingUrl || "");
  const tabTitle = String(tab?.title || "");
  const run = activeRuns.get(tabId);

  if (!run) {
    if (!isLoginUrl(tabUrl) && !isLogoutFlowUrl(tabUrl)) {
      return;
    }

    chrome.tabs.get(tabId)
      .then((tab) => {
        const adoptedRun = maybeAdoptRunForTab(
          tab,
          isLoginUrl(tab.url) ? "login" : "other",
        );

        if (adoptedRun) {
          wakeTab(adoptedRun.tabId).catch(() => {});
        }
      })
      .catch(() => {});
    return;
  }

  Promise.resolve()
    .then(async () => {
      if (isKnownBrokenPageTitle(tabTitle) && shouldRecoverNativeErrorPage(run, tabUrl, pendingUrl)) {
        await skipCurrentCycleAfterConnectionError(
          run,
          `Обнаружена страница ошибки "${tabTitle}". Пропускаю текущий цикл и перехожу к следующему proxy.`,
        );
        return;
      }

      const wokeUp = await wakeTab(tabId);

      if (!wokeUp && shouldRecoverNativeErrorPage(run, tabUrl, pendingUrl)) {
        await skipCurrentCycleAfterConnectionError(
          run,
          "Chrome открыл страницу ошибки конфиденциальности. Пропускаю текущий цикл и перехожу к следующему proxy.",
        );
        return;
      }

      clearProxyRecoveryWatchdog(run);
      updateRun(run, {
        proxyFailureCount: 0,
        proxyRecoveryInFlight: false,
        lastProxyFailureAt: 0,
        lastRequestedUrl: tabUrl || run.lastRequestedUrl,
      });
    })
    .catch(() => {});
});

chrome.webRequest.onErrorOccurred.addListener((details) => {
  if (details.tabId < 0 || details.type !== "main_frame") {
    return;
  }

  const run = activeRuns.get(details.tabId);

  if (!run || !isRetryableProxyError(details.error)) {
    return;
  }

  if (isSkippableProxyError(details.error)) {
    skipCurrentCycleAfterConnectionError(
      run,
      `Chrome получил ${details.error}. Пропускаю текущий цикл и перехожу к следующему proxy.`,
    ).catch(() => {});
    return;
  }

  recoverRunAfterProxyFailure(details.tabId, details.url, details.error).catch(() => {});
}, { urls: ["<all_urls>"] });

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "START_OZON_CYCLES") {
    loadRuntimeConfig()
      .then((config) => {
        const brand = String(message.brand || "").trim();
        const searchTerms = normalizeSearchTerms(message.searchTerms);
        const brandFilter = String(message.brandFilter || "").trim();
        const article = String(message.article || "").trim();
        const cycles = Math.max(1, Number.parseInt(String(message.cycles || "1"), 10) || 1);
        const durationMs = parseDurationMs(message.durationMs);
        const proxySummary = getProxyConfigSummary(config);

        if (!article) {
          sendResponse({
            ok: false,
            error: "Артикул пустой.",
          });
          return;
        }

        if (!proxySummary.proxies.length && proxySummary.error) {
          sendResponse({
            ok: false,
            error: proxySummary.error,
          });
          return;
        }

        clearStartupPreparationState();

        startRun("", [], searchTerms.length ? searchTerms : [brand], brandFilter, article, cycles, durationMs)
          .then((result) => {
            clearStartupPreparationState();
            sendResponse(result);
          })
          .catch((error) => {
            clearStartupPreparationState();
            sendResponse({
              ok: false,
              error: error.message || "Не удалось запустить циклы.",
            });
          });
      })
      .catch((error) => {
        clearStartupPreparationState();
        sendResponse({
          ok: false,
          error: error.message || "Не удалось прочитать user-config.json.",
        });
      });

    return true;
  }

  if (message?.type === "GET_OZON_PROXY_STATUS") {
    loadRuntimeConfig()
      .then((config) => getProxyStatus(config))
      .then(sendResponse)
      .catch((error) => {
        sendResponse({
          ok: false,
          message: error.message || "Не удалось получить статус proxy.",
        });
      });

    return true;
  }

  if (message?.type === "ROTATE_OZON_PROXY") {
    loadRuntimeConfig()
      .then((config) => rotateProxyFromConfig(config, {
        sessionId: buildProxySessionId("manual"),
      }))
      .then(sendResponse)
      .catch((error) => {
        sendResponse({
          ok: false,
          message: error.message || "Не удалось переключить proxy.",
        });
      });

    return true;
  }

  if (message?.type === "CLEAR_OZON_PROXY") {
    clearProxySettings()
      .then((result) => {
        sendResponse({
          ...result,
          message: "Proxy отключен. Браузер снова работает без proxy.",
        });
      })
      .catch((error) => {
        sendResponse({
          ok: false,
          message: error.message || "Не удалось отключить proxy.",
        });
      });

    return true;
  }

  if (message?.type === "OZON_PROXY_PAGE_FAILED") {
    const tabId = sender.tab?.id;

    if (!tabId) {
      sendResponse({
        ok: false,
        message: "Не удалось определить вкладку для смены proxy.",
      });
      return false;
    }

    Promise.resolve()
      .then(async () => {
        const run = activeRuns.get(tabId);

        if (!run) {
          throw new Error("Запуск уже неактивен.");
        }

        await skipCurrentCycleAfterConnectionError(
          run,
          String(message.errorText || "Ozon page reported no connection"),
        );
      })
      .then(() => {
        sendResponse({
          ok: true,
          message: "Страница без соединения замечена. Пропускаю текущий цикл и перехожу к следующему.",
        });
      })
      .catch((error) => {
        sendResponse({
          ok: false,
          message: error.message || "Не удалось пропустить цикл после ошибки страницы.",
        });
      });

    return true;
  }

  if (message?.type === "OZON_SKIP_CYCLE") {
    const tabId = sender.tab?.id;

    if (!tabId) {
      sendResponse({
        ok: false,
        message: "Не удалось определить вкладку для пропуска цикла.",
      });
      return false;
    }

    Promise.resolve()
      .then(async () => {
        const run = activeRuns.get(tabId);

        if (!run) {
          throw new Error("Запуск уже неактивен.");
        }

        await skipCurrentCycleAfterConnectionError(
          run,
          String(message.reason || "Текущий цикл пропущен из-за ошибки страницы."),
        );
      })
      .then(() => {
        sendResponse({
          ok: true,
          message: "Текущий цикл пропущен. Перехожу к следующему proxy.",
        });
      })
      .catch((error) => {
        sendResponse({
          ok: false,
          message: error.message || "Не удалось пропустить цикл.",
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
    const senderTab = sender.tab;
    const tabId = senderTab?.id;

    if (!tabId) {
      sendResponse({
        ok: false,
        action: "idle",
        error: "Не удалось определить вкладку.",
      });
      return false;
    }

    maybeAdoptRunForTab(senderTab, message.pageType);

    Promise.resolve(getRunCommand(
      tabId,
      message.pageType,
      String(message.pageUrl || ""),
      String(message.loginState || "other"),
    ))
      .then(sendResponse)
      .catch((error) => {
        sendResponse({
          ok: false,
          action: "stop",
          error: error.message || "Не удалось получить следующую команду цикла.",
        });
      });
    return true;
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

  if (message?.type === "OZON_LOGIN_SUBMITTED") {
    const tabId = sender.tab?.id;

    if (!tabId) {
      sendResponse({
        ok: false,
        error: "Не удалось определить вкладку.",
      });
      return false;
    }

    sendResponse(markLoginSubmitted(tabId, message.runId));
    return false;
  }

  if (message?.type === "OZON_SEARCH_SUBMITTED") {
    const tabId = sender.tab?.id;

    if (!tabId) {
      sendResponse({
        ok: false,
        error: "Не удалось определить вкладку.",
      });
      return false;
    }

    sendResponse(markSearchSubmitted(tabId, message.runId));
    return false;
  }

  if (message?.type === "OZON_BRAND_FILTER_APPLIED") {
    const tabId = sender.tab?.id;

    if (!tabId) {
      sendResponse({
        ok: false,
        error: "Не удалось определить вкладку.",
      });
      return false;
    }

    sendResponse(markBrandFilterApplied(tabId, message.runId));
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

  if (message?.type === "OZON_NAVIGATE_TAB") {
    const tabId = sender.tab?.id;

    if (!tabId) {
      sendResponse({
        ok: false,
        error: "Не удалось определить вкладку.",
      });
      return false;
    }

    navigateRunTab(tabId, message.runId, message.url)
      .then(sendResponse)
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error.message || "Не удалось выполнить переход во вкладке.",
        });
      });
    return true;
  }

  return false;
});
