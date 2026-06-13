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
- The Chrome extension can now spread the requested cycle count evenly across any selected total duration from 30 minutes up to 10 hours in 30-minute steps.

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
5. Open an Ozon search results or category listing page manually in Chrome
6. Click the extension icon
7. Optionally enter a brand such as `Apple`, `Xiaomi`, or `LG`
8. Enter the article
9. Optionally enter a cycle count such as `10`
10. Select the total duration in 30-minute steps from `30 минут` up to `10:00`
11. Check the helper text that shows the calculated interval for one cycle
12. Click `Запустить циклы`
13. Use `Стоп` if you want to cancel the active run immediately

The extension looks for an open Ozon results or category listing tab in the current Chrome window, switches to it, optionally enters the brand into the Ozon search box once, then finds the matching article in those results. If the product is not visible in the first screenful, the extension scrolls down through the listing until it finds the matching card, opens the product in the same tab, detects the product page correctly, returns to the original listing or results page for the next cycle, and repeats this full open/back cycle exactly for the number of cycles you set.

When you also choose a total duration, the extension divides that time across the cycle count and uses the result as the product-page dwell time for each cycle. For example, `100` cycles over `30 минут` keeps each product page open for about `18 секунд`, then returns to the original listing and opens the product again. Because navigation itself also takes time, the full run can last a bit longer than the exact selected duration.

The popup now shows live run progress, lets you stop the current run manually, and runs the cycle flow with a same-tab state machine so the next cycle resumes only after the previous back navigation returns to the search page.

If you reload the extension while an Ozon results tab is already open, the helper now reinjects its content script automatically when you start a run.

## Project files

- `index.html` contains the browser UI structure.
- `styles.css` contains the page styling and responsive layout.
- `app.js` contains the navigation logic for the browser version.
- `server.js` serves the static web app locally with Node.js.
- `script.js` keeps the original CLI version.
