## What and why

<!-- What this changes, and the problem it solves. Link the issue if there is one. -->

## How it was tested

<!-- Commands you ran and what you checked by hand. -->

- [ ] `pnpm build && pnpm test && pnpm -r typecheck && pnpm test:e2e` passes locally
- [ ] New behaviour has a test (unit, page-agent or e2e)
- [ ] If the UI or the demo page changed: images refreshed with `KITE_UPDATE_DOCS=1 pnpm test:e2e` and checked by eye

## Safety and privacy

- [ ] This does not let agents do more without asking (risky halts, pause, session ownership, recorded-tab block)
- [ ] This stores no typed values, secrets or file paths, and the extension still sends nothing anywhere
- [ ] Docs (README, docs/reference.md, store/privacy.md) match the code after this change
