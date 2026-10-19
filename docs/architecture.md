# Architecture (Logic)

How the code is organized and how its moving parts interact. For the reasons behind each
mechanism, see `problems.md`.

**Storage update:** [storage.md](storage.md) is the current persistence architecture.
The sections below retain the earlier baseline for comparison: project Markdown,
dirty-buffer save prompts and multi-batch archives are no longer the persisted design.
`reviewStorage.ts` now provides JSON records, path-keyed central storage, a directory
watcher and a cross-window write lock; `store.ts` bridges the existing host projection.

## 1. Layers And Modules

- **VS Code host:** `extension.ts` (`ReviewExtension`) coordinates commands, native
  comments, refresh, guards, dashboard dispatch and handoff/recovery.
  - `editorContext.ts`: freezes editor context, resolves endpoints and chooses the side.
  - `git.ts` / `gitPath.ts`: discover repositories, resolve resources and content, list
    candidates, compute statistics, and perform Stage/Revert.
  - `store.ts` (`ReviewStore`): serializes saved-note I/O, watches `REVIEW-NOTES.md`, and
    handles handoff/recovery I/O.
  - `archive.ts` (`ReviewArchives`): stores folder-scoped JSON archive records.
  - `dashboard.ts` (`ReviewDashboard`): provides the webview, decodes and authorizes
    messages, and projects host state.
- **Host-free core:** `model.ts`, `parser.ts`, `writer.ts`, `anchor.ts`, `handoff.ts` and
  `dashboardHtml.ts`.
- **Webview, in a separate JavaScript context:** `dashboardClient.tsx` uses Preact.
  `scripts/buildClient.mjs` bundles it into `src/generated/dashboardClientBundle.ts`.

The host-free core runs without VS Code. That is what makes the fast `node:test` suite
possible. Keep it that way.

| Module | Lines | Owns |
| --- | --- | --- |
| `extension.ts` | ~2,060 | All mutable host state, every command, the refresh pipeline, every guard |
| `git.ts` | ~990 | Workspace adapter, document→resource mapping, ownership walk, content reads, candidates, statistics cache, single-file add/clean |
| `gitPath.ts` | ~60 | Direct `git` processes: bracket pathspec check, literal index lookup |
| `editorContext.ts` | ~350 | Frozen capture and revalidation closures |
| `store.ts` | ~390 | Write queue, temp-file + rename publish, dirty-buffer handling, handoff/restore I/O, watcher |
| `archive.ts` | ~190 | Archive save/list/read with validation and listing cache |
| `handoff.ts` | | Handoff instruction and result types; `store.ts` executes copy and clear |
| `parser.ts` / `writer.ts` / `model.ts` | ~610 | Saved format: scanning, parsing, offsets, append/edit/delete/rewrite, validation |
| `anchor.ts` | ~150 | Resolving snippets to current line ranges |
| `dashboard.ts` | ~520 | Webview provider, message decoding, action authorization, state projection, editor acknowledgements |
| `dashboardHtml.ts` | ~270 | Static shell, CSS, CSP, inlined bundle |
| `dashboardClient.tsx` | ~950 | Webview UI |

## 2. Host State (`ReviewExtension`)

The extension is one large object. The fields that matter, grouped by purpose:

| Group | Fields | Notes |
| --- | --- | --- |
| Scope | `repo`, `store`, `repoSubscriptions` | `repo` and `store` are always replaced together (`useRepository`) |
| Note projection | `entries`, `savedEntries`, `cardEntries`, `hasFeedback`, `noteError`, `historyError`, `archives` | `savedEntries` and `hasFeedback` can be derived; `historyError` also carries scope errors |
| Editor support | `anchoredDocuments`, `revisionContents`, `diagnosticsKey`, `publishedHasFeedback` | Performance caches added to stop refreshes on every keystroke |
| Files to Review | `files`, `filesError`, `statisticsSnapshot`, `statisticsRevision`, `forceStatistics`, `statisticsWork` | `files` rows are changed in place from three places: statistics, visibility, change kind |
| File action | `pendingFileAction`, `advanceAfterStage`, `advancingFile` | `pendingFileAction` is both the lock and the row's pending marker |
| Panel editor | `dashboardEditor`, `editorBusy`, `editorSequence` | The session holds the draft body on the host |
| Native comments | `threads`, `drafts`, `submitting`, `cancelledDrafts`, `saving`, `editSessions`, `lastEditor`, `lastTab` | |
| Operation flags | `copyInProgress` | Used by both handoff and restore |
| Counters | `generation`, `filesGeneration`, `publishedGeneration`, `statisticsRevision`, `editorsRevision`, `cardSequence` | See §4 |

`ReviewDashboard` (in `dashboard.ts`) keeps its own copy of the last published state, the
in-flight action (`handlingAction`, `handlingFile`, `handlingRequestId`), history
visibility, and the editor acknowledgement state. Some of this duplicates host state.

## 3. The Refresh Pipeline

### Triggers

| Event | Call | Invalidates the file list? |
| --- | --- | --- |
| Git repository opened/closed; workspace folders changed | `schedule(true)` | yes |
| `repo.state.onDidChange` (every Git status run) | `schedule(true)` | yes |
| `REVIEW-NOTES.md` watcher/save (store debounces 300 ms), or the store's own writes | `schedule(true)` | yes |
| Store becomes idle | `schedule()` | no |
| Typing in, or closing, a working-tree file that has line notes | `schedule()` | no |
| `dejareview.*` configuration change | `schedule()` | no |
| Opening a `file:`/`git:` document while line notes exist | `scheduleEditors()` (100 ms) → `refreshEditors()` only | – |
| Visible editors changed | `refreshEditors()` directly | – |
| Every write action ends; explicit Refresh; activation | `refresh()` | yes, and forces statistics |

> Known cost: every write ends with `refresh()`, which defaults to forcing a full
> statistics recomputation. Adding one note therefore re-diffs every candidate file. Only
> the debounce timer and file actions use `refresh(false)`.

### Drain And Pass

- `refresh()` bumps the counters, then either joins the running drain or starts one. After
  the drain it always runs `openNextStagedFile()` (auto-advance).
- `drainRefresh()` loops `refreshProjection()` until a pass ends with `generation`
  unchanged, so every caller sees the newest projection.
- `refreshProjection()` follows flow F0 in `flows.md`. After each await it checks
  `currentRequest()`: generation, files generation, folder and store identity.

### Publication

`publishProjection()` is synchronous. It sets the projection, merges the file rows (keeping
previous statistics while revalidating), sets the change kinds, calls `updateDashboard()`,
rebuilds `anchoredDocuments`, republishes diagnostics only when they changed, and starts
statistics when the candidate list changed.

`updateDashboard()` turns host state into `DashboardState`. `ReviewDashboard.pushState()`
projects it again (`projectState()` keeps previews, removes archive text) and posts it.

## 4. Concurrency Model

There are no locks around the refresh pipeline. Instead, each asynchronous job captures
**generation counters** and abandons its result if they changed ("generations over
locks"). Write operations do use flags. On top of that, the code re-checks state after
every await.

### Counters

| Counter | Bumped by | Checked by |
| --- | --- | --- |
| `generation` | `schedule`, `refresh`, `useRepository`, handoff success, dispose | drain loop, `refreshProjection`, `reanchor` |
| `filesGeneration` | `schedule(true)`, every `refresh()` | `refreshProjection` (redundant with `generation`), `refreshEditors`, `openFile`, `changeFile`, `validateFileNoteTarget` |
| `publishedGeneration` | `publishProjection` | `reanchor` only |
| `statisticsRevision` | `schedule(true)`, `refresh(true)` | candidate reuse, `loadFileStatistics` |
| `editorsRevision` | each `refreshEditors()` | that call only (latest wins) |

### Guards

| Getter | Meaning |
| --- | --- |
| `fileActionBusy` | A Stage or Revert is running (`pendingFileAction`) |
| `mutating` | `copyInProgress \|\| fileActionBusy \|\| store.busy` |
| `editorActive` | A panel editor session is open or saving |
| `nativeWriteInFlight` | A native submit or save is writing |
| `nativeInputOpen` | Native drafts exist, or a native note is in edit mode |

Each operation checks its own combination of these guards, before and after its awaits.
The combinations are deliberately different. For example, `openNextStagedFile` leaves out
`fileActionBusy`, because it runs while the stage action still holds that flag. These
omissions are commented in the code. Not every difference is deliberate, though:

- Native submit, save and delete do not check `fileActionBusy`. The panel save does.
- Native delete checks only `copyInProgress`. Panel delete checks the editor and write
  state.

Data stays consistent either way, because the store queue and the snapshot checks catch
conflicts. Which action wins does depend on which UI was used.

### Validation Closures

Most operations build one or more closures (`validate`, `validateInput`,
`validateSession`, `current`, `valid`, …) and pass them down. `extension.ts` has roughly 15.
`store.mutate()` calls the caller's checks up to three times per write. `git.mutateFile()`
runs the caller's guard in the same synchronous turn as the Git call. `filesToReview` and
`fileStatistics` take an `isCurrent` callback and check it between batches.

### Dashboard Single-Flight

`ReviewDashboard.receiveMessage()` rejects every non-navigation webview action while
another is being handled or the state is busy. Webview-originated actions are therefore
serialized before they reach the host guards. Native commands and events bypass this
layer.

## 5. Persistence Engine (`store.ts`)

All reads and writes of `REVIEW-NOTES.md` go through `ReviewStore`. `serialize()` keeps a
promise queue, and while anything is queued, `busy` is true.

`mutate(change, validate?, validateInput?)`:

1. `ensureSaved()`: while the file has an unsaved editor buffer, show a modal **Save and
   retry / Cancel**.
2. **await** `read()`: refuses symlinks and non-regular files; decodes strict UTF-8 and
   keeps a BOM.
3. `change(snapshot)`. If the result is identical, return without writing.
4. `publish()`:
   1. Rejects unpaired surrogates.
   2. **await** write `.REVIEW-NOTES.md.<uuid>.tmp`.
   3. **await** the caller's `validate()`.
   4. **await** re-read: must still equal the snapshot.
   5. **await** stat: existence must be unchanged.
   6. Dirty-buffer checks after each await.
   7. The caller's synchronous `validateInput()`.
   8. Rename the temp file over the real one. Local files use Node's `rename`, which
      replaces atomically. `workspace.fs.rename` would delete the target first.
   9. Fire the change event.

   The temp file is removed on any failure.

Current `ReviewStore.handoff()` and `restore()` use the checkout write lock and structured
records (see [storage.md](storage.md)). `handoff.ts` defines the instruction and result
types; the earlier standalone Markdown copy-and-clear algorithm has been removed.

`workspace.fs` has no compare-and-swap, so these checks narrow the race window but cannot
close it. The code says so.

## 6. Git Layer (`git.ts`)

- **Discovery.**
  - `initialize()` waits for the vscode.git API.
  - `workspaceRepository()` finds the containing repository (longest root prefix) and
    walks the opened folder for symlinks and nested `.git` folders. It returns the cached
    **workspace adapter**.
- **Ownership.**
  - `withinRepository()` walks from a file up to the Git root and `stat`s every level.
    It refuses symlinks, nested `.git` markers and submodule paths.
  - `repositoryFor()` = discovery + ownership.
  - `validatedUri()` = build the URI + `repositoryFor()`.
- **Resources.**
  - `source()` parses and checks `git:` URIs.
  - `resource()` maps a document to `{path, origin}`. `''` means index, `HEAD` means HEAD,
    `~` means index if the file has staged changes and HEAD otherwise, and any other ref is
    resolved to a commit SHA.
  - `uri()` builds the reverse.
- **Content.** `content()` reads the open buffer or the disk for the working tree, and
  `repo.show()` for revisions. Missing revision paths are recognized only through a second
  lookup.
- **Candidates.**
  - `filesToReview()` reads the working-tree and untracked groups once (cached per Git
    event).
  - It validates every row twice in batches of 8 and re-reads membership before
    returning.
- **Statistics.**
  - `fileStatistics()` uses a two-pass algorithm with a per-file signature cache: stat
    metadata plus index object/mode from one literal `git ls-files` process.
  - Tracked counts come from `repo.diffWithHEAD()`, which in VS Code 1.96 compares the
    index to disk despite its name.
  - Untracked counts come from a bounded read.
- **Writes.** `mutateFile()` implements Stage and Revert (flow F8).

Process cost per Git status event, per changed tracked file: 2–3 `git` processes plus
about 4–5 ownership walks (two `stat` calls per folder level). See `problems.md` D6.

## 7. Error Reporting

- Commands are wrapped by `registerCommand()`. Errors are logged to the DejaReview output
  channel and shown as error messages.
- Background refresh errors go through `this.error()` and also show a message.
  Speculation: a persistent failure would show it on every Git or store event.
- After a successful write, a failed refresh is reported as a warning ("saved, but the
  display could not be refreshed"), never as a failed write. This logic is repeated in five
  places.
- Raw feedback and archive contents are never logged.

## 8. Tests

| Suite | Lines | Drives |
| --- | --- | --- |
| `test/core.test.ts`, `format.test.ts`, `generalNotes.test.ts`, `wholeFileNotes.test.ts` | ~1,100 | Format and anchors (host-free) |
| `test/storage.test.ts`, `handoff.test.ts` | ~1,180 | Store, archives and handoff over an in-memory filesystem |
| `test/git.test.ts`, `filesToReview.test.ts`, `gitPath.test.ts` | ~3,270 | Git layer over a synthetic vscode.git; real `git` in throwaway repos for `gitPath` |
| `test/dashboard.test.ts` + client fixture | ~3,100 | Webview client in happy-dom, provider protocol, shell/CSP |
| `test/filesDashboard.test.ts` | ~3,900 | The whole extension activated against a mocked VS Code |
| `test/integration/*` | ~970 | Real VS Code, disposable fixtures |

Most of the volume pins race handling: "X changes during await Y". When a mechanism is
simplified, these tests are where most of the work, and most of the deleted lines, will be.
## Baseline Size Before Central Storage

| Area | Source lines | Main files |
| --- | --- | --- |
| Host orchestration (commands, refresh, guards, native UI) | ~2,060 | `src/extension.ts` |
| Git integration and Files to Review | ~1,050 | `src/git.ts`, `src/gitPath.ts` |
| Webview (host side, shell, client) | ~1,740 | `src/dashboard.ts`, `src/dashboardHtml.ts`, `src/dashboardClient.tsx` |
| Saved format, anchors, storage, archives, handoff | ~1,420 | `src/model.ts`, `src/parser.ts`, `src/writer.ts`, `src/anchor.ts`, `src/store.ts`, `src/archive.ts`, `src/handoff.ts` |
| Capture | ~350 | `src/editorContext.ts` |
| **Total source** | **~6,600** | |
| **Tests** | **~13,900** | 2,000+ lines each: `filesDashboard`, `dashboard`, `filesToReview` |

The test suite is twice the size of the source. Most of it pins race handling and exact
protocol behaviour. That matters when you simplify: removing a mechanism usually removes
far more test code than source code.
