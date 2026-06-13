const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const puppeteer = require("puppeteer");

const host = "127.0.0.1";
const port = Number(process.env.PORT) || 3000;
const rootDir = __dirname;

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
};

const normalizeSiteUrl = (value) => {
  const trimmed = value.trim();
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return new URL(withProtocol).origin;
};

const buildSearchUrl = (siteUrl, searchText) => {
  const searchUrl = new URL("/search/", siteUrl);
  searchUrl.searchParams.set("text", searchText);
  return searchUrl.toString();
};

const resolveProduct = async (siteUrl, searchText, article) => {
  const browser = await puppeteer.launch({
    headless: false,
    channel: "chrome",
    defaultViewport: { width: 1440, height: 1100 },
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--lang=ru-RU",
    ],
  });

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(30000);
    const searchUrl = buildSearchUrl(siteUrl, searchText);

    await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36");
    await page.setExtraHTTPHeaders({
      "accept-language": "ru,en;q=0.9",
    });
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", {
        get: () => false,
      });
    });

    const response = await page.goto(searchUrl, { waitUntil: "domcontentloaded" });
    const title = await page.title();
    const finalUrl = page.url();

    if (!response || !response.ok()) {
      if (response && response.status() === 403) {
        throw new Error("Ozon блокирует автоматический поиск через браузерную автоматизацию (Antibot/403).");
      }
      throw new Error("Не удалось открыть страницу поиска.");
    }

    if (/antibot/i.test(title) || /__rr=1/.test(finalUrl)) {
      throw new Error("Ozon блокирует автоматический поиск через браузерную автоматизацию (Antibot Challenge).");
    }

    await page.waitForSelector('a[href*="/product/"]', { timeout: 30000 });

    const productUrl = await page.$$eval(
      'a[href*="/product/"]',
      (links, articleValue) => {
        const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();

        for (const link of links) {
          const href = link.getAttribute("href") || "";
          const text = normalize(link.textContent);
          const cardText = normalize(link.closest("article, div, li")?.textContent || "");

          if (href.includes(articleValue) || text.includes(articleValue) || cardText.includes(articleValue)) {
            return link.href;
          }
        }

        return null;
      },
      article,
    );

    if (!productUrl) {
      throw new Error("Товар с указанным артикулом не найден в результатах поиска.");
    }

    return { url: productUrl, matchType: "product" };
  } finally {
    await browser.close();
  }
};

const resolvePath = (requestUrl) => {
  const requestPath = requestUrl === "/" ? "/index.html" : requestUrl;
  const filePath = path.normalize(path.join(rootDir, requestPath));

  if (!filePath.startsWith(rootDir)) {
    return null;
  }

  return filePath;
};

const server = http.createServer((request, response) => {
  try {
    const requestUrl = new URL(request.url, `http://${host}:${port}`);

    if (requestUrl.pathname === "/resolve-product") {
      const site = requestUrl.searchParams.get("site");
      const searchText = requestUrl.searchParams.get("searchText");
      const article = requestUrl.searchParams.get("article");

      if (!site || !searchText || !article) {
        response.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: "Нужны сайт, текст поиска и артикул." }));
        return;
      }

      let siteUrl;
      try {
        siteUrl = normalizeSiteUrl(site);
      } catch (error) {
        response.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: "Некорректный адрес сайта." }));
        return;
      }

      resolveProduct(siteUrl, searchText, article)
        .then((result) => {
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(JSON.stringify(result));
        })
        .catch((error) => {
          const message = error.message || "Не удалось найти товар на сайте.";
          const statusCode = /Antibot|403|блокирует/i.test(message) ? 409 : 502;
          response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
          response.end(JSON.stringify({
            error: message,
            canOpenSearch: statusCode === 409,
            searchUrl: statusCode === 409 ? buildSearchUrl(siteUrl, searchText) : undefined,
          }));
        });
      return;
    }

    const filePath = resolvePath(request.url);

    if (!filePath) {
      response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Forbidden");
      return;
    }

    fs.readFile(filePath, (error, data) => {
      if (error) {
        const statusCode = error.code === "ENOENT" ? 404 : 500;
        response.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
        response.end(statusCode === 404 ? "Not found" : "Server error");
        return;
      }

      const extension = path.extname(filePath).toLowerCase();
      const contentType = contentTypes[extension] || "application/octet-stream";
      response.writeHead(200, { "Content-Type": contentType });
      response.end(data);
    });
  } catch (error) {
    response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: error.message || "Внутренняя ошибка сервера." }));
  }
});

server.listen(port, host, () => {
  console.log(`WebNavigator is running at http://${host}:${port}`);
});
