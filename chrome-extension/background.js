const activeRuns = new Map();
const lastRunStates = new Map();
const DEFAULT_DURATION_MS = 0;
const GO_BACK_DELAY_MS = 40;
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
const PROXY_PREFLIGHT_MIN_WORKING = 1;
const PROXY_PREFLIGHT_MAX_START_CHECKS = 12;
const PROXY_PREFLIGHT_MAX_RECOVERY_CHECKS = 18;
const PROXY_PREFLIGHT_TEST_URLS = ["https://www.ozon.ru/"];
const PROXY_FAILOVER_ERRORS = [
  "ERR_PROXY_CONNECTION_FAILED",
  "ERR_SOCKS_CONNECTION_FAILED",
  "ERR_TUNNEL_CONNECTION_FAILED",
  "ERR_CONNECTION_TIMED_OUT",
  "ERR_TIMED_OUT",
  "ERR_ADDRESS_UNREACHABLE",
  "ERR_CONNECTION_CLOSED",
  "ERR_CONNECTION_RESET",
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
  accountCount: run.accountPhones?.length || 0,
  currentAccountIndex: run.currentAccountIndex || 0,
  step: run.step,
  message: run.message,
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

const applyProxySettings = async (proxy, index, total) => {
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
    username: proxy.username,
    password: proxy.password,
    bypassList: proxy.bypassList,
  };

  await saveProxyState(proxyState);
  return buildProxyStatusPayload(proxyState, total);
};

const clearProxySettings = async () => {
  await callChromeApi((done) => {
    chrome.proxy.settings.clear({ scope: "regular" }, done);
  });

  await clearStoredProxyState();
  return buildProxyStatusPayload(null, 0);
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

  return applyProxySettings(proxies[nextIndex], nextIndex, proxies.length);
};

const rotateProxyForRun = async (run) => {
  if (!run?.pendingProxyRotation) {
    return null;
  }

  const config = await loadRuntimeConfig();
  const proxies = getActiveProxyConfigSummary(config).proxies;

  if (!proxies.length) {
    updateRun(run, {
      pendingProxyRotation: false,
    });
    return null;
  }

  const proxyStatus = await rotateProxyFromConfig(config, {
    allowUnchecked: true,
  });
  updateRun(run, {
    pendingProxyRotation: false,
    message: proxyStatus?.message || run.message,
  });
  return proxyStatus;
};

const isRetryableProxyError = (errorText) => {
  const normalizedError = String(errorText || "").toUpperCase();
  return PROXY_FAILOVER_ERRORS.some((code) => normalizedError.includes(code));
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

const getProxyStatus = async (config) => {
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
  const proxy = proxies[clampedIndex];

  const statusPayload = buildProxyStatusPayload({
    ...storedState,
    index: clampedIndex,
    label: proxy.label,
    scheme: proxy.scheme,
    host: proxy.host,
    port: proxy.port,
  }, proxies.length);

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
    .catch(() => ({}));

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

const buildSearchPhaseCommand = (run, pageUrl, delayMs = 0) => {
  updateRun(run, {
    currentCycle: run.completedCycles + 1,
    listingUrl: pageUrl || run.listingUrl,
    pendingProxyRotation: false,
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
  updateRun(run, {
    status,
    step: message,
    message,
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

const startRun = async (_loginUrl, _phones, brand, article, cycles, durationMs) => {
  const tab = await getStartTab();

  if (!tab?.id) {
    throw new Error("Сначала откройте любую страницу Ozon в текущем окне.");
  }

  const loginEnabled = false;
  const effectiveCycles = cycles;

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
    brand,
    article,
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
    step: `Ищу товар: цикл 1 из ${effectiveCycles}.`,
    message: `Выполнено 0 из ${effectiveCycles}. Интервал между циклами: ${formatDuration(calculateCycleIntervalMs(durationMs, effectiveCycles))}.`,
    lastRequestedUrl: tab.url || "",
    lastProductUrl: "",
    proxyFailureCount: 0,
    lastProxyFailureAt: 0,
    proxyRecoveryInFlight: false,
    proxyRecoveryWatchdogId: 0,
  };

  activeRuns.set(tab.id, run);
  rememberRunState(run);
  await chrome.tabs.update(tab.id, { active: true });

  await wakeTab(tab.id);

  return {
    ok: true,
    running: true,
    message: brand
      ? `Запущено ${effectiveCycles} цикл(ов) для бренда ${brand} и артикула ${article} на ${formatDuration(durationMs)}.`
      : `Запущено ${effectiveCycles} цикл(ов) для артикула ${article} на ${formatDuration(durationMs)}.`,
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
    const maxRecoveryAttempts = Math.max(proxies.length * 2, 3);

    if (nextFailureCount > maxRecoveryAttempts) {
      throw new Error("Не удалось найти рабочий proxy. Расширение перебрало слишком много вариантов.");
    }

    const retryUrl = getRetryUrlForRun(run, failedUrl);

    if (!retryUrl) {
      throw new Error("Не удалось определить адрес для повторной попытки после смены proxy.");
    }

    const failedProxyState = await loadStoredProxyState();

    if (failedProxyState) {
      removeProxyFromPreparedPool(failedProxyState);
    }

    const proxyStatus = await rotateProxyFromConfig(config, {
      allowUnchecked: true,
    });

    updateRun(run, {
      proxyFailureCount: nextFailureCount,
      pendingProxyRotation: false,
      proxyRecoveryInFlight: false,
      lastRequestedUrl: retryUrl,
      step: `Proxy упал, переключаюсь и повторяю попытку ${nextFailureCount}...`,
      message: proxyStatus?.message || "Proxy переключен. Повторяю открытие страницы.",
    });

    scheduleProxyRecoveryWatchdog(run, retryUrl);
    await chrome.tabs.update(tabId, { url: retryUrl });
  } catch (error) {
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

      finishRun(run, "completed", `Готово. Выполнено ${run.cycles} циклов за ${formatDuration(run.durationMs)}.`);
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

    return buildSearchPhaseCommand(run, pageUrl, 0);
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

  if (!normalizedUrl || !isOzonTab(normalizedUrl)) {
    return {
      ok: false,
      error: "Не удалось определить корректную страницу Ozon для перехода.",
    };
  }

  updateRun(run, {
    lastRequestedUrl: normalizedUrl,
  });

  await chrome.tabs.update(tabId, { url: normalizedUrl });

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
      const wokeUp = await wakeTab(tabId);

      if (!wokeUp && isOzonTab(tabUrl)) {
        await recoverRunAfterProxyFailure(
          tabId,
          tabUrl,
          "Loaded native browser error page after proxy switch.",
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

  recoverRunAfterProxyFailure(details.tabId, details.url, details.error).catch(() => {});
}, { urls: ["<all_urls>"] });

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "START_OZON_CYCLES") {
    loadRuntimeConfig()
      .then((config) => {
        const brand = String(message.brand || "").trim();
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

        startRun("", [], brand, article, cycles, durationMs)
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
      .then((config) => rotateProxyFromConfig(config))
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

    recoverRunAfterProxyFailure(
      tabId,
      String(message.pageUrl || sender.tab?.url || ""),
      String(message.errorText || "Ozon page reported no connection"),
    )
      .then(() => {
        sendResponse({
          ok: true,
          message: "Proxy ошибка на странице замечена. Переключаюсь на следующий proxy.",
        });
      })
      .catch((error) => {
        sendResponse({
          ok: false,
          message: error.message || "Не удалось переключить proxy после ошибки страницы.",
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
