# Central Storage And Last-Copy Recovery

This is the current storage design. It supersedes the project-Markdown and archive-history
sections in the earlier design-analysis documents.

## Identity And Location

- Use the absolute filesystem path of the local checkout/worktree root, normalized with
  `path.resolve`. Never use a remote URL, branch name or shared Git metadata directory.
- Store records beneath VS Code's extension `globalStorageUri`, in
  `checkouts/<sha256(checkoutPath)>/notes.json`.
- Store one recovery snapshot beside it as `last-copy.json`.
- Separate clones and worktrees remain isolated. Branch switches at the same path keep
  notes. Moving a checkout produces a new key; there is no automatic relocation.
- Storage belongs to the VS Code user profile. It is local, not encrypted or synced by
  the extension. No notes file or `.gitignore` entry is created in the project.

## Records And Projections

`notes.json` holds `version: 1`, `checkoutPath` and an array of `{id, note}` records.
File notes retain path, origin, side, comparison, range, snippet/elision and body. General
notes retain kind and body. File/comparison paths are checkout-relative POSIX paths.

The existing host works with a Markdown projection, parsed entries and snapshot checks.
`renderNotes` and `recordsFromText` bridge that projection to structured records. The
parser and writer therefore still exist: removing their role from UI mutations is a
separate simplification, not something accomplished by moving storage. IDs are persisted,
but the existing client authorization still uses projection-scoped handles.

Bodies are stored as original text, without Markdown wrappers. The renderer adds protective
fences only in the projection and clipboard output. Stored JSON is received as `unknown`
and validated before use; invalid JSON, metadata or locations fail closed.

## Subfolders

The workspace adapter keeps two paths:

- `rootUri`: the opened folder used by capture, navigation and Files to Review.
- `checkoutUri`: its containing local checkout/worktree root, used for storage identity.

Subfolder windows share `notes.json`. Each shows file notes within its folder, translated
to folder-relative paths for the existing UI. General notes are checkout-wide. Writes
preserve file records outside that window's scope.

If a root-captured comparison has its opposite endpoint outside the opened subfolder,
that subfolder displays/navigates the selected revision alone rather than retargeting the
other endpoint. Editing preserves the full stored comparison, as does copying. Open the
checkout root to navigate that full comparison.

Copy & Clear exports visible file notes and general notes with **checkout-relative paths**,
then removes only those records. Recovery is checkout-wide and refuses if *any* current
record exists, including records outside the visible folder. Restored notes keep their
original paths; some may therefore appear only in another folder or the checkout-root view.

## Cross-Window Writes And Watching

`ReviewStore` has an in-process promise queue. Each mutation also acquires a filesystem
`write.lock` using exclusive creation before reading the latest records. Other extension
windows retry briefly (up to about two seconds), then report that storage is busy.

The lock covers read/change/publication, including copy/recovery/clear ordering. Reads,
rendering and typing do not acquire it. Confirmation prompts stay in the host before the
store operation; capture validation remains in its existing layer.

Publication writes a unique temporary file with owner-only permissions and renames it
over the destination. The watcher watches the storage directory, so replacing `notes.json`
or `last-copy.json` triggers refresh in other windows. Lock/temp-file events are ignored.

There is deliberately no timeout-based lock stealing: it can let a slow live writer and a
new writer run simultaneously. If a process crashes while holding the lock, the error
identifies its location. Close all windows using the checkout before removing that lock.
This is a fail-closed limitation, not automatic stale-lock recovery.

Atomic replacement prevents partially written files, but is neither compare-and-swap
against arbitrary external programs nor fsync-backed durability. Dirty storage-file
buffers are refused; there is no save-and-retry hand-editing workflow.

## Handoff And Recovery

Within the checkout write lock:

1. Read and validate current records and caller guards.
2. Render the visible notes with checkout-relative paths and copy the unchanged handoff
   instruction plus Markdown to the clipboard.
3. Atomically publish the same records to `last-copy.json`, with a new ID, creation time
   and note count.
4. Revalidate and atomically remove those records from `notes.json`.
5. Refresh projections and report success or partial success.

Copy failure preserves both current notes and the previous recovery snapshot. Recovery
publication failure preserves current notes and the previous snapshot, even though the
clipboard may contain the new batch. Clear failure preserves live notes and the new
snapshot. Restore checks the snapshot ID, refuses active notes, and retains the recovery
file afterward. A newer successful copy replaces the previous recovery batch.

The UI calls this **Restore Last Copied Review Notes**. Internal archive names and message
IDs remain to avoid an unrelated protocol rewrite; they no longer imply multiple batches.

## What Has Not Changed

- Gutter `+`, shortcut and context-menu capture.
- Editing in both the gutter and panel.
- Revision/side/comparison context, including notes on removed code.
- Anchoring, navigation, counts, Stage/Revert, auto-advance and exit animation.
- Host authorization, generation-based refresh and the existing host guard sets.

No previous `REVIEW-NOTES.md` or archive data is read, migrated, deleted or rewritten.

## Verification

The storage suite uses disposable synthetic filesystem fixtures for checkout isolation,
subfolder projections, concurrent writers, watching atomic replacements, body/context
round trips, last-copy replacement, failure ordering and invalid storage. The real VS Code
suite exercises capture, editing, clipboard/recovery and both root and subfolder hosts.
Physical gutter/composer UX, themes and multi-window visual behaviour still need manual
acceptance.
