# Problems: Root Causes, Current Handling, Proportionality

**Implementation update:** this is the baseline complexity analysis, not a claim that all
listed mechanisms remain. Central JSON storage and last-copy recovery are now implemented
as described in [storage.md](storage.md). Markdown parsing/snapshot mutation still exists
as an internal UI projection; the broader capture, editor and guard simplifications have
not been implemented. Storage is central, not in the project directory.

This document separates **root problems** (facts about VS Code, Git, files, or the product
decisions) from the **mechanisms** built in response. For each mechanism it gives an
approximate cost and asks whether that cost fits a single-user, local note-taking tool.

Line counts are estimates from reading the code. Verdicts are judgements, meant as input
to decisions, not as conclusions.

**Review constraints:** the current-mechanism analysis below is unchanged unless noted.
Future simplification must keep gutter capture/editing, panel editing and every Files to
Review feature. The reviewer accepts structured repository-root storage without a
hand-editing workflow, and repository-scoped recovery of the last copy. See
`simplification.md` §1 for decisions and unresolved scope/context details.

Verdict scale:

| Verdict | Meaning |
| --- | --- |
| **Keep** | Essential and proportionate |
| **Reduce** | Right idea, built heavier than needed |
| **Question** | Exists because of a product decision worth revisiting |
| **Remove** | Defends against something that cannot happen or does not matter |

---

## Part 1. Complexity Drivers

Most of the complexity comes from eight decisions. Each one fans out into mechanisms across
several files. Changing a driver removes its mechanisms; changing a single mechanism
usually does not.

### D1. `REVIEW-NOTES.md` is both the database and a hand-editable document

**Decision.** The Markdown file is the only store. It must survive hand edits, unsaved
buffers, unknown sections, malformed blocks, BOM/CRLF, and duplicate notes, without ever
being regenerated.

**Consequences.**

- A custom fence-aware Markdown scanner and parser, with eight byte offsets per note
  (`parser.ts`).
- Targeted splicing for append, edit and delete, and re-parsing after each write to prove
  the round trip (`writer.ts`).
- Body serialization rules plus the `💬 Body: fenced` wrapper, so any text survives as a
  body.
- No stored note IDs. Identity is "offset within a snapshot", so every entry and every
  editor session carries the whole-file snapshot, and `current()` re-locates notes by raw
  text with a uniqueness rule.
- Dirty-buffer handling: an `ensureSaved` modal loop and dirty checks after every await in
  every write path.
- Compare-and-swap emulation (`workspace.fs` has none): temp file, re-read, compare,
  existence check, rename.
- Diagnostics, the malformed-block notice, and "changed on disk; refresh and retry"
  failures.

**Cost.** About 900 source lines (parser, writer, much of store, `current()` and snapshot
threading) and about 1,500 test lines.

**Reviewed direction: simplify storage.** Keep the visible local file, at the Git
repository root, but use structured records rather than a hand-editable Markdown database.
This removes Markdown offsets and raw-block identity, not atomic writes, invalid-file
handling or concurrent-writer protection. See `simplification.md` P1.

### D2. Capturing exact revision and diff-side provenance

**Decision.** Each line note records which revision (working tree, index, HEAD, commit)
and which diff pane it was taken from, plus the opposite endpoint. The capture must still
be true when the note is saved.

**Consequences.**

- The origin, side and comparison model, and the `Original/Modified: X vs Y` header
  grammar.
- Mapping `git:` URIs to origins, including the `~` ref that means "index if staged,
  otherwise HEAD".
- Frozen capture of displayed text for every relevant tab.
- A QuickPick when the side is ambiguous, and inference from open tabs for gutter drafts.
- Revalidating mutable revisions:
  - three Git-change listeners;
  - a recorded `baseCommit`;
  - re-reading blobs and comparing them with the displayed text;
  - re-checking the `~` mapping.

  Staleness is checked four times per capture.
- Navigation: reopening the exact diff, a side-by-side toggle, "Open Revision".

**Cost.** About 450 source lines across `editorContext.ts`, `extension.ts`, `git.ts`,
`parser.ts`, `writer.ts` and `model.ts`, plus large format and capture test suites.

**Reviewed direction: simplify without losing context.** The agent must distinguish
removed code, new code and changes, and notes must be rediscoverable in both UIs. Removing
Original-pane capture or all revision information is not an acceptable shortcut. Evaluate
the minimum endpoint/snippet context that meets those requirements (`simplification.md` P2).

### D3. Three editing surfaces for the same note

**Decision.** A note can be edited in its native gutter thread, in the panel editor, or by
hand in the file.

**Consequences.**

- Native edit sessions (`editSessions`, the `saving` set, "earlier body was saved" paths).
- A host-held panel editor session.
- Handoff and restore must know about native drafts and open edits, ask "Copy and discard
  drafts", and refuse recovery while any exist.
- `publishEditors()` must never touch threads in edit mode.

**Cost.** About 250 source lines for native editing, plus the panel editor (§D4).

**Reviewed direction: retain two editors.** Gutter and panel editing are required;
hand-editing the storage file is not. Share stable note identity and mutations where
possible, but keep draft retention and concurrent-edit protection for both UIs.

### D4. The webview is treated as stateless, untrusted, and recreated on hide

**Decision.**

- No `retainContextWhenHidden`.
- Every message is strictly validated in both directions.
- The editor must not lose a keystroke or double-save even if the page is destroyed
  mid-request.

**Consequences.**

- A transport cache in `setState`.
- The `inputAccepted` / `editorSettled` / `editorRequestStatus` handshake, with
  `requestId`s, settlement replay and `instanceKey`.
- A host-message validator in the client, duplicating the host projection.
- Input refused while busy, plus resend logic.
- Projection rules repeated in two or three places: preview truncation, archive cap,
  pending markers.

**Cost.** About 350 source lines and 700+ test lines for the editor transport, plus about
150 lines of duplicated validation.

**Verdict: Reduce.** Host decoding and authorization are a real trust boundary: keep them.
The transport machinery protects against a sub-second window that `retainContextWhenHidden`
plus the host-held body would almost remove. Validating our own host messages protects
against our own code.

### D5. Assuming the folder or repository can change at any moment

**Decision.** Re-check the opened folder after every await. Carry `repoKey` on every
webview message. Handle switching stores mid-operation, and handle "stranded" editor
sessions.

**Reality.** VS Code restarts the extension host when the first workspace folder changes,
so a running extension never sees `workspaceFolders[0]` change. The real transitions are:

- the Git repository appears late (Git initializes after activation);
- the Git repository disappears (closed or deleted).

**Consequences.**

- 22 `workspaceFolders[0]` comparisons.
- `useRepository` / `transitionRefreshScope` with refusal rules.
- `assertScope`, `storeFor`, `ensureWorkspaceStore`.
- `repoKey` in every message type and check.
- Folder-scoped row keys in the client.
- Mocked folder-switch tests.

**Cost.** About 200–250 source lines across the extension, dashboard and client, and a
sizeable part of `filesDashboard.test.ts`.

**Verdict: Remove** (mostly). Keep "repository appears or disappears" handling. Treat the
folder as fixed for the lifetime of the extension host.

### D6. Race-proof, cached `+N -M` statistics for Files to Review

**Decision.** Show line counts per changed file, computed in the background, cached by
file metadata and index object, and verified against concurrent changes.

**Consequences.**

- A signature cache keyed by Git event identity.
- A two-pass verification that recomputes signatures and retries raced cache hits.
- A literal `git ls-files` lookup per file per pass.
- A bounded untracked reader (5 MiB buffer per file).
- Bracket-path ambiguity handling.
- In the extension: `statisticsSnapshot`, `statisticsRevision`, `forceStatistics`,
  `statisticsWork`, and row merging.

**Cost.** About 330 source lines in `git.ts`/`gitPath.ts`, about 70 in `extension.ts`, and
about 1,000 test lines.

**Measured irony.** On a Git refresh where nothing changed, a cache hit costs **two** `git`
processes per file (signature + verification). The uncached path costs **one** `git diff`.
A single `git diff --numstat` for all files would cost one process in total.

**Verdict: Reduce.** The counts are display-only. The race handling is the strongest in
the codebase for derived data. Counts are required by the reviewer: simplify or batch their
computation rather than remove the feature.

### D7. Destructive Git actions through an API that takes pathspecs

**Decision.** Stage and Revert go through vscode.git `add` / `clean`, which pass paths to
Git as **patterns**. Revert must keep staged work and refuse unsafe states.

**Consequences.**

- Refusal of `*` and `?` in filenames.
- An extra `git ls-files` check for `[ ]` paths, before and after the confirmation dialog.
- A Revert status allow-list.
- Dirty-buffer refusal.
- The validate-then-act sequence in one synchronous turn.
- An ownership walk before each step.

**Cost.** About 110 source lines in `mutateFile`, about 45 for the pathspec check, and
about 550 test lines.

**Verdict:**

- **Keep** Revert and its safety rules; the reviewer requires it, and it is the only
  action that can destroy data.
- **Question** the API choice. `git --literal-pathspecs add/checkout` would remove the
  bracket problem at its root. The extension already runs `git` directly in `gitPath.ts`.

### D8. "Generations over locks" plus layered, per-site guards

**Decision.** Refreshes are never locked. They are invalidated by counters. Writes are
guarded by several flags, and each call site picks its own combination. State is
re-checked after every await, and checks are passed down as closures.

**Consequences.**

- Five counters, two of them effectively redundant (`filesGeneration`,
  `publishedGeneration`).
- Five guard getters.
- About 15 validation closures.
- `store.mutate` taking three hooks.
- Commented "deliberate omissions".
- Inconsistencies between native and panel paths (`architecture.md` §4).

**Cost.** Spread across `extension.ts`. Perhaps 300 lines of guard and validation code, and
a large share of the race tests.

**Verdict: Reduce.**

- Generations are a good fit for refresh.
- For writes, one serialized operation lock would replace most flags and combinations and
  make the rules uniform.
- Data checks against **external** writers (the snapshot comparison in the store) should
  stay.
- This would reverse AGENTS.md's "guards are layered, not shared", so it needs an explicit
  decision.

**Review decision:** acceptable only without noticeable slowdown. Typing, reads and
background work must remain responsive; modal prompts must not become long-held write
locks. See `simplification.md` P4 for the proposed boundaries and verification requirements.

---

## Part 2. Root-Problem Catalogue

Grouped by root cause. "Mechanism" names the main functions.

### Data Safety

| Root problem | Cause | Mechanism | Verdict |
| --- | --- | --- | --- |
| A write must never corrupt or partially write the notes | Crashes, concurrent writers | Temp file + atomic rename (`store › publish`) | **Keep** |
| Unsaved buffer of the notes file | Hand-editing in VS Code (D1) | `ensureSaved` loop, dirty checks after each await | **Question** (refusing would be simpler) |
| Something else writes the file between read and write | No compare-and-swap in `workspace.fs` | Re-read + compare + existence check before rename | **Reduce** (one check is enough) |
| Copy & Clear must never lose feedback | Clipboard, recovery publication and clearing are separate failure points | Ordered operations in `ReviewStore.handoff`, partial-success messages; see [storage.md](storage.md) | **Keep** the order |
| The reviewer is distracted or cannot paste after clearing | Clear deletes the live file | Archives + recovery | **Keep** recovery; the reviewed redesign needs only the last copied batch, scoped to the repository |
| Body text collides with Markdown structure | Bodies live inline in Markdown (D1) | Serialization rules, fenced wrapper, re-parse checks | **Question** (gone with structured storage) |
| BOM, CRLF, surrogates | Lossless editing of a user file (D1) | BOM-aware offsets, EOL detection, strict UTF-8 | **Keep** the cheap surrogate check; the rest follows D1 |

### Capture Accuracy

| Root problem | Cause | Mechanism | Verdict |
| --- | --- | --- | --- |
| Note must target what the reviewer saw, not what has focus at submit time | Async capture; focus moves | Synchronous `freezeEditor` before the first await | **Keep** (cheap) |
| Unknown origin of gutter `+` drafts | VS Code API gives only URI and range at submit | Submit-time inference from tabs, picker | **Question** (D2) |
| Diff editors expose two documents; `~` refs | VS Code diff model | Side/comparison model, ref mapping | **Question** (D2) |
| HEAD or index changes during capture or submit | Git can change at any time | Listeners, `baseCommit`, blob re-comparison, repeated four times | **Reduce** to one check at write time, or drop with D2 |
| Notes drift as code changes | Code is edited after review | Snippet anchoring (`resolveAnchor`), explicit re-anchor | **Keep** (core value) |

### External Change And Races

| Root problem | Cause | Mechanism | Verdict |
| --- | --- | --- | --- |
| Stale refresh results overwrite newer ones | Many awaits per pass, events arrive any time | Generation counters, drain loop | **Keep**, but merge counters |
| UI handles point at notes that moved | No stored IDs (D1) | `cardEntries` with snapshot, `current()` | **Question** (stored IDs would remove it) |
| Two operations touch the same thing at once | Native UI, webview, commands, events | Layered guards (D8) | **Reduce** to one lock |
| Folder switches mid-operation | Assumed (D5) | Scope checks everywhere | **Remove** |
| vscode.git returns new wrapper objects | API behaviour | Stable workspace adapter, membership keyed by event identity | **Keep** |
| vscode.git updates state before its event | API behaviour | Forced membership re-read at publication | **Keep** (two lines) |

### UI And Transport

| Root problem | Cause | Mechanism | Verdict |
| --- | --- | --- | --- |
| Webview page destroyed when hidden | No `retainContextWhenHidden` | Host-held body, client cache, ack handshake (D4) | **Reduce**: keep the host-held body |
| Spoofed or stale messages from the webview | Separate context | Exact-shape decode, authorization, host revalidation | **Keep** |
| Malformed messages from the host | Our own projection | Client-side validator | **Remove** or reduce to the type check |
| Rows move under the cursor during Stage | Git confirms asynchronously | `busy`/`pending`, never optimistic removal | **Keep** |
| List jumps when a row disappears | Visual continuity | 160 ms exit animation with cancel/reuse logic | **Keep**: required by the reviewer; simplify implementation only if behaviour remains |
| Focus lost on re-render | Imperative DOM plus Preact lists | Focus restore logic | **Keep**, simpler with one Preact tree |

### Git And Filesystem

| Root problem | Cause | Mechanism | Verdict |
| --- | --- | --- | --- |
| Paths are pathspecs (brackets glob) | vscode.git API (D7) | Single-match check, `*`/`?` refusal | **Question** the API, not the safety |
| Symlinks can redirect reads and writes | Filesystem | Per-folder `stat` walk on every resolve | **Keep** for capture and reads; **Reduce** for Files to Review (Git does not follow symlinks there) |
| Nested repositories and submodules | Repository layout | Longest-prefix owner, `.git` marker checks, submodule paths | **Keep** |
| Revert must keep staged work | Index vs working tree | `clean` (restores from the index), status allow-list | **Keep** if Revert stays |
| `diffWithHEAD` actually compares index to disk | Misnamed in VS Code 1.96 | Comment only | Worth re-checking on newer VS Code |

### Performance

| Root problem | Cause | Mechanism | Verdict |
| --- | --- | --- | --- |
| Refresh on every keystroke | Was triggered by any document change | Now filtered to noted working-tree files; revision text cached; unchanged threads not redrawn | **Keep** (fixed) |
| Full statistics after every note write | `refresh()` forces statistics by default | – | **Defect**: use `refresh(false)` after writes |
| Ownership walks per file per pass | Validation repeated 2–6× per candidate | – | **Reduce** |
| 5 MiB buffer allocated per untracked file | `Buffer.alloc(limit + 1)` | – | **Defect**: size the buffer to the file |

---

## Part 3. Known Defects And Loose Ends

These were found while analyzing the code. None of them loses data.

1. **Every note write forces a full statistics recomputation**: `refresh()` defaults to
   `invalidateStatistics = true`.
2. **The `dejareview.searchRadius` setting has no visible effect.** The anchor search falls
   back to the whole file and ranks by distance, so the result is the same. Anchor
   `confidence` is computed but never read outside tests.
3. **`dejareview.gotoCode` is a dead command**: registered, hidden, with no caller.
4. **Native delete has no confirmation**, but panel delete does.
5. **Re-anchoring uses unsaved buffer text**, has no confirmation, and fails if the
   reviewer types during it.
6. **Open Side-by-Side Comparison permanently changes** the user's
   `diffEditor.renderSideBySide` setting.
7. **The README says the clipboard instruction mentions "never stage or unstage
   anything".** The actual instruction is "Leave staging to me."
8. **A BOM in the notes file ends up in the clipboard** as an invisible character after
   the instruction.
9. **Untracked statistics allocate a 5 MiB buffer per file**, up to 8 in parallel.
10. **Native and panel paths use different guard sets** (`architecture.md` §4).
11. **`historyError` doubles as the scope-error field.**
12. **The archive picker and panel show only the newest 10**, while all archives are kept
    forever.

---

## Part 4. What Is Essential

Whatever is simplified, these carry the product. Each is relatively cheap.

- Capturing path, line range and snippet synchronously, before focus can move.
- Re-locating notes by snippet as the code changes.
- Atomic publication of the saved notes (temp file + rename).
- The copy → archive → delete order, which never deletes uncopied feedback.
- Some recovery of the last batch.
- Never sending raw prose as markup: CSP, text-only rendering, untrusted Markdown.
- Host-side decoding and authorization of webview messages.
- Never removing a Files to Review row before Git confirms the change.
- If Revert stays: restoring from the index and refusing unsafe states.
