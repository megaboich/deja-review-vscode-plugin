# DejaReview Development Guide

## Working Rules

- Keep user installation, workflow, recovery, privacy, and limitations in `README.md`; keep implementation and contributor guidance here.
- The reviewer alone manages staging. Do not stage, unstage, stash, or commit project changes. Preserve existing staged and unstaged work. Read-only `git diff HEAD` shows changes that plain `git diff` hides in the index.
- Treat pasted review feedback as the task input. Do not read, recreate, migrate, edit, or reply in the project's `REVIEW-NOTES.md`, legacy `COMMENTS.md`, or user-local review archives. Exclude these data files from searches. Recovery belongs to the reviewer.
- Tests may use synthetic in-memory feedback or disposable fixtures, never the user's review data. If the current task prohibits even fixture review-file/archive reads, skip the extension-host suite and report that limitation.
- Keep changes focused; add no compatibility layer without a concrete shipped or persisted contract. Existing archive records are such a contract. Do not introduce legacy scratch-file migration.
- Use Review Note(s) for extension-owned labels, prompts, tooltips, accessible text, and counters. Keep native VS Code comment APIs, internal model names, command/context IDs, and schema fields unchanged unless specifically required.
- The extension never stages, unstages, commits, or changes source code. Git integration is read-only. The optional `.gitignore` update requires reviewer approval.

## Architecture

TypeScript extension for VS Code 1.96+, package `dejareview`, ID `local-review.dejareview`, command/settings prefix `dejareview.`. Requires the bundled `vscode.git` extension and a containing local Git repository. Runtime npm dependencies are zero.

| File | Responsibility |
| --- | --- |
| `src/extension.ts` | Activation/disposal, commands, native drafts and saved threads, tree/status, decorations/hover, input guards, refresh scheduling and generations |
| `src/model.ts` | ReviewComment, ParsedComment, ResolvedAnchor, Resource, Origin, Side, Comparison and validation |
| `src/parser.ts` | Markdown scanning, parsing, base recognition, diagnostics and exact block offsets |
| `src/writer.ts` | Append, targeted body edit/delete, explicit line-number rewriting |
| `src/anchor.ts` | Content-based re-anchoring |
| `src/git.ts` | Git discovery, workspaceRepository adapter, origin/resource resolution and blobs |
| `src/editorContext.ts` | Frozen editor source/range, comparison picker, side/origin capture and snippet elision |
| `src/store.ts` | Saved-file reads, watcher/save notifications, serialized mutations, dirty/snapshot/symlink guards and handoff/recovery I/O |
| `src/handoff.ts` | Pure copyAndClear port, exact instruction and partial-success result types |
| `src/archive.ts` | Folder-scoped JSON archives, atomic publication, validated listing/reading |
| `src/dashboard.ts` | Webview provider, display metadata and validated actions |
| `src/dashboardHtml.ts` | Themed responsive dashboard shell and client script |

The parser, writer, anchor, port-based handoff and dashboard HTML are usable without a VS Code host. Native editor/tree UI stays in `extension.ts`; the webview is only for handoff and recovery, not a replacement composer. No AI service, account, PR integration, MCP server, daemon, agent replies, acceptance tracking, hunk inventory, or completion inference is in scope.

## Workspace And Git

- Scope everything to `vscode.workspace.workspaceFolders?.[0]`, deterministically. No picker, active-editor switching, arbitrary-repository fallback, or fallback to another workspace root.
- The opened folder owns `REVIEW-NOTES.md`, its watcher, paths, archive namespace, store, dashboard and mutation guards, even when it is a Git subfolder. Create notes lazily on first submission or explicit recovery, not activation.
- `workspaceRepository()` exposes the opened folder as `rootUri` and delegates Git state/events, commit resolution and revision operations to the containing Git repository. Translate workspace-relative paths only at the Git boundary. For `/repo/packages/app`, save `src/a.ts` while querying the parent Git resource `packages/app/src/a.ts`.
- Require local `file:` folders and supported `file:`/`git:` text resources. Reject outside-folder resources, other roots, nested separate repositories and cross-boundary comparisons. Discovering only a nested repository does not make a folder supported.
- Wait for Git initialization and retry discovery on relevant Git events. Workspace changes invalidate obsolete refreshes/actions and defer safely while mutations are busy; never retarget captured drafts or in-flight writes.
- Resolve origin separately from comparison side. `file:` means `changed`; Git query ref `''` means `staged`, `HEAD`/`head` means `head`, and `~` means index only when the absolute file URI belongs to `repo.state.indexChanges`, otherwise HEAD. Other supported refs resolve through `getCommit` to `commit:<full-sha>`.
- Git URI queries are an implementation detail: validate malformed/unavailable refs rather than guessing. Use absolute resource URIs for index membership and ownership checks.
- `.gitignore` suggestion state is scoped by opened folder URI and the current scratch filename suffix.

## Markdown Contract

The saved file is the sole source of the current review. UI is a full parse/resolve projection; archives are not current feedback until explicitly recovered. Never regenerate the whole file from the parsed model.

```text
document   := preamble? comment*
comment    := header anchor? comparison? body
header     := "## File: `" path "`; Lines: " range "; Origin: " origin "; Side: " side
range      := positive-int | positive-int "-" positive-int
origin     := "changed" | "staged" | "head" | "commit:" full-sha
side       := "document" | "left" | "right"
comparison := "Comparison: Left: `" path "` (" origin "); Right: `" path "` (" origin ")"
```

- The optional H1 carries a short base SHA; preserve the writer's existing preamble format. If HEAD moves from the recorded base, HEAD/index notes become suspect and stale with a warning, not automatically rebased.
- Paths are opened-folder-relative POSIX paths; accept backslashes on read and normalize on write. Ranges are 1-based inclusive in the selected origin. Side records capture provenance, not acceptance or a fixed mapping from origin to pane.
- The anchor is only the immediately following code fence, allowing blank lines. Prose before a fence means no anchor. Comparison metadata occupies the next reserved position; left/right notes require an ordered pair whose selected endpoint agrees with File/Origin. Document notes omit it.
- Track backtick and tilde fences, including longer runs. Only an unfenced `##` starts a block. Tolerate header whitespace and case-insensitive origin/side values; require Side. Full commit hashes may be 40 or 64 hexadecimal characters.
- Duplicate headers are distinct notes. Preserve unknown sections, malformed blocks, preamble text, BOM, CRLF and other original formatting; publish diagnostics instead of guessing malformed metadata or dropping feedback.
- Append preserves preceding bytes. Body edits splice only the body and preserve comparison metadata and sibling blocks. Deletion removes the target block and exactly one following blank separator. Preserve BOM-aware splice offsets.
- UI bodies require balanced fences, no unfenced `##` headings and no content masquerading as reserved anchor/comparison metadata. Use `###` for body headings.

## Capture And Anchoring

- Capture path, side-local range, origin, side, ordered comparison pair and original whole-line snippet. No selection means current line. A selection ending at column zero excludes that final line; native thread ranges include their end line.
- Keyboard/menu entry freezes source context before asynchronous UI and before typing. Never use whichever editor is active at submission to retarget a draft. Unsaved source buffers can provide captured text without saving or changing source.
- Preserve up to 20 lines verbatim; longer ranges store first 10, a bare `...`, and last 5 while retaining the full range. This is fixed, not configurable. Recognize elision only for that shape and a range longer than 20; match both endpoints, allowing omitted length to change.
- Re-anchor against the selected origin, using the open buffer for `changed` when available. Try the recorded position, local search (default +/-50 lines), then whole-file search. Strip trailing whitespace and use a common-indentation-insensitive fallback. Ambiguous matches choose the nearest with low confidence; no anchor uses low-confidence line hints; no match is stale.
- Never search the opposite comparison resource as fallback. Stale notes remain in the tree and clipboard but have no anchored thread/decoration. Never automatically delete or rewrite them.
- Re-anchoring normally updates only display positions. Persist `Lines:` changes only for explicit `dejareview.reanchorAll`.

## Persistence And Concurrency

- Watch the opened folder's root file and handle save events, explicit refresh and mutations. Unsaved notes are not parsed; source-buffer changes may re-anchor. Missing notes clear saved projections without recreating the file or restoring archives. Preserve input during refresh.
- Debounce/coalesce notifications. Explicit writes refresh; watcher reads never write, so duplicate reads are harmless. Do not add last-written suppression or promise exactly one parse or fixed refresh latency.
- Generation tokens prevent obsolete async refresh publication. Action arguments carry the entry, folder scope and exact saved snapshot, not a semantic stable ID.
- Before a stale edit/delete/reveal, reparse the saved snapshot. Use the index only if snapshot and raw block match; otherwise require a uniquely matching exact raw block in both old and current parses. Reject ambiguous duplicates or changed entries, preserve edit input and ask to refresh.
- Serialize mutations per opened folder. Dirty review buffers block writes with Save and retry / Cancel. Keep snapshot, symlink and file validation guards; never write under unsaved feedback.
- `workspace.fs` has no atomic compare-and-write/delete against external writers. Rechecks protect observed changes but cannot eliminate the final filesystem race. Do not claim transactional clearing/recovery.

## Handoff And Archives

Keep `HANDOFF_INSTRUCTION` in `src/handoff.ts` and its exact-string test synchronized. The current instruction is:

> Address the review feedback below using the file paths, captured snippets, and Original/Modified comparison context. Paths are relative to the opened project folder; locations and snippets may be stale. All explicitly approved changes are already staged. Never stage or unstage anything; only the reviewer manages staging. Summarize your changes in this conversation.

1. Validate folder scope, busy state and known drafts/edits. Offer finish, explicit discard-on-success, or cancellation for known input; dirty review buffers require save/retry or cancel.
2. Read the complete saved raw snapshot. Missing/whitespace-only content leaves clipboard and file untouched. Malformed/free-form feedback remains meaningful even with zero parsed notes.
3. Copy instruction plus raw text, including stale/malformed content and captured snippets. Await clipboard success.
4. Durably archive the exact raw snapshot without the instruction using temporary JSON plus atomic rename without overwriting an archive. Await success before clearing.
5. Recheck dirty state and source snapshot, then delete only the opened folder's notes file. Concurrent changes retain live feedback and the archived snapshot. Failures report partial success explicitly; do not restore or clear the clipboard.
6. Only after successful clearing, clear saved projections and explicitly authorized known input. Keep unobservable native drafts alive. A new submission creates a fresh base unless a batch was recovered first.

Archives use `globalStorageUri/reviews/<sha256(openedFolderURI)>/<uuid>.json`. Preserve the existing version and fields: `version`, `id`, `repoUri`, `text`, `createdAt`, `commentCount`. Legacy `repoUri` holds the opened folder URI; do not rename it or migrate records. Validate IDs, identity, URI, dates, counts and text; invalid/path-like IDs cannot access arbitrary files. Skip invalid list records.

Git-root namespaces stay compatible; subfolder namespaces are isolated. Never scan other namespaces or rewrite historical raw contents, paths or filename mentions. Show the latest 10 valid batches newest-first, but retain all older batches. No purge, archive-delete action, synchronization or encryption is provided.

Recovery is explicit and keeps the archive. Refuse active feedback, dirty buffers, known drafts/edits, busy mutations and changed snapshots. Restore exact raw text, including BOM/CRLF and original base, only into an absent or unchanged whitespace-only file. Never merge or silently overwrite. Reparse/refresh only after restore; never recover automatically on activation or an empty file.

## UI And API Limits

- Native multiline comments are single-note containers; disable replies after submission. No resolution state or separate thread store. Apply projections to every matching visible editor, not just the active editor.
- Resolve diff side using full URI (including query) against ordered `TabInputTextDiff` endpoints. Ask when uncertain or same-URI; scheme, path and viewColumn alone cannot identify the focused side. Match display resources by folder/repository, path and origin, not text or path alone.
- Stable APIs expose neither native gutter draft creation context nor all unsubmitted drafts. At native submission, capture then-current source text before the picker and confirm context. Copy excludes unsaved composer text; preserve unobservable drafts for the next pass, without promising persistence across reloads.
- Native threads are URI/range scoped, not pane scoped. Same-URI comparisons can show a thread on both sides. Inline Original-side placement is unreliable. Only explicit Open Side-by-Side Comparison may invoke `toggle.diff.renderSideBySide`; normal navigation must not change layout or substitute the Modified side.
- Preserve capture labels even when the revision is later shown on another side. Tree navigation reopens ordered comparisons; stale notes reveal their Markdown block. Offer selected-revision navigation when exact pane placement is unavailable.
- Use untrusted Markdown for bodies, hovers and tooltips (`isTrusted = false`, `supportHtml = false`); no executable links from user feedback. Badges are `[review]` at the first resolved line with an overview-ruler mark; duplicate notes retain separate identities.
- Dashboard shows parsed count, copy action and empty-review history, with no repository heading/selector. Raw meaningful feedback, not count, determines visibility. Initially hide copy and its explanation; show both for meaningful raw feedback, disabling rather than hiding the button while busy. Hide tree toolbar copy without feedback and disable it while busy.
- The primary Copy Review Notes & Clear button is full-width and at least 48px tall. Use VS Code theme/focus/high-contrast tokens, accessible labels, keyboard controls and narrow-sidebar wrapping. History shows local dates and singular/plural review-note counts, including zero.
- Webview uses nonce-based restrictive CSP, no remote resources and text-only metadata rendering. Send display metadata, not raw code/feedback. Validate action schema, current folder key, archive membership, mode and busy state again in the host; stale/cross-folder actions must fail safely.

## Commands And Settings

`package.json` is the command/menu/keybinding source of truth. Preserve `dejareview.` IDs: `addComment`, `submitComment`, `editComment`, `saveComment`, `cancelEdit`, `cancelDraft`, `deleteComment`, `reveal`, `gotoCode`, `openComparison`, `copyForAgent`, `restoreArchive`, `reanchorAll`, `refresh`, `suggestGitignore`. No `selectRepository` command.

Add Review Note uses Ctrl+Alt+M / Cmd+Alt+M with `editorTextFocus`; read-only Git panes remain supported. Entry is native gutter, editor menu or palette, not a CodeActionProvider. Settings are only `dejareview.decorationStyle` (`badge`/`none`, default `badge`) and `dejareview.searchRadius` (0-10000, default 50).

## Verification

```sh
npm run check
npm test
npm run test:integration
npm run package
git diff --check
```

`npm test` compiles and runs `test/core.test.ts`, `test/handoff.test.ts`, and `test/dashboard.test.ts`, using synthetic in-memory feedback. Keep regressions for duplicate identity, BOM/CRLF offsets, fenced Markdown, malformed metadata, targeted writes, elided/ambiguous/stale anchors, partial handoff failures and async races, dashboard visibility and action validation.

`test/runIntegration.ts` runs root and subfolder extension hosts using `/Applications/Visual Studio Code.app/Contents/MacOS/Code` by default; override `VSCODE_EXECUTABLE_PATH` for another installation. It creates disposable Git fixtures and isolated user-data/extensions directories, isolates Git configuration, stages/commits only fixture source, and cleans up. Integration tests read/write synthetic notes and archives and restore clipboard text, not other clipboard formats. Never point them at the project or a user's workspace/storage.

Coverage includes native command/API flows, Git origins and capture, saved projections, targeted mutations, watcher refresh, re-anchoring, clipboard/archive failure safeguards, archive retention/validation/recovery, and subfolder startup/storage with parent-Git delegation and outside-folder rejection. Do not confuse fixture/command coverage with visual acceptance. Multi-root reorder/switch races, nested separate repository rejection, and historical archive compatibility need explicit fixtures before claiming comprehensive coverage.

Manual validation remains necessary for visual gutter/composer actions, physical shortcuts, modal context/dirty/draft prompts, reload/split-editor UX, inline/same-URI placement, narrow sidebars, keyboard focus and light/dark/high-contrast themes.

Packaging produces `dejareview-0.1.0.vsix`; `.vscodeignore` excludes this technical guide, source/tests, maps, development dependencies and review data. Do not package local feedback or archive contents. Report commands actually run and skipped checks honestly; do not claim audit cleanliness without a current audit.
