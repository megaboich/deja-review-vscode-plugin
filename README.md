# DejaReview

Local code-review feedback for VS Code 1.96+. Add comments beside code, keep them in the repository's `COMMENTS.md`, then copy a review pass into any AI tool. No AI service, account, or runtime npm dependencies; the bundled `vscode.git` extension must be enabled. The extension provides no staging commands and does not change the index or source code.

### Install

With Node.js, npm, and Git installed, run from this project:

```sh
npm install
npm test
npm run package
```

In VS Code, open **Extensions**, choose **Install from VSIX...** from its menu, and select the generated `dejareview-0.1.0.vsix`. For development instead, open this project and press **F5** with **Run DejaReview** selected; the launch task compiles and opens an Extension Development Host.

The extension ID is `local-review.dejareview`, with command/settings prefix `dejareview.`. The renamed extension cannot automatically update an installation of `local-review.simple-loop-review`; disable or uninstall that previous extension if both are installed.

### Review

1. Open a local Git repository and a text file or comparison. The **DejaReview** activity-bar view shows the selected repository; use **Select Review Repository** in its title bar or Command Palette when working with multiple repositories. Adding a comment selects its source repository. Copy-and-clear acts only on the selected repository.
2. Select lines, or leave the cursor on one line. Press **Ctrl+Alt+M** (**Cmd+Alt+M** on macOS), or use **Add Review Comment** in the editor context menu/Command Palette. The shortcut is recommended: it captures the source, range, side, and snippet before you type. Confirm the context if asked.
3. Alternatively, hover the native comment gutter and click **+**. Type multiline feedback and choose **Add Comment**. Native gutter drafts require context confirmation at submission and capture the source text as it exists then, not when the gutter was clicked.
4. Expand saved gutter comments to read, edit, save, cancel, or delete them. The **Review Comments** view groups comments by file, with a **Stale** group for missing anchors; click to navigate, or use **Reveal in COMMENTS.md**. Hand-editing and saving that file is supported; **Refresh Comments** explicitly reloads it.
5. Finish submitting comments and saving edits, then use **Copy Comments & Clear**, the central full-width button (at least 48px tall) in the **Review** webview dashboard above the native **Review Comments** tree. The sidebar follows your VS Code theme; comment creation and editing remain native. The command is also available in the tree title and Command Palette. It copies the saved file with a handoff instruction, atomically saves an archive via a temporary file and rename, then rechecks the source and dirty-buffer state before deleting `COMMENTS.md`. Clipboard or archive failure retains the source; an archive failure may leave the clipboard already copied. If the source changes, the original snapshot stays archived and the live file remains intact. Deletion failure also leaves feedback available.
6. Paste the clipboard into your AI tool. The handoff tells the agent not to read, recreate, or reply in root `COMMENTS.md`; feedback has been archived, not permanently discarded. When no saved meaningful raw feedback remains (the file is missing or whitespace-only), the dashboard shows the selected repository's latest 10 archived batches, newest first, with copy/creation dates, parsed comment counts, and **Recover** actions. Any non-whitespace raw feedback hides archive history and remains copyable, even malformed blocks or free-form notes showing **0 comments**.

Saved feedback includes repo-relative paths, side-local line ranges, origins (`changed`, `staged`, `head`, or a commit), captured snippets, and **Document / Left Original / Right Modified** context with both comparison endpoints. This context persists across reloads in `COMMENTS.md`; displaying a revision elsewhere does not change its captured side. The next submitted comment creates a fresh file after a successful handoff unless you recover a batch first. Adding `COMMENTS.md` to `.gitignore` is optional and requires your approval.

### Archives And Recovery

Root `COMMENTS.md` remains the sole source of the current review. Archives persist across reloads and restarts but do not populate current comments until explicitly recovered. Use **Recover** or **Recover Archived Review** (`dejareview.restoreArchive`) to write the archive's exact original raw text, including its original base SHA, back to `COMMENTS.md`. Recovery never merges with or overwrites active feedback, dirty buffers, or known in-flight drafts/edits, and keeps the archived copy. Finish or cancel input first; native gutter drafts still have the limitations below.

Archives live outside the repository in the extension's user-local machine storage at `globalStorageUri/reviews/<sha256(repoURI)>/<uuid>.json`. Each record contains the repository URI, raw text (including captured code snippets), creation/copy date, and parsed comment count. Only the latest 10 appear in the UI; older batches are retained, with no automatic purge or archive-delete action. This is local recovery storage, not conversation history, synced storage, or an encrypted backup. DejaReview does not sync or encrypt these files; account for the retained code and feedback when managing local storage.

### v0.1 Limits

- Only local Git repositories and their `file:` / `git:` text resources are supported. No untitled buffers, arbitrary virtual documents, remote repository schemes, notebook/custom/merge editors, or cross-repository comparisons.
- Stable VS Code APIs cannot observe a native gutter draft's initial context or enumerate those unsubmitted drafts. Copy exports submitted, saved comments only, plus all saved raw notes and malformed blocks, never unsaved composer text. Known shortcut drafts and open edits prompt you to finish first or explicitly discard them on successful copy-and-clear. Unsubmitted native gutter drafts are preserved, not silently destroyed, and remain available for the next pass; they are not persisted in `COMMENTS.md` until submitted.
- Inline diffs do not reliably display original-side native threads. Explicitly invoke **Open Side-by-Side Comparison** on a comparison comment as a fallback. Only this action invokes `toggle.diff.renderSideBySide` when the diff is inline; ordinary navigation does not change the layout. If both sides use the same URI, VS Code may show a comment on both sides despite its preserved capture label.
- Comment bodies require balanced Markdown fences and no unfenced `##` headings, which delimit review blocks. Use `###` for body headings. Anchors capture whole lines: up to 20 verbatim; longer selections use the first 10 lines, a bare `...`, and the last 5, retaining the full range. This limit is fixed, not a setting.
- Re-anchoring updates display positions, not the saved snippets or line numbers. **Rewrite Line Numbers from Anchors** is explicit. Settings are limited to `dejareview.decorationStyle` (`badge` or `none`) and `dejareview.searchRadius` (default `50`).

### Tests And Status

`npm test` runs the pure parser, writer, anchor, handoff, and dashboard tests. Run the extension-host suite, including archive persistence and recovery tests, with:

```sh
npm run test:integration
```

The runner uses the system macOS executable at `/Applications/Visual Studio Code.app/Contents/MacOS/Code`. For another installation, set its actual VS Code executable path:

```sh
VSCODE_EXECUTABLE_PATH="/path/to/VS Code executable" npm run test:integration
```

Integration tests use a disposable Git fixture, isolated user-data and extensions directories, and restore the previous clipboard **text** in cleanup (not other clipboard formats). They exercise commands, resource capture, persistence, watchers, and clipboard handoff. They do not verify visual gutter clicking, physical shortcuts, native draft prompts, or inline/same-URI placement; manual UI validation remains pending. See `SPECIFICATION.md` in the source project for the detailed contract and validation checklist.

There are zero runtime npm dependencies. `npm audit` currently reports low-severity transitive warnings in development/packaging tooling, including age/license-policy findings; the development dependency tree is not audit-clean.
