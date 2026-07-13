# Standard: XDG Base Directory Compliance

**Purpose:** One convention for where every app in a suite puts its files — config, data, state,
cache, and executables — so the suite behaves predictably on Linux (where `$XDG_*` env vars are
load-bearing, not decoration), survives a `rm -rf ~/.cache`, and stops scattering runtime data into
`~/bin`, ad-hoc config trees, and third-party substrate directories.

**Scope:** This is a portable engineering standard. It captures the universal rules for classifying
files, resolving paths, namespacing a suite, and migrating a legacy layout onto the XDG Base
Directory spec without data loss or races. Throughout, `<vendor>` is a placeholder for your suite or
org segment and `<app>` for an individual application.

---

## 1. The five classes

Every file an app writes falls into exactly one of five classes. Classify by asking (in the same
order as the table below): *is it directly runnable? → is it a config value a human or install step
sets? → is it durable user/app data the app owns? → is it operational state (logs, PID files, view
state) the app regenerates on restart? → is it disposable and safe to delete?*

| Class | Spec var → fallback | Holds |
|---|---|---|
| **bin** | (no `$XDG_*` var — `~/.local/bin` convention) | Installed executables and CLI shims |
| **config** | `$XDG_CONFIG_HOME` → `~/.config` | Config the app reads at startup (settings files, source lists, policy) |
| **data** | `$XDG_DATA_HOME` → `~/.local/share` | Durable app-owned data (cloned repos, event archives) |
| **state** | `$XDG_STATE_HOME` → `~/.local/state` | Operational state: logs, PID files, persistent view state |
| **cache** | `$XDG_CACHE_HOME` → `~/.cache` | Disposable, regenerable data: indexes, deletable temp |

---

## 2. Suite namespacing

Namespace under the suite/vendor, not per-app at the top level:

```
<base>/<vendor>/<app>/
```

e.g. `~/.config/<vendor>/<app>/<app>.yaml`, `~/.local/share/<vendor>/<app>/repos/`,
`~/.local/state/<vendor>/<app>/logs/`. Every app in the suite shares the `<vendor>/` segment under
each XDG base, then its own `<app>/` subdirectory. This is **not** `<base>/<app>/` (e.g. plain
`~/.config/<app>`) — a per-app top-level directory is the common pre-standard layout and is exactly
the legacy path a migration reads from.

**No dot-prefix inside the tree.** XDG exists specifically to replace the old dot-file convention
(`~/.vimrc` → `~/.config/vim/vimrc`) — the directory already provides the "this is config/data/
etc." signal, so a leading dot on top of it is redundant, not idiomatic. Files inside
`<vendor>/<app>/` carry **no leading dot**: `<app>.yaml`, never `.<app>.yaml`. If you're tempted to
dot-prefix a file inside an XDG dir, that's a sign the file doesn't belong there (a hidden marker
file for a different purpose) — not a naming-style choice.

---

## 3. Directory names vs. service-unit names (an intentional split)

The suite-grouped, dotless convention in §2 governs **directories and files on disk**. It does
**not** govern the **names of service units** — those follow *each platform's own* native idiom,
which differ from the directory convention and from each other:

```
macOS / launchd:   <reverse-dns-domain>.<app>.<slug>   (reverse-DNS)
Linux / systemd:   <app>-<slug>.service                (plain)
```

This is a deliberate, permanent split, not an inconsistency to converge later:

- **Directories are suite-grouped and dotless** because that's XDG's native idiom (§2) — a flat
  `<vendor>/<app>/` tree that's easy to back up, easy to `rm -rf ~/.cache` safely, and matches what
  every other XDG-compliant Linux app looks like.
- **macOS launchd labels/plist filenames are reverse-DNS** because that's launchd's native idiom —
  launchd requires globally-unique job labels, reverse-DNS guarantees it, and it's what every other
  entry in `launchctl list` looks like.
- **Linux systemd unit names are plain** (`<app>-<slug>.service`) because that's systemd's native
  idiom — units are plainly named like `sshd.service`/`nginx.service`; reverse-DNS is **not** a
  systemd convention. Do not carry the macOS reverse-DNS label onto the Linux unit.

Renaming service units to match the dotless directory convention (or to match each other across
platforms) would fight each platform's own tooling for no benefit; renaming XDG directories to
reverse-DNS would fight XDG's ethos and churn every path this standard just froze. Each name follows
the convention native to what it names, on the platform it runs on — apply the right one for the
artifact in front of you, not whichever one you used last.

---

## 4. Path table

The per-class resolution, following the XDG Base Directory spec:

| Class | Env → fallback | Path | Example |
|---|---|---|---|
| bin | (`~/.local/bin` convention) | `~/.local/bin` | `~/.local/bin/<app>` |
| config | `$XDG_CONFIG_HOME` → `~/.config` | `…/<vendor>/<app>/` | `~/.config/<vendor>/<app>/<app>.yaml` |
| data | `$XDG_DATA_HOME` → `~/.local/share` | `…/<vendor>/<app>/` | `~/.local/share/<vendor>/<app>/events/` |
| state | `$XDG_STATE_HOME` → `~/.local/state` | `…/<vendor>/<app>/` | `~/.local/state/<vendor>/<app>/logs/` |
| cache | `$XDG_CACHE_HOME` → `~/.cache` | `…/<vendor>/<app>/` | `~/.cache/<vendor>/<app>/` |

---

## 5. Precedence

For every class, resolve in this order — **first match wins**:

1. **App-specific override** — an env var scoped to one app that overrides everything else for that
   app (e.g. `<APP>_CONFIG_DIR`, `<APP>_DATA_DIR`).
2. **The matching `$XDG_*` variable** — `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`,
   `XDG_CACHE_HOME`. Honored only if set to a non-empty **absolute** path, per spec.
3. **Spec fallback** — `~/.config`, `~/.local/share`, `~/.local/state`, `~/.cache` (cache is the
   spec's one exception to the `~/.local/*` pattern) respectively; `~/.local/bin` for executables
   (no spec var — pure convention).

An app must never invent its own default that diverges from the spec fallback when no override or
`$XDG_*` var is set — divergent per-app defaults are what make a pre-standard layout inconsistent in
the first place (one app honoring its own override but not `$XDG_CONFIG_HOME`, another ignoring
both). Per the spec, a `$XDG_*` value that is **not an absolute path** is invalid and must be
ignored — fall through to the spec fallback. Treat empty, whitespace-only, or relative values as
unset.

---

## 6. The third-party substrate boundary

Some apps install artifacts into a directory owned by *another* tool (an editor, an agent runtime, a
plugin host) because that tool discovers them there by fixed path. An app that installs hooks,
plugins, commands, or config into such a tree is a *guest* there — most of what a guest puts there
must stay, because the host tool discovers it by fixed path. But apps also drop their own runtime
data into that tree because it's convenient, not because the host needs to see it. This standard
draws the line:

> **An artifact the host tool reads stays in the host's directory. An artifact only the app itself
> reads or writes belongs in the app's own XDG tree, not the host's directory.**

Do the classification per artifact:

| Artifact kind | Host-required? | Verdict | If MOVE, target |
|---|---|---|---|
| Hooks/plugins the host invokes by path | Yes | **STAYS** | — |
| Config the host reads directly | Yes | **STAYS** | — |
| Commands / skills the host discovers by convention | Yes | **STAYS** | — |
| App-private event buffers | No — only the app reads/writes | **MOVE** | `data` or `state` per durability |
| App-private policy + runtime taps | No | **MOVE** | `config` (policy) + `state` (tap) |
| App-private logs | No | **MOVE** | `state` |

**A moved artifact's readers must be updated in the same change** — a hook or separate process that
still hardcodes the old host-directory path after the buffer moves is a silent breakage, not a
completed migration. Every app doing this classification must produce this table as a review
deliverable, not assume the pattern above generalizes without checking its own artifacts. A separate
reader process typically needs an explicit env var to find the new location.

---

## 7. Migration-on-touch

Apps do not do a one-time forced migration on upgrade — they migrate **the first time the new path
is resolved**:

- On first resolve of a path: if the new (XDG) path is **absent** and the legacy path is
  **present**, migrate it with the two-constraint primitive: **never `rename` the source; always
  atomically write the destination** — `open(dest.tmp, 'wx', <source mode>)` → write → `fsync` →
  `rename(dest.tmp, dest)`. Creating with the source's mode (not chmod-after) matters: a naive copy
  applies the umask, so a chmod-after shim exposes a `0600` secret at `0644` in the window — and
  fail-closed consumers (a reader that enforces strict permissions and refuses a loose file) turn
  that into an outage, not just a leak. The source is kept until a later cleanup phase (rollback
  stays possible); a journal records each move. Idempotent — a re-install or repeated resolve can
  never clobber a working config.
- Keep a legacy read-fallback window before any legacy path is deleted outright — but **fallbacks
  must be loud, switchable, and time-boxed**: every fallback hit emits one structured log line
  (rate-limited per process); a global strict switch disables all fallbacks and fails hard with the
  legacy path named (fresh-install semantics on demand); each fallback names its removal milestone.
  Backward compat exists to protect live data during the transition — **it is never evidence the
  migration works**. Only a fresh environment with fallbacks disabled proves the new-path
  resolution, so CI must include a scratch-home, strict-mode, no-legacy-trees run that asserts zero
  fallback lines.
- **State is in scope for migration from the first pass**, not deferred to a follow-up — which
  raises the one hard constraint below.

### Running-daemon safety (hard constraint)

**Never move a live service's PID file, socket, or open log mid-run.** State migration (logs, PID
files, persistent view state) is restart-time only, and the not-running gate's oracle is the
**service manager, never the filesystem**: stop the unit through the service manager, then assert
its absence through the service manager (macOS: bootout the job, then confirm via `launchctl print`;
Linux: stop the unit, then confirm via `systemctl --user is-active`). **Pidfile presence is not a
valid oracle** — supervisors with keep-alive/restart-always policies keep a daemon permanently alive
(a pidfile gate is then a permanent no-op), and daemons *unlink* their pidfiles on stop while the
supervisor respawns them inside its throttle window, so "no pidfile" races straight into a live
process (TOCTOU). The gate must also return a restore handle and re-start the service on ANY failure
path — a stop through the service manager is persistent, and an aborted migration must not leave the
fleet down. A migration that races a running service start is the highest-risk failure mode this
standard has to guard against; treat the service-manager gate as non-negotiable.

**Absence must be proven positively, not inferred.** Migrate a daemon's state only when you have
positively identified it *dead* on three independent legs:

1. **The right unit** — discovered by the config path in its start command, never a unit name
   derived by convention.
2. **A manager-reached down verdict** — a query that actually reached the service manager and
   returned a *definitive* down signal, which is platform-specific:
   - Linux: `systemctl --user is-active` returns the state word `inactive` or `failed`.
   - macOS: `launchctl print` returns a non-zero exit from a call that did not itself error.
   - **An unreachable manager, an errored query, or ambiguous/empty output counts as PRESENT, not
     absent.**
3. **A confirmed process exit** — the pre-stop PID polled until the process no longer exists
   (`ESRCH`), because deregistration from the manager is not death.

A daemon with *no* service unit — hand-started or system-scope — is caught by a **pidfile-liveness
belt**: a live pidfile refuses the gate regardless of service-manager state. Inferring absence from
any single non-up signal is fail-**open**, the exact failure mode this constraint exists to prevent.

---

## 8. Reference implementation

Provide **one** canonical resolver module — a pure module exposing:

```ts
binDir(): string
configDir(app: string): string   // $XDG_CONFIG_HOME ?? ~/.config  →  <base>/<vendor>/<app>
dataDir(app: string): string     // $XDG_DATA_HOME   ?? ~/.local/share
stateDir(app: string): string    // $XDG_STATE_HOME  ?? ~/.local/state
cacheDir(app: string): string    // $XDG_CACHE_HOME  ?? ~/.cache
```

**Distribution — vendored copy vs. shared package.** If you vendor the resolver into each consumer
(rather than publishing it as a shared runtime dependency) so bundles stay standalone: **a vendored
copy is a fork unless it carries a pinned version marker and a test that fails on drift** — both are
required. A comment asking a human to "keep it in sync" is not a mechanism; a vendored resolver
copied "so the bundle is standalone" silently diverges the moment the canonical version moves. The
drift test compares the vendored file's pinned version/hash against the canonical one and fails the
consumer's CI, so drift is caught where it breaks, not where it was authored.

Every resolver function should accept an optional `{ home, env, platform, override }` seam for
tests. `binDir()` has no `app` parameter — bin is suite-shared, not per-app namespaced (see §1).

---

## 9. Applying this standard

- **Adding XDG-aware path resolution to an app?** Reuse the one canonical resolver (§8). Don't
  hand-roll a new one — a second implementation is a second place precedence bugs hide.
- **Adding a new class of file to an app?** Classify it against §1 before deciding where it lives.
  If it's disposable, it's cache — don't put it in data or state because deleting it "feels risky."
- **Naming a directory, file, or service unit?** Directories/files follow §2 (suite-grouped,
  dotless). Service-unit names follow §3, per platform: macOS/launchd = reverse-DNS, Linux/systemd =
  plain. Don't cross the conventions, and don't carry the macOS label onto the Linux unit.
- **Installing something into another tool's directory?** Apply the boundary rule in §6 explicitly:
  does the host tool discover this by path, or does only your app read it? When in doubt, it's not
  host-required — move it.
- **Migrating an existing app onto this standard?** Apply migration-on-touch (§7), never a forced
  one-shot migration, and if state (logs/PID files) is involved, the running-daemon safety
  constraint is mandatory, not optional hardening.
- **Building a brand-new app in the suite?** Start on this standard from day one — resolve every
  path class through the canonical resolver, and there is no legacy layout to migrate away from.

---

## 10. Common mistakes this standard prevents

Check this list before you freeze a path decision.

1. **`$XDG_CACHE_HOME` falls back to `~/.cache` — not `~/.local/cache`.**
   Cache is the spec's **one exception** to the `~/.local/*` pattern. Getting it wrong silently
   breaks the `rm -rf ~/.cache` guarantee in §1 and buries disposable data inside a tree users back
   up.
   ✅ `~/.cache/<vendor>/<app>/`  ❌ `~/.local/cache/<vendor>/<app>/`

2. **Reverse-DNS is launchd's idiom — not systemd's, and never a directory's.**
   macOS launchd labels/plists use reverse-DNS. Linux systemd units are plainly named
   (`<app>-<slug>.service`, like `sshd.service`). XDG directories are plain, suite-grouped, dotless.
   Don't carry the macOS label onto the Linux unit, and don't carry either into a path. (§3)

3. **No leading dot on files inside XDG directories.**
   `<app>.yaml`, never `.<app>.yaml`. The directory already namespaces the file; the dot-file
   convention is precisely what XDG replaced. A dot-prefixed file inside an XDG dir is a signal it
   was moved without being reconsidered. (§2)

4. **Classify by lifecycle, not by convenience or by what feels safe to delete.**
   Cloned package repos are **data** (app-managed, not user-edited) — not config. A package index is
   **cache** (regenerable) — not data. Keeping both under `~/.config/` means `rm -rf ~/.cache`
   reclaims nothing and a config backup drags gigabytes of clones. Classify against §1 *before*
   choosing the directory. (§1)

5. **Never move an artifact another tool discovers by path.**
   A host tool executes hooks at the absolute paths registered in its config, and finds
   plugins/commands by convention under its own directory. Those **stay**. Only app-private buffers
   may move — and when they do, the reader (often a separate process) needs an explicit env var to
   find the new location. (§6)

6. **Never migrate a running daemon's state.**
   PID files, sockets, and open log handles belong to a live process. State migration is
   restart-time only and gated by the **service manager, not the filesystem** — a daemon proven dead
   by pidfile absence alone is fail-open (§7). A migration that races a service start corrupts the
   stack it was meant to tidy. (§7, running-daemon safety)

7. **One resolver, one precedence chain.**
   App override > `$XDG_*` > spec fallback, evaluated in exactly that order, with empty/whitespace
   treated as unset. A second implementation is a second place for precedence bugs to hide — reuse
   the reference resolver, don't re-derive it. (§5, §8)
