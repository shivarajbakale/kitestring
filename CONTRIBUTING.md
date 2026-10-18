# Contributing to Kitestring

Thanks for helping. This page covers setup, the test gate every change must pass, and how commits are written.

## Setup

You need macOS or Linux, Node 22.12 or newer, pnpm 12 (`npm i -g pnpm`; the exact version is pinned in
`package.json`), and Google Chrome or Chromium.

```sh
pnpm install
pnpm build
pnpm --filter @kitestring/e2e exec playwright install chromium   # once, for the browser tests
```

To try your build in your own Chrome, load `packages/extension/build/chrome-mv3-prod` unpacked and run
`node packages/cli/dist/bin.js init` (see the [Quickstart](README.md#quickstart)). The test suites never touch your
Chrome profile or `~/.kitestring`.

## The test gate

Every change must pass, locally, before it is merged:

```sh
pnpm build && pnpm test && pnpm -r typecheck && pnpm test:e2e
```

- `pnpm test` runs the unit tests (protocol, CLI and host, extension, torture server), the page-agent browser tests
  and the store packaging tests.
- `pnpm test:e2e` launches Playwright's Chromium with the built extension and drives it through the real `kite`
  CLI against the torture site (`apps/torture`). CI does not run it (it needs Chromium with the extension loaded
  and a native host), so run it yourself.
- A bug fix comes with a test that fails without it. A new edge case usually means a new torture page
  (`apps/torture/pages/`, listed in `apps/torture/expected.md`) and an e2e test.
- If you change the popup, the side panel or `apps/torture/pages/showcase-listing.html`, refresh the images with
  `KITE_UPDATE_DOCS=1 pnpm test:e2e` and look at them before committing.

Never run `scripts/agent-smoke.sh` in CI: it drives a real agent and spends credits.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): summary`, in the imperative or as a
plain statement of the new behaviour, lower case, no trailing period.

- Types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`, `chore`.
- Scopes are the area touched: `extension`, `cli`, `mcp`, `batch`, `memory`, `record`, `cache`, `page-agent`,
  `torture`, `e2e`, `store`, `brand`.
- One logical change per commit. Examples from the history:
  - `fix(batch): risk-check a press of Enter against the form it would submit`
  - `feat(mcp): plan ids from browser_plan_find; secrets for browser_plan_run`
  - `docs: cache claims match R3`

## Pull requests

Fill in the pull request template. Keep the safety model intact: risky halts, the Pause switch, per-session tab
ownership and the recorded-tab block. Kitestring must never store typed values, and the extension must never send
anything off the computer. If your change alters what Kitestring can read or store, update `store/privacy.md` and
`SECURITY.md` in the same pull request.

By contributing you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
