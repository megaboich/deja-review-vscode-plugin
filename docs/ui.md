# UI

**Storage update:** capture and both editors remain. Stale cards open the panel editor,
not a saved Markdown block. Recent Archives is now **Restore Last Copied Review Notes**
with one recovery batch per checkout. The gitignore command is removed. The rest of this
page records the baseline UI/protocol; see [storage.md](storage.md) for current persistence.

DejaReview has two user interfaces that share one host state:

1. **Native VS Code surfaces**: comment threads in editors, gutter badges, the status bar
   and commands.
2. **The Review Notes webview**: a sidebar panel with Files to Review, note cards, a note
   editor, and archive history.

Each note can be edited from either one, or by hand in `REVIEW-NOTES.md`. That is a
complexity driver (`problems.md` D3).

---

## 1. Native Surfaces

### 1.1 Comment Controller And Threads

There is one controller, `dejareview`, configured in `extension › configureController`.
`provideCommentingRanges` makes every `file:` or `git:` document inside the repository
commentable, except during a copy. Thread kinds:

| Kind | Created by | `contextValue` | Can reply? | Tracked in |
| --- | --- | --- | --- | --- |
| Command draft | `add()` | `draft` (not used by any menu) | yes | `drafts` |
| Gutter draft | VS Code, when `+` is clicked | – | yes | not visible to the extension until submit |
| Saved note | `publishEditors()` | `saved`, or `comparison` for diff notes | no | `threads` |

A saved thread holds one `Note`: a comment plus `entry` and `parent`. Its `contextValue`
is `saved` or `editing`, and the menus check it:

| Menu | Command | When |
| --- | --- | --- |
| Thread reply area | Add Review Note / Cancel | `commentThreadIsEmpty` |
| Comment title | Edit, Delete | `comment == saved` |
| Comment (editing) | Save, Cancel | `comment == editing` |
| Thread title | Open Side-by-Side Comparison | `commentThread == comparison` |

**Placement.** `publishEditors()` puts one thread on every open document that shows the
note's origin and path. Existing threads are reused, and their properties are reassigned
only when they changed, because reassigning re-renders the widget. Threads in edit mode are
never touched.

**Hovers and bodies** are `MarkdownString`s with `isTrusted = false` and `supportHtml =
false`, created by `untrustedMarkdown()`.

### 1.2 Badges, Status Bar, Context Keys, Commands

- **Badge.** A ` [review]` after-text decoration and an overview-ruler mark on each
  resolved note line. `dejareview.decorationStyle: none` turns it off.
- **Status bar.** `$(comment) N` while the notes file exists. Clicking it focuses the
  panel.
- **Context keys.**
  - `dejareview.hasFeedback` enables **Copy Review Notes & Clear**.
  - `dejareview.copyInProgress` disables native submit and copy while a copy or recovery
    runs.
- **Commands** (`package.json`):
  - Visible: Add Review Note (`Cmd/Ctrl+Alt+M` and the editor context menu), Copy Review
    Notes & Clear, Recover Archived Review, Refresh Review Notes (the panel's only title
    action), Rewrite Line Numbers from Anchors, Add REVIEW-NOTES.md to .gitignore.
  - Internal: submit, cancel, edit, save, delete, gotoCode, openComparison.
  - `gotoCode` has no caller in the UI.

---

## 2. The Webview: What It Shows

The static shell is `dashboardHtml › renderDashboard()`: fixed HTML with element IDs, CSS
built from VS Code theme tokens, SVG icon templates, and a nonce-based CSP. The client,
`dashboardClient.tsx`, fills it in.

| Section | Contents | Actions sent |
| --- | --- | --- |
| Toolbar | Add General Review Note, a "More actions" menu with one item (Recent Archives), Copy Review Notes & Clear (only when there is feedback), note count | `addGeneral`, `openHistory`, `copy` |
| Files to Review | Rows: path, change kind, `+N -M` / "Loading stats" / "Stats unavailable", visible highlight, pending accent. Hover or focus shows Revert, Add File Note, Stage | `openFile`, `revertFile`, `addFileNote`, `stageFile` |
| Note cards | Title (`name:range`, file name, or "General Review Note"), 2-line preview, Edit and Delete icons | `open` (file notes), `edit`, `delete` |
| History | Up to 10 archives with date, count and Recover. Shown only when there is no feedback | `restore`, `closeHistory` |
| Editor dialog | Title, textarea, error, Save / Cancel / Close | `input` (every keystroke), `saveEdit`, `cancelEdit` |
| Errors | History/scope error, malformed-block notice, files error, editor error | – |

---

## 3. The Webview Protocol

### 3.1 Messages

**Host → client**

| Type | Payload |
| --- | --- |
| `state` | `DashboardState`: `repoKey`, `hasFeedback`, `commentCount`, `busy`, `historyVisible`, `files[]`, `notes[]` (previews only), `archives[]` (no text), errors, `editor?` (`id`, `repoKey`, `title`, `body`, `error`) |
| `inputAccepted` | `{repoKey, editorId, requestId}`: the host stored this keystroke |
| `editorSettled` | `{repoKey, editorId, requestId}`: the Save or Cancel request has finished |

**Client → host.** `ready`, then the actions listed in §2, plus `editorRequestStatus`
(sent after the webview is recreated, to ask what happened to an in-flight Save). Every
action except `ready` carries the `repoKey` it was rendered for. Editor messages also carry
`editorId` and `requestId`.

### 3.2 Validation Layers

| Layer | Where | Checks |
| --- | --- | --- |
| Client, before sending | `send`, `sendNote`, `sendFile`, `restoreArchive`, `sendEditor` | Not busy, no editor open, node still in the DOM, same folder, id still in the current state |
| Client, on receive | `isDashboardHostMessage` (~76 lines) | Exact key sets and field types of every host message |
| Host shape | `dashboard › decodeDashboardMessage` (~65 lines) | Exact keys per action type; builds a fresh object |
| Host authorization | `ReviewDashboard.receiveMessage`, `authorizeAction` | Ready, same folder, not busy, no other action running, ids present in the last published state, history/feedback preconditions |
| Host execution | `extension › dispatchDashboard`, `dashboardNote`, `dashboardInput` | Same folder as the live repo, live guards, `cardEntries` lookup, snapshot and raw-block revalidation after modals and awaits |

AGENTS.md defines the layers like this: client checks improve UX, host checks authorize,
and post-await checks detect changed state.

### 3.3 Where State Lives

- **Host (`extension.ts`)** is authoritative. That includes the panel editor session and
  its body.
- **Provider (`ReviewDashboard`)** holds:
  - the last projected state;
  - history visibility;
  - the action being handled;
  - the last settled editor request, so it can be replayed after the webview is recreated.
- **Client** holds:
  - the last state;
  - focus bookkeeping;
  - exit-animation bookkeeping;
  - a **transport cache** stored with `vscode.setState()`. It holds the last
    unacknowledged keystroke and any in-flight Save or Cancel, keyed to the provider's
    random `instanceKey`.

### 3.4 Draft Retention

The panel is registered **without** `retainContextWhenHidden`, so VS Code destroys the
webview's page whenever the panel is hidden and starts a new one when it is shown again.
To keep the reviewer's typing:

1. Every keystroke is sent to the host, which keeps it in the session. This covers almost
   everything.
2. The client also keeps the last unacknowledged keystroke in `setState`, and sends it
   again when the new page starts.
3. If the host was busy, it refuses the keystroke. The client resends it when the host
   becomes idle.

### 3.5 Save And Cancel Acknowledgement

When the reviewer presses Save, the client freezes the editor and waits for
`editorSettled` with the same `requestId`. If the page is recreated in the meantime, the
new page sends `editorRequestStatus`. The host then does one of three things:

- answers nothing, if the request is still running;
- replays the stored settlement;
- reports "settled" for a request it does not know.

Save is never sent twice automatically. This exists so the editor neither unlocks too
early nor saves twice. It costs about 150 lines across the client and host, and most of the
editor tests.

---

## 4. Webview Rendering Model

- **Mixed model.** Preact renders three lists: files, notes and archives. Everything else
  (toolbar, menu, history visibility, errors, the dialog, disabled flags, focus) is updated
  directly through `byId(...)` on every state. There are no Preact hooks or component
  state.
- **Keys** combine the folder key and the projection id (`rowKey`). After a folder switch,
  rows are replaced rather than reused, because the same id can name a different row in
  another folder.
- **Refs.**
  - `iconRef` clones SVG templates into buttons.
  - `fileNodeRef` records row elements so they can be measured for the exit animation.
- **Exit animation.**
  - When a file leaves the list, it stays rendered, inert and disabled, at its old index,
    and collapses over 160 ms.
  - If the row reappears, the animation is cancelled and the row is reused.
  - A finished animation removes the row only if it is still the animation recorded for
    that row.
  - Reduced motion and folder switches clear all exits.
  - The animation is cosmetic. What prevents misclicks is the host's `busy` and `pending`
    flags.
- **Stale clicks.** Row handlers capture their folder and node, and refuse when the node
  is no longer connected or the id is gone. Real users cannot click detached nodes, so
  these checks mostly protect against synthetic events.
- **Focus.**
  - Focus is restored after list renders.
  - When the editor dialog closes, focus returns to the button that opened it.
  - Opening history focuses its Close button.
- **Input retention.** The textarea is outside Preact. Its value is set only when a new
  session starts. Later state echoes never overwrite what the reviewer typed.

---

## 5. Security Model Of The Webview

All review prose is untrusted.

- CSP: `default-src 'none'`. Scripts and styles need the per-render nonce. There are no
  remote resources.
- The client renders text only through text nodes and attributes. The shell test bans the
  string `innerHTML` in `dashboardClient.tsx`.
- `scripts/buildClient.mjs` refuses a bundle that contains `</script`, `<!--` or
  `<script`, because the bundle is inlined into a `<script>` element.
- The nonce and `instanceKey` are checked against a regex before they go into the HTML.
- `projectState()` sends previews only and never sends archive text.
- Host decoding plus authorization is the trust boundary. Client checks are UX only.

## 6. Build

`npm run build:client` runs esbuild on `src/dashboardClientEntry.ts` (which exposes
`globalThis.__dejareviewDashboard`). The output is an IIFE stored as a string constant in
`src/generated/dashboardClientBundle.ts`. This file is generated and gitignored.
`dashboardHtml.ts` inlines it. `check` and `compile` run the build first. Preact is a
development dependency only; it ships inside the bundle.
