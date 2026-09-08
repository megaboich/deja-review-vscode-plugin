# DejaReview

Local code-review feedback for VS Code 1.96+. Add review notes beside code, keep them in the opened workspace folder's root `REVIEW-NOTES.md`, then copy a review pass into any AI tool. No AI service, account, or runtime npm dependencies; the bundled `vscode.git` extension must be enabled and a containing Git repository is required. The extension provides no staging commands and does not change the index or source code.

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

Review agent changes in VS Code, stage the hunks you approve using the built-in Source Control UI, and leave **Review Notes** where more work is needed. Staging and adding a note are independent: an approved pattern can still receive a note asking the agent to use it elsewhere. Only you manage staging; DejaReview does not track acceptance or infer review completion.

1. Open a local folder in a Git repository and a text file or comparison. DejaReview automatically scopes the review to the **first VS Code workspace folder**. With multiple workspace roots, folder order deterministically decides the scope; other roots are unsupported. There is no repository picker or active-editor switching. Opening a subfolder inside a repository keeps `REVIEW-NOTES.md` at that opened folder's root, not the Git root.
2. Select lines, or leave the cursor on one line. Press **Ctrl+Alt+M** (**Cmd+Alt+M** on macOS), or use **Add Review Note** in the editor context menu/Command Palette. The shortcut is recommended: it captures the source, range, side, and snippet before you type. Confirm the context if asked.
3. Alternatively, hover the native comment gutter and click **+**. Type multiline feedback and choose **Add Review Note**. Native gutter drafts require context confirmation at submission and capture the source text as it exists then, not when the gutter was clicked.
4. Expand saved gutter review notes to read them, use **Edit Review Note** or **Delete Review Note**, or save/cancel edits. The **Review Notes** view groups review notes by file, with a **Stale** group for missing anchors; click to navigate, or use **Reveal in REVIEW-NOTES.md**. Hand-editing and saving that file is supported; **Refresh Review Notes** explicitly reloads it.
5. Finish submitting review notes and saving edits, then use **Copy Review Notes & Clear**, the central full-width button (at least 48px tall) in the **Review** webview dashboard above the native **Review Notes** tree. The sidebar follows your VS Code theme; creation and editing remain in the native comment UI. The command is also available in the tree title when saved meaningful feedback exists, and in the Command Palette. It copies the saved file with a handoff instruction, atomically saves an archive via a temporary file and rename, then rechecks the source and dirty-buffer state before deleting `REVIEW-NOTES.md`. Clipboard or archive failure retains the source; an archive failure may leave the clipboard already copied. If the source changes, the original snapshot stays archived and the live file remains intact. Deletion failure also leaves feedback available.
6. Paste the clipboard into your AI tool. The handoff tells the agent to use the captured context, never stage or unstage anything, and summarize changes in the conversation. Feedback has been archived, not permanently discarded. When no saved meaningful raw feedback remains (the file is missing or whitespace-only), the dashboard shows that folder's latest 10 archived batches, newest first, with copy/creation dates, parsed review note counts labeled **review notes**, and **Recover** actions. Any non-whitespace raw feedback hides archive history and remains copyable, even malformed blocks or free-form notes showing **0 review notes**.

Saved feedback includes opened-workspace-folder-relative paths, side-local line ranges, origins (`changed`, `staged`, `head`, or a commit), captured snippets, and **Document / Left Original / Right Modified** context with both comparison endpoints. Git discovery supplies revisions from the containing repository, including a parent repository when a subfolder is opened; it does not move the review file or change its path scope. This context persists across reloads in `REVIEW-NOTES.md`; displaying a revision elsewhere does not change its captured side. The next submitted comment creates a fresh file after a successful handoff unless you recover a batch first. A previously named scratch file is not scanned or migrated automatically.

The dashboard shows the parsed review note count (including **0 review notes**), conditional copy action, and conditional archive history, with no repository heading or selection button. The copy button and its explanatory paragraph are hidden initially, until saved meaningful raw feedback is known, and whenever the file is missing or whitespace-only. Both appear for any non-whitespace saved text, even with zero parsed review notes. While busy, the button stays visible but disabled, and the paragraph stays visible; busy state does not hide them. The tree toolbar copy action is likewise hidden without saved meaningful feedback and disabled, not hidden, while busy with feedback. The empty-review archive list remains available independently of the hidden copy controls. An optional unavailable-state diagnostic can ask you to open a local project folder in a Git repository; it does not offer a repository picker or silently choose another scope. Files outside the first workspace folder and nested separate repositories are unsupported, even if Git discovers them.

Adding `REVIEW-NOTES.md` to the opened folder's `.gitignore` is optional and requires your approval. The one-time suggestion is scoped per opened folder and current scratch filename, so another folder or a previous filename's dismissal does not suppress it.

### Archives And Recovery

The opened folder's root `REVIEW-NOTES.md` remains the sole source of the current review. Archives persist across reloads and restarts but do not populate current comments until explicitly recovered. Use **Recover** or **Recover Archived Review** (`dejareview.restoreArchive`) to write the archive's exact original raw text, including its original base SHA, back to `REVIEW-NOTES.md`. Recovery never merges with or overwrites active feedback, dirty buffers, or known in-flight drafts/edits, and keeps the archived copy. Finish or cancel input first; native gutter drafts still have the limitations below.

Archives live outside the repository in VS Code's user-local extension storage. They contain the exact saved feedback (including captured code snippets), the copy/creation date, and the parsed review note count. Existing Git-root archives stay accessible when that root is opened; opening a subfolder uses separate history. Historical contents are never rewritten. Only the latest 10 appear in the UI; older batches are retained, with no automatic purge or archive-delete action. This is local recovery storage, not conversation history, synced storage, or an encrypted backup. DejaReview does not sync or encrypt these files; account for the retained code and feedback when managing local storage.

### Hand-Edited Notes

You can edit and save `REVIEW-NOTES.md` directly. Notes are a flat list of `##` blocks with readable metadata, an optional captured code fence, and feedback prose:

````md
## File: `src/client.ts`; Lines: 42; Origin: changed; Side: right

```ts
const response = await fetch(url);
```

Comparison: Left: `src/client.ts` (staged); Right: `src/client.ts` (changed)

Handle request failures before using the response.
````

Paths are relative to the opened folder. Line ranges are 1-based and inclusive, belonging to the selected origin and side, not necessarily the working tree. A regular-editor note uses `Side: document` without a `Comparison:` line. Keep the anchor fence immediately after the header and comparison metadata immediately after the anchor (blank lines are allowed). Use `###` rather than `##` for headings inside feedback, and balance Markdown fences.

Unknown sections and malformed blocks are preserved and copied even when they cannot appear as anchored notes. Missing anchors use line hints with low confidence. Snippets that cannot be found appear under **Stale** and are still copied; stale notes are never automatically deleted. If the optional review base differs from the current HEAD, index/HEAD notes are marked stale rather than rebased automatically.

### Agent Guidance

No agent configuration is required: clipboard feedback is self-contained. If you maintain instructions for your AI tool, you can also tell it:

- Only the reviewer manages staging; never stage or unstage changes.
- Use pasted feedback and captured snippets to locate code; line numbers may be stale, and Original/Modified context matters.
- Do not read, recreate, or reply in `REVIEW-NOTES.md`, or inspect local review archives. Recovery is the reviewer's explicit action.
- Address the requested changes, leave unrelated work alone, and summarize results in the conversation.

DejaReview does not create or edit agent instructions in reviewed projects.

### v0.1 Limits

- Only local Git repositories and their `file:` / `git:` text resources are supported. No untitled buffers, arbitrary virtual documents, remote repository schemes, notebook/custom/merge editors, or cross-repository comparisons.
- Stable VS Code APIs cannot observe a native gutter draft's initial context or enumerate those unsubmitted drafts. Copy exports submitted, saved comments only, plus all saved raw notes and malformed blocks, never unsaved composer text. Known shortcut drafts and open edits prompt you to finish first or explicitly discard them on successful copy-and-clear. Unsubmitted native gutter drafts are preserved, not silently destroyed, and remain available for the next pass; they are not persisted in `REVIEW-NOTES.md` until submitted.
- Save hand-edited review notes before copying or making other changes through the extension. Dirty review buffers block writes with **Save and retry** / **Cancel**. Snapshot checks protect observed concurrent changes, but clearing and recovery cannot be transactional against external filesystem writers. Native drafts are transient and are not guaranteed to survive reloads.
- Inline diffs do not reliably display original-side native threads. Explicitly invoke **Open Side-by-Side Comparison** on a comparison comment as a fallback. Only this action invokes `toggle.diff.renderSideBySide` when the diff is inline; ordinary navigation does not change the layout. If both sides use the same URI, VS Code may show a comment on both sides despite its preserved capture label.
- Comment bodies require balanced Markdown fences and no unfenced `##` headings, which delimit review blocks. Use `###` for body headings. Anchors capture whole lines: up to 20 verbatim; longer selections use the first 10 lines, a bare `...`, and the last 5, retaining the full range. This limit is fixed, not a setting.
- Re-anchoring updates display positions, not the saved snippets or line numbers. **Rewrite Line Numbers from Anchors** is explicit. Settings are limited to `dejareview.decorationStyle` (`badge` or `none`, default `badge`) and `dejareview.searchRadius` (0-10000, default `50`).

### Tests And Status

`npm test` runs the pure parser, writer, anchor, handoff, and dashboard tests. Run the extension-host suite, including archive persistence and recovery tests, with:

```sh
npm run test:integration
```

The runner uses the system macOS executable at `/Applications/Visual Studio Code.app/Contents/MacOS/Code`. For another installation, set its actual VS Code executable path:

```sh
VSCODE_EXECUTABLE_PATH="/path/to/VS Code executable" npm run test:integration
```

Integration tests use disposable Git fixtures, isolated user-data and extensions directories, and restore the previous clipboard **text** in cleanup (not other clipboard formats). They exercise commands, resource capture, persistence, watchers, clipboard handoff, and archive recovery. Separate root and subfolder hosts cover opened-folder storage, parent-Git delegation, and outside-folder resource rejection. Tests do not verify visual gutter clicking, physical shortcuts, native draft prompts, or inline/same-URI placement; manual UI validation remains pending.

For architecture, persistence contracts, development commands, and contributor constraints, see `AGENTS.md` in the source repository (not included in the VSIX).

There are zero runtime npm dependencies. Development and packaging tools have transitive dependencies; run `npm audit` for their current findings rather than assuming the development dependency tree is audit-clean.
