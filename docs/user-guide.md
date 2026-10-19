# DejaReview User Guide

Full reference for the workflow summarized in the top-level `README.md`.

## Review Workflow

### Add Feedback

For a file-specific note, select lines in a text file or diff and press **Ctrl+Alt+M** (**Cmd+Alt+M** on macOS). With no selection, the current line is used. **Add Review Note** is also available in the editor context menu and Command Palette. Type your feedback in the native comment composer and submit it.

The shortcut captures the file, lines, snippet, and comparison context **before you type**. You can also click **+** in the native comment gutter, but gutter notes capture source text at submission. If the comparison side is ambiguous, DejaReview asks rather than guessing.

For feedback that is not tied to code, use **Add General Review Note** in the toolbar inside the Review Notes panel. A floating editor opens in the panel with **Save** and **Cancel**; **Escape** cancels. No file or text selection is required, but a supported local project folder in Git is still required.

For feedback on an entire changed file, use the note-bubble **Add File Review Note** button in its **Files to Review** row. The same floating editor opens for that file, without needing an active editor or selection. Whole-file notes have a file path but no line range or snippet, and work for binary, untracked, and deleted files too. Saving the note hides that path from Files to Review.

### Refine The Review

The panel shows file-specific and general notes together in saved order, with a combined note count and a short two-line preview of each.

- Click a file note to open its code or captured comparison. If its snippet can no longer be located, the card opens its panel editor instead, keeping the feedback available. Whole-file cards show just the filename and open the file, or its staged version for an unstaged deletion.
- Click a general note to edit it.
- Hover any card or move keyboard focus into it to reveal **Edit Review Note**, followed by **Delete Review Note**. Edit opens the floating editor for either kind of note; deletion asks for confirmation.
- Use **Save** to apply an edit, or **Cancel** / **Escape** to leave the saved note unchanged. File-note edits change the feedback, not its captured location or comparison context. Native gutter editing remains available for file notes.

The panel editor keeps your input when the panel refreshes or is hidden and reopened during the session. A failed save keeps your text so you can resolve the problem and retry. Finish or cancel this editor before copying or restoring Review Notes. Unsaved input is not guaranteed to survive a VS Code reload.

### Where Notes Are Saved

Saved feedback lives in JSON files in VS Code's user-local extension storage, **not your
project directory**. Edit notes in the gutter or panel; hand-editing storage files is not
supported. Use the panel title's **Refresh Review Notes** action if needed.

Storage is keyed by the absolute disk path of the local Git checkout/worktree root.
Separate clones and worktrees remain isolated even when they share a remote or Git
metadata. Changing branches at the same path keeps its notes. Subfolder windows share
that checkout's storage while showing file notes within their opened folder; general
notes are checkout-wide. Moving a checkout changes its storage key; notes are not
automatically relocated.

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

Square-bracket paths such as `pages/projects/[versionId]/opportunities/page.ts` are supported. Before staging or reverting them, DejaReview checks that Git's filename matching selects only that file; if the brackets also match another path, the action is refused.

When you stage the **first row**, DejaReview automatically opens the next remaining file after refreshed Git state confirms the staged file has disappeared. It uses the same editor/diff behavior as clicking that next row. Staging any other row or reverting does not advance. Failed staging, residual unstaged changes, and an empty remaining list do not open another file. Another dashboard action cancels a pending advance.

**Revert File** asks before discarding that file's unstaged disk changes. Tracked files are restored from the staging area, **not HEAD**, leaving staged changes intact. This restores an unstaged deletion, not a staged deletion. For untracked files, confirmation warns that the file will be removed and **Git cannot recover it**. A file with unsaved editor changes cannot be reverted; the extension never saves or discards those buffers for you. Conflicts, intent-to-add, and other unsupported states are refused rather than risking staged work.

Line counts compare the staging area with saved working-tree content, not unsaved editor text. New untracked text files are counted up to **5 MiB**. Binary, over-limit, or unavailable results show **Stats unavailable**; standard binary files, new files, and deletions can still be staged or reverted subject to the safeguards above.

File rows label Git-reported additions, removals, and renames relative to the **staging area**: for example **Added +60**, **Removed -60**, or **Renamed +2 -1**. Redundant zero counts are hidden on these labelled rows; modified files keep the usual **+N -N** display. Labels remain visible while statistics load or are unavailable. Once an addition or rename is staged, further edits show ordinary modified-file counts; the earlier staged change does not determine the label. A move appears as **Renamed** only when Git identifies an unstaged rename; otherwise it appears as separate added and removed files.

This is a files-only aid, **not approval or completion tracking**. An empty list means no current candidates, not that the review is complete. Neither staging nor reverting adds a note or marks work approved. Other workspace roots, nested separate repositories, the review file, and archives are excluded.

### Send The Review

1. Finish saving your notes and edits. Stage changes you approve using Source Control or **Stage File**; staging and leaving feedback are independent.
2. Select **Copy Review Notes & Clear** in the panel, or use the command with that name.
3. Paste into your AI tool. The clipboard contains Markdown notes, captured code context,
   checkout-relative paths, and: "Please address these review notes and summarize your
   changes here. Leave staging to me."
4. Review the resulting changes and begin the next pass. The last copied batch remains
   available for recovery until another successful copy replaces it.

In a subfolder window, Copy & Clear exports visible file notes plus checkout-wide general
notes. File notes outside that folder remain saved.

Copy exports **saved feedback only**, never unsaved editor text. An open dashboard editor must be finished or cancelled first. Known native drafts and native edits retain their existing choice: finish first, cancel the handoff, or explicitly discard that input **only after a successful copy-and-clear**. Unsubmitted gutter drafts that VS Code cannot expose are left alone for the next pass.

## Safety And Privacy

**You control staging and discarding.** Git access is read-only except for your explicit, single-file Stage File action or confirmed Revert File action. DejaReview never automatically or bulk stages or reverts, unstages, stashes, commits, or otherwise changes source code. Coding agents must not stage, unstage, stash, or invoke revert on workspace changes; the panel's reviewer actions do not grant agents that permission.

**Copy comes before clearing.** DejaReview copies the notes, saves their recovery records,
then clears those live records. Clipboard failure leaves notes and the previous recovery
batch intact. Recovery-write failure also keeps live notes, though the clipboard may
already contain the review. A clearing failure keeps both live notes and the new recovery
batch and reports partial success. Atomic replacement prevents partial files; it is not
an fsync-backed backup guarantee.

Multiple windows coordinate writes using a short-lived checkout-wide filesystem lock;
directory watchers reload changes from other windows. Reads and typing do not acquire
the lock. A busy write is retried briefly, then reported so you can retry the action.
If a VS Code process crashes while holding the lock, close **all windows using that
checkout** before removing the `write.lock` at the path shown in the error. DejaReview
does not automatically steal locks. Unsupported external writes are not protected by this
lock; detected changes and invalid JSON fail rather than overwrite notes. Dirty buffers
for internal storage files must be closed or discarded before writes.

**Your review stays local until you share it.** DejaReview has no AI service, account or
remote upload. Current notes and the recovery batch include feedback and captured code
snippets; the clipboard sends that text wherever you paste it. Storage is not encrypted
or synced by DejaReview and is normally specific to the VS Code user profile. No project
file or `.gitignore` entry is created. Failed cleanup can leave a temporary JSON file in
extension storage.

No agent configuration is required. If you maintain agent instructions, tell the agent to use the pasted feedback, preserve unrelated work, and summarize in the conversation. Do not have it read DejaReview storage or restore feedback without a separate explicit request. DejaReview does not edit your agent instructions.

## Last-Copy Recovery

If you were distracted or could not paste after clearing, open **More actions (...)** and
choose **Restore Last Copied Review Notes**, then **Restore**. The command with the same
name is also available in the Command Palette. The recovery section stays hidden by
default and does not reopen automatically after a copy.

There is exactly **one recovery batch per local checkout**, shared with its subfolder
windows. A successful new recovery write replaces the previous batch; it is not a review
history. Recovery does not overwrite or merge with any current notes in that checkout,
including notes outside an opened subfolder. Finish or cancel open drafts and edits first.

Restored records keep their original checkout-relative paths. Notes outside the current
subfolder become visible when you open their folder or the checkout root. Restoring keeps
the recovery batch available, and never happens automatically on reload.

Current notes are in `checkouts/<hash>/notes.json` beneath DejaReview's
`globalStorageUri`; recovery is `last-copy.json` beside it. The hash uses the local
checkout's absolute disk path, not its remote or branch. Both survive restarts. This is
local recovery storage, not conversation history or an encrypted backup.

## Limitations

- File-specific capture supports local text files and Git text revisions in the first workspace folder. Untitled buffers, arbitrary virtual documents, remote repository schemes, notebook/custom/merge editors, other roots, nested separate repositories, and cross-boundary comparisons are unsupported. General notes need no file, but still require the supported folder and containing Git repository.
- Paths through symbolic links below the containing Git root are rejected, even when the link points inside the project. On macOS/Linux, filenames containing literal backslashes are also unsupported rather than confused with directory separators. These restrictions apply to file capture, reads, and Files to Review actions.
- Native gutter drafts cannot reliably record the moment you clicked the gutter or expose every unsubmitted draft. Prefer the shortcut to freeze context before typing. If a revision changes during capture or composition, you may need to recapture; failed validation preserves your input. Native drafts and dashboard input are transient, not reload-persistent storage.
- Inline diffs do not reliably show Original-side native notes. Use the native **Open Side-by-Side Comparison** action when needed; normal card navigation does not change your diff layout. When both panes show the same resource, VS Code may display a note on both sides even though its saved context identifies the selected side.
- If a shared note's comparison has an endpoint outside the opened subfolder, that window opens only the selected revision. Editing and copying preserve the full comparison; open the checkout root to navigate both endpoints.
- Snippets capture whole lines: up to 20 verbatim, or the first 10 and last 5 for longer selections, with an explicit omission marker. Locations may become stale. DejaReview adjusts display positions when it can find the snippet, but does not automatically rewrite saved lines, snippets, or remove stale feedback. **Rewrite Line Numbers from Anchors** is an explicit action for file notes.
- Settings are limited to `dejareview.decorationStyle` (`badge` or `none`, default `badge`) and `dejareview.searchRadius` (0-10000, default `50`). There is no AI integration, PR workflow, reply thread, or review-completion model.

## Clipboard Markdown

The gutter and panel handle storage for you. The copied review uses Markdown: each note
starts with a heading, and 💬 marks the feedback body. File locations and revision context
share one line:

````md
## General Review Note

💬 Add regression tests for the error-handling changes before the next pass.

## `src/client.ts`:file (Working tree)

💬 Split this file into smaller modules.

## `src/client.ts`:42 (Modified: Staging area vs HEAD)

```ts
const response = await fetch(url);
```

💬 Handle request failures before using the response.
````

<details>
<summary>Context and body formatting</summary>

Copied paths are relative to the checkout root. Ranges are 1-based and inclusive in the selected revision. A regular-editor header ends with `(Working tree)`, `(Staging area)`, `(HEAD)`, or `(Commit <full-sha>)` (40 or 64 hexadecimal characters). In `(Modified: Working tree vs HEAD)`, the location and snippet belong to the Modified working-tree side; HEAD is the opposite side. `(Original: HEAD vs Working tree)` selects the Original HEAD side instead, even if both revisions happen to contain identical text.

Different-file comparisons include the opposite path: ``## `new.ts`:42 (Modified: Working tree vs `old.ts` @ HEAD)``. A captured code fence goes between the heading and 💬, allowing blank lines. General notes use the exact heading `## General Review Note` and have only a 💬 body, without file context or an anchor. The 💬 marker is saved-file formatting and does not become part of the editable feedback.

Composers accept arbitrary text, including `##` headings, unfinished fences and significant whitespace. When necessary, copied bodies use `💬 Body: fenced` followed by a `markdown` fence longer than any backtick run in the feedback. Editors and JSON records hold the original body without that wrapper. Empty or whitespace-only new notes cannot be submitted.

Long file selections use `; Snippet: elided` in the heading and a bare `...` between the first 10 and last 5 snippet lines. Without that label, an ellipsis is literal code. Line-specific notes without snippets use line hints rather than a reliable match. Whole-file notes use `:file` instead of a range and cannot have a comparison or anchor. They do not create native line threads or participate in line-number rewriting.

Duplicate notes remain distinct records. Internal JSON files are not a hand-editable
review document; malformed storage is reported as an error rather than treated as empty.

</details>
