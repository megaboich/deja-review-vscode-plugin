# Simplification Options

This document lists concrete ways to reduce complexity. For each option it gives what it
removes, what it costs, and the risk. Line counts are rough estimates from reading the
code. "Tests" means test lines that would be deleted or rewritten.

**Implementation status:** central JSON storage and one last-copy recovery batch are now
implemented ([storage.md](storage.md)). P1 and B5 below reflect the revised decision to
keep storage outside the project. Markdown projection, capture, both editors and host
guards remain; other proposed savings are not implemented or verified.

Options are grouped into three tiers:

- **Tier A, no-loss cleanups:** nothing the reviewer can see changes.
- **Tier B, feature trims:** small, visible losses.
- **Tier C, pivots:** changes to the product shape or the persisted format. Several of
  these contradict current `AGENTS.md` rules, which would have to change with them.

Backward compatibility is not a constraint: no version has been released and existing
review files and archives have no value.

---

## 1. Review Decisions And Constraints

These are the reviewer's answers, including the later central-storage decision. Storage
and recovery have changed; the existing capture model and host guards remain.

| # | Decision | Consequence for the plan |
| --- | --- | --- |
| Q1 | Hand-editing is not needed, and a project notes file is undesirable. Use central JSON storage mapped by project/checkout disk path. | Implemented under extension storage as `checkouts/<hash>/notes.json`; no project file or gitignore prompt. |
| Q2 | Notes must be rediscoverable in the gutter and panel, and the agent must understand whether they refer to removed code, new code or the change itself. | Replace the working-tree-only proposal with P2 below. Preserve enough context for both sides of a change; simplify provenance only where this stays reliable. |
| Q3 | Gutter `+` capture is required. | B6 is rejected. Keep native gutter capture alongside shortcut/context-menu capture. |
| Q4 | Editing in both the gutter and panel is required. Editing the storage file is not. | Replace the panel-only proposal with P3 below. Shared storage can simplify the two editors without removing either. |
| Q5 | Counts, Revert, auto-advance and exit animation are all required. | B1–B4 are rejected. Optimize their implementation, not their availability. Stage also stays. |
| Q6 | Restore the last copied batch is sufficient, scoped to the local checkout disk path. | Implemented as `last-copy.json`. It protects against being distracted or failing to paste after Copy & Clear. Recovery refuses any current checkout notes. |
| Q7 | A single operation lock is acceptable if it does not noticeably slow the extension. | Pursue P4 conditionally. Keep typing and reads responsive, and verify write-action latency before adopting it. |

**Scope resolved:** subfolder windows share their checkout's central store. File-note views
are folder-filtered; general notes are checkout-wide. Clipboard paths are checkout-relative.
Separate checkout/worktree paths have separate notes and recovery. Branch switches at the
same path keep notes. There is no migration of previous folder-scoped files or archives.

---

## 2. Tier A: No-Loss Cleanups

These are implementation candidates, not automatic approvals. Several need verification
of API assumptions, race safety or retention behaviour before their proposed savings can
be claimed. They must preserve the requirements in §1.

| ID | Change | Saves (src / tests) | Risk | Notes |
| --- | --- | --- | --- | --- |
| A1 | Treat the opened folder as fixed for the extension host's lifetime. Keep only "repository appeared or disappeared". Drop `repoKey` from messages, stranded-session handling and most of the 22 folder re-checks | 200–250 / several hundred | Low | VS Code restarts the host on a first-folder change. Rewrites some AGENTS.md wording ("One folder, deterministically" stays true) |
| A2 | Use `refresh(false)` after note writes. Force statistics only on explicit Refresh | ~5 / small | Very low | Fixes defect 1 in `problems.md` |
| A3 | Drop the statistics signature cache and its verification pass. Diff each file on each Git event | ~150 / 300–400 | Low | Fewer Git processes than today on unchanged refreshes |
| A4 | Compute tracked counts with one `git --literal-pathspecs diff --numstat -z` per refresh (on top of A3) | another ~100 / ~200 | Low–medium | One process total. One failure marks all counts unavailable |
| A5 | Validate each candidate once per pass. Cache the folder walk per refresh | 40–60 / ~150 | Low | Display-only; Stage and Revert still revalidate |
| A6 | Merge `filesGeneration` into `generation`. Drop `publishedGeneration` (compare `entries` identity). Derive `savedEntries`, `hasFeedback`, `anchoredDocuments` | 60–100 / some | Low–medium | |
| A7 | Make file rows immutable: combine candidates, statistics and visibility in `updateDashboard` instead of mutating rows from three places | ~30, mostly clarity | Low | |
| A8 | Accept panel `input` while busy (it only updates memory) | ~40 / ~100 | Low | Removes the resend logic |
| A9 | Set `retainContextWhenHidden: true`. Drop the client transport cache, `instanceKey`, `editorRequestStatus` and settlement replay. Keep the host-held body | ~150 / ~400 | Low–medium | Costs memory for one small panel while hidden |
| A10 | Replace the `requestId` / `inputAccepted` / `editorSettled` handshake with an `editor.saving` flag in state (after A9) | ~100 / ~300 | Medium | |
| A11 | Remove the client-side host-message validator (`isDashboardHostMessage`), or reduce it to the `type` check | ~70 / ~40 | Low | The host is trusted; `projectState` stays |
| A12 | Apply each projection rule once: preview truncation, archive cap of 10, `pending`, general-note `open`→`edit` | ~30 | Very low | |
| A13 | Remove dead or unused code: `gotoCode`, unused thread `contextValue`s, anchor `confidence`, and the no-op `searchRadius` setting | ~30 / ~20 | Low | Removing the setting is visible in Settings, but it does nothing today |
| A14 | Evaluate consolidating capture revalidation at write time | Not yet estimated | Medium | Must still rediscover removed/new-code notes and reject ambiguous mutable-revision captures; P2 does not eliminate those requirements |
| A15 | One helper for "saved, but display not refreshed" (5 copies). One debounce for store and Git events. Report background refresh errors in the panel instead of as messages | ~20 | Low | |
| A16 | Size the untracked statistics buffer to the file (fixes the 5 MiB allocation) | ~1 | None | Defect fix |

The earlier aggregate savings estimate is not a commitment: options overlap, and their
safety assumptions need testing. Statistics batching and simpler editor transport remain
promising without removing required features.

---

## 3. Tier B: Feature Trims And Their Review Status

The table retains rejected options to explain why they are not part of the roadmap.
Only B5 is accepted; B7–B9 remain undecided and must preserve the requirements in §1.

| ID | Remove | Saves (src / tests) | Loses | Risk |
| --- | --- | --- | --- | --- |
| B1 (rejected) | File-row exit animation | ~110 / ~160 | A required collapse effect | Not in the plan |
| B2 (rejected) | Auto-advance after staging the first row | ~60 / some | Required navigation convenience | Not in the plan |
| B3 (rejected) | Revert File | ~40 in `mutateFile` + revert branches / ~400 | Required one-click discard | Not in the plan |
| B4 (rejected) | `+N -M` statistics entirely | ~400 / ~1,000 | Required size cue per file | Not in the plan |
| B5 (accepted) | Archive history: keep the last successfully copied batch per repository, with **Restore Last Copied Review Notes** | Earlier history/UI estimate: ~300 / ~300; re-estimate for repository scope | Older batches | Publish the recovery copy before clearing; replace it only on a successful new recovery write |
| B6 (rejected) | Gutter `+` drafts (command-only capture) | 40–60 / some | Required gutter capture | Not in the plan |
| B7 | Elided snippets: keep a capped full snippet, or the first N lines | ~70 in `anchor.ts` + format bits / ~150 | Precise tracking of the end of long selections | Low |
| B8 | `reanchorAll` command: put resolved line numbers into the copied text instead | ~70 / some | Rewriting saved positions | Low–medium |
| B9 | "More actions" menu: replace it with a single Recent Archives button | ~50 / some | Room for menu items that the non-goals forbid anyway | Low |
| B10 (rejected) | Native note editing: gutter threads become read-only, editing happens in the panel | ~120 / several hundred | Required gutter editing | Not in the plan |

---

## 4. Tier C: Pivots

### P1. Structured Storage; Markdown Only On Copy (answers Q1)

**Implemented storage direction.** Store notes as structured records in central JSON at
`globalStorageUri/checkouts/<sha256(absoluteCheckoutDiskPath)>/notes.json`. Hand-editing
is not supported; the gutter and panel remain the editors. Render agent-readable Markdown
when copying. Each local checkout/worktree path is independent, including separate clones
of the same remote. Subfolder windows share storage with folder-filtered file-note views.

**Remaining potential removals, not accomplished by this storage step:**

- almost all of `parser.ts` (~250);
- most of `writer.ts` (~160; a ~50-line renderer remains);
- offsets and `Parsed*` types in `model.ts` (~40);
- `current()` and snapshot threading (~40);
- diagnostics;
- the fenced wrapper rules;
- supported hand-editing flows and the save-and-retry modal;
- projection-scoped note identity, replaced with stable IDs shared by both editors.

**Implemented removals:** the project Markdown database, save-and-retry hand-editing loop,
gitignore offering/command and multiple retained recovery batches. The parser/writer and
snapshot-based host authorization still work on an internal Markdown projection.

**Still needed with central local files:** schema validation, atomic replacement, protection
against concurrent windows or external writes, and a safe refusal if someone has opened a
dirty storage-file buffer. Ignoring hand-editing does not make external writers impossible.
Storage is outside the checkout and a directory watcher publishes cross-window updates.

**Savings need re-estimation.** The earlier 700–900-line estimate included
`workspaceState` and removal of filesystem safeguards, which no longer matches the plan.
The custom Markdown parser, byte-offset editing and raw-block identity remain the main
savings. Native and panel editing machinery stays.

**Loses:**

- hand-editing as an extension workflow, but not the visible local file;
- "jump to the raw block" for stale notes (replace with "edit in panel");
- preservation of arbitrary Markdown sections as part of current notes. Malformed
  structured data must still produce a clear error rather than be overwritten.

**AGENTS.md impact.** The persisted contract now specifies central JSON and path identity.
Preserve copy → recovery publication → clear, including live-file revalidation where needed.

**Risk:** medium. It touches every write path and both UI projections.

### P2. Minimal Context That Still Identifies The Change (answers Q2)

**Required outcome.** A note is rediscoverable in the gutter and panel, and its handoff
lets an agent identify the exact code or change being discussed. A working-tree-only
model is insufficient: removed code no longer exists there.

**Design to evaluate, not a settled schema:**

- Keep the captured path, range and snippet. For renames, retain the relevant old/new
  paths when they differ.
- Retain enough endpoint information to place a note on removed or new code. A note
  about a replacement may need both before and after snippets, not just a side label.
- Capture immutable context rather than expecting mutable HEAD/index contents to remain
  available unchanged until handoff.
- Resolve each display against the appropriate current document/revision. If a match is
  missing or ambiguous, keep the panel card and its captured context rather than attach
  it to guessed lines.
- Render explicit before/after or removed/new context for the agent when relevant.
  Exact revision provenance is useful only insofar as it supports this identification.

**Acceptance cases:** a note on newly added lines; one on removed lines in an Original
diff pane; one on a replacement/change; renamed or deleted files; and code that moves
after capture. In each case, gutter/panel navigation and copied context must remain
understandable. Gutter `+` capture stays, including an ambiguity fallback where VS Code
does not provide the draft's original tab context.

**Potential simplification:** structured records remove complex header grammar, and a
smaller context model may replace some comparison bookkeeping. Endpoint resolution,
anchoring and revision safety cannot all be assumed removable.

**Savings:** not estimated until the context design passes these cases. The earlier
400–450-line estimate depended on dropping removed-code capture and is withdrawn.

### P3. Two Editors, One Note Model (answers Q4)

**Required outcome.** Keep gutter capture and editing, plus panel capture and editing.
Only storage-file editing is removed as a supported workflow.

**Potential simplification:** stable IDs and one structured store allow both editors to
use the same note mutations. Centralize the rules that genuinely match, while keeping
editor-specific draft and focus behaviour local. Detect concurrent edits rather than
silently letting one editor replace another's newer body.

**Still needed:** native drafts and edit sessions, panel sessions, preserving input during
refresh, and safe Copy & Clear handling for unsaved input. The earlier proposal to remove
native editing (and its 120–200-line savings estimate) is rejected.

### P4. One Host Operation Lock (answers Q7)

**Direction conditionally accepted.** In plain language, a lock means that only one
state-changing action runs at a time, instead of each action checking a different set of
busy flags. It must not make the extension noticeably slower.

**Proposed change.** Replace `copyInProgress`, `pendingFileAction`-as-lock, `editorBusy` and
`store.busy`-as-guard with a single `operation?: {kind, path?}`.

- Every writer acquires it: submit, save, delete, panel save, Stage/Revert, Copy & Clear,
  recovery and re-anchor.
- The UI's `busy` and `pending` are derived from it.
- Generations stay for refresh only.
- Data checks against external writers stay inside the local-file store, including P1.

**Saves** about 100–150 lines of guard code. It also removes the per-site guard
combinations and their "deliberate omission" comments, and fixes the native vs panel
inconsistencies.

**Responsiveness requirements:** typing drafts, reading notes, rendering, navigation and
background statistics must not wait behind a write. Do not hold a global lock across a
long confirmation dialog: confirm first, then acquire and revalidate, or define an
equally responsive alternative. Avoid nested acquisition when a write calls refresh or
auto-advance.

**AGENTS.md impact.** Revise "Guards are layered, not shared" when implementing this
model. Host authorization and post-await data revalidation still matter; a lock only
serializes this extension's own writes.

**Risk:** medium. Decide whether competing writes queue or are refused, and test rapid
note saves and consecutive Stage/Revert actions against current behaviour. Adopt only
if latency and input retention remain acceptable; no performance claim has been verified.

---

## 5. Revised Target

The earlier ~2,500-line target assumed dropping diff-side capture, native editing,
auto-advance and animation. Those assumptions conflict with the review decisions, so that
estimate is withdrawn. Re-estimate after removing the remaining projection machinery and
designing any smaller context model.

The target is simpler internals with these behaviours retained:

- structured notes in central checkout-path-keyed JSON, without a project file or hand-editing workflow;
- gutter `+`, shortcut/context-menu capture, and editing in both gutter and panel;
- rediscovery and agent-readable context for removed code, new code and changes;
- Files to Review with counts, Stage, Revert, auto-advance and exit animation;
- one-click copy and safe clear, with the last copied batch recoverable per repository;
- responsive reads and typing even if writes use one operation lock;
- untrusted-prose safety and filesystem/Git write safeguards.

---

## 6. Suggested Roadmap

1. **Resolve remaining design questions:** minimal before/after context and whether the
   existing host guards should become one operation lock. Storage format/scope is resolved;
   separate extension windows now coordinate store writes with a filesystem lock.
   These are not reasons to drop the features already confirmed in §1.
2. **Verify contained cleanups:** avoid unnecessary statistics refreshes, reduce I/O and
   evaluate batched counts without removing counts or weakening Stage/Revert safety.
3. **Implement accepted directions in reviewable units, when requested:**
   1. P1 follow-up: replace internal Markdown mutations with record operations/IDs while
      retaining atomic writes and both UIs. Central storage itself is implemented.
   2. P2/P3: simplify context and shared mutation logic while preserving capture/editing.
   3. B5 is implemented: one checkout-scoped last-copy recovery record, published before
      clearing and never restored over active notes.
   4. P4: evaluate a write lock with responsiveness and race regressions.
   5. Update the corresponding `AGENTS.md` contracts with each implementation change.
4. **Throughout.**
   - Remove obsolete mechanism tests, but retain coverage of the user-visible guarantees.
   - Keep the host-free core and the fast test suite.
   - Keep the integration suite as the end-to-end safety net.
   - Leave staging and commits to the reviewer unless explicitly authorized otherwise.
