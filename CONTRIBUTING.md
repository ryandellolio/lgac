# Contributing

Keep it small: plain ESM JavaScript, no build step, few dependencies.

- Reproduce in `--mock` first. `node bin/lgac.js --mock …` and `lgac tui --mock` run
  offline from `fixtures/sample.json`.
- Don't add API calls. LG rate-limits per user. See "API usage" in the README.
- New endpoints or payloads should cite the line in LG's
  [Python SDK](https://github.com/thinq-connect/pythinqconnect) they come from.
- Different LG model? Open an issue with `lgac status <unit> --profile` (capabilities only,
  no secrets).
- AI-assisted PRs are fine. Say so, and run `npm run check` plus a `--mock` TUI session.

```bash
npm install
npm run check        # offline smoke tests
npm run tui:dev      # node --watch src/tui.js --mock
```
