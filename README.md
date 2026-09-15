# DejaReview

**Review code where you work. Send your AI one clear review pass.**

DejaReview brings your feedback together in a single **Review Notes** panel in VS Code. Leave a note beside the code or add a general request for the whole review, refine your feedback in the panel, then copy it into any AI tool. No manually copying file paths, line numbers, or code snippets: file-specific notes capture that context for you.

- **Keep feedback in context.** Select code in a file or diff and write what needs to change. DejaReview remembers the selected revision and comparison side.
- **Say more than line comments allow.** Add general feedback about design, tests, or the next iteration without opening a file.
- **Manage one review pass in one place.** Browse changed files, revisit notes, and edit any saved note from its card.
- **Hand off without losing your review.** Copy saved feedback with instructions for your agent, keep a local recovery archive, and start the next pass with a clear panel.

The loop is simple: **review changes, stage what you approve, leave notes for what needs work, copy the review, repeat.** DejaReview does not run an AI or require an account.

## Install

1. In VS Code, open **Extensions** and choose **Install from VSIX...** from its menu.
2. Select `dejareview-0.1.0.vsix`.
3. Open a local folder inside a Git repository, then open the **Review Notes** panel.

Requires **VS Code 1.96+**, Git, and VS Code's bundled Git extension enabled. In a multi-root workspace, only the **first folder** is used, not whichever editor is active. Opening a repository subfolder keeps the review and its paths scoped to that subfolder. There is no repository picker.

Building a VSIX or developing the extension is covered in `AGENTS.md` in the source repository.

## Review Workflow

### Add Feedback

For a file-specific note, select lines in a text file or diff and press **Ctrl+Alt+M** (**Cmd+Alt+M** on macOS). With no selection, the current line is used. **Add Review Note** is also available in the editor context menu and Command Palette. Type your feedback in the native comment composer and submit it.

The shortcut captures the file, lines, snippet, and comparison context **before you type**. You can also click **+** in the native comment gutter, but gutter notes capture source text at submission. If the comparison side is ambiguous, DejaReview asks rather than guessing.

For feedback that is not tied to code, use **Add General Review Note** in the toolbar inside the Review Notes panel. A floating editor opens in the panel with **Save** and **Cancel**; **Escape** cancels. No file or text selection is required, but a supported local project folder in Git is still required.

For feedback on an entire changed file, use the note-bubble **Add File Review Note** button in its **Files to Review** row. The same floating editor opens for that file, without needing an active editor or selection. Whole-file notes have a file path but no line range or snippet, and work for binary, untracked, and deleted files too. Saving the note hides that path from Files to Review.

### Refine The Review

The panel shows file-specific and general notes together in saved order, with a combined note count and a short two-line preview of each.

- Click a file note to open its code or captured comparison. If its snippet can no longer be located, the card opens the saved note in `REVIEW-NOTES.md` instead. Whole-file cards show just the filename and open the file, or its staged version for an unstaged deletion.
- Click a general note to edit it.
- Hover any card or move keyboard focus into it to reveal **Edit Review Note**, followed by **Delete Review Note**. Edit opens the floating editor for either kind of note; deletion asks for confirmation.
- Use **Save** to apply an edit, or **Cancel** / **Escape** to leave the saved note unchanged. File-note edits change the feedback, not its captured location or comparison context. Native gutter editing remains available for file notes.

The panel editor keeps your input when the panel refreshes or is hidden and reopened during the session. A failed save keeps your text so you can resolve the problem and retry. Finish or cancel this editor before copying a review or recovering an archive. Unsaved input is not guaranteed to survive a VS Code reload.

Saved feedback lives in `REVIEW-NOTES.md` at the opened folder's root. It is created only when you first save a note or explicitly recover a review. You do not need to manage this file yourself, but hand-editing and saving it is supported. Use the panel title's **Refresh Review Notes** action if needed.

### Review Changed Files

**Files to Review**, above the note cards, helps you find files that still need attention. It lists unstaged changes and untracked files in the opened folder that have no saved file-specific note on their path.

The section heading shows the file count. Once the Review Notes view has initialized, its native Activity Bar badge shows the same count; the badge tooltip includes both files to review and saved Review Notes. The badge is hidden when there are no candidate files. VS Code controls its theme colors and visibility.

The validated file list appears before addition/deletion counts finish loading. New rows show Loading stats while counts are fetched in the background; file actions do not wait for those counts. Existing rows keep their last displayed counts or Stats unavailable during revalidation, without blinking back to loading. Git notifications recheck stats inputs and reuse counts when file metadata and the tracked file's index object are unchanged. Editor-only changes retain current counts. Explicit refresh forces recomputation; use it if an external tool changes content while preserving file timestamps and size.

- A saved file note hides that path even if it refers to an older revision or can no longer be located. A general note, an unsaved draft, or a note mentioning a file only as the other comparison endpoint does not hide it. Malformed notes are not used to guess file associations.
- Fully staged files are absent; partially staged files can remain while unstaged changes exist. The list updates with Git changes. After handoff or deletion of a file's last note, that file can reappear for the next pass.
- Click a tracked file for its unstaged diff, with VS Code's native Stage Hunk/Selection actions, an untracked file to open it, or a deleted file to see its staged version.
- A subtle background highlight marks files currently visible in an editor, including a diff pane. Hidden tabs do not count; split editors can mark multiple files. The highlight follows visible panes as you switch or close them.
- Hover or focus a row to reveal **Revert File**, **Add File Review Note**, then **Stage File**. These buttons overlay the top-right corner without reserving row space. Actions are disabled while a staging or revert operation, including its confirmation, is in progress. Failures are reported, and the list follows Git's actual state rather than assuming success.
- The affected row immediately shows an inset progress accent and stays read-only through verification, without adding a loading line or changing its height. Staging/reverting status remains available to screen readers. The panel refreshes immediately after the action, without the normal debounce delay. A row briefly collapses only after Git confirms it is no longer a candidate, never on an optimistic timeout. Reduced-motion preferences skip the animation. Failed candidate refreshes retain the last known list and show an error.

**Stage File** stages that whole file's saved disk state without a confirmation dialog, including remaining unstaged changes or a deletion. It does not save or stage unsaved editor text. Use VS Code Source Control to stage selected hunks instead.

When you stage the **first row**, DejaReview automatically opens the next remaining file after refreshed Git state confirms the staged file has disappeared. It uses the same editor/diff behavior as clicking that next row. Staging any other row or reverting does not advance. Failed staging, residual unstaged changes, and an empty remaining list do not open another file. Another dashboard action cancels a pending advance.

**Revert File** asks before discarding that file's unstaged disk changes. Tracked files are restored from the staging area, **not HEAD**, leaving staged changes intact. This restores an unstaged deletion, not a staged deletion. For untracked files, confirmation warns that the file will be removed and **Git cannot recover it**. A file with unsaved editor changes cannot be reverted; the extension never saves or discards those buffers for you. Conflicts, intent-to-add, and other unsupported states are refused rather than risking staged work.

Line counts compare the staging area with saved working-tree content, not unsaved editor text. New untracked text files are counted up to **5 MiB**. Binary, over-limit, or unavailable results show **Stats unavailable**; standard binary files, new files, and deletions can still be staged or reverted subject to the safeguards above.

File rows label Git-reported additions, removals, and renames relative to the **staging area**: for example **Added +60**, **Removed -60**, or **Renamed +2 -1**. Redundant zero counts are hidden on these labelled rows; modified files keep the usual **+N -N** display. Labels remain visible while statistics load or are unavailable. Once an addition or rename is staged, further edits show ordinary modified-file counts; the earlier staged change does not determine the label. A move appears as **Renamed** only when Git identifies an unstaged rename; otherwise it appears as separate added and removed files.

This is a files-only aid, **not approval or completion tracking**. An empty list means no current candidates, not that the review is complete. Neither staging nor reverting adds a note or marks work approved. Other workspace roots, nested separate repositories, the review file, and archives are excluded.

### Send The Review

1. Finish saving your notes and edits. Stage changes you approve using Source Control or **Stage File**; staging and leaving feedback are independent.
2. Select **Copy Review Notes & Clear** in the panel, or use the command with that name. It appears when there is meaningful saved feedback, including free-form or malformed text even if the parsed note count is zero.
3. Paste into your AI tool. The clipboard includes the saved review and instructions to use its context, never stage or unstage anything, and summarize changes in the conversation.
4. Review the resulting changes and begin the next pass. Your previous review is archived locally, not permanently discarded.

Copy exports **saved feedback only**, never unsaved editor text. An open dashboard editor must be finished or cancelled first. Known native drafts and native edits retain their existing choice: finish first, cancel the handoff, or explicitly discard that input **only after a successful copy-and-clear**. Unsubmitted gutter drafts that VS Code cannot expose are left alone for the next pass.

## Safety And Privacy

**You control staging and discarding.** Git access is read-only except for your explicit, single-file Stage File action or confirmed Revert File action. DejaReview never automatically or bulk stages or reverts, unstages, stashes, commits, or otherwise changes source code. Coding agents must not stage, unstage, stash, or invoke revert on workspace changes; the panel's reviewer actions do not grant agents that permission.

**Copy comes before clearing.** DejaReview copies the saved text, durably archives that exact review, then checks for unsaved or concurrent changes before removing the live review file. Clipboard failure leaves feedback intact. Archive failure also keeps it, though the clipboard may already contain the review. Concurrent changes or a clearing failure leave live feedback in place and report the partial result; a successfully created archive is retained.

Save direct edits to `REVIEW-NOTES.md` before changing saved feedback through the extension. Unsaved review-file edits block writes with **Save and retry** / **Cancel**. Temporary-file writes protect against partial-write failures, and checks catch observed external changes, but cannot eliminate every race with another program writing the same file. Failed cleanup can leave a `.REVIEW-NOTES.md.*.tmp` file containing feedback.

**Your review stays local until you share it.** DejaReview has no AI service, account, or remote upload. The review file and local archives include your feedback and captured code snippets; the clipboard sends that text wherever you choose to paste it. These files are not encrypted or synced by DejaReview. Adding `REVIEW-NOTES.md` to the opened folder's `.gitignore` is optional and requires your approval; the suggestion is remembered per folder and filename.

No agent configuration is required. If you maintain agent instructions, tell the agent to use the pasted feedback, preserve unrelated work, and summarize in the conversation. Do not have it read, recreate, or reply in `REVIEW-NOTES.md`, inspect local archives, or recover feedback without a separate explicit request. DejaReview does not edit your agent instructions.

## Archives And Recovery

Archive history is **hidden by default**, including after a handoff. Open **More actions (...)** in the toolbar inside the panel, then choose **Recent Archives**. While saved feedback is active, selecting this unavailable item explains that you must finish your review and use **Copy Review Notes & Clear** first. History hides when new saved feedback becomes active and does not reopen automatically after clearing. Close it with its close control when you are finished. Files to Review candidates do not prevent viewing history.

History shows the latest **10** valid batches, newest first, with local dates, total review-note counts including general notes, and **Recover** actions. **Recover Archived Review** also remains available in the Command Palette.

Recovery restores the exact saved text and its original review base into an absent or unchanged whitespace-only `REVIEW-NOTES.md`. It keeps the archive and never merges with or overwrites active feedback. Finish or cancel drafts and edits, including the dashboard editor, and resolve unsaved review-file changes first. Archives never become current notes automatically, even after a reload or when the review file is missing.

Archives live outside the repository in VS Code's user-local extension storage and survive restarts. Each opened folder has separate history: opening a repository subfolder does not show the parent folder's archives. Existing repository-root history stays available when that root is opened. Older batches are retained even though only the latest 10 are displayed; there is no purge or archive-delete action. Counts describe the archived batch, not a fresh recount. This is local recovery storage, not conversation history or an encrypted backup; account for the retained code and feedback when managing local storage. Previously named scratch files are not scanned or migrated.

## Limitations

- File-specific capture supports local text files and Git text revisions in the first workspace folder. Untitled buffers, arbitrary virtual documents, remote repository schemes, notebook/custom/merge editors, other roots, nested separate repositories, and cross-boundary comparisons are unsupported. General notes need no file, but still require the supported folder and containing Git repository.
- Paths through symbolic links below the containing Git root are rejected, even when the link points inside the project. On macOS/Linux, filenames containing literal backslashes are also unsupported rather than confused with directory separators. These restrictions apply to file capture, reads, and Files to Review actions.
- Native gutter drafts cannot reliably record the moment you clicked the gutter or expose every unsubmitted draft. Prefer the shortcut to freeze context before typing. If a revision changes during capture or composition, you may need to recapture; failed validation preserves your input. Native drafts and dashboard input are transient, not reload-persistent storage.
- Inline diffs do not reliably show Original-side native notes. Use the native **Open Side-by-Side Comparison** action when needed; normal card navigation does not change your diff layout. When both panes show the same resource, VS Code may display a note on both sides even though its saved context identifies the selected side.
- Snippets capture whole lines: up to 20 verbatim, or the first 10 and last 5 for longer selections, with an explicit omission marker. Locations may become stale. DejaReview adjusts display positions when it can find the snippet, but does not automatically rewrite saved lines, snippets, or remove stale feedback. A changed review base makes HEAD/staging-area notes stale rather than silently rebasing them. **Rewrite Line Numbers from Anchors** is an explicit action for file notes.
- Settings are limited to `dejareview.decorationStyle` (`badge` or `none`, default `badge`) and `dejareview.searchRadius` (0-10000, default `50`). There is no AI integration, PR workflow, reply thread, or review-completion model.

## Optional Markdown

You can hand-edit and save `REVIEW-NOTES.md`, but the panel and native composer handle this format for you. General notes have the exact heading `## General Review Note` and a body, with no file path, location, or captured snippet. File notes include their captured context:

````md
## General Review Note

Add regression tests for the error-handling changes before the next pass.

## `src/client.ts`:file
Selected: Working tree

Split this file into smaller modules.

## `src/client.ts`:42
Comparison: HEAD -> Staging area
Selected: Modified (Staging area)

```ts
const response = await fetch(url);
```

Handle request failures before using the response.
````

<details>
<summary>Hand-editing details</summary>

Paths are relative to the opened folder. File-note ranges are 1-based and inclusive in the selected revision. A regular-editor note uses `Selected: Working tree`, `Selected: Staging area`, `Selected: HEAD`, or `Selected: Commit <full-sha>` (40 or 64 hexadecimal characters). A comparison records Original then Modified endpoints and always names the selected side and its revision, as above.

Same-file comparisons omit endpoint paths. Different-file comparisons name both, for example ``Comparison: `old.ts` (HEAD) -> `new.ts` (Working tree)`` with `Selected: Modified (Working tree)` under a `new.ts` heading. The selected endpoint must match the heading's path and selected revision. Keep file metadata directly after the heading and any captured code fence directly after `Selected:`; blank lines are allowed. General notes have none of this metadata, and code fences in their body are feedback, not anchors.

Composers accept arbitrary text, including `##` headings, metadata examples, unfinished fences, and significant surrounding whitespace. When necessary, the saved body uses `Body: fenced` followed by a `markdown` backtick fence longer than any backtick run in the feedback. Editors show the original body without the wrapper; copy and archives preserve the saved representation. When hand-editing, keep wrappers intact. Outside a wrapper, use `###` for body headings and balance fences: an unfenced `##` starts another block. A broken fence can block further submissions until repaired. Empty or whitespace-only new notes cannot be submitted.

Long file selections use `; Snippet: elided` in the heading and a bare `...` between the first 10 and last 5 snippet lines. Without that label, an ellipsis is literal code. Line-specific notes without snippets use line hints rather than a reliable match. Whole-file notes use `:file` instead of a range and cannot have a comparison or anchor. They do not create native line threads or participate in line-number rewriting.

Unknown sections, malformed blocks, duplicate notes, and original formatting are preserved rather than guessed or discarded. Old compact file-context formats are not parsed or automatically migrated, but remain copyable. Edits target the selected body; they do not regenerate the whole review file.

</details>
