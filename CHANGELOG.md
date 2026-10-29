# Changelog

## 0.1.0 (2026-10-29)

First public preview.

- Add Review Notes to selected lines in files and diffs, on either side of a comparison, with **Ctrl+Alt+M** (**Cmd+Alt+M** on macOS) or the gutter **+**.
- Add general Review Notes and whole-file Review Notes from the **Review Notes** panel.
- Edit, navigate and delete notes from their cards in the panel or in the gutter.
- **Files to Review** lists changed files without notes, with line counts, **Stage File**, **Revert File** and opening of the next file after staging.
- **Copy Review Notes & Clear** copies all notes as Markdown with file paths, lines, code snippets and an instruction for the agent, and confirms how many notes were copied.
- Restore the last copied batch if it was never pasted.
- Notes are stored in VS Code's extension storage for each local checkout, never in the project.

Found a bug or have a suggestion? [Report an issue on GitHub](https://github.com/megaboich/deja-review-vscode-plugin/issues).
