# Flows

**Storage update:** [storage.md](storage.md) gives the current read/write, copy/clear and
recovery flows. This page retains the baseline flow analysis. There is no project notes
file, hand-editing/save prompt, gitignore offer or archive picker now. Stale-note navigation
opens the panel editor. Both native and panel editing and Files to Review flows remain.

Each flow is one thing the reviewer does, traced step by step. Function names point into
the code (`file › function`). The checks are listed because most of the complexity lives in
them. `problems.md` explains why they exist.

Notation: **await** marks an asynchronous step. After it, state may have changed, and the
code usually checks again.

---

## F0. Activation And Refresh (Background)

**Trigger.** VS Code starts (`onStartupFinished`), or any of these events fires:

- a Git status change;
- a save or watcher event on `REVIEW-NOTES.md`;
- typing in or closing a working-tree file that has line notes;
- a configuration change;
- an explicit Refresh;
- the end of every write action.

**Steps.**

1. `extension › schedule()` bumps the generation counter and debounces for 300 ms.
   `refresh()` does the same without the debounce.
2. `drainRefresh()` runs `refreshProjection()` repeatedly until one pass finishes with no
   newer request.
3. One pass:
   1. **await** `git.workspaceRepository()` finds the repository that contains the opened
      folder. If it is a different repository, `useRepository()` / `transitionRefreshScope()`
      switch the store, or refuse while anything is open or running.
   2. **await** `store.load()` reads and parses `REVIEW-NOTES.md`.
   3. **await** `computeRefreshProjection()`:
      - lists archives, only when the file is blank;
      - resolves every line note's position against its origin's content (`git show` for
        revisions, cached until the next Git event);
      - lists Files to Review candidates (reused when Git and the file are unchanged).
   4. `publishProjection()` stores entries and rows, updates the panel, rebuilds
      diagnostics, and starts background statistics.
   5. **await** `refreshEditors()` maps open documents to notes, marks visible rows, and
      places or updates gutter threads and badges (`publishEditors()`).
   6. Updates the `dejareview.hasFeedback` context key and the status bar count.
4. Background statistics (`loadFileStatistics()` → `git.fileStatistics()`) run one at a
   time and fill `+N -M` into existing rows when they finish.

**Stale results** are dropped. Every pass captures the counters and the folder, and does
not publish if they changed (see `architecture.md` §4).

---

## F1. Capture A Line Note With The Shortcut Or The Context Menu

**Trigger.** `Cmd/Ctrl+Alt+M`, or **Add Review Note** in the editor context menu
(`dejareview.addComment`).

1. `extension › add()` picks the editor:
   - **Shortcut:** the last focused text editor (`lastEditor`/`lastTab`), so it still works
     when focus is in the webview.
   - **Context menu:** the active editor if it shows that URI, otherwise the first visible
     editor that shows it.
2. `editorContext › captureContext()`:
   1. `freezeEditor()`, synchronously: URI, line range (a selection ending at column 0 does
      not include that line), tab input, all open tabs, and the displayed text of every
      relevant document.
   2. **await** `git.repositoryFor(uri)` checks that the file is inside the repository,
      walking up the folders and refusing symlinks, nested repositories and submodules.
      Records `baseCommit` and listens for Git changes.
   3. **await** `resolveEndpoint()`:
      - maps the document to a resource (path and origin);
      - for `git:` documents, reads the revision and requires it to equal the displayed
        text;
      - checks that the Git revision did not move.
   4. Builds the snippet, elided when the selection is longer than 20 lines.
   5. `chooseContext()`:
      - in a diff tab where the URI is exactly one side, that side is used;
      - in a plain tab, `document`;
      - otherwise **await** a QuickPick: "Where did you add this Review Note?"
   6. **await** `validate()` once, immediately: re-resolves, re-reads, re-checks HEAD and
      the `~` index mapping.
3. `useRepository()` switches the store if needed (refused while input is open).
4. A native comment thread is created at the range, marked `draft`, with a reply box. The
   captured context is stored in `drafts`.

**Nothing is written yet.**

---

## F2. Capture A Line Note With The Gutter `+`

**Trigger.** The reviewer clicks `+` in the editor gutter. VS Code creates the thread
itself; `provideCommentingRanges` allows it on every `file:`/`git:` document in the
repository.

- The extension learns nothing until submit. There is no event for "draft created".
- At submit, `captureContext()` runs with `inferFromOpenTabs` and `rangeSemantics:
  'thread'`. The snippet therefore comes from the text **at submit time**, and the diff side
  is inferred from open tabs, with a picker when ambiguous.
- Unsubmitted gutter drafts cannot be listed. Copy & Clear can neither warn about them nor
  remove them.

---

## F3. Submit A Native Draft

**Trigger.** **Add Review Note** button in the thread (`dejareview.submitComment` →
`extension › submit()`).

1. Ignored if:
   - the text is empty;
   - a copy is in progress;
   - this thread is already submitting;
   - this thread was cancelled.
2. Gets the captured context: the stored draft (F1), or **await** a capture now (F2).
3. `useRepository()`, then checks that the repo and store did not change.
4. For HEAD or index notes, listens for Git changes during the write.
5. **await** `store.mutate()`. See `architecture.md` §5 for the full write protocol.
   - The change callback runs `appendComment()`, which serializes the note, parses it again
     and refuses if anything would not round-trip.
   - Validation after the temporary write: `captured.validate()` again, then the input
     checks (still in scope, not cancelled, HEAD unchanged for mutable origins).
   - Rename publishes the file.
6. After publishing, the draft is closed even if a later step fails, so a retry cannot
   append the note twice. `refresh()` follows. The newest matching thread is expanded, and
   the extension offers once per folder to add `REVIEW-NOTES.md` to `.gitignore`.

---

## F4. Add A General Or Whole-File Note In The Panel

**Trigger.** **Add General Review Note**, or **Add File Note** on a Files to Review row.

1. Webview → host: `addGeneral` or `addFileNote`.
   - The provider authorizes against the last published state.
   - `dispatchDashboard()` checks the folder, busy flags and whether an editor is already
     open.
2. `openDashboardEditor()` creates a host-held session: `{id, repo, store, target,
   snapshot, body, error}`.
   - For a file note, it first rechecks that the file is still a candidate.
3. The webview opens a modal dialog. Every keystroke sends `input`. The host stores the
   body in the session, so it survives the webview being hidden. The client also caches
   unacknowledged input in `setState` (`ui.md` §3.4).
4. **Save** sends `saveEdit` → `dashboardInput()`:
   1. Rejects an empty body.
   2. **await** `workspaceRepository()` must be unchanged.
   3. For a file note: **await** the target must still be a candidate.
   4. **await** `store.mutate()`:
      - the file must still equal the session snapshot;
      - append `appendGeneralNote()` or `appendComment({wholeFile: true})`;
      - the validation closure runs again after the temporary write and before rename.
   5. Closes the session, **await** `refresh()`, offers `.gitignore` once.
5. Cancel or Escape discards the session. The webview acknowledges completion with
   `editorSettled` so it unlocks the editor exactly once (`ui.md` §3.5).

---

## F5. Edit A Note

There are two editors for the same note, plus hand-editing the file (F12).

**In the panel (any note kind).** Clicking a card's edit icon, or clicking a general-note
card, opens the same dialog as F4 with target `edit`. Save calls `editComment()`, which
splices only the body and parses the result again. The note is located with `current()`.

**In the native thread (line notes).**

1. `edit()` switches the comment to Editing mode and records an edit-session token.
2. Save (`save()`):
   - **await** `store.mutate()` with `current()` + `editComment()`;
   - validation checks the session token and that the typed body did not change during the
     write;
   - after publishing, the note is rebound to the new snapshot.
3. If the reviewer kept typing during the write, the earlier body is saved and the newer
   text is kept in the box, with a message.
4. `cancelEdit()` restores the saved body.

---

## F6. Delete A Note

| From | Confirmation | Checks |
| --- | --- | --- |
| Panel card trash icon | Modal | After the modal: same snapshot and raw block, no editor open, nothing writing |
| Native thread trash icon | **None** | Copy in progress only |

Both call `store.mutate()` → `deleteComment()`, which removes the block plus exactly one
following blank line, and then `refresh()`.

---

## F7. Navigate To A Note

**Trigger.** Clicking a file-note card (`open`), or the thread title's
**Open Side-by-Side Comparison** (`openComparison`).

`extension › goto()` re-reads the saved file and re-locates the note with `current()`
before each step.

| Note | What opens |
| --- | --- |
| Whole-file | The file, or its index version if it was deleted |
| Stale (not found) | `REVIEW-NOTES.md` at the note's block. Refused if that buffer is dirty. |
| Comparison | `vscode.diff(left, right)`. With `openComparison` and the inline diff layout, toggles side-by-side (a lasting setting change). Selects the lines in the chosen pane, or offers **Open Revision** if that pane is not an editor. |
| Plain | The document, with the resolved lines selected as whole lines |

`dejareview.gotoCode` is registered but has no menu and is hidden from the palette. The
panel calls `goto()` directly.

---

## F8. Files To Review

**Listing.** Happens on refresh (F0).

1. `git › filesToReview()` reads the working-tree and untracked groups once.
2. Filters out noted paths, review files and archive storage.
3. Validates each file in two passes (folder walk, regular file, inside the repository).
4. Re-reads membership at the end.

**Statistics.** Happen in the background.

1. `git › fileStatistics()`, per file, in batches of 8:
   - validate;
   - index-object signature (one `git ls-files` process);
   - diff, or a bounded untracked read, on a cache miss;
   - validate again.
2. A second pass recomputes the signatures and retries anything that changed while it was
   read.
3. Results go into the cache only if the Git state did not move meanwhile.

**Open a row.** `openFile()`:

| File | What opens |
| --- | --- |
| Untracked | The file |
| Deleted | Its index version |
| Tracked | `vscode.diff` of the index against the working tree, titled "(Unstaged changes)", so VS Code's own Stage Hunk menus work |

**Stage / Revert a row.** `changeFile()`, then `git › mutateFile()`:

1. Marks the row pending, which disables the whole panel.
2. Synchronous checks: inside the folder, not a review or archive file, no saved note,
   still a candidate. For Revert also: no dirty buffer and a supported Git status.
3. **await** checks on the file and its path. For Revert: rechecks, checks brackets,
   **await** the modal confirmation, then rechecks again.
4. Bracket path: **await** `git ls-files` must match only this file.
5. In one synchronous turn: host guard, candidate check, then `repo.add([path])` or
   `repo.clean([path])`.
6. **await** `refresh(false)`. Only then is the pending mark cleared; rows are never
   removed optimistically.
7. If the staged file was the first row and its diff was open, the next candidate opens
   automatically (`openNextStagedFile()`).

---

## F9. Copy Review Notes & Clear (Handoff)

**Trigger.** The panel button or `dejareview.copyForAgent`. Enabled only when there is
feedback.

1. `extension › handoff()`:
   - refuses while a panel editor is open or anything is writing;
   - explains, instead of doing nothing, when a native submit is still in flight;
   - remembers the current native drafts and open edits.
2. Sets `copyInProgress` and its context key. Native submit and new capture are now
   disabled.
3. If native drafts or edits exist, a modal asks **Copy and discard drafts** or **Finish
   Review Notes first**.
4. **await** `store.handoff()`, inside the store queue. The steps below describe the
   earlier Markdown flow; see [storage.md](storage.md#handoff-and-recovery) for the current
   JSON record flow and checkout write lock:
   1. `ensureSaved()` (modal if `REVIEW-NOTES.md` has unsaved changes);
   2. read;
   3. **copy** the instruction plus the raw text;
   4. **archive**;
   5. re-read, and **delete** only if unchanged.

   The buffer must stay clean between steps.
5. On success:
   - disposes the known drafts and threads, unless input changed meanwhile, in which case
     it is kept;
   - **await** `refresh()`;
   - shows a success message, or success plus a "display not refreshed" warning.
6. On partial failure, the message says exactly what happened: copied or not, archived or
   not, cleared or not.

---

## F10. Recover An Archive

**Trigger.** Recent Archives in the panel. It is available only when there is no saved
feedback, so a recovery never overwrites current notes. It can also be run from the
Command Palette with a picker.

1. `restore()` requires no open panel editor, drafts or edits, and nothing writing.
2. **await** `store.restore()`:
   - the live file must be missing or blank;
   - reads and validates the archive;
   - writes it with the same temporary-file-and-rename protocol;
   - re-checks that the file is still blank and the buffer clean.
3. **await** `refresh()`. The archive stays available.

---

## F11. Rewrite Line Numbers From Anchors

**Trigger.** `dejareview.reanchorAll` (Command Palette).

1. **await** `refresh()`, then remembers the entries and the generation.
2. **await** `store.mutate()`. The generation must still be the published one. For each
   resolved note, `rewriteLinesBatch()` replaces only the range in its heading.
3. **await** `refresh()`.

Caveats:

- Working-tree positions come from the **live buffer**, so unsaved edits can be written as
  line numbers.
- Any typing in a noted file during the command bumps the generation and makes it fail.
- There is no confirmation.

---

## F12. Hand-Editing `REVIEW-NOTES.md`

This is supported. When the file is saved, the watcher and save listener trigger a refresh.

- Malformed blocks become diagnostics. They stay copyable and are never dropped.
- Every write path refuses or prompts while the buffer has unsaved changes.
- Every action on a stale handle fails with "changed on disk; refresh and retry", because
  `current()` cannot re-locate the block uniquely.
