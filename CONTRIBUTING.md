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
| `feat` | a new feature (bumps MINOR version) |
| `fix` | a bug fix (bumps PATCH version) |
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
npm install
```
