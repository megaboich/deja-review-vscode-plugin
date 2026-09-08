# DejaReview — Specification

**Extension ID:** `local-review.dejareview`
**Display name:** DejaReview
**Command prefix:** `dejareview.`
**Target:** vanilla VS Code (no dependency on Copilot, Windsurf, or any bundled AI feature)
**Language:** TypeScript

The package name is `dejareview`; the v0.1 installation artifact is `dejareview-0.1.0.vsix`. Changing the extension ID does not automatically update an existing `local-review.simple-loop-review` installation. If both are installed, disable or uninstall the previous extension to avoid duplicate review providers.

---

## 1. Purpose

A review-feedback layer for code produced by command-line AI coding agents (`opencode`, `claude`).

The workflow this supports:

1. Agent makes changes in the working tree.
2. Human reviews the diff in VS Code.
3. Hunks that are good get **staged** — staging is the accept signal.
4. Hunks that need work get a **comment** anchored to the code.
5. Comments land in `COMMENTS.md` at the repo root.
6. Human clicks **Copy Comments & Clear** in the dashboard. Saved feedback, including captured code context, goes to the clipboard, then into a persistent local batch archive; only after archive success and snapshot/dirty-buffer checks is `COMMENTS.md` deleted. Unsubmitted input is not exported (§8 Input UI).
7. Human pastes the feedback into their AI tool. The agent addresses it; it does not read or reply in `COMMENTS.md`.
8. Repeat from 2. Adding the first comment of the next pass creates a fresh `COMMENTS.md`.

### Design principles

- **Root `COMMENTS.md` is the single source of truth for the current review pass.** Current UI state is a projection of a full re-parse of that file, not an archive. Recoverable batch archives are separate snapshots and never become current feedback until explicitly restored. The file is a scratch buffer, not a conversation history.
- **Staging stays in VS Code's SCM UI.** The human stages accepted changes; the extension neither stages code nor tracks acceptance or review completion.
- **Clipboard handoff is explicit and self-contained.** The human chooses when a pass is ready. Copy the feedback with paths, ranges, origins, and captured snippets, then archive the exact raw snapshot before clearing the scratch file.
- **The file must stay hand-editable.** Editing `COMMENTS.md` in the editor is a first-class input path, equal to using the UI.
- **Markdown must stay readable as markdown.** No HTML comments, no hidden metadata, nothing that looks like noise in a rendered preview.
- **Anchor by content, not by line number.** Line numbers are a hint; the code snippet is the anchor.
- **Comment where the code is.** Add and read comments in regular text editors and both sides of side-by-side comparisons, including read-only originals. No need to open `COMMENTS.md` for routine review.
- **Comparison side is explicit.** Preserve Left / Original versus Right / Modified independently of Git origin, in both the UI and clipboard feedback. Never infer the side from a file path or URI scheme alone.

### Non-goals

- No source-code revert / discard / restore actions. VS Code's built-in SCM view already does this. Restoring an archived feedback batch to `COMMENTS.md` is supported; it never changes code or the index.
- No LLM calls, no API keys, no model configuration. The extension never talks to an AI service.
- No GitHub/GitLab/PR integration. Local repository resources only.
- No MCP server, no IPC, no background daemon. The human pastes clipboard feedback into any AI tool.
- No agent replies in the file, threaded conversations, resolved states, or conversation history. Recoverable feedback batches are supported, not an agent conversation log.
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
| **Copy and clear** | Copy current feedback with context to the clipboard, archive its exact raw snapshot, then guardedly delete that repo's `COMMENTS.md`. |
| **Archive** | A user-local, repository-scoped batch snapshot with raw text, creation/copy date, and parsed comment count; not current feedback until restored. |

---

## 3. File format — `COMMENTS.md`

### 3.1 Location

Repo root, next to `.git` (a directory or worktree metadata file). Not configurable in v1. Create the file lazily on the first comment or explicit archive recovery; do not create an empty file on activation or automatically recreate it after copy-and-clear.

Recommended `.gitignore` entry — this is scratch review state, not history. The extension does **not** write to `.gitignore` automatically; it offers a one-time prompt (see §8, `dejareview.suggestGitignore`).

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
| `changed` | working-tree file or open buffer | usually right pane of unstaged diff; either pane of file comparisons | edits or deletion can invalidate the captured anchor |
| `staged` | index | right pane of staged diff; unstaged original when Git's `~` baseline selects the index | index changes or review-base movement |
| `head` | `HEAD` blob | left pane of staged diff; unstaged original when Git's `~` baseline selects HEAD | commit or unavailable blob |
| `commit:<full-sha>` | immutable commit blob | either pane of a historical comparison | blob unavailable locally |

Git URI refs map as follows: `''` means index, `HEAD`/`head` means HEAD, and `~` means index only when the queried file URI occurs in `repo.state.indexChanges`; otherwise it means HEAD. Other supported refs resolve through `getCommit` to a full commit SHA. Origin describes the resource, not a fixed pane.

`changed` will dominate in practice. `staged` identifies context captured from the index, not an acceptance or rejection state: a staged snippet may still receive a correction or a request to propagate a good pattern. `head` covers commenting on untouched existing code ("this is the pattern to follow").

**`Side:`** records where the comment was created: `left` = Original, `right` = Modified, `document` = regular editor. In inline diff mode, Original/Modified retain their meaning even though they are not physically left/right. Keep the captured side unchanged when rendering the same resource elsewhere.

**`Comparison:`** records the ordered pair of resources, not merely a comparison type. This distinguishes staged versus unstaged comparisons and file-versus-file comparisons where both sides have `Origin: changed`. Lines and snippets always belong to the selected side, including deleted lines on the original side. Do not translate them into the other side's line numbering.

### 3.5 Base SHA

The optional H1 preamble carries the base commit: `# Review · base <short-sha>`.

One SHA for the whole file, not per comment — a staleness check is then a single comparison. If `HEAD` has moved past the recorded base, all `head`- and `staged`-origin comments are suspect; the extension warns once and marks them stale rather than trying to rebase them.

### 3.6 Review-pass lifecycle

Comments remain in `COMMENTS.md` across editor reloads and restarts until the human edits/deletes them or runs **Copy Comments & Clear**. Staging code never deletes a comment.

Copy-and-clear ends the pass by deleting the file only after clipboard and archive success (§8.1). The archived batch persists across reloads and restarts and can be explicitly recovered (§8.2); clearing is not permanent deletion of that feedback. Agent responses live in the AI tool, not in the file. Blockquotes are ordinary body content with no special state or UI treatment.

### 3.7 Parse rules and gotchas

1. **Fence tracking is mandatory.** A `## ` line inside a fenced block is content, not a header. Track fence open/close (``` and ~~~, honouring longer runs) while scanning. This bites the first time you comment on a markdown file.
2. **Anchor is the first fence after the header, or nothing.** Prose between header and fence means there is no anchor. Define it strictly; do not scan forward for a "probable" fence.
3. **Duplicate headers are legal.** Two comments on the same range in the same file are distinct comments. Never dedupe by header.
4. **Unknown content is preserved.** Text before the first `## ` that isn't the H1 preamble is kept verbatim and round-tripped.
5. **Unparseable blocks are preserved, not dropped.** See §7.4.
6. Header matching is a single regex; keep it tolerant of extra whitespace around `;` and `:`, and case-insensitive on the `Origin` and `Side` values. Require `Side` on every comment; there is no previously shipped format to migrate.
7. Parse the comparison line separately, validate both endpoints, and keep its original bytes on body edits. Never treat a later `Comparison:` line inside body prose or a fence as metadata.
8. UI-created or edited bodies must have balanced fences and no unfenced `##` headings. Use `###` for body headings; `##` is reserved for block boundaries. The writer rejects bodies that occupy the reserved anchor or comparison-metadata position.

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

With no selection, capture the current line. An exclusive selection end at column zero does not include that final line; native thread ranges instead include their end line. Keyboard/menu entry captures the source editor, side-local range, comparison endpoints, and text before opening the comment composer; changing focus must not retarget that draft. Native gutter entry cannot expose its creation context through stable APIs: at submission, confirm context and capture current source text before the picker (§5.1). Unsaved working-tree text may be captured from the editor without saving or modifying code. Re-anchor against the open buffer when available; the stored snippet remains the original capture.

Capture up to 20 lines verbatim, a fixed limit with no setting. If the selection is longer, store the first 10 and last 5 lines separated by a bare `...` marker line (16 stored lines) and record the true range in `Lines:`. Re-anchoring recognizes this exact shape only for ranges longer than 20 lines and matches both ends, allowing the omitted length to change. Rationale: a 400-line selection produces an unreadable `COMMENTS.md` and a useless anchor.

### 4.2 Re-anchoring

Run on every parse, per comment, against the resource named by `path` and `origin` (the open buffer for `changed`, when available). Never search the opposite comparison resource as a fallback:

1. **Exact match at recorded position.** Compare `anchorText` against `[startLine, endLine]`. Hit → resolved, done. (Fast path, covers the common no-drift case.)
2. **Local search.** Search ±50 lines around `startLine` for an exact occurrence of `anchorText`. Single hit → resolved, update line numbers in memory (do not rewrite the file for this).
3. **Whole-file search.** Exact occurrence anywhere in the file. Single hit → resolved.
4. **Ambiguous.** More than one hit in step 2 or 3 → pick the one nearest `startLine`, mark `confidence: 'low'`.
5. **Not found.** An anchor with no match becomes `stale`.

Whitespace: compare with trailing whitespace stripped per line and with a leading-indentation-insensitive fallback (strip the common indent prefix from both sides) before giving up. Reformatters change indentation constantly.

No anchor snippet (hand-written comment with only a header) → trust `Lines:` verbatim, mark `confidence: 'low'`.

### 4.3 Stale comments

Stale comments are **never automatically deleted or rewritten**. They:

- appear in the tree view under a "Stale" group with a warning icon
- render no editor decoration or anchored native thread (there is nowhere to put it)
- are still included verbatim in clipboard feedback; the handoff instruction warns that snippets and locations may be stale

Explicit comment deletion and copy-and-clear apply to stale comments too.

### 4.4 Line-number rewriting

The extension rewrites `Lines:` in the file **only** when the user explicitly runs `dejareview.reanchorAll`. Automatic rewriting on every drift would cause constant `COMMENTS.md` churn and fight the sync loop. In-memory resolved positions are used for all UI.

---

## 5. UI surfaces

### 5.1 Primary entry - native comment gutter

Use `vscode.comments.createCommentController` with a `commentingRangeProvider` for supported text documents. Hover a line's comment gutter and click **+** to open a native multiline composer. Existing comments have native gutter markers; clicking one expands the comment inline. A new thread is a temporary draft until **Add Comment** persists it to `COMMENTS.md`. Cancelling an empty draft leaves no file or comment behind.

Support all text languages in normal editors, split editor groups, and both panes of side-by-side text diffs. This includes read-only Git originals, staged and unstaged comparisons, historical Git comparisons, and file-versus-file comparisons within one repository. Text outside a repository, untitled buffers, arbitrary virtual-provider documents, binary/custom editors, notebook cells, and merge editors are outside v1 scope; explain unsupported resources rather than silently attaching feedback elsewhere.

The native comment API provides the gutter/input UI but not persistence. Contribute explicit submit, edit, and delete commands. This uses a thread as a single-comment display container, not a conversation: disable replies after submission. No agent reply, resolution workflow, or separate thread store.

**v0.1 API deviation:** stable APIs expose neither a native gutter draft-creation event with source context nor an enumeration of those unsubmitted drafts. `CommentReply` supplies the thread URI/range, not its initial comparison or source snapshot. Native submission therefore always asks for context confirmation and captures current source text at submission, before the picker. It cannot recover the text from the initial gutter click. Keyboard/menu entry captures before typing and is recommended. Never reconstruct provenance from whichever tab is active after typing; unobservable drafts also affect handoff (§8 Input UI).

### 5.2 Trigger — keybinding and menus

- Keybinding: `ctrl+alt+m` / `cmd+alt+m`, `when: "editorTextFocus"`. Comment on the selection, or current line if none.
- `editor/context` menu item **Add Review Comment**, group `dejareview`, in regular and diff text editors, including read-only panes. Do not require `!editorReadonly`.
- Command palette: **Add Review Comment**, with the same behavior. Capture the last focused text editor context before opening UI; if the source is ambiguous, ask the user to choose it.

There is no CodeActionProvider or lightbulb entry; these commands and the native gutter are the supported entry points.

All entry paths use the native multiline composer. Keyboard/menu-created drafts have a label showing the captured path, side-local line range, and **Left / Original**, **Right / Modified**, or **Document**, plus the origin. Their submission uses this captured context, not whichever pane is active afterward. Native gutter drafts obtain confirmed context only at submission. A toolbar action must not default to the right pane when neither pane has focus; the gutter and keyboard are the primary paths.

### 5.3 Resource and comparison-side resolution

Resolve origin and comparison side separately:

1. Capture the invoking document URI and range. For editor commands, use the invoking or last focused text editor and freeze source text before asynchronous work. For native gutter submission, use the thread URI/range and current source text, then require explicit context confirmation; no initial entry snapshot is available. Never infer source from the active editor at submission time.
2. Inspect the relevant tab's `TabInputTextDiff`, which exposes `original` and `modified` URIs. Match the captured document's full URI, including query, against these endpoints: unique original match means `left`; unique modified match means `right`. A normal text tab means `document`.
3. If the tab/editor association is uncertain, both endpoints have the same URI, or neither matches, ask which comparison/side the user intends. Public APIs do not expose a direct focused-diff-side property. Do not use `viewColumn`, scheme, or file name as a substitute.
4. Resolve each endpoint into a repo-relative path and origin. `file:` means `changed`, regardless of side. For `git:`, validate the JSON query and resolve its ref through the Git integration: empty ref means `staged`, HEAD means `head`, and `~` conditionally selects index or HEAD (§3.4). Other commit refs resolve to `commit:<full-sha>`. Reject unsupported/unavailable refs rather than calling them working-tree code.
5. Require comparison endpoints to belong to the same selected repository in v1. Persist the ordered pair and selected side with the comment.

The bundled Git extension's URI query is an implementation detail, not a stable API. Verify actual refs for staged, unstaged, deleted, renamed, and historical files during development; handle malformed queries without throwing. Side resolution must also work for `vscode.diff` comparisons where both endpoints are `file:` URIs.

### 5.4 Comment display - compact decorations

Native gutter markers and expandable comment boxes are the primary display. Supplement them with a compact badge and overview-ruler mark at the resolved anchor range's **first line**:

```ts
vscode.window.createTextEditorDecorationType({
  after: {
    contentText: ' [review]',
    margin: '0 0 0 1em',
    color: new vscode.ThemeColor('editorInfo.foreground'),
  },
  overviewRulerColor: new vscode.ThemeColor('editorInfo.foreground'),
  overviewRulerLane: vscode.OverviewRulerLane.Right,
  rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
});
```

v0.1 uses the same `[review]` badge for high- and low-confidence anchors; there is no separate low-confidence badge, replied state, or resolved state.

The overview-ruler mark helps locate comments in long files. Duplicate comments retain separate threads and tree entries; badges are not aggregated into counts.

The `after` badge attaches after the line text, not to the viewport's right edge. Full text is available in the hover and expanded native comment box. Apply decorations to every matching `window.visibleTextEditors` entry, not only the active editor, and refresh on visibility, document, Git, and review-file changes.

### 5.5 Comment display — hover

`DecorationOptions.hoverMessage` uses an untrusted `MarkdownString` (`isTrusted = false`, `supportHtml = false`). The same untrusted content is used for tree tooltips:

```
**Review comment** · Right / Modified · working tree · L42-43
Comparison: src/auth/login.ts (index) -> src/auth/login.ts (working tree)

Missing error handling on the await — ...
```

Do not add executable command links to user-editable Markdown. Edit/delete/reveal use native comment actions; the tree also offers reveal/delete. Native comment bodies are untrusted as well. Actions carry an entry snapshot rather than a hover command URI (§7.3).

### 5.6 Editor placement and comparison labels

Create native threads against the selected resource's URI and resolved range. They and decorations are projections of the same parsed file, disposed or refreshed after edits/deletion. New comments open expanded; restored comments may start collapsed but must retain visible gutter markers. Editing uses the native multiline editor, and deleting removes the corresponding markdown block.

In comparisons with distinct resource URIs, a comment is projected onto its matching resource/revision, not onto the opposite revision. Match resources by repository, path, and origin, not path alone: identical paths and identical snippets on opposite Git revisions must not produce duplicate or misplaced comments. Never put a deleted-line comment on a nearby right-side line. Same-URI comparisons have the placement limitation below.

Comments also appear in other editors displaying the same resource/revision. A working-tree comment is visible in the normal file editor and its matching diff pane. A staged or HEAD comment does not decorate the working tree merely because its text matches. Always label capture provenance explicitly, for example **Captured: Left / Original (index)**; that index resource can later appear on the right in a staged comparison without changing the stored side. Include the ordered comparison pair in the expanded box/hover and clipboard text.

**Public API limits:** native threads are URI/range-scoped, not tab- or pane-scoped. If a comparison uses exactly the same URI on both sides, VS Code may show the thread on both; preserve the explicitly chosen capture side and label it rather than promising independent placement. In inline diff mode, native original-side threads are not reliably displayed. **Open Side-by-Side Comparison** opens the recorded pair and invokes `toggle.diff.renderSideBySide` only when explicitly requested and the diff is inline. Ordinary tree navigation does not toggle the layout. Keep tree/markdown navigation and the offer to open the selected revision separately as fallbacks; never create a modified-side comment instead. Visual placement and toggle behavior remain pending manual UI validation.

### 5.7 Tree view

View container in the activity bar, `DejaReview`. Groups:

- **Comments** - by file, retaining parsed file order within each file
- **Stale** — unresolvable anchors

Tree items show the capture-side label and origin alongside the comment preview. Clicking a comparison comment reopens its recorded pair with `vscode.diff`, preserving Original/Modified ordering and revealing the selected resource/range where the public API allows. Never focus the other pane as a substitute; offer opening the selected revision directly if precise diff-side navigation is unavailable. Clicking a regular-editor comment opens its resource at the resolved range. Clicking a stale comment reveals its block in `COMMENTS.md`.

The tree view title retains **Copy Comments & Clear** (`dejareview.copyForAgent`, copy icon) as a secondary entry point alongside the palette. After successful copy/archive/deletion, saved threads, tree entries, and decorations clear; the dashboard offers recent archives or a new pass. Unobservable native gutter drafts remain available (§8 Input UI).

### 5.7.1 Review dashboard

A **Review** webview (`dejareview.dashboard`) sits above the native **Review Comments** tree in the DejaReview activity-bar container. Its central primary action is a full-width, centered **Copy Comments & Clear** button with a minimum height of 48px. Explain that it copies, archives the batch, and clears current comments. Use VS Code sidebar, foreground, button, font, focus, and high-contrast theme tokens, responsive wrapping for narrow sidebars, and keyboard-accessible controls. The comments tree and multiline composer remain native; the webview is only the dashboard.

Show the selected repository and current parsed comment count. Availability and history visibility use saved raw feedback, not that count: any non-whitespace `COMMENTS.md` text is meaningful feedback. Malformed/free-form-only feedback can show **0 comments** but must still enable copy and hide archives. When the file is missing or whitespace-only, show the latest 10 valid archives for the selected repository, newest first, with localized creation/copy dates, parsed comment counts, and **Recover** actions. Dates describe batch archive creation during copying, not the original comment dates or recovery time. Do not show history while current raw feedback exists, or mix repositories. Disable mutation controls while busy and revalidate requests in the extension host.

Use a restrictive nonce-based CSP, no remote resources, and validated messages scoped to the selected repository. Send only display metadata to the webview, not raw feedback/code; render metadata as text rather than executable HTML.

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

Handle `git.state !== 'initialized'` by awaiting `onDidChangeState`. With zero repositories the review UI has no selected store. Initially choose the repository containing the active editor, or the sole open repository; otherwise leave selection unset. **Select Review Repository** offers an explicit picker, and copy-and-clear asks for selection if none exists. Adding a comment selects its source repository; ordinary editor focus changes do not switch an existing selection. Known drafts/edits and active mutations block repository switching. Scope the tree, dashboard, archives, recovery, and copy-and-clear action to that selected repository and show its name in the view. Never combine feedback from different repositories. Only local `file:` repository roots and supported `file:`/`git:` text resources are in v0.1 scope.

Needed operations:

| Need | Source |
|---|---|
| base SHA | `repo.state.HEAD?.commit` |
| blob content for re-anchoring | `repo.show(ref, path)` |
| immutable commit origin | `repo.getCommit(ref)` |
| conditional `~` baseline | `repo.state.indexChanges` file URI membership |
| change notifications | `repo.state.onDidChange` |

No diff/hunk parsing is required. Git integration is read-only: repository discovery, origin blobs for diff comments, and the optional base SHA. The extension does not mutate the index or working-tree code.

`repo.state.onDidChange` fires frequently; debounce and coalesce refresh requests. This is scheduling, not a UI latency guarantee.

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

`vscode.workspace.createFileSystemWatcher` is scoped to the selected repository's root `COMMENTS.md`, alongside `onDidSaveTextDocument`. Handle create, change, and delete events with debounced notifications and refresh scheduling. Save events and explicit refresh keep ignored review files usable even when watcher delivery is suppressed. Unsaved `COMMENTS.md` edits are not parsed until saved; other open source-buffer changes can trigger re-anchoring. A missing file means an empty saved review: clear parsed entries, diagnostics, saved preview threads, decorations, tree, and status bar without recreating it. Preserve drafts and open native edits during refresh.

**Loop prevention:** there is no `lastWritten` suppression. Explicit mutation commands refresh after writes, while store notifications and watcher/save events schedule debounced refreshes. Duplicate reads are harmless: parsing, re-anchoring, and rendering never write feedback. Only explicit create/edit/delete/reanchor/handoff/restore actions mutate it, so there is no parse-to-write feedback loop and no exactly-one-parse promise. A missing root file never causes automatic recovery from archives; only the dashboard's empty-state archive list changes.

Refresh, repository switching, and successful handoff advance a generation token; outdated asynchronous refreshes cannot publish UI. Comment mutations separately recheck current disk content (§7.3). The first submitted comment after deletion creates a fresh preamble using the current base SHA unless a batch was explicitly recovered first; recovery preserves its original base. Native gutter drafts remain on the live controller, not in the saved model.

### 7.3 Parse generations

The extension uses a generation counter to reject obsolete asynchronous refresh results, not as a persisted comment ID. Native/tree action arguments carry the parsed entry, repository, and exact file snapshot. Before saving, deleting, rewriting lines, or revealing a Markdown block, read or mutate against current saved text:

1. Re-parse current text. If it equals the entry snapshot, use the index only when the raw block also matches.
2. Otherwise, require the exact raw block to occur uniquely in both the old snapshot and the current parse. Changed bodies/headers and ambiguous duplicates are not guessed by semantic fields.
3. Proceed only on a match and in the same selected repository; otherwise report that the comment changed on disk and ask the user to refresh/select it again. Failed saves preserve open edit input.

This is the price of dropping stable IDs. It is worth paying — no IDs means new comments are a pure append with no splice-offset bugs — but it must be handled explicitly, not ignored.

### 7.4 Writes

- **Create** → append to end of file. Never a mid-file insert. This is the entire reason the comment list is flat.
- **Edit body** → splice that block only; every other byte is preserved verbatim, including user formatting, blank lines, and unknown sections.
- **Delete** → remove the block and exactly one following blank-line separator.
- **Copy and clear** -> copy the complete file snapshot, atomically archive it via temporary-file rename, then guardedly delete the file itself (§8.1), not one block at a time.
- **Restore archive** -> write exact archived raw text, including the original base preamble, only into an absent or unchanged whitespace-only file with no dirty buffer or known active input (§8.2). Never merge or regenerate it from parsed comments; retain the archive.

Never regenerate the whole file from the model. That is how the "just edit the markdown" property dies in week one.

**Malformed blocks:** do not drop, do not rewrite. Publish a `vscode.Diagnostic` on the offending line of `COMMENTS.md` (`"unparseable review block: expected 'Lines:' field"`), keep the block as opaque raw text, and round-trip it untouched. Corrupting review notes because a regex missed is the one unrecoverable failure mode in this design.

### 7.5 Concurrent edits

If `COMMENTS.md` is open and dirty in an editor when the extension wants to write, do not write. Show a warning offering *Save and retry* / *Cancel*. Writing under a dirty buffer loses the user's in-flight edit.

This guard also applies before copy-and-clear and recovery: never silently copy only the saved version and delete a file with unsaved feedback, or overwrite an active/dirty review with an archive. Serialize extension mutations, including handoff and recovery, per repository. After archive success, recheck the snapshot and dirty-buffer state before deletion; if either changed, keep the archived snapshot and retain the live file. Clipboard writes, archive persistence, and filesystem deletion cannot be one atomic transaction, so report partial success explicitly rather than promising all-or-nothing behavior.

`workspace.fs` has no atomic compare-and-write/delete against external writers. Snapshot and dirty-buffer checks guard observed changes but cannot eliminate the final filesystem race; atomic archive publication does not make root-file recovery or clearing transactional.

---

## 8. Commands

| Command | Title | Context |
|---|---|---|
| `dejareview.addComment` | Add review comment | current line or selection in file/git editor, editor menu, palette; gutter uses the native provider |
| `dejareview.submitComment` | Add Comment | native draft comment composer |
| `dejareview.editComment` | Edit comment | native comment title |
| `dejareview.saveComment` | Save | native comment edit |
| `dejareview.cancelEdit` | Cancel | native comment edit |
| `dejareview.cancelDraft` | Cancel | native draft composer |
| `dejareview.deleteComment` | Delete comment | native comment title, tree view |
| `dejareview.reveal` | Reveal in COMMENTS.md | native comment title, tree view |
| `dejareview.gotoCode` | Go to code | tree view |
| `dejareview.openComparison` | Open Side-by-Side Comparison | comparison comment, original-side inline-diff fallback |
| `dejareview.copyForAgent` | Copy Comments & Clear | dashboard primary button, tree view title, palette |
| `dejareview.restoreArchive` | Recover Archived Review | dashboard archive row, palette picker |
| `dejareview.reanchorAll` | Rewrite line numbers from anchors | palette |
| `dejareview.refresh` | Re-parse and refresh | palette, tree view title |
| `dejareview.selectRepository` | Select Review Repository | palette, tree view title |
| `dejareview.suggestGitignore` | Add COMMENTS.md to .gitignore | palette, one-time prompt per repository |

### 8.1 Copy Comments & Clear

`copyForAgent` is the primary handoff command:

1. Use the selected repository, asking for selection if none exists (§6). For known keyboard/menu drafts or open comment edits, offer **Finish comments first** or **Copy and discard drafts**, or cancel (§8 Input UI). Native gutter drafts cannot be enumerated and are preserved, not exported. If `COMMENTS.md` is open and dirty, offer **Save and retry** / **Cancel** before copying anything. Guard new command-created composers, submissions, and comment edits while copying, and return no new commenting ranges.
2. Read the complete saved file into a snapshot. If the file is missing or whitespace-only, show "No review comments to copy", leave the clipboard untouched, and do not delete anything.
3. Prepend the instruction below and copy the snapshot with `vscode.env.clipboard.writeText`. Preserve all raw content, including paths, side-local ranges, origins, explicit sides, comparison pairs, captured code snippets, stale comments, malformed blocks, and hand-written notes. Do not export only successfully parsed comments or substitute current code for the captured context.
4. Await successful clipboard completion. If copying fails, report the failure and leave the file and UI intact.
5. Save the exact raw snapshot (without the handoff instruction) as a new archive (§8.2): write a temporary JSON file in the archive directory, then atomically rename it to its UUID destination without overwriting another archive. Await archive success before any source deletion. On failure, retain the source and input/UI, report that the clipboard copied but archiving failed and `COMMENTS.md` was not cleared, and clean up the temporary file where possible.
6. Re-read the source and recheck that it matches the snapshot and no dirty editor buffer exists, then delete only that repository's `COMMENTS.md`. Never modify source code or the git index. If the file or buffer changed, retain the live state and the archived snapshot and report that feedback was copied and archived but `COMMENTS.md` was not cleared, with a request to save and retry.
7. After successful deletion, clear saved review projections and any known drafts/edits explicitly authorized for discard; retain the controller and unobservable native gutter drafts (§7.2). Report that feedback was copied and archived, current comments were cleared, and it is ready to paste into the AI tool. Refresh the dashboard's recent archive list.

Handoff instruction:

> Review feedback follows. Address the comments using the included file paths and captured code snippets as context; line numbers and snippets may be stale. Side: left refers to Original, Side: right to Modified, and Side: document to a regular editor. Each comparison records both resources; lines and snippets belong to the selected side, not necessarily the current working-tree file. Staging remains under the human's control. This feedback was copied from a completed review pass; do not read, recreate, or reply in COMMENTS.md. Summarize your changes in this conversation.

If deletion fails after copying and archiving succeed, retain the file/UI and archive and report partial success with the error. The user can retry; copying and archiving the same feedback again is safer than losing it. Do not clear or restore the clipboard on failure. Clipboard content is a point-in-time snapshot; persistent recovery uses the separate archive, not the clipboard.

The deliberately named action needs no additional confirmation in the normal success path. Keep it available when the file contains only malformed blocks or free-form notes, since those must remain exportable. Disable it while a copy-and-clear operation is running.

### 8.2 Batch archives and recovery

Store archives outside the repository at `ExtensionContext.globalStorageUri/reviews/<sha256(repoURI)>/<uuid>.json`, hashing the repository URI string. Each JSON record contains `version`, `id`, `repoUri`, exact raw `text`, ISO `createdAt` (archive creation during copying), and `commentCount` from parsing that snapshot. Counts can be zero for meaningful malformed or free-form feedback. Validate record identity, repository, dates, counts, and content before use; reject invalid/path-like IDs and skip invalid records in listings.

Archives persist across VS Code reloads and restarts in user-local machine storage. Sort newest first and show only the latest 10 valid batches in the dashboard/picker. Ten is a display limit, not a retention limit: retain older archives, with no automatic purge or archive-delete command. Recovery also keeps the archived copy and its original creation date. These files contain review prose and captured source-code snippets; they are local only, not synced or encrypted by the extension, and are not an encrypted backup service. Users must account for that retained content when managing their local storage.

`dejareview.restoreArchive` recovers an explicitly selected batch for the selected repository. Block recovery while another mutation or known draft/edit is active. Require the root file to be absent or whitespace-only and have no dirty buffer; recheck both the saved snapshot and dirty state immediately before writing. If either changes, abort without overwriting the live review. Never merge, append to active feedback, or silently discard input. Stable APIs cannot enumerate native gutter drafts; preserve them and keep the existing native-input limitations explicit.

Write the archived raw text exactly to root `COMMENTS.md`, preserving formatting, malformed/free-form content, snippets, and the original base SHA rather than substituting the current HEAD. Re-parse and refresh current native threads/tree/decorations afterward, applying normal stale-base/anchor rules. Only this explicit restore makes archive content current. Do not modify code or the index, consume the archive, or automatically restore on activation or an empty file.

### Input UI

Use the native comment composer for multiline creation and editing (§5.1), with **Add Comment**, **Save**, and **Cancel** actions as appropriate. No single-line input box, escaped-newline convention, or custom webview composer; the dashboard webview is a separate handoff/recovery surface. Hand-editing and saving `COMMENTS.md` remains supported; bodies require balanced fences and no unfenced `##` headings (use `###`).

**Implemented v0.1 deviation:** copy exports only submitted, saved comments and other raw content already saved in `COMMENTS.md`, never unsubmitted composer text or unsaved edits. Known keyboard/menu drafts and open saved-comment edits trigger a finish/discard/cancel prompt; authorized discard happens only after successful copy-and-clear. Stable APIs cannot enumerate native gutter-created drafts, so the extension cannot include them in that prompt or guarantee an all-drafts-finished pass boundary. It keeps the controller alive and does not silently destroy them: those unsubmitted native drafts remain available for the next pass. They are transient, not persisted across reloads. Their eventual submission requires context confirmation and captures then-current source text, not initial gutter-click text. Recommend keyboard entry when pre-typing capture matters.

---

## 9. Configuration

| Setting | Default | Description |
|---|---|---|
| `dejareview.decorationStyle` | `badge` | `badge` \| `none` |
| `dejareview.searchRadius` | `50` | Lines searched around recorded position when re-anchoring; range 0-10000 |

The 20-line anchor threshold and first-10 / `...` / last-5 elision format are fixed, not configurable.

---

## 10. `package.json` contributions (sketch)

```json
{
  "activationEvents": ["onStartupFinished"],
  "contributes": {
    "commands": [
      { "command": "dejareview.addComment", "title": "Add review comment", "category": "DejaReview" },
      { "command": "dejareview.copyForAgent", "title": "Copy Comments & Clear", "category": "DejaReview", "icon": "$(copy)", "enablement": "dejareview.hasFeedback && !dejareview.copyInProgress" },
      { "command": "dejareview.restoreArchive", "title": "Recover Archived Review", "category": "DejaReview" }
    ],
    "keybindings": [
      {
        "command": "dejareview.addComment",
        "key": "ctrl+alt+m",
        "mac": "cmd+alt+m",
        "when": "editorTextFocus"
      }
    ],
    "menus": {
      "editor/context": [
        { "command": "dejareview.addComment", "when": "resourceScheme == file || resourceScheme == git", "group": "dejareview@1" }
      ],
      "view/title": [
        { "command": "dejareview.copyForAgent", "when": "view == dejareview.tree", "group": "navigation@1" }
      ]
    },
    "views": {
      "dejareview": [
        { "id": "dejareview.dashboard", "name": "Review", "type": "webview", "initialSize": 2 },
        { "id": "dejareview.tree", "name": "Review Comments" }
      ]
    },
    "viewsContainers": {
      "activitybar": [
        { "id": "dejareview", "title": "DejaReview", "icon": "resources/icon.svg" }
      ]
    },
    "configuration": { "title": "DejaReview", "properties": {} }
  }
}
```

`onStartupFinished` rather than a narrower activation event: the status bar and tree view need to be live before the user selects anything.

`dejareview.hasFeedback` reflects non-whitespace raw content, not the parsed comment count. `dejareview.copyInProgress` prevents repeated invocation during a handoff. Both are scoped to the selected repository and updated after file changes.

The sketch omits native comment contributions: register submit/edit/save/delete/cancel commands and the `comments/commentThread/context`, `comments/comment/title`, and `comments/comment/context` menus with draft/editing context conditions. Use the controller's `commentingRangeProvider` for gutter entry; enforce resource support inside all command handlers too.

---

## 11. Module layout

```
src/
  extension.ts        activation/disposal, commands, native drafts/threads,
                      decorations/hover, tree/status, refresh generations/debounce
  model.ts            ReviewComment, ParsedComment, ResolvedAnchor, Resource,
                      Origin, Side, Comparison types and validation
  parser.ts           parse() -> { comments, diagnostics, base }, scanMarkdown()
  writer.ts           appendComment(), editComment(), deleteComment(), rewriteLines()
  anchor.ts           re-anchoring algorithm (§4.2)
  git.ts              repository discovery, git extension API wrapper, origin blobs
  handoff.ts          pure copyAndClear() port, instruction and result types
  archive.ts          repository-scoped JSON snapshots, atomic save, list/read validation
  dashboard.ts        webview provider, display state, validated action messages
  dashboardHtml.ts    themed responsive dashboard shell, copy button and archive rows
  editorContext.ts    freeze source/range, context picker, pair/side/origin, elision
  store.ts            ReviewStore: saved-file reads, watcher/save events, debounce,
                      serialized mutations, dirty/snapshot/symlink guards, handoff I/O
```

Native comment/tree/editor UI remains in `extension.ts`; the dashboard provider and HTML are separate modules. There are no `ui/` or `sync.ts` modules. `parser.ts`, `writer.ts`, `anchor.ts`, the port-based `handoff.ts`, and `dashboardHtml.ts` run without a VS Code host. Runtime npm dependencies are zero; build, package, and test tools are development dependencies. The current `npm audit` reports low-severity transitive development-tool warnings, including age/license-policy findings, not an audit-clean development tree.

---

## 12. Test cases

This is a validation checklist, not a claim that every UI scenario has been manually verified. `npm test` compiles and runs `test/core.test.ts`, `test/handoff.test.ts`, and `test/dashboard.test.ts`. `npm run test:integration` compiles and runs the extension-host suite in `test/integration/`, including `archives.ts` for archive persistence/recovery, through `test/runIntegration.ts`.

The integration runner uses `/Applications/Visual Studio Code.app/Contents/MacOS/Code` by default; set `VSCODE_EXECUTABLE_PATH` to the actual executable for another installation. It creates an isolated disposable Git fixture, user-data directory, and extensions directory, isolates Git configuration, and restores prior clipboard text in cleanup (not other clipboard formats). Command/API assertions cover resource capture, persisted projections, editing/deletion, watcher refresh, re-anchoring, and real clipboard handoff. Visual gutter clicks, physical shortcut dispatch, modal prompt interactions, reload UX, and inline/same-URI placement remain pending manual validation.

Parser:
- `## ` inside a fenced block is content
- fences of 4+ backticks, and `~~~`
- two comments with identical headers survive as two comments
- unknown H2 sections round-trip verbatim
- CRLF input round-trips as CRLF
- a missing anchor is valid and uses low-confidence line hints; missing `Origin` or malformed `Lines:` produces a diagnostic and preserves the block
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
- explicit extension writes refresh saved projections; subsequent watcher reads never write feedback
- external edits refresh after debounced notifications; save events and explicit refresh cover ignored files without promising exact parse counts or latency
- obsolete refresh generations cannot publish; stale entry snapshots re-resolve uniquely by raw block or fail cleanly
- write blocked while `COMMENTS.md` is dirty
- deletion clears saved projections while preserving open input; obsolete reads cannot publish and stale mutations fail safely
- first comment after a handoff recreates the file with a fresh base SHA

Clipboard handoff:
- copies every comment with paths, ranges, origins, and original snippets, then atomically archives the exact raw snapshot before deleting the file
- includes stale comments, malformed blocks, unknown sections, and free-form-only feedback verbatim
- clipboard failure leaves the file and review UI intact
- archive write/rename failure retains source and input/UI, reports clipboard-only partial success, and never deletes COMMENTS.md
- deletion failure reports partial success and keeps feedback available for retry
- missing or whitespace-only file does not overwrite the clipboard or delete anything
- dirty buffer offers Save and retry / Cancel; cancellation changes nothing
- file or buffer changes during clipboard/archive writes preserve the archived snapshot and live feedback, prevent deletion, and prompt a retry
- repeated clicks do not run overlapping handoffs
- only the explicitly selected repository's COMMENTS.md is copied and deleted
- successful handoff never stages, unstages, or modifies code
- copied feedback unambiguously identifies the selected comparison side and both resources
- known shortcut drafts/open edits prompt to finish, explicitly discard on success, or cancel; native gutter unsubmitted drafts are not exported and remain available for the next pass

Archives and dashboard:
- archives persist across store re-creation/restarts outside the repository, scoped by repository URI hash
- latest 10 batches show newest-first copy/creation dates and parsed counts; older files remain retained
- missing/whitespace-only root feedback shows archives; any non-whitespace raw content hides history, even with zero parsed comments
- malformed/free-form-only feedback copies, archives, and restores verbatim with a zero parsed count
- recovery preserves original raw text and base SHA, keeps the archive, and refreshes current projections only after explicit restore
- recovery rejects active raw feedback, dirty buffers, known drafts/edits, concurrent mutations, and source changes during recovery without merging or overwriting
- malformed records, invalid IDs, and repository mismatches cannot restore arbitrary files or leak another repository's archives
- themed full-width button is at least 48px tall above the native tree; verify narrow sidebar, keyboard focus, light/dark/high-contrast themes manually
- dashboard CSP and validated messages reject executable metadata and stale/cross-repository actions; raw code is not sent to the webview

Editor integration (extension-host/manual tests):
- gutter entry, current-line shortcut, range shortcut, and context menu work in regular editors for all text languages
- existing comments remain visible after reload and in all matching split editor groups, not just the active editor
- native multiline create/edit/delete round-trip through COMMENTS.md without reply controls
- unstaged diff: conditional HEAD-or-index/original left and working-tree/modified right comments target their respective resources
- staged diff: HEAD/original left and index/modified right comments remain distinct even with identical text and paths
- deleted lines on the left retain original line numbers/snippets; added lines on the right use modified coordinates
- switching focus while composing a keyboard/menu draft does not change captured side, path, range, or snippet; native gutter submission confirms context and captures current source text instead
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
  root scratch buffer, cleared only after the human copies and locally
  archives a completed pass. Feedback is recoverable, not permanently deleted;
  archive recovery is the human's explicit action, not the agent's task.
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

**M4 - handoff UI.** Native comments tree, themed webview dashboard with the prominent **Copy Comments & Clear** button, comment-count status bar, clipboard export, atomic batch archive, guarded file deletion, recent-10 archive display, safe explicit recovery, failure handling, and fresh-pass reset. Validates the full human-to-AI loop.

**M5 - polish.** `reanchorAll`, settings, stale-base warning, and repository-selection UX.

### Implementation status (v0.1)

The M1-M5 implementation paths are present in the modules above, including persistence, UI projections, guarded handoff, repository selection, settings, and explicit re-anchoring. Automated pure and extension-host suites exist; their command/API coverage is distinct from manual interaction validation (§12). Native gutter creation-time capture and all-draft enumeration are unavailable through stable APIs; the implemented confirmation/preservation deviations are recorded in §5.1 and §8 Input UI.

Manual validation remains pending for visual gutter/composer actions, keyboard dispatch, context and dirty/draft prompts, reload/split-editor UX, and inline/same-URI comparison placement. These milestones are not visual acceptance results or timing promises.

---

## 15. Open questions

The elision decision is implemented: a bare `...` between the first 10 and last 5 lines for selections longer than 20 (§4.1); re-anchoring matches both ends rather than searching for literal marker text. Remaining validation questions concern native UI behavior listed in §12 and §14.

Scope decisions: selections may span hunks without splitting; v1 does not parse hunks. Each repository has its own root `COMMENTS.md`, with one explicitly selected repository in the UI at a time. Agent replies and acceptance tracking are out of scope.
