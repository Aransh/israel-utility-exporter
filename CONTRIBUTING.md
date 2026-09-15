# Contributing

## Before opening a pull request

```bash
npm install
npm run lint
npm run build
npm test
```

All three should pass. Tests stub `globalThis.fetch` with fake portal/IEC
servers, so no real credentials are needed to run them.

## Every PR should include

- **A version bump** in `package.json` (and `package-lock.json`, which stays
  in sync automatically if you bump with `npm version <version>
  --no-git-tag-version` rather than editing it by hand) — following [Semantic
  Versioning](https://semver.org/spec/v2.0.0.html). Bugfix → patch, new
  metric/feature → minor, breaking change (a renamed or removed metric,
  config variable, etc.) → major.
- **A [`CHANGELOG.md`](CHANGELOG.md) entry** for the change, under a new `##
  [x.y.z] - YYYY-MM-DD` heading (see the existing entries for the expected
  level of detail — the *why*, not just the *what*). This becomes the release
  notes verbatim, so write it for someone deciding whether to upgrade.

Publishing the actual release (tagging, building and pushing the Docker
image) is a separate, maintainer-only step — not something a PR needs to
trigger or wait on.
