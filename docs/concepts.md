# Concepts

**Storage update:** see [storage.md](storage.md) for current concepts. Project Markdown
and archive history below describe the original baseline. The database is now central
JSON keyed by checkout disk path; Markdown is a UI/clipboard projection and recovery
holds only the last copied batch. Capture, origin, side and anchoring concepts still apply.

This is the vocabulary used across the code and the other documents. Each term is defined
as implemented, not as intended. Where intent and implementation differ, the difference is
called out.

## 1. The Loop

```text
 reviewer reads change ──► attaches notes ──► REVIEW-NOTES.md (source of truth)
        ▲                                             │
        │                                  Copy Review Notes & Clear
        │                                             ▼
 next review pass ◄── agent edits code ◄── clipboard: instruction + raw notes
                                                      │
                                         archive (recoverable copy of the batch)
```

Everything else supports one of these arrows. The Files to Review list helps the reviewer
avoid skipping files. Stage and Revert let the reviewer act on a file without leaving the
panel. Re-anchoring keeps notes pointing at the right lines while the code moves.

## 2. Scope: The Opened Folder

- DejaReview works on exactly one folder, `workspace.workspaceFolders[0]`. It is called the
  **opened folder** or **project folder**.
- The opened folder must be inside a local Git repository. It may be the repository root
  or any subfolder of it.
- All saved paths are relative to the opened folder. They become relative to the Git root
  only when a Git call is made.
- The notes file, the archive namespace and the Files to Review list all belong to the
  opened folder.
- In the code, `repo` is a **workspace adapter** (`GitResources.workspaceRepository`). It
  looks like a vscode.git `Repository`, but its `rootUri` is the opened folder, and every
  member is read live from the current vscode.git wrapper. Its object identity is stable,
  so `this.repo === repo` works as a guard.

> VS Code restarts the extension host when the first workspace folder changes. The code
> nevertheless re-checks the folder after almost every await. `problems.md` (D5) discusses
> this.

## 3. The Saved File: `REVIEW-NOTES.md`

- It is the only store of current feedback. Everything on screen is a **projection** of
  it.
- It is hand-editable. VS Code may hold an unsaved buffer for it, and other tools may write
  it.
- The code never regenerates it. Appends add bytes at the end, edits splice one body, and
  deletes remove one block plus one blank separator line. Unknown text is kept
  byte-for-byte.

### Note Kinds

| Kind | Heading | Created from | Has location? |
| --- | --- | --- | --- |
| **Line note** | ``## `src/a.ts`:42-45 (Working tree)`` | Editor: shortcut, context menu, gutter `+` | Path, line range, origin, optional side/comparison, optional snippet |
| **Whole-file note** | ``## `src/a.ts`:file (Working tree)`` | Panel: Files to Review → Add File Note | Path only |
| **General note** | `## General Review Note` | Panel: Add General Review Note | None |

Any other `##` section is **opaque**: it is ignored, kept, and copied. A malformed note
block is kept too and reported as a **diagnostic** (a warning in the Problems view, plus
"N malformed block(s)" in the panel).

### Body, Marker And Wrapper

- Every note body starts with `💬`. The marker is formatting only and is never part of the
  body the reviewer edits.
- When a body could be misread as structure, it is saved as `💬 Body: fenced` followed by a
  `markdown` code fence longer than any backtick run inside it. "Misread as structure"
  means it contains a `##` heading, an unbalanced fence, a leading fence, significant
  leading or trailing whitespace, or a first line equal to the wrapper label.
- After every write the code parses the result again and refuses if the body would not
  come back identical.

### Snippet (Anchor Text) And Elision

- A line note can carry a fenced **snippet** of the selected lines between the heading and
  the body.
- Selections longer than 20 lines are **elided**: the first 10 lines, a `...` line, and the
  last 5 lines, with `; Snippet: elided` on the heading. Without that suffix, a `...` line
  is literal code.

## 4. Where A Line Note Points

### Origin

Which content the line numbers refer to.

| Origin | Saved label | Content source |
| --- | --- | --- |
| `changed` | `Working tree` | The open editor buffer if the file is open, otherwise the file on disk |
| `staged` | `Staging area` | The index (`git show :path`) |
| `head` | `HEAD` | `git show HEAD:path` |
| `commit:<sha>` | `Commit <full sha>` | `git show <sha>:path` |

- `staged` and `head` are **mutable**: they change when the reviewer stages or commits.
- `changed` is mutable too, but it is the content the agent edits.
- A pinned commit never changes.

### Side And Comparison

- When a note is captured in a diff editor, it records which pane was selected
  (**side**): `Original` (left) or `Modified` (right). It also records the opposite
  endpoint (**comparison**), for example ``(Modified: Working tree vs HEAD)``.
- A note captured in a plain editor has side `document` and no comparison.
- Side means provenance ("I was looking at this pane"), not approval.

### Capture Context (Frozen Capture)

At capture time the code synchronously records the editor, the selection, the tab and the
displayed text **before the first await**. This is `freezeEditor`. The purpose is that
later focus changes cannot retarget the note.

It also records the HEAD commit (`baseCommit`) and returns a `validate()` closure that
re-checks, at submit time, that the captured revision still matches what Git reports.

> Native gutter `+` drafts are the exception. VS Code does not tell the extension where
> such a draft was created, so its context is inferred at **submit** time from open tabs.
> If that is ambiguous, the extension asks with a picker.

### Resolved Position And Stale Notes

- On every refresh each line note is matched against the current content of its origin
  (`resolveAnchor`). The search tries, in order:
  1. the saved lines,
  2. the nearest exact match,
  3. the nearest match ignoring indentation.
- An elided snippet matches its first and last parts independently.
- The result is a **resolved range**. It is used only for display: gutter threads, badges
  and navigation.
- A note whose snippet cannot be found, or whose revision cannot be read, is **stale**. It
  keeps its card, but has no gutter thread. Opening it jumps to its block in
  `REVIEW-NOTES.md`.
- Saved line numbers change only through the explicit command **Rewrite Line Numbers from
  Anchors** (`reanchorAll`).

## 5. Projection, Entries And Handles

| Term | Meaning |
| --- | --- |
| **Snapshot** | The exact text of `REVIEW-NOTES.md` that a projection was parsed from. |
| **Parsed note** | A note with its byte offsets in that snapshot (`startOffset`, `bodyStartOffset`, `deleteEndOffset`, …) and `rawBlock`, the exact block text. There is no stored note ID. |
| **Entry** | A parsed line or whole-file note plus its resolved range, repo and snapshot. `savedEntries` adds general notes. |
| **`current(text, entry)`** | Re-locates an entry in fresh text. If the snapshot is unchanged it matches by offset. Otherwise there must be exactly one block with the same raw text in both the old and the new file. If not, the action fails with "changed on disk". |
| **Card / note id** | A short id handed to the webview for one entry. It is valid only while the snapshot and raw block are unchanged. Any write to the file renews all ids. |
| **File id** | The file's relative path. |

The webview never receives full bodies, snippets, snapshots or archive text. It receives
two-line previews of at most 320 characters. The one exception is the body of the note
currently open in the panel editor.

## 6. Files To Review

- A **candidate** is a file with unstaged or untracked changes in the opened folder that
  has no saved file-specific note.
- These are excluded: `REVIEW-NOTES.md`, its temporary files, archive storage, anything
  outside the folder, symlinks, nested repositories and submodules.
- Deleted files stay listed.
- **Change kind** (Added, Removed, Renamed) comes from Git status.
- **Statistics** (`+N -M`) are computed in the background:
  - tracked files: from the index-to-working-tree diff;
  - untracked files: by counting lines, up to 5 MiB.
  - They are cached by file metadata and index object.
- **Visible** marks rows whose file is shown in an editor.
- **Pending** marks the row whose Stage or Revert is running.
- The list is a heuristic, not a completion model. Empty means "no candidates right now",
  not "approved". Clearing notes makes files reappear for the next pass.

### Stage File And Revert File

These are the only two Git writes. Each uses exactly one validated path.

- **Stage** calls vscode.git `add`.
- **Revert** asks for confirmation, then calls vscode.git `clean`:
  - Tracked files are restored from the **index**, so staged work survives.
  - Untracked files are deleted.
  - Unsupported Git states are refused: conflicts, intent-to-add, unknown statuses.
  - Revert is also refused while the file has unsaved changes in an editor.
- Paths with `[` or `]` are first checked with Git to make sure they match only that file,
  because vscode.git passes paths to Git as patterns.
- After staging the first row, the next candidate opens automatically (**auto-advance**).

## 7. Handoff, Archive, Recovery

- **Handoff (Copy Review Notes & Clear)** runs these steps in order:
  1. validate;
  2. read the file;
  3. copy the instruction plus the raw file to the clipboard;
  4. archive the same raw text;
  5. re-read, and delete the file only if it is unchanged.

  Each step runs only if the previous one succeeded, so feedback is never deleted before
  it has been copied and archived. Partial success is reported explicitly.
- **Instruction**: `Please address these review notes and summarize your changes here.
  Leave staging to me.` A test pins it word for word.
- **Archive**: `globalStorage/reviews/<sha256(folder URI)>/<uuid>.json` with `version`,
  `id`, `repoUri` (which actually holds the opened folder URI), `text`, `createdAt` and
  `commentCount`. Archives are never deleted. The panel and the picker show only the
  newest 10.
- **Recovery** writes an archive's raw text back into a missing or blank
  `REVIEW-NOTES.md`. The archive is kept.

## 8. Glossary

| Term | Code name | Defined in |
| --- | --- | --- |
| Opened folder | `workspaceFolders[0]`, adapter `repo.rootUri` | `extension.ts`, `git.ts` `workspaceRepository` |
| Line / whole-file / general note | `ReviewComment` (`wholeFile`), `GeneralReviewNote` | `model.ts` |
| Origin | `Origin`: `changed`, `staged`, `head`, `commit:<sha>` | `model.ts` |
| Side, comparison | `Side`, `Comparison` | `model.ts` |
| Snippet / anchor text | `anchorText`, `elided` | `model.ts`, `editorContext.ts` |
| Resolved range | `ResolvedAnchor` | `anchor.ts` |
| Snapshot, raw block | `snapshot`, `rawBlock` | `extension.ts`, `parser.ts` |
| Diagnostics | `ParseResult.diagnostics` | `parser.ts` |
| Frozen capture | `FrozenEditor`, `CapturedContext` | `editorContext.ts` |
| Native draft / thread / note | `drafts`, `threads`, `Note` | `extension.ts` |
| Dashboard editor session | `DashboardEditor` | `extension.ts` |
| Candidate, statistics | `FileReviewCandidate`, `FileStatistics` | `git.ts` |
| Handoff | `ReviewStore.handoff`, `HANDOFF_INSTRUCTION` | `store.ts`, `handoff.ts` |
| Archive | `ReviewArchive`, `ReviewArchives` | `archive.ts` |
| Generation | `generation`, `filesGeneration`, … | `extension.ts` (see `architecture.md`) |
