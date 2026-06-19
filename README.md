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
7. Enter one or more search names for the product
8. Enter the article
9. Optionally enter a cycle count such as `10`
10. Click `Запустить циклы`
11. Use `Стоп` if you want to cancel the active run immediately

The extension now starts from the currently active Ozon tab, not only from an existing search results page. It remembers that start URL for the whole run, uses the Ozon search field when needed, scrolls until it finds the matching article, opens the matching product in the same tab, waits briefly on the product page, goes back to the saved results page, and repeats that simple cycle until the requested number of passes is completed. The temporary login, account switching, and logout flow is currently disabled, so the popup works only with search names, article, and cycle count.

The temporary simplified mode does not require `user-config.json` for starting runs. Just reload the extension in `chrome://extensions`, open Ozon, enter one or more search names, enter the article, set the cycle count, and click `Запустить циклы`.

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

If your source is a plain text list with one proxy URL per line such as `http://1.2.3.4:8080` or `socks5://1.2.3.4:1080`, first convert each line into a proxy object inside `proxies`. The extension does not read newline-separated proxy URL strings directly.

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
16. During a running cycle, the popup now shows a per-cycle proxy log that reports whether the request was sent through the proxy and whether the detected exit IP changed or stayed the same.
17. Search-result detection now waits a bit longer after submitting the query so Ozon product cards have time to render before the extension decides that the article is missing.
18. For proxy usernames that contain sticky session markers such as `;anon.1`, the extension now rewrites that session marker on every cycle so providers that support session-based rotation can issue a fresh exit IP more often.
19. After each proxy rotation, the extension now waits briefly and re-checks the detected exit IP a few times before reporting `IP не сменился`, so slow gateway updates are less likely to produce a false warning.
20. When only one rotating gateway is configured, proxy recovery no longer throws that gateway away immediately and now retries it with fresh sessions several times before declaring that no working proxy was found.
21. If proxy recovery still keeps failing during a cycle, the extension now falls back only for that current cycle without a proxy, then tries proxy rotation again on the next cycle instead of stopping the whole run.
22. Returning from the product page to the listing page is now intentionally a bit slower, and the next cycle waits briefly after the return so Ozon has time to stabilize before the next search starts.
23. Each new cycle now tries proxy rotation from the full configured proxy list again, even if the temporary runtime pool previously became empty, so a configured proxy is less likely to stay silently disabled across later cycles.
24. The popup no longer replaces the previous proxy result with a temporary `Проверяю, сменился ли IP...` state on every cycle; it now waits and updates the proxy line only when the actual IP result is ready.
25. The popup now supports adding multiple search names for the same article with a `+` button, and the extension uses those names one by one across cycles: search, open product, go back, then move to the next name on the next cycle.
26. The popup now also has a separate optional brand field; when you fill it, the extension tries to use Ozon’s brand filter in the left sidebar before matching the article so the correct product is easier to find.
27. The overall cycle pacing is now intentionally slower and more stable: the extension stays longer on the product page, waits longer after returning to results, and now prefers waiting for search/filter/result readiness signals instead of relying only on short fixed sleeps.
28. The popup now shows lightweight run metrics such as search submissions, product opens, product visits, back navigations, proxy recoveries/fallbacks, failed cycles, and average time spent on the product page.
29. If the article is not found for the current search name, the extension now retries that same search once and then tries the next configured search names within the same cycle before marking the cycle as failed.
30. The final completed-run summary now reports the real elapsed run time instead of echoing the optional configured duration value, so finished runs no longer show misleading text such as `за 0 мс`.
31. When a brand filter is configured, the extension now treats it as mandatory: it re-checks the sidebar filter state before matching the article, retries the brand click if needed, waits for the filtered results to react, and stops with an explicit error if the brand could not be selected.
32. After a brand filter is successfully selected, the extension now restarts the same cycle step once on the settled filtered page before trying to open the product, so brand selection and product opening no longer compete in the same unstable DOM update window.
33. Within the same cycle, a freshly accepted brand filter is skipped only on the immediate follow-up pass, so the extension can move on to product matching instead of looping on the brand step.
34. That one-pass brand-follow-up state is also persisted in the tab session, so a same-tab Ozon refresh right after brand selection does not make the extension forget that it should continue to the product step.
35. Product scanning now resets the page viewport back to the top of the results before searching for the article, so a previous brand/filter scroll position does not trap the run in lower recommendation blocks.
36. Before applying the requested brand, the extension now clears obviously wrong preselected brand chips and uses a stricter exact-brand option match so it does not accidentally accumulate unrelated brands in the Ozon sidebar.
37. Brand matching now targets precise option rows and, if needed, scrolls the brand-filter area itself to find the requested brand instead of guessing from broad container text around the sidebar.
38. The popup temporarily no longer exposes a brand-filter field, so current runs always work without sidebar brand filtering while the core search-and-open flow is stabilized.
39. If Ozon opens its own `Похоже, нет соединения` page during a run, the extension now skips that broken current cycle, returns to a safe Ozon page, and starts the next cycle instead of looping on the same dead page.
40. Temporary proxy disable/fallback during a bad cycle no longer resets the rotation cursor: the next cycle continues from the next proxy in `user-config.json`, and after the last proxy it wraps back to the first one.
41. Chrome native privacy/certificate interstitials such as `NET::ERR_CERT_AUTHORITY_INVALID` are now also treated as bad proxy pages, so the extension rotates away instead of freezing on the warning screen.
42. Search-step problems that only break the current pass, such as `Артикул ... не найден среди текущих результатов` on a bad proxy page, now skip only that cycle and continue with the next proxy instead of stopping the whole run.
43. If the browser tab title itself changes to known broken pages such as `Похоже, нет соединения` or `Ошибка нарушения конфиденциальности`, the background worker now force-skips that cycle immediately instead of waiting for the page script to recover.

## Project files

- `index.html` contains the browser UI structure.
- `styles.css` contains the page styling and responsive layout.
- `app.js` contains the navigation logic for the browser version.
- `server.js` serves the static web app locally with Node.js.
- `script.js` keeps the original CLI version.
