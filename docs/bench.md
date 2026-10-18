# Time-to-done benchmark

Date: 2026-10-18  
Machine: Apple M3 Pro, 12 cores, darwin 25.5.0 arm64  
Node: v26.0.0

Four torture-site tasks, each run four ways. Every mode is scripted: no model is called and nothing costs credits.
**Agent thinking time is not simulated.** The numbers are what Kitestring and Chrome spend; a real agent also spends model time on
every tool call, so the `tool calls` column is the lever that matters most in practice.

| Task | Mode | Wall ms | Browser ms | Tool calls | Cached |
| --- | --- | ---: | ---: | ---: | ---: |
| multi-page-checkout | 1 single actions | 3258 | 2650 | 6 | - |
| multi-page-checkout | 2 one batch per page | 3133 | 2913 | 2 | - |
| multi-page-checkout | 3 plan replay, cold cache | 2797 | 2711 | 1 | 0 |
| multi-page-checkout | 4 plan replay, warm cache | 2816 | 2724 | 1 | 6 |
| store-listing | 1 single actions | 6782 | 5051 | 16 | - |
| store-listing | 2 one batch per page | 5402 | 5289 | 1 | - |
| store-listing | 3 plan replay, cold cache | stopped | stopped | 1 | 0 |
| store-listing | 4 plan replay, warm cache | stopped | stopped | 1 | 5 |
| cookie-wall | 1 single actions | 1156 | 934 | 2 | - |
| cookie-wall | 2 one batch per page | 1084 | 958 | 1 | - |
| cookie-wall | 3 plan replay, cold cache | 1073 | 978 | 1 | 0 |
| cookie-wall | 4 plan replay, warm cache | 1072 | 977 | 1 | 2 |
| file-upload | 1 single actions | 1232 | 937 | 3 | - |
| file-upload | 2 one batch per page | 1050 | 946 | 1 | - |
| file-upload | 3 plan replay, cold cache | 1084 | 991 | 1 | 0 |
| file-upload | 4 plan replay, warm cache | 1824 | 1556 | 1 | 3 |

- store-listing, mode 3: the replay stopped at batch 1 step 6: not_found, no element matches "Privacy"
- store-listing, mode 4: the replay stopped at batch 1 step 6: not_found, no element matches "Privacy"

- Wall ms: median of 3 runs, measured around the `kite` processes (start-up included) and nothing else.
- Browser ms: mode 2 sums the steps' own `ms`; mode 1 sums the extension's activity-log `ms` for its calls. Modes 3-4 report the replay's own total (`ms` in `kite run --json`), which also includes its RPC round trips.
- Tool calls: what an agent would make. Mode 1 one per step, mode 2 one per page, modes 3-4 one `kite run`.
- Cached: steps the action cache served (modes 3-4; mode 3 starts cold, so only repeats within a run hit).
- `multi-page-checkout` ends on the review page, one click short of the risky "Place order"; the agent makes that click itself.
- Each repetition starts from a fresh page load and a cleared cache, except mode 4, which keeps the cache warmed by one untimed run.

Reproduce: `pnpm build && pnpm bench --write`.
