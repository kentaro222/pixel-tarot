# Browser regression checks

The application itself needs no package installation or build step. These optional
checks require Node.js, Playwright and Chromium. In the prepared Codex environment:

```sh
cd /workspace/pixel-tarot
node --test --test-timeout=60000 tests/pwa.test.cjs
```

The runner starts and closes its own local HTTP server and browser. It tests a
subdirectory deployment, service-worker caching and error responses, cache
migration, animation cancellation, accessibility, saved preferences, unavailable
local storage, all spreads, the gallery and offline use. It does not modify app
files. Each test uses an isolated browser context.

On another machine, install Playwright outside the checkout and point the runner
to that installation and a Chromium executable, for example:

```sh
npm install --prefix /tmp/pixel-tarot-test-tools --no-save --package-lock=false playwright
NODE_PATH=/tmp/pixel-tarot-test-tools/node_modules CHROMIUM_PATH=/path/to/chromium \
  node --test --test-timeout=60000 tests/pwa.test.cjs
```
