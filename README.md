# Simple Loop-Review Comments

Local code-review feedback for VS Code 1.96+. Add comments beside code, keep them in the repository's `COMMENTS.md`, then copy a review pass into any AI tool. No AI service, account, or runtime npm dependencies; the bundled `vscode.git` extension must be enabled. The extension provides no staging commands and does not change the index or source code.

### Install

With Node.js, npm, and Git installed, run from this project:

```sh
npm install
npm test
npm run package
```

In VS Code, open **Extensions**, choose **Install from VSIX...** from its menu, and select the generated `simple-loop-review-0.1.0.vsix`. For development instead, open this project and press **F5** with **Run Loop Review** selected; the launch task compiles and opens an Extension Development Host.

### Review

1. Open a local Git repository and a text file or comparison. The **Loop Review** activity-bar view shows the selected repository; use **Select Review Repository** in its title bar or Command Palette when working with multiple repositories. Adding a comment selects its source repository. Copy-and-clear acts only on the selected repository.
2. Select lines, or leave the cursor on one line. Press **Ctrl+Alt+M** (**Cmd+Alt+M** on macOS), or use **Add Review Comment** in the editor context menu/Command Palette. The shortcut is recommended: it captures the source, range, side, and snippet before you type. Confirm the context if asked.
3. Alternatively, hover the native comment gutter and click **+**. Type multiline feedback and choose **Add Comment**. Native gutter drafts require context confirmation at submission and capture the source text as it exists then, not when the gutter was clicked.
4. Expand saved gutter comments to read, edit, save, cancel, or delete them. The **Review Comments** view groups comments by file, with a **Stale** group for missing anchors; click to navigate, or use **Reveal in COMMENTS.md**. Hand-editing and saving that file is supported; **Refresh Comments** explicitly reloads it.
5. Finish submitting comments and saving edits, then use **Copy Comments & Clear (Deletes COMMENTS.md)** in the view title or Command Palette. Paste the clipboard into your AI tool. The command copies the saved file with a handoff instruction, then deletes it only after clipboard success and unchanged-file/dirty-buffer checks. Copy failure retains feedback; a change or deletion failure after copying reports that the file was not cleared.

Saved feedback includes repo-relative paths, side-local line ranges, origins (`changed`, `staged`, `head`, or a commit), captured snippets, and **Document / Left Original / Right Modified** context with both comparison endpoints. This context persists across reloads in `COMMENTS.md`; displaying a revision elsewhere does not change its captured side. The next submitted comment creates a fresh file after a successful handoff. Adding `COMMENTS.md` to `.gitignore` is optional and requires your approval.

### v0.1 Limits

- Only local Git repositories and their `file:` / `git:` text resources are supported. No untitled buffers, arbitrary virtual documents, remote repository schemes, notebook/custom/merge editors, or cross-repository comparisons.
- Stable VS Code APIs cannot observe a native gutter draft's initial context or enumerate those unsubmitted drafts. Copy exports submitted, saved comments only, plus all saved raw notes and malformed blocks, never unsaved composer text. Known shortcut drafts and open edits prompt you to finish first or explicitly discard them on successful copy-and-clear. Unsubmitted native gutter drafts are preserved, not silently destroyed, and remain available for the next pass; they are not persisted in `COMMENTS.md` until submitted.
- Inline diffs do not reliably display original-side native threads. Explicitly invoke **Open Side-by-Side Comparison** on a comparison comment as a fallback. Only this action invokes `toggle.diff.renderSideBySide` when the diff is inline; ordinary navigation does not change the layout. If both sides use the same URI, VS Code may show a comment on both sides despite its preserved capture label.
- Comment bodies require balanced Markdown fences and no unfenced `##` headings, which delimit review blocks. Use `###` for body headings. Anchors capture whole lines: up to 20 verbatim; longer selections use the first 10 lines, a bare `...`, and the last 5, retaining the full range. This limit is fixed, not a setting.
- Re-anchoring updates display positions, not the saved snippets or line numbers. **Rewrite Line Numbers from Anchors** is explicit. Settings are limited to `loopReview.decorationStyle` (`badge` or `none`) and `loopReview.searchRadius` (default `50`).

### Tests And Status

`npm test` runs the pure parser, writer, anchor, and handoff tests. Run the extension-host suite with:

```sh
npm run test:integration
```

The runner uses the system macOS executable at `/Applications/Visual Studio Code.app/Contents/MacOS/Code`. For another installation, set its actual VS Code executable path:

```sh
VSCODE_EXECUTABLE_PATH="/path/to/VS Code executable" npm run test:integration
```

Integration tests use a disposable Git fixture, isolated user-data and extensions directories, and restore the previous clipboard **text** in cleanup (not other clipboard formats). They exercise commands, resource capture, persistence, watchers, and clipboard handoff. They do not verify visual gutter clicking, physical shortcuts, native draft prompts, or inline/same-URI placement; manual UI validation remains pending. See `SPECIFICATION.md` in the source project for the detailed contract and validation checklist.

There are zero runtime npm dependencies. `npm audit` currently reports low-severity transitive warnings in development/packaging tooling, including age/license-policy findings; the development dependency tree is not audit-clean.
