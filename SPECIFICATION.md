# Simple Loop-Review Comments — Specification

**Extension ID:** `simple-loop-review`
**Display name:** Simple loop-review comments
**Command prefix:** `loopReview.`
**Target:** vanilla VS Code (no dependency on Copilot, Windsurf, or any bundled AI feature)
**Language:** TypeScript

---

## 1. Purpose

A review-feedback layer for code produced by command-line AI coding agents (`opencode`, `claude`).

The workflow this supports:

1. Agent makes changes in the working tree.
2. Human reviews the diff in VS Code.
3. Hunks that are good get **staged** — staging is the accept signal.
4. Hunks that need work get a **comment** anchored to the code.
5. Comments land in `COMMENTS.md` at the repo root.
6. Human clicks **Copy Comments & Clear** in the extension UI. All comments, including their code context, go to the clipboard; after a successful copy, `COMMENTS.md` is deleted.
7. Human pastes the feedback into their AI tool. The agent addresses it; it does not read or reply in `COMMENTS.md`.
8. Repeat from 2. Adding the first comment of the next pass creates a fresh `COMMENTS.md`.

### Design principles

- **`COMMENTS.md` is the single source of truth for the current review pass.** The extension holds no authoritative state. Every read is a full re-parse of the file. The file is a scratch buffer, not a conversation history.
- **Staging stays in VS Code's SCM UI.** The human stages accepted changes; the extension neither stages code nor tracks acceptance or review completion.
- **Clipboard handoff is explicit and self-contained.** The human chooses when a pass is ready. Copy the feedback with paths, ranges, origins, and captured snippets before deleting the scratch file.
- **The file must stay hand-editable.** Editing `COMMENTS.md` in the editor is a first-class input path, equal to using the UI.
- **Markdown must stay readable as markdown.** No HTML comments, no hidden metadata, nothing that looks like noise in a rendered preview.
- **Anchor by content, not by line number.** Line numbers are a hint; the code snippet is the anchor.
- **Comment where the code is.** Add and read comments in regular text editors and both sides of side-by-side comparisons, including read-only originals. No need to open `COMMENTS.md` for routine review.
- **Comparison side is explicit.** Preserve Left / Original versus Right / Modified independently of Git origin, in both the UI and clipboard feedback. Never infer the side from a file path or URI scheme alone.

### Non-goals

- No revert / discard / restore actions. VS Code's built-in SCM view already does this and it is explicitly not wanted here.
- No LLM calls, no API keys, no model configuration. The extension never talks to an AI service.
- No GitHub/GitLab/PR integration. Local repository resources only.
- No MCP server, no IPC, no background daemon. The human pastes clipboard feedback into any AI tool.
- No agent replies in the file, threaded conversations, resolved states, or review history.
- No hunk inventory, unreviewed counters, stale-acceptance detection, or automatic completion inference.

---

## 2. Terminology

| Term | Meaning |
|---|---|
| **Comment** | One `##` block in `COMMENTS.md`: a header, an anchor snippet, optional comparison context, and body prose. |
| **Anchor** | The fenced code snippet under a comment header, used to re-locate the comment when line numbers drift. |
| **Origin** | Which document revision the `Lines:` field is indexed against: `changed`, `staged`, `head`, or `commit:<full-sha>`. |
| **Side** | Capture location: `document` for a regular editor, `left` for Original, or `right` for Modified in a comparison. Not an acceptance state. |
| **Stale comment** | A comment whose anchor snippet can no longer be found in its origin blob. |
| **Review pass** | Comments collected since the previous successful copy-and-clear handoff. |
| **Copy and clear** | Copy the current review feedback with context to the clipboard, then delete that repo's `COMMENTS.md`. |

---

## 3. File format — `COMMENTS.md`

### 3.1 Location

Repo root, next to `.git` (a directory or worktree metadata file). Not configurable in v1. Create the file lazily on the first comment; do not create an empty file on activation or recreate it after copy-and-clear until the user adds another comment.

Recommended `.gitignore` entry — this is scratch review state, not history. The extension does **not** write to `.gitignore` automatically; it offers a one-time prompt (see §8, `loopReview.suggestGitignore`).

### 3.2 Structure

```
document  := preamble? comment*
preamble  := "# " <anything>            (single H1 line, optional)
comment   := header anchor? comparison? body
header    := "## File: `" path "`; Lines: " range "; Origin: " origin "; Side: " side
anchor    := fenced code block, IMMEDIATELY following header (blank lines allowed)
comparison := "Comparison: Left: `" path "` (" origin "); Right: `" path "` (" origin ")"
body      := everything until the next "## " at fence-depth 0
range     := <int> | <int> "-" <int>
origin    := "changed" | "staged" | "head" | "commit:" <full-sha>
side      := "document" | "left" | "right"
```

Comments are a **flat list**. There is no per-file `#` grouping — flatness is what makes writes an append to end-of-file rather than a mid-file splice.

Comparison comments require the `Comparison:` line immediately after the anchor (or header if there is no anchor), with blank lines allowed. It identifies both resources using repo-relative paths and origins. The selected endpoint must agree with `File:` and `Origin:`. Regular-editor comments use `Side: document` and omit this line. Reserve this position for comparison metadata; the editable comment body follows it. Malformed or inconsistent metadata produces a diagnostic and is preserved, not guessed.

### 3.3 Example

````md
# Review · base 8e2c1f4

## File: `src/auth/login.ts`; Lines: 42-43; Origin: changed; Side: right

```ts
const token = await fetchToken(id);
setSession(token);
```

Comparison: Left: `src/auth/login.ts` (staged); Right: `src/auth/login.ts` (changed)

Missing error handling on the await — if `fetchToken` rejects we silently
leave the session unset and the caller sees a logged-out state with no
indication why.

## File: `src/auth/login.ts`; Lines: 12; Origin: staged; Side: left

```ts
const data = fetch('/api/user/' + id);
```

Comparison: Left: `src/auth/login.ts` (staged); Right: `src/auth/login.ts` (changed)

This removal was correct — don't reintroduce string-concatenated URLs here.

## File: `src/http/client.ts`; Lines: 88-90; Origin: changed; Side: document

```ts
export async function fetchToken(id: string) {
  return withRetry(() => post('/auth/token', { id }));
}
```

Good — use this same `withRetry` wrapper in the other three call sites in
this file, they're all doing bare `post()` right now.
````

Note the third comment: it is anchored to code the reviewer is **happy with**, and requests propagation elsewhere. The anchor snippet is not exclusively for problems, and such a hunk will typically be staged *and* commented. **Comment and stage are not mutually exclusive** — do not encode that assumption anywhere.

### 3.4 Header field semantics

**`File:`** — repo-root-relative POSIX path, backtick-wrapped. Backticks render as inline code in preview and make the outline view readable. Forward slashes on all platforms; normalise `\` on write and accept both on read.

**`Lines:`** — 1-based, inclusive, indexed against the blob named by `Origin`. A hint only. If it disagrees with the anchor, the anchor wins.

**`Origin:`** — the blob revision whose line numbering `Lines:` refers to:

| Origin | Blob | Diff it appears in | Goes stale on |
|---|---|---|---|
| `changed` | working-tree file | right pane of unstaged diff | nothing (always current) |
| `staged` | index | right pane of staged diff, left pane of unstaged diff | `git add`, `git reset` |
| `head` | `HEAD` blob | left pane of staged diff | commit |
| `commit:<full-sha>` | immutable commit blob | either pane of a historical comparison | blob unavailable locally |

`changed` will dominate in practice. `staged` identifies context captured from the index, not an acceptance or rejection state: a staged snippet may still receive a correction or a request to propagate a good pattern. `head` covers commenting on untouched existing code ("this is the pattern to follow").

**`Side:`** records where the comment was created: `left` = Original, `right` = Modified, `document` = regular editor. In inline diff mode, Original/Modified retain their meaning even though they are not physically left/right. Keep the captured side unchanged when rendering the same resource elsewhere.

**`Comparison:`** records the ordered pair of resources, not merely a comparison type. This distinguishes staged versus unstaged comparisons and file-versus-file comparisons where both sides have `Origin: changed`. Lines and snippets always belong to the selected side, including deleted lines on the original side. Do not translate them into the other side's line numbering.

### 3.5 Base SHA

The optional H1 preamble carries the base commit: `# Review · base <short-sha>`.

One SHA for the whole file, not per comment — a staleness check is then a single comparison. If `HEAD` has moved past the recorded base, all `head`- and `staged`-origin comments are suspect; the extension warns once and marks them stale rather than trying to rebase them.

### 3.6 Review-pass lifecycle

Comments remain in `COMMENTS.md` across editor reloads and restarts until the human edits/deletes them or runs **Copy Comments & Clear**. Staging code never deletes a comment.

Copy-and-clear ends the pass by deleting the file after clipboard success (§8.1). Agent responses live in the AI tool, not in the file. Blockquotes are ordinary body content with no special state or UI treatment.

### 3.7 Parse rules and gotchas

1. **Fence tracking is mandatory.** A `## ` line inside a fenced block is content, not a header. Track fence open/close (``` and ~~~, honouring longer runs) while scanning. This bites the first time you comment on a markdown file.
2. **Anchor is the first fence after the header, or nothing.** Prose between header and fence means there is no anchor. Define it strictly; do not scan forward for a "probable" fence.
3. **Duplicate headers are legal.** Two comments on the same range in the same file are distinct comments. Never dedupe by header.
4. **Unknown content is preserved.** Text before the first `## ` that isn't the H1 preamble is kept verbatim and round-tripped.
5. **Unparseable blocks are preserved, not dropped.** See §7.4.
6. Header matching is a single regex; keep it tolerant of extra whitespace around `;` and `:`, and case-insensitive on the `Origin` and `Side` values. Require `Side` on every comment; there is no previously shipped format to migrate.
7. Parse the comparison line separately, validate both endpoints, and keep its original bytes on body edits. Never treat a later `Comparison:` line inside body prose or a fence as metadata.

Suggested header regex:

```ts
const HEADER = /^##\s+File:\s*`([^`]+)`\s*;\s*Lines:\s*(\d+)(?:\s*-\s*(\d+))?\s*;\s*Origin:\s*(changed|staged|head|commit:(?:[0-9a-f]{40}|[0-9a-f]{64}))\s*;\s*Side:\s*(document|left|right)\s*$/i;
```

---

## 4. Anchoring

### 4.1 Capture

On comment creation, store:

- `path`, `startLine`, `endLine`, `origin`, `side`, and both comparison endpoints when applicable
- `anchorText` - the selected lines, verbatim, including original indentation; expand partial-line selections to whole lines for line-based anchoring

With no selection, capture the current line. An exclusive selection end at column zero does not include that final line. Capture the source editor, side-local range, comparison endpoints, and text before opening the comment composer; changing focus must not retarget the comment. Unsaved working-tree text may be captured from the editor without saving or modifying code. Re-anchor against the open buffer when available; the stored snippet remains the original capture.

Cap the anchor at 20 lines. If the selection is longer, store the first 10 and last 5 lines separated by a `// ...` elision marker line and record the true range in `Lines:`. Rationale: a 400-line selection produces an unreadable `COMMENTS.md` and a useless anchor.

### 4.2 Re-anchoring

Run on every parse, per comment, against the resource named by `path` and `origin` (the open buffer for `changed`, when available). Never search the opposite comparison resource as a fallback:

1. **Exact match at recorded position.** Compare `anchorText` against `[startLine, endLine]`. Hit → resolved, done. (Fast path, covers the common no-drift case.)
2. **Local search.** Search ±50 lines around `startLine` for an exact occurrence of `anchorText`. Single hit → resolved, update line numbers in memory (do not rewrite the file for this).
3. **Whole-file search.** Exact occurrence anywhere in the file. Single hit → resolved.
4. **Ambiguous.** More than one hit in step 2 or 3 → pick the one nearest `startLine`, mark `confidence: 'low'`.
5. **Not found.** No anchor, or no match → `stale`.

Whitespace: compare with trailing whitespace stripped per line and with a leading-indentation-insensitive fallback (strip the common indent prefix from both sides) before giving up. Reformatters change indentation constantly.

No anchor snippet (hand-written comment with only a header) → trust `Lines:` verbatim, mark `confidence: 'low'`.

### 4.3 Stale comments

Stale comments are **never automatically deleted or rewritten**. They:

- appear in the tree view under a "Stale" group with a warning icon
- render no editor decoration or anchored native thread (there is nowhere to put it)
- are still included verbatim in clipboard feedback; the handoff instruction warns that snippets and locations may be stale

Explicit comment deletion and copy-and-clear apply to stale comments too.

### 4.4 Line-number rewriting

The extension rewrites `Lines:` in the file **only** when the user explicitly runs `loopReview.reanchorAll`. Automatic rewriting on every drift would cause constant `COMMENTS.md` churn and fight the sync loop. In-memory resolved positions are used for all UI.

---

## 5. UI surfaces

### 5.1 Primary entry - native comment gutter

Use `vscode.comments.createCommentController` with a `commentingRangeProvider` for supported text documents. Hover a line's comment gutter and click **+** to open a native multiline composer. Existing comments have native gutter markers; clicking one expands the comment inline. A new thread is a temporary draft until **Add Comment** persists it to `COMMENTS.md`. Cancelling an empty draft leaves no file or comment behind.

Support all text languages in normal editors, split editor groups, and both panes of side-by-side text diffs. This includes read-only Git originals, staged and unstaged comparisons, historical Git comparisons, and file-versus-file comparisons within one repository. Text outside a repository, untitled buffers, arbitrary virtual-provider documents, binary/custom editors, notebook cells, and merge editors are outside v1 scope; explain unsupported resources rather than silently attaching feedback elsewhere.

The native comment API provides the gutter/input UI but not persistence. Contribute explicit submit, edit, and delete commands. This uses a thread as a single-comment display container, not a conversation: disable replies after submission. No agent reply, resolution workflow, or separate thread store.

The API does not supply comparison provenance on `CommentReply`. Validate draft-context capture in M1; if native gutter creation cannot be associated reliably with its original comparison, require an explicit context confirmation before saving. Do not reconstruct provenance from whichever tab is active after typing.

### 5.2 Trigger — keybinding and menus

- Keybinding: `ctrl+alt+m` / `cmd+alt+m`, `when: "editorTextFocus"`. Comment on the selection, or current line if none.
- `editor/context` menu item **Add Review Comment**, group `loopReview`, in regular and diff text editors, including read-only panes. Do not require `!editorReadonly`.
- Command palette: **Add Review Comment**, with the same behavior. Capture the last focused text editor context before opening UI; if the source is ambiguous, ask the user to choose it.

All entry paths open the same native multiline composer. Its label shows the captured path, side-local line range, and **Left / Original**, **Right / Modified**, or **Document**, plus the origin. Submission uses this captured context, not whichever pane is active afterward. A toolbar action must not default to the right pane when neither pane has focus; the gutter and keyboard are the primary paths.

### 5.3 Resource and comparison-side resolution

Resolve origin and comparison side separately:

1. Capture the invoking document URI and range. For a native draft, use its thread URI/range and the captured entry context; for editor commands, use the invoking text editor. Never infer source from the active editor at submission time.
2. Inspect the relevant tab's `TabInputTextDiff`, which exposes `original` and `modified` URIs. Match the captured document's full URI, including query, against these endpoints: unique original match means `left`; unique modified match means `right`. A normal text tab means `document`.
3. If the tab/editor association is uncertain, both endpoints have the same URI, or neither matches, ask which comparison/side the user intends. Public APIs do not expose a direct focused-diff-side property. Do not use `viewColumn`, scheme, or file name as a substitute.
4. Resolve each endpoint into a repo-relative path and origin. `file:` means `changed`, regardless of side. For `git:`, validate the JSON query and resolve its ref through the Git integration: index means `staged`, HEAD means `head`, and other commit refs resolve to `commit:<full-sha>`. Reject unsupported/unavailable refs rather than calling them working-tree code.
5. Require comparison endpoints to belong to the same selected repository in v1. Persist the ordered pair and selected side with the comment.

The bundled Git extension's URI query is an implementation detail, not a stable API. Verify actual refs for staged, unstaged, deleted, renamed, and historical files during development; handle malformed queries without throwing. Side resolution must also work for `vscode.diff` comparisons where both endpoints are `file:` URIs.

### 5.4 Comment display - compact decorations

Native gutter markers and expandable comment boxes are the primary display. Supplement them with a compact badge and overview-ruler mark at the resolved anchor range's **first line**:

```ts
vscode.window.createTextEditorDecorationType({
  after: {
    contentText: ' 💬',
    margin: '0 0 0 2em',
    color: new vscode.ThemeColor('editorInfo.foreground'),
  },
  backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
  overviewRulerColor: new vscode.ThemeColor('editorInfo.foreground'),
  overviewRulerLane: vscode.OverviewRulerLane.Right,
  rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
});
```

Badge variants by state: `💬` normal, `⚠️` low confidence. There is no replied or resolved state.

The overview-ruler mark helps locate comments in long files. A badge may show a count when several comments share a line; do not hide duplicates.

The `after` badge attaches after the line text, not to the viewport's right edge. Full text is available in the hover and expanded native comment box. Apply decorations to every matching `window.visibleTextEditors` entry, not only the active editor, and refresh on visibility, document, Git, and review-file changes.

### 5.5 Comment display — hover

`DecorationOptions.hoverMessage`, a `MarkdownString` with `isTrusted = true`:

```
**Review comment** · Right / Modified · working tree · L42-43
Comparison: src/auth/login.ts (index) -> src/auth/login.ts (working tree)

Missing error handling on the await — ...

[Edit](command:loopReview.editComment?%5B3%5D) ·
[Delete](command:loopReview.deleteComment?%5B3%5D) ·
[Reveal in COMMENTS.md](command:loopReview.reveal?%5B3%5D)
```

Command arguments are URI-encoded JSON arrays. The argument is the comment's **index in the parsed file**, valid only for the current parse generation — see §7.3.

### 5.6 Editor placement and comparison labels

Create native threads against the selected resource's URI and resolved range. They and decorations are projections of the same parsed file, disposed or refreshed after edits/deletion. New comments open expanded; restored comments may start collapsed but must retain visible gutter markers. Editing uses the native multiline editor, and deleting removes the corresponding markdown block.

In the captured comparison, a left comment appears only on Original and a right comment only on Modified. Match resources by repository, path, and origin, not path alone: identical paths and identical snippets on opposite Git revisions must not produce duplicate or misplaced comments. Never put a deleted-line comment on a nearby right-side line.

Comments also appear in other editors displaying the same resource/revision. A working-tree comment is visible in the normal file editor and its matching diff pane. A staged or HEAD comment does not decorate the working tree merely because its text matches. Always label capture provenance explicitly, for example **Captured: Left / Original (index)**; that index resource can later appear on the right in a staged comparison without changing the stored side. Include the ordered comparison pair in the expanded box/hover and clipboard text.

**Public API limits:** native threads are URI/range-scoped, not tab- or pane-scoped. If a comparison uses exactly the same URI on both sides, VS Code may show the thread on both; preserve the explicitly chosen capture side and label it rather than promising independent placement. In inline diff mode, native original-side threads are not reliably displayed. Offer **Open Side-by-Side Comparison** using the recorded pair for original-side review, with the tree/markdown as an always-available fallback. Do not silently create a modified-side comment instead. Validate these behaviors in the extension host before claiming support.

### 5.7 Tree view

View container in the activity bar, `Loop Review`. Groups:

- **Comments** — by file, then by resolved position
- **Stale** — unresolvable anchors

Tree items show the capture-side label and origin alongside the comment preview. Clicking a comparison comment reopens its recorded pair with `vscode.diff`, preserving Original/Modified ordering and revealing the selected resource/range where the public API allows. Never focus the other pane as a substitute; offer opening the selected revision directly if precise diff-side navigation is unavailable. Clicking a regular-editor comment opens its resource at the resolved range. Clicking a stale comment reveals its block in `COMMENTS.md`.

The tree view title exposes a prominent **Copy Comments & Clear** action (`loopReview.copyForAgent`, copy icon). Its tooltip explicitly says it copies all feedback and deletes `COMMENTS.md`. This is the primary end-of-pass action, not a palette-only utility. After successful deletion, the tree and decorations clear and the empty view invites the user to add comments for the next pass.

### 5.8 Status bar

`💬 3` - current comment count. Click opens the tree view. Hide when no comments file exists.

The human decides when to hand off feedback. Copy-and-clear does not depend on staging, hunk coverage, or a completion counter.

---

## 6. Git integration

Via the bundled git extension API:

```ts
const git = vscode.extensions.getExtension<GitExtension>('vscode.git')!.exports.getAPI(1);
// Select a repository using the rules below before accessing its review file.
```

Handle `git.state !== 'initialized'` by awaiting `onDidChangeState`. Handle zero repositories (extension stays dormant) and multiple repositories (use the one containing the active editor; if ambiguous, ask the user to select a repository). Scope the tree and copy-and-clear action to that selected repository and show its name in the view. Never silently choose a repository for file deletion or combine feedback from different repositories.

Needed operations:

| Need | Source |
|---|---|
| base SHA | `repo.state.HEAD?.commit` |
| blob content for re-anchoring | `repo.show(ref, path)` |
| change notifications | `repo.state.onDidChange` |

No diff/hunk parsing is required. Git integration is read-only: repository discovery, origin blobs for diff comments, and the optional base SHA. The extension does not mutate the index or working-tree code.

`repo.state.onDidChange` fires frequently; debounce at 300ms and coalesce.

### Guardrails

The human controls staging through the built-in SCM UI. Existing instructions preventing agents from staging or committing without approval remain useful, but the extension does not infer acceptance from the index or try to enforce those instructions.

---

## 7. Synchronisation

### 7.1 Model

```
COMMENTS.md  ──parse──▶  Comment[]  ──resolve──▶  ResolvedComment[]  ──▶  UI
     ▲                                                                    │
     └──────────────── append / splice / delete ◀─────────────────────────┘
```

Full re-parse on every change. No incremental updates, no reconciliation against a cached store. Identity is position in file; hand-reordering blocks self-heals on next read.

### 7.2 Watching

`vscode.workspace.createFileSystemWatcher` scoped to the selected repository's root `COMMENTS.md` plus `onDidSaveTextDocument`. Handle create, change, and delete events. Debounce 300ms. A missing file means an empty saved review: clear the parsed model, diagnostics, saved native threads, decorations, tree, and status bar without recreating it. Do not silently discard unsaved composers during a watcher refresh.

**Loop prevention:** keep the exact string last written by the extension. On a change event, read the file; if the content equals `lastWritten`, ignore the event entirely. Without this, write→parse→write oscillates the first time an `await` lands in the wrong order.

After file deletion, reset `lastWritten` and advance the generation to invalidate old comment actions. Cancel or discard in-flight reads from the previous generation so they cannot repopulate the cleared UI. The first new comment creates a fresh preamble using the current base SHA.

### 7.3 Parse generations

Every successful parse increments a generation counter. Command arguments embedded in hover markdown carry `(generation, index)`. A command invoked with a stale generation:

1. re-parses
2. attempts to re-resolve by `(file, lines, origin, side, comparison)` plus anchor text; if several comments match, fails rather than choosing one
3. on success, proceeds; on failure, shows "This comment has changed on disk" and refreshes the UI

This is the price of dropping stable IDs. It is worth paying — no IDs means new comments are a pure append with no splice-offset bugs — but it must be handled explicitly, not ignored.

### 7.4 Writes

- **Create** → append to end of file. Never a mid-file insert. This is the entire reason the comment list is flat.
- **Edit body** → splice that block only; every other byte is preserved verbatim, including user formatting, blank lines, and unknown sections.
- **Delete** → remove the block and exactly one following blank-line separator.
- **Copy and clear** → copy the complete file snapshot, then delete the file itself (§8.1), not one block at a time.

Never regenerate the whole file from the model. That is how the "just edit the markdown" property dies in week one.

**Malformed blocks:** do not drop, do not rewrite. Publish a `vscode.Diagnostic` on the offending line of `COMMENTS.md` (`"unparseable review block: expected 'Lines:' field"`), keep the block as opaque raw text, and round-trip it untouched. Corrupting review notes because a regex missed is the one unrecoverable failure mode in this design.

### 7.5 Concurrent edits

If `COMMENTS.md` is open and dirty in an editor when the extension wants to write, do not write. Show a warning offering *Save and retry* / *Cancel*. Writing under a dirty buffer loses the user's in-flight edit.

This guard also applies before copy-and-clear: never silently copy only the saved version and delete a file with unsaved feedback. Serialize extension mutations, including copy-and-clear, per repository. Recheck the snapshot and dirty-buffer state before deletion; if either changed, retain the file and ask the user to retry. Clipboard writes and filesystem deletion cannot be atomic, so report partial success explicitly rather than promising an all-or-nothing transaction.

---

## 8. Commands

| Command | Title | Context |
|---|---|---|
| `loopReview.addComment` | Add review comment | comment gutter, current line or selection in file/git editor, palette |
| `loopReview.submitComment` | Add Comment | native draft comment composer |
| `loopReview.editComment` | Edit comment | hover, tree view |
| `loopReview.deleteComment` | Delete comment | hover, tree view |
| `loopReview.reveal` | Reveal in COMMENTS.md | hover, tree view |
| `loopReview.gotoCode` | Go to code | tree view |
| `loopReview.openComparison` | Open Side-by-Side Comparison | comparison comment, original-side inline-diff fallback |
| `loopReview.copyForAgent` | Copy Comments & Clear | tree view title, palette |
| `loopReview.reanchorAll` | Rewrite line numbers from anchors | palette |
| `loopReview.refresh` | Re-parse and refresh | palette, tree view title |
| `loopReview.suggestGitignore` | Add COMMENTS.md to .gitignore | one-time prompt |

### 8.1 Copy Comments & Clear

`copyForAgent` is the primary handoff command:

1. Resolve the selected repository explicitly (§6). Require any open draft or comment edit to be submitted, explicitly discarded, or cancel the handoff (§8 Input UI). If its `COMMENTS.md` is open and dirty, offer **Save and retry** / **Cancel** before copying anything. Prevent new composers or comment edits until the handoff finishes.
2. Read the complete saved file into a snapshot. If the file is missing or whitespace-only, show "No review comments to copy", leave the clipboard untouched, and do not delete anything.
3. Prepend the instruction below and copy the snapshot with `vscode.env.clipboard.writeText`. Preserve all raw content, including paths, side-local ranges, origins, explicit sides, comparison pairs, captured code snippets, stale comments, malformed blocks, and hand-written notes. Do not export only successfully parsed comments or substitute current code for the captured context.
4. Await successful clipboard completion. If copying fails, show an error and leave the file and UI intact.
5. Verify that the saved file still matches the snapshot and no dirty editor buffer exists, then delete only that repository's `COMMENTS.md`. Never delete any other file or change the git index. If the file changed, retain it and report "Feedback copied, but COMMENTS.md changed and was not cleared. Retry to copy the latest feedback."
6. After successful deletion, clear the review UI and invalidate old actions (§7.2). Show "Review feedback copied; COMMENTS.md deleted. Paste it into your AI tool."

Handoff instruction:

> Review feedback follows. Address the comments using the included file paths and captured code snippets as context; line numbers and snippets may be stale. Side: left refers to Original, Side: right to Modified, and Side: document to a regular editor. Each comparison records both resources; lines and snippets belong to the selected side, not necessarily the current working-tree file. Staging remains under the human's control. This feedback was copied from a completed review pass; do not read, recreate, or reply in COMMENTS.md. Summarize your changes in this conversation.

If deletion fails after copying succeeds, retain the file/UI and report "Feedback copied, but COMMENTS.md could not be deleted" with the error. The user can retry; copying the same feedback again is safer than losing it. Do not clear or restore the clipboard on failure. Clipboard content is a point-in-time snapshot, not a persistent review archive.

The deliberately named action needs no additional confirmation in the normal success path. Keep it available when the file contains only malformed blocks or free-form notes, since those must remain exportable. Disable it while a copy-and-clear operation is running.

### Input UI

Use the native comment composer for multiline creation and editing (§5.1), with **Add Comment**, **Save**, and **Cancel** actions as appropriate. No single-line input box, escaped-newline convention, or custom webview. Hand-editing `COMMENTS.md` remains supported. Unsubmitted drafts are transient; copy-and-clear must offer to finish or discard them, or cancel the handoff, before proceeding so clearing the UI cannot silently lose draft feedback.

---

## 9. Configuration

| Setting | Default | Description |
|---|---|---|
| `loopReview.anchorMaxLines` | `20` | Lines captured before eliding |
| `loopReview.decorationStyle` | `badge` | `badge` \| `none` |
| `loopReview.searchRadius` | `50` | Lines searched around recorded position when re-anchoring |

---

## 10. `package.json` contributions (sketch)

```json
{
  "activationEvents": ["onStartupFinished"],
  "contributes": {
    "commands": [
      { "command": "loopReview.addComment", "title": "Add review comment", "category": "Loop Review" },
      { "command": "loopReview.copyForAgent", "title": "Copy Comments & Clear", "category": "Loop Review", "icon": "$(copy)", "enablement": "loopReview.hasFeedback && !loopReview.copyInProgress" }
    ],
    "keybindings": [
      {
        "command": "loopReview.addComment",
        "key": "ctrl+alt+m",
        "mac": "cmd+alt+m",
        "when": "editorTextFocus"
      }
    ],
    "menus": {
      "editor/context": [
        { "command": "loopReview.addComment", "when": "resourceScheme == file || resourceScheme == git", "group": "loopReview@1" }
      ],
      "view/title": [
        { "command": "loopReview.copyForAgent", "when": "view == loopReview.tree", "group": "navigation@1" }
      ]
    },
    "views": {
      "loopReview": [
        { "id": "loopReview.tree", "name": "Review Comments" }
      ]
    },
    "viewsContainers": {
      "activitybar": [
        { "id": "loopReview", "title": "Loop Review", "icon": "resources/icon.svg" }
      ]
    },
    "configuration": { "title": "Simple loop-review comments", "properties": {} }
  }
}
```

`onStartupFinished` rather than a narrower activation event: the status bar and tree view need to be live before the user selects anything.

`loopReview.hasFeedback` reflects non-whitespace raw content, not the parsed comment count. `loopReview.copyInProgress` prevents repeated invocation during a handoff. Both are scoped to the selected repository and updated after file changes.

The sketch omits native comment contributions: register submit/edit/save/delete/cancel commands and the `comments/commentThread/context`, `comments/comment/title`, and `comments/comment/context` menus with draft/editing context conditions. Use the controller's `commentingRangeProvider` for gutter entry; enforce resource support inside all command handlers too.

---

## 11. Module layout

```
src/
  extension.ts        activate/deactivate, wiring, disposables
  model.ts            Comment, ResolvedComment, Origin, Side, Comparison types
  parser.ts           parse() → { comments, rawBlocks, diagnostics }
  writer.ts           append(), spliceBody(), remove() — byte-preserving
  anchor.ts           re-anchoring algorithm (§4.2)
  git.ts              repository discovery, git extension API wrapper, origin blobs
  handoff.ts          clipboard snapshot, guarded file deletion, result notification
  ui/comments.ts      CommentController, multiline input, thread projection
  editorContext.ts    capture document/range, comparison pair, side and origin
  ui/decorations.ts   decoration + hover rendering
  ui/tree.ts          TreeDataProvider
  ui/status.ts        status bar item
  sync.ts             watcher, debounce, loop prevention, generations
```

`parser.ts` and `anchor.ts` are pure functions over strings. They should carry the bulk of the test suite and require no VS Code host to run.

---

## 12. Test cases

Parser:
- `## ` inside a fenced block is content
- fences of 4+ backticks, and `~~~`
- two comments with identical headers survive as two comments
- unknown H2 sections round-trip verbatim
- CRLF input round-trips as CRLF
- missing anchor, missing `Origin`, malformed `Lines:` each produce a diagnostic and preserve the block
- missing/invalid Side or inconsistent comparison endpoints produce a diagnostic without dropping feedback
- left/right comments on the same file/range remain distinct; comparison metadata survives body edits

Writer:
- append preserves every preceding byte
- body splice preserves sibling blocks byte-for-byte
- delete removes exactly one separator blank line

Anchor:
- no drift → exact match fast path
- 10 lines inserted above → local search resolves
- moved to another part of the file → whole-file search resolves
- reindented by a formatter → indentation-insensitive fallback resolves
- two identical snippets → nearest wins, `confidence: 'low'`
- deleted → stale

Sync:
- extension write does not retrigger parse
- external edit triggers exactly one parse after debounce
- command with stale generation re-resolves or fails cleanly
- write blocked while `COMMENTS.md` is dirty
- deletion clears UI and invalidates old actions, including pending reads
- first comment after a handoff recreates the file with a fresh base SHA

Clipboard handoff:
- copies every comment with paths, ranges, origins, and original snippets before deleting the file
- includes stale comments, malformed blocks, unknown sections, and free-form-only feedback verbatim
- clipboard failure leaves the file and review UI intact
- deletion failure reports partial success and keeps feedback available for retry
- missing or whitespace-only file does not overwrite the clipboard or delete anything
- dirty buffer offers Save and retry / Cancel; cancellation changes nothing
- file or buffer changes during clipboard write prevent deletion and prompt a retry
- repeated clicks do not run overlapping handoffs
- only the explicitly selected repository's COMMENTS.md is copied and deleted
- successful handoff never stages, unstages, or modifies code
- copied feedback unambiguously identifies the selected comparison side and both resources
- unsubmitted drafts must be finished, explicitly discarded, or cancel the handoff

Editor integration (extension-host/manual tests):
- gutter entry, current-line shortcut, range shortcut, and context menu work in regular editors for all text languages
- existing comments remain visible after reload and in all matching split editor groups, not just the active editor
- native multiline create/edit/delete round-trip through COMMENTS.md without reply controls
- unstaged diff: index/original left and working-tree/modified right comments render on their respective resources
- staged diff: HEAD/original left and index/modified right comments remain distinct even with identical text and paths
- deleted lines on the left retain original line numbers/snippets; added lines on the right use modified coordinates
- switching focus while composing does not change the captured side, path, range, or snippet
- file-versus-file comparison with two file URIs records the correct ordered paths and selected side
- historical comparisons resolve immutable commit origins; renamed-file comparisons preserve each endpoint's path
- identical-URI or uncertain comparison context asks for a side and labels the known placement limitation
- inline original-side review offers a side-by-side fallback, never silently retargets to Modified
- working-tree comments appear in regular editors and matching diff panes; staged/HEAD comments never leak into them
- a captured-left index comment shown later in a staged diff still identifies its original capture context
- unsupported documents explain the limitation without writing a misattributed comment

---

## 13. Optional agent guidance

No agent-side setup is required. Clipboard feedback is self-contained. Users who already maintain an `AGENTS.md` may include this guidance; the extension does not create or edit it.

```md
## Review loop

The git index is the human's review signal, not yours.

- Never run `git add`, `git rm`, `git stash`, or `git commit`. Staged changes
  mean the human has accepted them; staging anything yourself destroys that
  signal.
- Review feedback is pasted into this conversation by the human. Each `##`
  block includes a file path, origin, side, and captured code snippet.
  Comparison comments also identify both resources: left is Original and
  right is Modified. Lines belong to that selected side, not automatically
  the working tree. Locate by snippet and context; line numbers may be stale.
- Do not read, recreate, or reply in `COMMENTS.md`. It is the extension's
  scratch buffer and is deleted when the human copies a completed pass.
- Only modify code covered by a comment, or code you must touch to satisfy one.
  Leave unrelated changes alone unless the human requests otherwise.
- Use `git diff HEAD` to see your full change set — plain `git diff` hides
  anything already staged.
- Summarize addressed comments and any remaining questions in this conversation.
```

---

## 14. Milestones

**M1 - editor entry and placement spike.** Native comment gutter + current-line/range keybinding + context menu, multiline draft submission to `COMMENTS.md`. Validate both diff panes, full URI/origin/side capture, file comparisons, and inline-diff limitations against real editors before building the rest of the UI.

**M2 - read path.** Parser, anchoring, native thread projection, decorations, side labels, multiline edit/delete, and comparison navigation. Comments are visible in all matching text editors and `COMMENTS.md` is round-trippable.

**M3 — sync.** File watcher, loop prevention, generations, dirty-buffer guard, diagnostics for malformed blocks.

**M4 - handoff UI.** Comments tree, comment-count status bar, prominent **Copy Comments & Clear** action, clipboard export, guarded file deletion, failure handling, and fresh-pass reset. Validates the full human-to-AI loop.

**M5 - polish.** `reanchorAll`, settings, stale-base warning, and repository-selection UX.

M1 must establish the actual editor API behavior before estimating the remaining UI work.

---

## 15. Open questions

1. **Elision marker** in long anchors (§4.1) - `// ...` is language-specific and will look wrong in Python or YAML. A bare `...` line, or a language-aware marker? Re-anchoring must also account for elision rather than searching for the marker as literal source text.

Scope decisions: selections may span hunks without splitting; v1 does not parse hunks. Each repository has its own root `COMMENTS.md`, with one explicitly selected repository in the UI at a time. Agent replies and acceptance tracking are out of scope.
