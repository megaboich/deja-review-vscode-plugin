# DejaReview Development Guide

This file records **intent, invariants and non-goals**. Mechanism lives in the code and its
comments; where the two disagree, the code is correct and this file is stale. Add a note here
only when a competent contributor reading the code could still get it *wrong* — otherwise put
the explanation next to the code it constrains.

User-facing installation, workflow, recovery, privacy and limitations belong in `README.md`.

## Agent Safety Rules

These are behavioural rules for coding agents, not code style.

- **Never stage, unstage, stash, or revert anything.** The reviewer alone manages staging,
  including activating Stage File and confirming Revert File. The extension's own Git
  exceptions below do not authorize an agent to perform them.
- **Commit only when explicitly asked**, and include only what the reviewer already staged.
  Never stage files to prepare a commit. Inspect status, the staged diff and recent history
  first. `git diff HEAD` is read-only and shows what plain `git diff` hides in the index.
- **Treat pasted review feedback as the task input.** Exclude `REVIEW-NOTES.md` and review
  archives from routine searches. Explicit permission to read one does not authorize
  editing, migrating, replying in, or recovering review data.
- **Tests use synthetic data only** — in-memory feedback or disposable fixtures, never the
  user's review data. If a task forbids even fixture reads, skip the extension-host suite and
  say so.
- Use **Review Note(s)** in user-visible labels, prompts, tooltips and counters. Leave native
  VS Code comment APIs, internal model names, command/context IDs and schema fields alone.

## Architecture

VS Code 1.96+ extension. Package `dejareview`, ID `local-review.dejareview`, command and
settings prefix `dejareview.`. Requires the bundled `vscode.git` extension and a containing
local Git repository. **Zero runtime npm dependencies** — Preact and esbuild are development
dependencies bundled into the generated webview script, never installed alongside the extension.

| File | Responsibility |
| --- | --- |
| `src/extension.ts` | Activation, commands, native threads/decorations, guards, refresh scheduling and generations |
| `src/model.ts` | Note models, validation and normalization |
| `src/parser.ts` | Markdown scanning, note parsing, diagnostics, exact block offsets |
| `src/writer.ts` | Append, targeted body edit/delete, line-number rewriting |
| `src/anchor.ts` | Content-based re-anchoring |
| `src/git.ts` | Repository discovery, revision/blob resolution, review candidates and stats, single-file add/clean |
| `src/gitPath.ts` | Pathspec-expansion check for bracket filenames |
| `src/editorContext.ts` | Frozen editor capture: source, range, side/origin, snippet elision |
| `src/store.ts` | Saved-file I/O, watcher, serialized mutations, handoff/recovery |
| `src/handoff.ts` | Host-free copy-and-clear port and result types |
| `src/archive.ts` | Folder-scoped JSON archives with atomic publication |
| `src/dashboard.ts` | Webview provider, host-held sessions, projections, action authorization |
| `src/dashboardHtml.ts` | Static shell, styles, CSP; inlines the compiled client bundle |
| `src/dashboardClient.tsx` | Webview client: Preact lists, message validation, input retention |
| `src/dashboardClientEntry.ts` | Bundle entry; exposes the client as one global |
| `scripts/buildClient.mjs` | esbuild bundle → `src/generated/dashboardClientBundle.ts` (generated, gitignored) |

`parser`, `writer`, `anchor`, `handoff` and `dashboardHtml` run without a VS Code host, which
is what makes the fast test suite possible. Keep it that way.

Native line-note capture lives in `extension.ts`. The single Review Notes webview owns general
notes, editing any saved note, Files to Review, cards, navigation, handoff and archive history.

## Non-Goals

No AI service, account, PR integration, MCP server, daemon, agent replies, acceptance
tracking, hunk inventory, or completion inference. No tree view, editor panel, repository
picker, or `selectRepository` command. No archive purge, delete, sync or encryption. No schema
library or generic routing framework for the small webview protocol. Preact is the only UI
framework in the webview; add no second one, and no state, router or styling library beside it.
Add no commands, settings or runtime dependencies for dashboard features.

**Files to Review is a heuristic, not a completion model.** It lists changed files with no
saved note. Clearing notes intentionally makes files reappear for the next pass. Empty means
"no current candidates", never "approved". Keep no persistent completion flag.

`package.json` is the source of truth for commands, menus and keybindings. Two constraints are
not recoverable from it:

- The user explicitly removed the user-facing `dejareview.reveal` command. Do not re-contribute
  it or reference it in menus or palette rules; stale-note navigation to the saved Markdown
  block stays internal.
- Note capture is a command plus gutter/editor-menu entry, never a `CodeActionProvider`. The
  dashboard's only view-title action is `dejareview.refresh`.

## Persisted Contracts

Breaking any of these corrupts existing user data. They are the reason this file exists.

### Saved Markdown

The saved file is the sole source of current review feedback. The UI is a projection of it.
Never regenerate the whole file from the parsed model.

```text
document   := preamble? note*
note       := comment | general
general    := "## General Review Note" newline body
comment    := header anchor? body
header     := "## `" path "`:" (range | "file") " (" context ")" elision?
elision    := "; Snippet: elided"
range      := positive-int | positive-int "-" positive-int
origin     := "Working tree" | "Staging area" | "HEAD" | "Commit " full-sha
context    := origin | side ": " origin " vs " endpoint
side       := "Original" | "Modified"
endpoint   := origin | "`" path "` @ " origin
body       := "💬 " prose | "💬 Body: fenced" newline wrapped-body
```

- Paths are opened-folder-relative POSIX. Ranges are 1-based inclusive in the selected origin.
- The selected origin comes first; the opposite endpoint follows `vs`, named only when its
  path differs. Side is always explicit, even for identical endpoints, and means provenance,
  not acceptance.
- **Preserve everything you do not understand**: unknown sections, malformed blocks, preamble,
  BOM, CRLF, duplicate headers. Publish diagnostics instead of guessing or dropping feedback.
  Duplicate headers are distinct notes.
- Append preserves preceding bytes; edits splice only the body; deletion removes the block and
  exactly one following blank separator.
- Bodies accept arbitrary text. The `💬 Body: fenced` wrapper exists so that headings, unbalanced
  fences, leading fences and significant boundary whitespace survive a round trip. Copy and
  archive use raw saved bytes including wrappers.
- Parse only this format. No compatibility parsing, no automatic migration, no scratch-file
  migration.

### Archives

`globalStorageUri/reviews/<sha256(openedFolderURI)>/<uuid>.json` with fields `version`, `id`,
`repoUri`, `text`, `createdAt`, `commentCount`. `repoUri` holds the *opened folder* URI despite
its name — do not rename it or migrate records. Counts are historical facts, not assertions
against the current parser; never recount. Subfolder namespaces are isolated from their Git
root's namespace.

### Handoff instruction

`HANDOFF_INSTRUCTION` in `src/handoff.ts` has an exact-string test. Change both together.

> Please address these review notes and summarize your changes here. Leave staging to me.

Handoff order is: validate input guards → read snapshot → copy → archive → delete → clear
projections. Each step awaits the previous one's success, so a failure can never lose feedback
that was not already archived. Report partial success explicitly.

## Design Intent

Why the code is shaped the way it is. The mechanism is in the code; this is the reasoning.

- **One folder, deterministically.** Everything scopes to `workspaceFolders[0]`, which owns the
  notes file, watcher, archive namespace, store and guards — even when it is a Git subfolder.
  There is no picker and no fallback to another root, because a review that silently retargets
  is worse than one that refuses. Paths translate to the parent repository only at the Git
  boundary.
- **Guards are layered, not shared.** Client checks improve UX, host checks authorize, and
  post-await checks detect changed state. They often look alike; deduplicating them removes a
  trust boundary. `extension.ts` names its guard sets (`mutating`, `editorActive`,
  `nativeWriteInFlight`, `nativeInputOpen`) so each call site's combination is reviewable —
  but every site still re-reads them after each await, and several deliberately omit one flag.
  Those omissions are commented; do not "normalize" them.
- **Never trust the client.** Note and file IDs are projection-scoped handles, not stable
  identities. Resolve them to host-held entries and revalidate scope, membership and the exact
  saved snapshot before any navigation or mutation.
- **Keyed rows are folder-scoped.** Because a projection id names a different row in another
  folder, list keys fold the folder in, so rows are replaced rather than reused across folders.
  Row handlers re-check the folder and that their node is still connected: a detached node is a
  superseded row whose listener outlived it.
- **Exiting file rows stay rendered.** A removed row is kept in the list, inert, until its
  collapse settles; a row that reappears cancels the animation and is reused. Settlement is
  matched against the recorded animation, so a stale one cannot remove a live row.
- **Generations over locks.** Refresh publication is gated by generation tokens so obsolete
  async passes cannot overwrite newer state. Keep one source of truth per session, snapshot and
  projection; derive display state rather than syncing parallel flags.
- **Git is read-only, with two audited exceptions.** Stage File calls `Git.add` once, and Revert
  File calls `Git.clean` once after modal confirmation, each with exactly one validated
  host-held path — never a directory, wildcard, or multiple paths. Revert restores tracked
  content from the *index*, so staged work survives; it refuses any state where that cannot be
  guaranteed. Dirty buffers block it. The extension never unstages, stashes or commits.
- **Capture freezes context before the user types**, so a draft can never be retargeted by
  whichever editor happens to be active at submission. Stable APIs cannot tell us where a
  native gutter draft was created, so submission-time inference is used and ambiguity asks.
- **Re-anchoring moves display positions only.** Saved line numbers change solely through the
  explicit `dejareview.reanchorAll`. Stale notes keep their feedback and are never auto-deleted.
- **`workspace.fs` has no atomic compare-and-write.** Rechecks narrow the window but cannot
  close it. Do not claim transactional clearing or recovery.
- **The webview receives previews, not content.** Card payloads carry the first two body lines
  bounded to 320 characters. The single full-body exception is the active editor session. Never
  send anchors, raw snapshots or archive text.
- **All review prose is untrusted input.** It is rendered with `isTrusted = false` and
  `supportHtml = false`, the webview runs under a nonce-based CSP with no remote resources, and
  paths are rejected when they traverse a symlink below the Git root. These three defences live
  in `extension.ts`, `dashboardHtml.ts` and `git.ts`; weakening any of them needs a deliberate
  decision, not a convenience fix.
- **The client never writes markup.** Every rendered value is review prose, so it goes through
  text nodes and attributes only. Preact ships `innerHTML` for `dangerouslySetInnerHTML`, which
  the shell test can no longer ban outright; it bans the string in `dashboardClient.tsx` instead.
  Preact's XML namespace URIs are the only URLs exempt from the remote-resource check.

## Code Quality

General TypeScript and readability practice is assumed. Only project-specific rules are listed.

- Keep changes focused. Add no compatibility layer without a concrete shipped or persisted
  contract; existing archive records are such a contract.
- Receive external data as `unknown` and narrow it with runtime checks. No `any`, no non-null
  assertions, no `as Action` to bypass validation. Prefer discriminated unions over one object
  with every field optional.
- Validate message shape, authorize against live host state, then execute — keep the three
  distinguishable. Reject unknown actions and unexpected fields.
- Share logic only when it is the same rule that should change for the same reason. Similar
  shape is not enough. Keep helpers local until a second module needs them.
- Never swallow a failed write or log raw feedback/archive contents.
- Comments explain a non-obvious reason, invariant or API limitation — not what the code says.
- Keep native VS Code APIs, webview DOM APIs and theme tokens; do not import another project's
  UI conventions.

## Development And Verification

`npm install`, then:

```sh
npm run check          # bundles the client, then type-checks
npm test               # compile + node:test suite
npm run test:integration
npm run package
git diff --check
```

`npm run build:client` regenerates `src/generated/dashboardClientBundle.ts`; `check` and
`compile` run it automatically. F5 with *Run DejaReview* opens an Extension Development Host.

`npm test` uses synthetic feedback and mocked filesystem/Git APIs plus disposable Git fixtures.
`test/runIntegration.ts` drives root and subfolder extension hosts, defaulting to
`/Applications/Visual Studio Code.app/Contents/MacOS/Code` (override `VSCODE_EXECUTABLE_PATH`).
It creates disposable fixtures with isolated user-data, extensions and Git config. **Never
point it at a real workspace or storage.**

The dashboard suites drive the client through `test/dashboardClientFixture.ts`, a real DOM
(happy-dom) with test affordances patched onto `Element.prototype`: deterministic animations,
a layout-free `getBoundingClientRect`, and `dispatch`/`invokeListener`. Animations stay
deterministic because reappearance races need an exact settle or cancel point.

**Never assert on a DOM object itself.** Comparing elements or `NamedNodeMap`s makes Node walk
the whole window graph — one such assertion cost 74s and 10GB before the fixture gained a short
`inspect.custom` and the suites switched to comparing names and values.

When changing the saved format, keep regressions for: round-tripping every origin/side/path
combination, literal body markers, BOM/CRLF/CR offsets, duplicate notes, malformed metadata,
elision versus literal ellipses, targeted writes, and opaque unknown sections.

**Report what you actually ran.** Automated coverage does not include visual acceptance:
gutter/composer UX, physical shortcuts, modal prompts, focus restoration, hide/reopen input
retention, narrow sidebars, and light/dark/high-contrast themes still need manual checks. Do
not claim audit cleanliness without running `npm audit`.
