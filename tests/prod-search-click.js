const puppeteer = require("puppeteer");

const readConfig = () => {
  const config = {
    appUrl: process.env.APP_URL,
    searchSelector: process.env.SEARCH_SELECTOR,
    searchText: process.env.SEARCH_TEXT,
    resultSelector: process.env.RESULT_SELECTOR,
    targetId: process.env.TARGET_ID,
    resultIdSelector: process.env.RESULT_ID_SELECTOR || "",
    searchSubmitSelector: process.env.SEARCH_SUBMIT_SELECTOR || "",
    readySelector: process.env.READY_SELECTOR || "",
    timeoutMs: Number.parseInt(process.env.TIMEOUT_MS || "30000", 10),
    headless: process.env.HEADLESS !== "false",
  };

  const missing = Object.entries({
    APP_URL: config.appUrl,
    SEARCH_SELECTOR: config.searchSelector,
    SEARCH_TEXT: config.searchText,
    RESULT_SELECTOR: config.resultSelector,
    TARGET_ID: config.targetId,
  }).filter(([, value]) => !value);

  if (missing.length > 0) {
    const missingKeys = missing.map(([key]) => key).join(", ");
    throw new Error(`Missing required environment variables: ${missingKeys}`);
  }

  return config;
};

const normalizeText = (value) => String(value || "").replace(/\s+/g, " ").trim();

const waitForReadyState = async (page, config) => {
  if (config.readySelector) {
    await page.waitForSelector(config.readySelector, { timeout: config.timeoutMs });
  }
};

const submitSearch = async (page, config) => {
  await page.waitForSelector(config.searchSelector, { timeout: config.timeoutMs });
  await page.click(config.searchSelector, { clickCount: 3 });
  await page.type(config.searchSelector, config.searchText);

  if (config.searchSubmitSelector) {
    await page.click(config.searchSubmitSelector);
    return;
  }

  await page.keyboard.press("Enter");
};

const findMatchingResult = async (page, config) => {
  await page.waitForSelector(config.resultSelector, { timeout: config.timeoutMs });

  const result = await page.$$eval(
    config.resultSelector,
    (nodes, targetId, resultIdSelector) => {
      const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();

      for (const node of nodes) {
        const idSource = resultIdSelector
          ? node.querySelector(resultIdSelector)?.textContent
          : node.textContent;
        const normalizedIdSource = normalize(idSource);

        if (normalizedIdSource.includes(targetId)) {
          node.scrollIntoView({ block: "center", behavior: "instant" });
          node.setAttribute("data-codex-target-match", "true");
          return {
            matchedText: normalizedIdSource,
          };
        }
      }

      return null;
    },
    config.targetId,
    config.resultIdSelector,
  );

  if (!result) {
    return null;
  }

  const clickableHandle = await page.$(`${config.resultSelector}[data-codex-target-match="true"]`);

  return {
    clickableHandle,
    matchedText: result.matchedText,
  };
};

const run = async () => {
  const config = readConfig();
  const browser = await puppeteer.launch({
    headless: config.headless,
    defaultViewport: { width: 1440, height: 1000 },
  });

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(config.timeoutMs);

    await page.goto(config.appUrl, { waitUntil: "domcontentloaded" });
    await waitForReadyState(page, config);
    await submitSearch(page, config);

    const match = await findMatchingResult(page, config);

    if (!match || !match.clickableHandle) {
      throw new Error(`Result with target ID "${config.targetId}" was not found.`);
    }

    await match.clickableHandle.click();

    console.log(
      JSON.stringify(
        {
          status: "clicked",
          appUrl: config.appUrl,
          searchText: config.searchText,
          targetId: config.targetId,
          matchedText: normalizeText(match.matchedText),
        },
        null,
        2,
      ),
    );
  } finally {
    await browser.close();
  }
};

run().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
