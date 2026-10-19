# DejaReview Design Notes

How DejaReview works and why. For using the extension, see the top-level `README.md`;
for rules contributors must follow, see `AGENTS.md`. When these notes and the code
disagree, the code wins.

## What It Does

You review a change in VS Code and leave notes on lines, whole files, or the change as a
whole. One action copies all notes, with enough code context for an AI agent, to the
clipboard and clears them; the last copied batch stays recoverable. A sidebar lists
changed files you have not commented on yet, with Stage and Revert for each.

## Pages

- [user-guide.md](user-guide.md) — full user reference: workflow, safety, recovery, limitations
- [storage.md](storage.md) — where notes are saved and how recovery works
- [concepts.md](concepts.md) — the vocabulary: notes, revisions, sides, snippets
- [flows.md](flows.md) — what happens when you capture, edit, copy or recover
- [architecture.md](architecture.md) — modules, state, refresh and concurrency
- [ui.md](ui.md) — gutter comments and the Review Notes panel
- [problems.md](problems.md) — why the code is as complex as it is
- [simplification.md](simplification.md) — options for making it smaller
