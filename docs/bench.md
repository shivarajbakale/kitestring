# Time-to-done benchmark

Date: 2026-10-18  
Machine: Apple M3 Pro, 12 cores, darwin 25.5.0 arm64  
Node: v26.0.0

Four torture-site tasks, each run four ways. Every mode is scripted: no model is called and nothing costs credits.
**Agent thinking time is not simulated.** The numbers are what Kitestring and Chrome spend; a real agent also spends model time on
every tool call, so the `tool calls` column is the lever that matters most in practice.

| Task | Mode | Wall ms | Browser ms | Tool calls | Cached |
| --- | --- | ---: | ---: | ---: | ---: |
| multi-page-checkout | 1 single actions | 3266 | 2658 | 6 | - |
| multi-page-checkout | 2 one batch per page | 2923 | 2706 | 2 | - |
| multi-page-checkout | 3 plan replay, cold cache | 2830 | 2750 | 1 | 0 |
| multi-page-checkout | 4 plan replay, warm cache | 3071 | 2981 | 1 | 6 |
| store-listing | 1 single actions | 6848 | 5052 | 16 | - |
| store-listing | 2 one batch per page | 5475 | 5356 | 1 | - |
| store-listing | 3 plan replay, cold cache | 5476 | 5388 | 1 | 0 |
| store-listing | 4 plan replay, warm cache | 5490 | 5400 | 1 | 16 |
| cookie-wall | 1 single actions | 1168 | 951 | 2 | - |
| cookie-wall | 2 one batch per page | 1078 | 962 | 1 | - |
| cookie-wall | 3 plan replay, cold cache | 1076 | 990 | 1 | 0 |
| cookie-wall | 4 plan replay, warm cache | 1080 | 990 | 1 | 2 |
| file-upload | 1 single actions | 1286 | 955 | 3 | - |
| file-upload | 2 one batch per page | 1108 | 988 | 1 | - |
| file-upload | 3 plan replay, cold cache | 1099 | 1011 | 1 | 0 |
| file-upload | 4 plan replay, warm cache | 1110 | 1021 | 1 | 3 |

- Wall ms: median of 3 runs, measured around the `kite` processes (start-up included) and nothing else.
- Browser ms: mode 2 sums the steps' own `ms`; mode 1 sums the extension's activity-log `ms` for its calls. Modes 3-4 report the replay's own total (`ms` in `kite run --json`), which also includes its RPC round trips.
- Tool calls: what an agent would make. Mode 1 one per step, mode 2 one per page, modes 3-4 one `kite run`.
- Cached: steps the action cache served (modes 3-4; mode 3 starts cold, so only repeats within a run hit).
- `multi-page-checkout` ends on the review page, one click short of the risky "Place order"; the agent makes that click itself.
- Each repetition starts from a fresh page load and a cleared cache, except mode 4, which keeps the cache warmed by one untimed run.

What the numbers show:

- The action cache does not save time: the full in-page search runs either way, and the cache only records which element
  matched (`cached: true`). So a warm cache (mode 4) is within noise of a cold one (mode 3).
- The real gain is the tool-call column. Each tool call is an agent turn (model time, tokens, latency) that this bench does not
  simulate: 16 calls become 1 on store-listing, 6 become 1 on multi-page-checkout.
- Mode 1 also pays one `kite` process start per call, which is part of why mode 2 beats it.

Reproduce: `pnpm build && pnpm bench --write`.
