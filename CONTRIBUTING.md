# Contributing

## Commit conventions

This repository follows [Conventional Commits](https://www.conventionalcommits.org/).
Commit messages are **English only**, imperative mood ("add", not "added"/"adds").

### Format

```
<type>(<scope>): <subject>

[optional body]

[optional footer(s)]
```

- **type** (mandatory) — see the table below.
- **scope** (optional) — a module/area, e.g. `socks5`, `exit`, `dht`, `docs`, `ci`.
- **subject** — imperative, no trailing dot, ≤ 50 chars, lowercase after the first word
  unless it is a proper noun or code identifier.
- **body** (optional) — what and why, wrapped at 72 chars.
- **footers** (optional) — `Closes #123`, `Refs #45`, `BREAKING CHANGE: ...`
  (a breaking change can also be marked with `!` before the colon).

### Types

| Type | When to use |
|---|---|
| `feat` | a new feature (normally a MINOR change when released) |
| `fix` | a bug fix (normally a PATCH change when released) |
| `docs` | documentation only |
| `style` | formatting, whitespace — no logic change |
| `refactor` | a code change that neither fixes nor adds behavior |
| `perf` | a performance improvement |
| `test` | adding/fixing tests |
| `build` | build system or dependency changes |
| `ci` | CI configuration and scripts |
| `chore` | maintenance, no src/docs changes |
| `revert` | reverting a previous commit |

### Breaking changes

Either add `!` before the colon — `feat(tunnel)!: switch framing` — or add a footer:

```
BREAKING CHANGE: the wire prefix changed from oflx-* to mgt-*, PSK derivation changed
```

### Rules

1. One logical change per commit; do not mix unrelated changes.
2. Never commit secrets, credentials, keys, or the `key/` directory.
3. Commit messages in English only (a `commit-msg` hook enforces this).
4. Prefer `git commit` with the template: `git config commit.template .gitmessage` is set for
   this repo.
5. Commits must pass validation (`core.hooksPath .githooks` is set; the hook checks the type,
   the subject length and rejects non-ASCII subjects).

### Examples

```
feat(socks5): add UDP ASSOCIATE support

Implements SOCKS5 UDP gateway so QUIC-capable browsers work through the
tunnel. Domain CONNECT requests are unchanged.

Closes #12
```

```
fix(dht): persist seq across restarts

Nodes reject a mutable put whose seq is not monotonically increasing,
so the exit now reads the last value from MAGNETGATE_SEQ_FILE and
increments it on every publish.
```

```
docs: translate testing guide to english
```

## Local setup after cloning

```bash
git config commit.template .gitmessage
git config core.hooksPath .githooks
npm ci
npm test   # Node core, security, consistency and local integration tests
```

## Components and validation

Use Node.js 20.19+ for the root package, or 22.12+ when also developing the desktop app.
Run commands from the repository root unless shown otherwise.

```powershell
npm ci
npm test
npm --prefix app ci
npm --prefix app test
```

Desktop tests that exercise sing-box need the pinned files described in [app/README.md](app/README.md).
For Android, prepare JDK 17, Android SDK/NDK and the combined AAR using the
[Android build guide](app-android/README.md), then run:

```powershell
.\app-android\gradlew.bat -p app-android :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
```

The Go core is a separate module (`go 1.26.0` in its go.mod):

```powershell
Push-Location app-android/core
go test ./...
Pop-Location
```

Run the checks appropriate to the changed component. A successful unit suite does not replace device
network tests or elevated Windows firewall tests. Android acceptance scripts can interrupt the VPN
and network; their behavior and prerequisites are described in the Android guide.

Before committing:

```powershell
git diff --check
node scripts/check-hygiene.mjs
# After staging, include new files in the repository gate:
node scripts/check-hygiene.mjs --staged
```

## Documentation and releases

Keep [README.md](README.md) and [README.ru.md](README.ru.md) aligned. Platform-specific behavior
belongs in [app/README.md](app/README.md) or the paired Android guides. Record new behavior in
[CHANGELOG.md](CHANGELOG.md) under Unreleased, and remove completed work from future-only roadmap
lists. Historical changelog entries describe their revision; the current guides describe `main`.

Root, desktop and Android versions are maintained independently in `package.json`,
`app/package.json` and `app-android/app/build.gradle.kts`. Wire/offer versions are separate again.
A Conventional Commit does not automatically bump package versions or publish a release.

Keep secrets, APKs/AARs, EXEs, user configurations, logs and device captures out of commits.
`docs/` is internal and ignored: put public instructions in tracked Markdown outside it. Use
documentation-only addresses and placeholders in examples; never copy live device evidence into a
README. Preserve third-party notices, including [Lucide](app-android/THIRD_PARTY_ICONS.txt).
