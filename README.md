# WebNavigator

WebNavigator is now a small browser-based app that simulates web navigation history with stack logic. You can visit a page label or URL, move backward, move forward, and reset the navigation state from a visual interface.

## Features

- Visit a new page or URL from the input field.
- Enter a site address, a search text, and a product article in three separate fields.
- Choose any positive number of automatic visit cycles using the cycle count field under the input.
- Keep the entered URL in the input after visiting so you can retry quickly.
- Show a visual loading/progress panel that increments after every completed cycle.
- Move backward through the back stack.
- Move forward through the forward stack.
- Use the simplified interface without the lower current-page/history summary section.
- Open real URLs in one temporary tab, run the requested number of cycles automatically, then close that tab while keeping the WebNavigator home page open.
- The visible web interface text is now in Russian.
- For OZON-like flows, the local server uses Puppeteer with a real Chrome window to open the site's search results for the provided text, scan product results for the requested article, and open that exact product automatically.
- If OZON blocks automation with an antibot page, the app now shows that explicitly and offers a manual fallback button that opens the search in the same browser tab.
- Includes a configurable Puppeteer production test that types into a search field, waits for results, finds a matching ID, and clicks the matching result.
- Includes a Chrome extension that can run directly on an already-open Ozon results or category listing page, optionally search once by brand, and then click the product matching the article you provide.
- The Chrome extension now uses an ultra-fast built-in pacing by default, with almost no idle time between product open and return.
- The Chrome extension can now optionally apply a configured HTTP, HTTPS, SOCKS4, or SOCKS5 proxy before the cycle run starts.

## Run locally

1. Install dependencies:

```bash
npm install
```

2. Start the web app:

```bash
npm start
```

3. Open this address in your browser:

```text
http://127.0.0.1:3000
```

## Optional CLI mode

The original terminal version is still available:

```bash
npm run cli
```

## Production Puppeteer Test

Run the configurable production search test with environment variables:

```bash
APP_URL="https://your-production-app.example" \
SEARCH_SELECTOR='input[name="search"]' \
SEARCH_TEXT="your search text" \
RESULT_SELECTOR='[data-testid="search-result"]' \
TARGET_ID="4510869097" \
npm run test:prod-search
```

Optional variables:

- `RESULT_ID_SELECTOR` limits ID matching to a child element inside each result card.
- `SEARCH_SUBMIT_SELECTOR` clicks a specific search button instead of pressing `Enter`.
- `READY_SELECTOR` waits for a page element before starting the search.
- `HEADLESS=false` opens the browser visibly during the run.
- `TIMEOUT_MS=45000` overrides the default timeout.

The script is stored at [tests/prod-search-click.js](/Users/mac/Desktop/hh/WebNavigator/tests/prod-search-click.js).

## Chrome Extension

The extension files are stored in [chrome-extension](/Users/mac/Desktop/hh/WebNavigator/chrome-extension).

How to use it:

1. Open `chrome://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select `/Users/mac/Desktop/hh/WebNavigator/chrome-extension`
5. Open any Ozon page manually in Chrome
6. Click the extension icon
7. Optionally enter a brand such as `Apple`, `Xiaomi`, or `LG`
8. Enter the article
9. Optionally enter a cycle count such as `10`
10. Click `Запустить циклы`
11. Use `Стоп` if you want to cancel the active run immediately

The extension now starts from the currently active Ozon tab, not only from an existing search results page. It remembers that start URL for the whole run, uses the Ozon search field when needed, scrolls until it finds the matching article, opens the matching product in the same tab, waits briefly on the product page, goes back to the saved results page, and repeats that simple cycle until the requested number of passes is completed. The temporary login, account switching, and logout flow is currently disabled, so the popup works only with brand, article, and cycle count.

The temporary simplified mode does not require `user-config.json` for starting runs. Just reload the extension in `chrome://extensions`, open Ozon, enter the brand if needed, enter the article, set the cycle count, and click `Запустить циклы`.

The popup now shows live run progress, lets you stop the current run manually, and runs the cycle flow with a same-tab state machine so the next cycle resumes only after the previous back navigation returns to the search page.

If you reload the extension while an Ozon results tab is already open, the helper now reinjects its content script automatically when you start a run.

### Optional proxy configuration

If you want the extension to work through a proxy, add a proxy list to `/Users/mac/Desktop/hh/WebNavigator/chrome-extension/user-config.json` and then reload the extension in `chrome://extensions`.

Example:

```json
{
  "proxies": [
    {
      "label": "RU proxy 1",
      "scheme": "http",
      "host": "123.123.123.123",
      "port": 8000,
      "username": "login",
      "password": "password"
    },
    {
      "label": "RU proxy 2",
      "scheme": "socks5",
      "host": "124.124.124.124",
      "port": 1080
    }
  ]
}
```

Supported keys for each proxy:

- `label` optional readable name shown in the popup
- `scheme` one of `http`, `https`, `socks4`, `socks5`
- `host` proxy host or IP
- `port` proxy port
- `username` optional proxy username
- `password` optional proxy password
- `bypassList` optional array of Chrome proxy bypass patterns

You can use either of these formats:

1. Object with `proxies`:

```json
{
  "proxies": [
    {
      "label": "RU proxy 1",
      "scheme": "http",
      "host": "123.123.123.123",
      "port": 8000
    }
  ]
}
```

2. Raw array copied directly from a free proxy list file such as `Free_Proxy_List.json`:

```json
[
  {
    "ip": "177.38.206.110",
    "port": "8080",
    "country": "BR",
    "protocols": ["socks4"]
  },
  {
    "ip": "119.3.188.87",
    "port": "1080",
    "country": "CN",
    "protocols": ["socks5"]
  }
]
```

If you already downloaded a large proxy dump, you can also replace the whole `/Users/mac/Desktop/hh/WebNavigator/chrome-extension/user-config.json` file with that raw JSON array directly.

Important:

- Files that look like this are not valid proxy lists for the extension:

```json
[
  {
    "vpn_servers": "public-vpn-43",
    "__0": "219.100.37.7",
    "__1": 2892468
  }
]
```

- That format is only a VPN/server statistics list. It does not include the required Chrome proxy fields such as `port` and `scheme` or `protocol`.
- For the extension to read proxies correctly, every record must contain at least:
  - `ip` or `host`
  - `port`
  - `scheme`, `protocol`, or `protocols`

How it works now:

1. When you press `Запустить циклы`, the extension first checks `user-config.json`.
2. Before every new cycle, it switches to the next proxy from the list automatically.
3. The `Сменить proxy` button in the popup also switches to the next proxy manually.
4. The `Отключить proxy` button in the popup clears the current Chrome proxy immediately if a free proxy is dead or stops opening websites.
5. If the current proxy returns browser errors such as `ERR_PROXY_CONNECTION_FAILED` or `ERR_SOCKS_CONNECTION_FAILED`, the extension now tries to rotate to the next proxy automatically and reload the same page without hanging on the dead proxy.
6. If Ozon itself opens its internal "нет соединения" page, the extension now also treats that as a dead proxy and keeps advancing through the proxy list until it finds a working one or exhausts the retry limit.
7. If Chrome opens its own native timeout page such as `ERR_TIMED_OUT`, the extension now keeps a short watchdog and automatically switches to the next proxy instead of freezing on that failed page.
8. If no proxies are configured, the extension runs normally without a proxy.
9. Before every new run, the extension now performs a fast batch preflight: it checks only a small chunk of proxies, keeps the first working ones, and starts the cycle process immediately instead of waiting for a full scan of the whole file.
10. If the first checked chunk contains no working proxy, the extension automatically jumps to the next chunk until it finds a working one or exhausts the list.
11. If a proxy dies later during the run, the extension removes that proxy from the current runtime pool and lazily checks the next unchecked proxies only when it needs a replacement, so the same dead proxy is not retried again in the same launch.
12. Manual proxy rotation now also stays inside the checked runtime pool, so the popup keeps cycling only through proxies that already passed the extension's quick health check.
13. Product opening is now forced into the current tab first, so the extension avoids opening a new tab and navigates straight to the product page as quickly as possible.
14. Run startup no longer blocks on proxy preflight: cycles start immediately after you press `Запустить циклы`, and the extension applies the first proxy during the live run instead of waiting for launch-time checks to finish.
15. Search scrolling, proxy switching, product opening, and the default per-cycle delay were reduced to a speed-first flow so large runs start and repeat as fast as possible.

## Project files

- `index.html` contains the browser UI structure.
- `styles.css` contains the page styling and responsive layout.
- `app.js` contains the navigation logic for the browser version.
- `server.js` serves the static web app locally with Node.js.
- `script.js` keeps the original CLI version.
