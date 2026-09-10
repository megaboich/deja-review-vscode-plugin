import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { decodeDashboardMessage, ReviewDashboard, type DashboardAction, type DashboardNote, type DashboardState } from "../src/dashboard";
import { renderDashboard } from "../src/dashboardHtml";
import { isDashboardHostMessage } from "../src/dashboardClient";
import { viewFixture } from "./dashboardViewFixture";
import { scriptFixture, lastMessage, type Element } from "./dashboardClientFixture";

function note(overrides: Partial<Extract<DashboardNote, { path: string }>> = {}): Extract<DashboardNote, { path: string }> {
  return {
    id: "projection:0", path: "src/example.ts", startLine: 4, endLine: 6,
    preview: "Review this condition", stale: false, comparison: false,
    ...overrides,
  };
}

function generalNote(): Extract<DashboardNote, { general: true }> {
  return { id: "projection:0", general: true, preview: "Review this condition" };
}

function state(overrides: Partial<DashboardState> = {}): DashboardState {
  return {
    repoKey: "/repo", hasFeedback: true,
    commentCount: 2, busy: false, notes: [note(), note({ id: "projection:1", comparison: true })],
    files: [{ id: "files:0", path: "src/example.ts", insertions: 2, deletions: 1 }],
    archives: [{ id: "batch", createdAt: "2026-09-08T10:00:00Z", commentCount: 3 }],
    ...overrides,
  };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function matchedText(text: string, pattern: RegExp, group = 0): string {
  const match = text.match(pattern);
  assert.ok(match, `Expected dashboard HTML to match ${pattern}`);
  const value = match[group];
  assert.ok(value !== undefined, `Expected capture group ${group} for ${pattern}`);
  return value;
}

test("decoder constructs exact action variants independently of live authorization", () => {
  const valid = [
    { type: "ready" },
    ...["copy", "addGeneral", "openHistory", "closeHistory"].map(type => ({ type, repoKey: "/repo" })),
    { type: "restore", repoKey: "/repo", archiveId: "batch" },
    ...["open", "edit", "delete"].map(type => ({ type, repoKey: "/repo", noteId: "note" })),
    ...["openFile", "revertFile", "stageFile"].map(type => ({ type, repoKey: "/repo", fileId: "file" })),
    ...["input", "saveEdit"].map(type => ({ type, repoKey: "/repo", editorId: "editor", body: "", requestId: "request" })),
    { type: "cancelEdit", repoKey: "/repo", editorId: "editor", requestId: "request" },
    { type: "editorRequestStatus", repoKey: "/repo", editorId: "editor", requestId: "request" },
  ];
  for (const message of valid) {
    const decoded = decodeDashboardMessage(message);
    assert.deepEqual(decoded, message);
    assert.notEqual(decoded, message, "do not retain externally mutable message objects");
    assert.equal(decodeDashboardMessage({ ...message, extra: undefined }), undefined);
    for (const key of Object.keys(message)) {
      const missing: Record<string, unknown> = { ...message };
      delete missing[key];
      assert.equal(decodeDashboardMessage(missing), undefined);
      assert.equal(decodeDashboardMessage({ ...message, [key]: null }), undefined);
    }
  }
  for (const invalid of [null, [], "input", 1, {}, { type: "unknown", repoKey: "/repo" }]) {
    assert.equal(decodeDashboardMessage(invalid), undefined);
  }
});

function editor(overrides: Partial<NonNullable<DashboardState["editor"]>> = {}): NonNullable<DashboardState["editor"]> {
  return { id: "editor:0", repoKey: "/repo", title: "Edit Review Note", body: "Full\nbody\nincluding third line", ...overrides };
}

test("only a current explicit editor session includes full body and whitelisted editor metadata", () => {
  const dashboard = new ReviewDashboard(() => {});
  const fixture = viewFixture();
  fixture.resolve(dashboard);
  fixture.send({ type: "ready" });
  const body = "<script>arbitrary</script>\r\n".repeat(1000);
  const session = { ...editor({ body, error: "Save failed" }), snapshot: "PRIVATE", anchor: "PRIVATE" };
  dashboard.update(state({ editor: session, notes: [generalNote()] }));
  const posted = fixture.latestState;
  assert.deepEqual(posted.editor, editor({ body, error: "Save failed" }));
  assert.equal(posted.notes[0].general, true);
  assert.deepEqual(posted.notes[0], generalNote());
  assert.doesNotMatch(JSON.stringify(posted), /PRIVATE|snapshot|anchor/);
  session.body = "changed after snapshot";
  assert.ok(posted.editor);
  assert.equal(posted.editor.body, body);
  for (const next of [state(), state({ editor: session, repoKey: "/other" }), state({ editor: session, repoKey: undefined })]) {
    dashboard.update(next);
    assert.equal("editor" in fixture.latestState, false);
    assert.doesNotMatch(JSON.stringify(fixture.latestState), /arbitrary|changed after snapshot/);
  }
  dashboard.dispose();
});

test("addGeneral and edit require exact schemas and live scope; general open delegates to edit", async () => {
  const actions: DashboardAction[] = [];
  const dashboard = new ReviewDashboard(action => { actions.push(action); });
  const fixture = viewFixture();
  fixture.resolve(dashboard);
  fixture.send({ type: "ready" });
  for (const hasFeedback of [false, true]) {
    dashboard.update(state({ hasFeedback }));
    const action = { type: "addGeneral", repoKey: "/repo" };
    for (const invalid of [
      { type: "addGeneral" }, { ...action, repoKey: "/other" }, { ...action, repoKey: null },
      ...["noteId", "body", "editorId", "extra"].map(key => ({ ...action, [key]: undefined })),
    ]) fixture.send(invalid);
    assert.equal(actions.length, hasFeedback ? 1 : 0);
    fixture.send(action);
    await settle();
    assert.deepEqual(actions.at(-1), action);
  }
  for (const type of ["edit", "open"]) {
    dashboard.update(state({ notes: [generalNote()] }));
    fixture.send({ type, repoKey: "/repo", noteId: "projection:0" });
    await settle();
    assert.deepEqual(actions.at(-1), { type: "edit", repoKey: "/repo", noteId: "projection:0" });
  }
  const count = actions.length;
  for (const overrides of [{ busy: true }, { repoKey: undefined }, { editor: editor() }]) {
    dashboard.update(state(overrides));
    fixture.send({ type: "addGeneral", repoKey: "/repo" });
  }
  for (const overrides of [{ notes: [] }, { hasFeedback: false }, { repoKey: "/other" }, { busy: true }]) {
    dashboard.update(state(overrides));
    fixture.send({ type: "edit", repoKey: "/repo", noteId: "projection:0" });
  }
  dashboard.update(state());
  for (const message of [
    { type: "edit", repoKey: "/repo" }, { type: "edit", repoKey: "/repo", noteId: "missing" },
    ...["archiveId", "body", "editorId", "path"].map(key => ({ type: "edit", repoKey: "/repo", noteId: "projection:0", [key]: undefined })),
  ]) fixture.send(message);
  assert.equal(actions.length, count);
  fixture.send({ type: "edit", repoKey: "/repo", noteId: "projection:0" });
  await settle();
  assert.equal(actions.length, count + 1);
  dashboard.dispose();
});

test("general payloads omit every file field and bound previews without changing mixed note order", () => {
  const dashboard = new ReviewDashboard(() => {});
  const fixture = viewFixture();
  fixture.resolve(dashboard);
  fixture.send({ type: "ready" });
  const general = { ...generalNote(), ...note(), general: true as const,
    body: "PRIVATE BODY", anchor: "PRIVATE ANCHOR", preview: "first\r\n" + "x".repeat(400) + "\r\nPRIVATE THIRD" };
  dashboard.update(state({ notes: [note({ id: "first" }), general, note({ id: "last" })] }));
  const notes = fixture.latestState.notes;
  assert.deepEqual(notes, [note({ id: "first" }), {
    id: "projection:0", general: true, preview: ("first\n" + "x".repeat(400)).slice(0, 320),
  }, note({ id: "last" })]);
  assert.deepEqual(Object.keys(notes[1]).sort(), ["general", "id", "preview"]);
  assert.doesNotMatch(JSON.stringify(notes), /PRIVATE/);
  if (notes[0].general) assert.fail("expected a file card");
  assert.equal(notes[0].path, "src/example.ts");
  dashboard.dispose();
});

test("provider owns history visibility, validates exact open/close schemas and preserves it across view reconstruction", async () => {
  const actions: DashboardAction[] = [];
  const dashboard = new ReviewDashboard(action => { actions.push(action); });
  const fixture = viewFixture();
  const empty = state({ hasFeedback: false, notes: [], commentCount: 0 });
  dashboard.update({ ...empty, historyVisible: true });
  fixture.resolve(dashboard);
  fixture.send({ type: "openHistory", repoKey: "/repo" });
  fixture.send({ type: "ready" });
  assert.equal(fixture.latestState.historyVisible, false, "neither owner updates nor pre-ready messages open history");
  const restore = { type: "restore", repoKey: "/repo", archiveId: "batch" };
  fixture.send(restore);
  assert.equal(actions.length, 0);
  for (const type of ["openHistory", "closeHistory"]) {
    fixture.send({ type: "openHistory", repoKey: "/repo" });
    fixture.send({ type: type === "openHistory" ? "closeHistory" : "openHistory", repoKey: "/repo" });
    const visible = type === "closeHistory";
    const before = fixture.messages.length;
    for (const message of [
      { type },
      ...[undefined, null, 1, {}, [], "", "/other"].map(repoKey => ({ type, repoKey })),
      ...["archiveId", "noteId", "fileId", "editorId", "body", "historyVisible", "extra"].flatMap(key =>
        [undefined, "untrusted"].map(value => ({ type, repoKey: "/repo", [key]: value }))),
    ]) fixture.send(message);
    assert.equal(fixture.messages.length, before);
    assert.equal(fixture.latestState.historyVisible, visible);
    fixture.send({ type, repoKey: "/repo" });
    assert.equal(fixture.latestState.historyVisible, !visible);
  }
  fixture.send({ type: "openHistory", repoKey: "/repo" });
  dashboard.update(empty);
  assert.equal(fixture.latestState.historyVisible, true);
  fixture.show();
  assert.equal(fixture.latestState.historyVisible, true);
  fixture.close();
  const replacement = viewFixture();
  replacement.resolve(dashboard);
  replacement.send({ type: "ready" });
  assert.equal(replacement.latestState.historyVisible, true);
  assert.equal(actions.length, 0, "history messages are handled locally by the provider");
  replacement.send(restore);
  await settle();
  assert.deepEqual(actions, [restore]);
  replacement.send({ type: "closeHistory", repoKey: "/repo" });
  replacement.send(restore);
  assert.equal(actions.length, 1, "closed history rejects webview recovery");
  dashboard.dispose();
});

test("history resets for feedback, editors and folder changes, and busy actions cannot open or close it", async () => {
  const actions: DashboardAction[] = [];
  let finish: (() => void) | undefined;
  const dashboard = new ReviewDashboard(action => {
    actions.push(action);
    return new Promise<void>(resolve => { finish = resolve; });
  });
  const fixture = viewFixture();
  fixture.resolve(dashboard);
  fixture.send({ type: "ready" });
  const empty = state({ hasFeedback: false, notes: [], commentCount: 0 });
  const open = { type: "openHistory", repoKey: "/repo" };
  const close = { type: "closeHistory", repoKey: "/repo" };
  const restore = { type: "restore", repoKey: "/repo", archiveId: "batch" };
  for (const overrides of [{ hasFeedback: true }, { repoKey: "/other" }, { repoKey: undefined }, { editor: editor() }]) {
    dashboard.update(empty);
    fixture.send(open);
    assert.equal(fixture.latestState.historyVisible, true);
    dashboard.update({ ...empty, ...overrides });
    fixture.send(open);
    fixture.send(close);
    fixture.send(restore);
    assert.equal(fixture.latestState.historyVisible, false);
    assert.equal(actions.length, 0);
    dashboard.update(empty);
    assert.equal(fixture.latestState.historyVisible, false, "returning to empty or the old folder never reopens history");
  }
  for (const visible of [false, true]) {
    dashboard.update(empty);
    fixture.send(visible ? open : close);
    dashboard.update({ ...empty, busy: true });
    const before = fixture.messages.length;
    fixture.send(open);
    fixture.send(close);
    fixture.send(restore);
    assert.equal(fixture.messages.length, before);
    assert.equal(fixture.latestState.historyVisible, visible);
    dashboard.update(empty);
    fixture.send({ type: "openFile", repoKey: "/repo", fileId: "files:0" });
    const count = actions.length;
    fixture.send(open);
    fixture.send(close);
    fixture.send(restore);
    assert.equal(actions.length, count);
    assert.equal(fixture.latestState.historyVisible, visible);
    assert.ok(finish, "Expected a pending file action");
    finish();
    await settle();
    assert.equal(fixture.latestState.busy, false);
    fixture.send(open);
    assert.equal(fixture.latestState.historyVisible, true);
    fixture.send(close);
    assert.equal(fixture.latestState.historyVisible, false);
  }
  dashboard.dispose();
});

for (const type of ["input", "saveEdit", "cancelEdit"] as const) test(`${type} validates exact session schema without requiring the original card`, async () => {
  const actions: DashboardAction[] = [];
  const dashboard = new ReviewDashboard(action => { actions.push(action); });
  const fixture = viewFixture();
  fixture.resolve(dashboard);
  fixture.send({ type: "ready" });
  const current = state({ editor: editor(), notes: [], hasFeedback: false });
  dashboard.update(current);
  const action = { type, repoKey: "/repo", editorId: "editor:0", ...(type === "cancelEdit" ? {} : { body: " arbitrary\n".repeat(1000) }) };
  const request = { ...action, requestId: "request" };
  for (const message of [
    { type }, { type, repoKey: "/repo" },
    ...[undefined, null, {}, 1, "", "stale"].map(editorId => ({ ...action, editorId })),
    ...[undefined, null, {}, 1, "", "/other"].map(repoKey => ({ ...action, repoKey })),
    ...["noteId", "fileId", "archiveId", "extra"].map(key => ({ ...action, [key]: undefined })),
    ...(type === "cancelEdit" ? [{ ...action, body: "" }, { ...action, body: undefined }]
      : [undefined, null, 1, {}, []].map(body => ({ ...action, body }))),
    ...(type === "saveEdit" ? ["", " \n\t"].map(body => ({ ...action, body })) : []),
  ]) fixture.send({ ...message, requestId: "request" });
  for (const requestId of [undefined, null, 1, ""]) {
    fixture.send({ ...action, requestId });
  }
  assert.equal(actions.length, 0);
  for (const overrides of [{ editor: undefined }, { busy: true }, { repoKey: "/other" }, { editor: editor({ id: "new" }) }]) {
    dashboard.update({ ...current, ...overrides });
    fixture.send(request);
  }
  assert.equal(actions.length, 0);
  dashboard.update(current);
  fixture.send(request);
  await settle();
  assert.deepEqual(actions, [action]);
  if (type === "input") {
    fixture.send({ ...request, body: "" });
    const latest = actions.at(-1);
    assert.ok(latest?.type === "input");
    assert.equal(latest.body, "");
  }
  dashboard.dispose();
});

test("input updates synchronously without busy flicker; saves serialize every action and retain failed sessions", async (t) => {
  t.mock.method(console, "error", () => {});
  const actions: DashboardAction[] = [];
  let current = state({ editor: editor() });
  let reject: ((error: Error) => void) | undefined;
  const dashboard = new ReviewDashboard(action => {
    actions.push(action);
    if (action.type === "input") {
      assert.ok(current.editor);
      current = { ...current, editor: { ...current.editor, body: action.body } };
      dashboard.update(current);
    } else return new Promise<void>((_resolve, fail) => { reject = fail; });
  });
  const fixture = viewFixture();
  fixture.resolve(dashboard);
  fixture.send({ type: "ready" });
  dashboard.update(current);
  const count = fixture.messages.length;
  for (const body of ["", "a", "ab", "abc"]) {
    fixture.send({ type: "input", repoKey: "/repo", editorId: "editor:0", body, requestId: "input:" + body });
    assert.equal(current.editor?.body, body);
    assert.equal(fixture.latestState.editor?.body, body);
  }
  assert.equal(fixture.messages.length, count + 4);
  assert.ok(fixture.messages.every(message => !message.state.busy));
  const otherActions = [
    { type: "copy", repoKey: "/repo" }, { type: "restore", repoKey: "/repo", archiveId: "batch" },
    { type: "addGeneral", repoKey: "/repo" },
    ...["edit", "open", "delete"].map(type => ({ type, repoKey: "/repo", noteId: "projection:0" })),
    ...["openFile", "revertFile", "stageFile"].map(type => ({ type, repoKey: "/repo", fileId: "files:0" })),
  ];
  for (const action of otherActions) fixture.send(action);
  assert.equal(actions.length, 4);
  const save = { type: "saveEdit", repoKey: "/repo", editorId: "editor:0", body: "abc", requestId: "save" };
  fixture.send(save);
  dashboard.update(current);
  for (const action of [...otherActions, save, { ...save, type: "input" }, { type: "cancelEdit", repoKey: "/repo", editorId: "editor:0", requestId: "cancel" }]) fixture.send(action);
  assert.equal(actions.length, 5);
  assert.equal(fixture.latestState.busy, true);
  assert.equal(fixture.latestState.editor?.body, "abc");
  assert.ok(current.editor);
  dashboard.update({ ...current, editor: { ...current.editor, error: "Save failed" } });
  assert.ok(reject, "Expected a pending save");
  reject(new Error("save failed"));
  await settle();
  assert.equal(fixture.latestState.busy, false);
  assert.equal(fixture.latestState.editor?.error, "Save failed");
  fixture.send({ ...save, type: "input", body: "retry" });
  assert.equal(actions.length, 6);
  dashboard.dispose();
});

test("static shell has nonce-only CSP, accessible full-text copy button and responsive native styling", () => {
  const html = renderDashboard("test-nonce");
  assert.match(html, /default-src 'none'; script-src 'nonce-test-nonce'; style-src 'nonce-test-nonce'/);
  assert.match(html, /base-uri 'none'; form-action 'none'/);
  assert.equal((html.match(/nonce="test-nonce"/g) || []).length, 2);
  assert.doesNotMatch(html, /https?:|<script[^>]+src=|<link|unsafe-inline|innerHTML|outerHTML|eval\(/i);
  assert.match(html, /<button id="copy"[^>]+hidden disabled>Copy Review Notes &amp; Clear<\/button>/);
  const explanation = "Copies your review notes to the clipboard, archives this batch, and clears the current review notes.";
  const copy = matchedText(html, /<button id="copy"[^>]*>/);
  assert.ok(copy.includes(`title="${explanation}"`));
  assert.ok(copy.includes(`aria-description="${explanation}"`));
  assert.doesNotMatch(html, /id="explanation"|aria-describedby=/);
  for (const paragraph of html.matchAll(/<p\b[^>]*>[\s\S]*?<\/p>/g)) {
    assert.ok(!paragraph[0].includes(explanation));
  }
  assert.doesNotMatch(html, /select-repository|<header\b|<h1\b|id="repository"|repoName/);
  assert.match(html, /<button id="copy"[^>]*>[^<]*<\/button>\s*<section id="files-section"[^>]*>[\s\S]*?<\/section>\s*<p id="count"[^>]*>0 review notes<\/p>/);
  assert.match(html, /<h2 id="files-title">Files to Review \(0\)<\/h2>/);
  assert.match(html, /<p id="no-files" class="muted">No files to review\.<\/p>/);
  assert.match(html, /\.file-insertions \{ color: var\(--vscode-gitDecoration-addedResourceForeground,/);
  assert.match(html, /\.file-deletions \{ color: var\(--vscode-gitDecoration-deletedResourceForeground,/);
  assert.match(html, /\.file-row\s*\{[^}]*position: relative;/);
  assert.match(html, /\.file-exiting\s*\{[^}]*display: block;[^}]*overflow: hidden;[^}]*min-height: 0;[^}]*pointer-events: none;/);
  assert.match(html, /\.file-pending\s*\{ box-shadow: inset 2px 0 var\(--vscode-progressBar-background\); \}/);
  assert.match(html, /\.file-in-editor\s*\{ background: var\(--vscode-list-inactiveSelectionBackground, var\(--vscode-list-hoverBackground\)\); \}/);
  const progressStyles = matchedText(html, /\.file-progress\s*\{([^}]+)\}/, 1);
  assert.match(progressStyles, /position: absolute/);
  assert.match(progressStyles, /clip-path: inset\(50%\)/);
  const labelStyles = matchedText(html, /\.file-label\s*\{([^}]+)\}/, 1);
  assert.match(labelStyles, /display: flex/);
  assert.doesNotMatch(labelStyles, /flex-wrap: wrap/);
  assert.doesNotMatch(html, /\.file-exiting \.file-progress/);
  assert.match(html, /\.file-visible\s*\{ color: var\(--vscode-icon-foreground\);/);
  assert.match(html, /\.file-open\s*\{[^}]*padding-right: 70px;/);
  const actionStyle = matchedText(html, /\.file-action\s*\{([^}]+)\}/, 1);
  assert.match(actionStyle, /position: absolute;\s*right: 4px;[\s\S]*width: 28px;\s*height: 28px;\s*padding: 6px;/);
  assert.match(actionStyle, /opacity: 0;/);
  assert.doesNotMatch(actionStyle, /display: none|visibility: hidden|pointer-events: none/);
  assert.match(html, /\.file-revert\s*\{ right: 36px; \}/);
  assert.match(html, /\.file-row:hover \.file-action,\s*\.file-row:focus-within \.file-action\s*\{ opacity: 1; \}/);
  const disabledStyle = matchedText(html, /\bbutton:disabled\s*\{([^}]+)\}/, 1);
  assert.match(disabledStyle, /cursor: default;/);
  assert.doesNotMatch(disabledStyle, /opacity\s*:/, "disabled buttons must neither dim the panel nor override hidden file-action opacity");
  assert.doesNotMatch(html, /[^{}]*\.file-action[^{}]*:disabled[^{}]*\{[^}]*opacity\s*:\s*(?!0\s*;)/);
  assert.match(html, /\.file-open:hover\s*\{ background: var\(--vscode-list-hoverBackground\); \}/,
    "the file hover background must remain stable even while disabled");
  assert.match(html, /#show-archives\[aria-disabled="true"\]\s*\{ color: var\(--vscode-disabledForeground\); \}/);
  assert.match(html, /<p id="archive-unavailable" class="muted" role="status" hidden><\/p>/);
  assert.match(html, /\.file-action svg\s*\{ display: block; width: 14px; height: 14px; fill: currentColor; \}/);
  assert.doesNotMatch(html, /\bconfirm\s*\(/);
  assert.match(html, /<dialog id="note-editor" aria-labelledby="editor-title">/);
  assert.doesNotMatch(html, /aria-pressed|checkbox/);
  assert.match(html, /<p id="empty" class="muted">Open a local project folder in VS Code to start reviewing\.<\/p>/);
  assert.match(html, /#copy\s*\{[^}]*justify-content: center;[^}]*width: 100%;[^}]*min-height: 48px;/);
  assert.match(html, /white-space: normal/);
  assert.match(html, /overflow-wrap: anywhere/);
  assert.match(html, /@media \(max-width: 220px\)/);
  const previewStyle = matchedText(html, /\.note-preview\s*\{([^}]+)\}/, 1);
  for (const rule of ["display: -webkit-box;", "-webkit-box-orient: vertical;", "-webkit-line-clamp: 2;",
    "max-height: 2.8em;", "overflow: hidden;", "white-space: pre-wrap;"]) {
    assert.ok(previewStyle.includes(rule), rule);
  }
  assert.match(html, /\.note-open\s*\{[^}]*line-height: 1\.4;/);
  assert.match(html, /\.note-card\s*\{[^}]*position: relative;/);
  assert.match(html, /\.note-title\s*\{[^}]*padding-right: 60px;/);
  assert.match(html, /\.note-action\s*\{[^}]*position: absolute;[^}]*top: 5px;[^}]*right: 5px;[^}]*width: 28px;[^}]*height: 28px;[^}]*opacity: 0;/);
  assert.match(html, /\.note-edit\s*\{ right: 37px; \}/);
  assert.match(html, /\.note-action:disabled \{ opacity: 0; \}/);
  assert.match(html, /\.note-card:hover \.note-action, \.note-card:focus-within \.note-action \{ opacity: 1; \}/);
  const narrowStyle = matchedText(html, /@media \(max-width: 220px\)\s*\{([\s\S]*?)\n\s*\}/, 1);
  assert.match(narrowStyle, /#archives li button\s*\{ width: 100%; \}/);
  assert.doesNotMatch(narrowStyle.replace(/#archives li button\s*\{[^}]*\}/, ""), /button|note-|width:\s*100%/);
  assert.doesNotMatch(html, /note-directory|note-context|note-stale|note-status|note-actions|note-comparison|Open Side-by-Side Comparison/);
  assert.match(html, /<template id="delete-icon"><svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="[MmLlHhVvZz0-9 .-]+"\/><\/svg><\/template>/);
  assert.match(html, /<template id="stage-icon"><svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="[MmLlHhVvZz0-9 .-]+"\/><\/svg><\/template>/);
  assert.match(html, /<template id="revert-icon"><svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="[MmLlHhVvAaZz0-9 .-]+"\/><\/svg><\/template>/);
  assert.match(html, /var\(--vscode-button-background\)/);
  assert.match(html, /:focus-visible \{ outline: 2px solid var\(--vscode-focusBorder\)/);
  assert.match(html, /aria-busy="false"/);
  assert.match(html, /<ul id="archives"/);
  assert.match(html, /<ul id="notes" aria-label="Review Notes"/);
  assert.match(html, /role="alert"/);
  assert.throws(() => renderDashboard('x" onclick="bad'), /Invalid dashboard nonce/);
  assert.throws(() => renderDashboard("x'; script-src 'unsafe-inline"), /Invalid dashboard nonce/);
});

test("manifest contributes only the Review Notes webview and refresh title action, without reveal or tree UI", () => {
  const manifest: unknown = JSON.parse(readFileSync(resolve(__dirname, "../../package.json"), "utf8"));
  assert.ok(manifest && typeof manifest === "object" && "contributes" in manifest);
  const contributes = manifest.contributes;
  assert.ok(contributes && typeof contributes === "object" && "views" in contributes && "menus" in contributes);
  const menus = contributes.menus;
  assert.ok(menus && typeof menus === "object" && "view/title" in menus);
  assert.deepEqual(contributes.views, {
    dejareview: [{ id: "dejareview.dashboard", name: "Review Notes", type: "webview" }],
  });
  assert.equal("viewsWelcome" in contributes, false);
  assert.equal("view/item/context" in menus, false);
  assert.deepEqual(menus["view/title"], [{
    command: "dejareview.refresh", when: "view == dejareview.dashboard", group: "navigation@1",
  }]);
  assert.doesNotMatch(JSON.stringify(manifest), /dejareview\.reveal|initialSize|treeView|tree-item/);
});

test("provider waits for ready, posts latest metadata only, caps newest archives and keeps HTML stable", () => {
  const dashboard = new ReviewDashboard(() => {});
  const fixture = viewFixture();
  const archives = Array.from({ length: 12 }, (_, index) => ({
    id: String(index), createdAt: new Date(2026, 0, index + 1).toISOString(), commentCount: index,
    rawText: "PRIVATE FEEDBACK",
  }));
  const notes = [{ ...note(), preview: "Visible preview\r\nVisible second line\r\nPRIVATE THIRD LINE", body: "PRIVATE FULL BODY",
    context: "PRIVATE CONTEXT",
    anchor: "PRIVATE ANCHOR", snapshot: "PRIVATE SNAPSHOT", rawText: "PRIVATE FEEDBACK" }];
  const latest = { ...state({ archives, notes, noteError: "Some notes are stale" }),
    snapshot: "PRIVATE SNAPSHOT", body: "PRIVATE FULL BODY", anchor: "PRIVATE ANCHOR" };
  dashboard.update(state());
  fixture.resolve(dashboard);
  dashboard.update(latest);
  archives[11].commentCount = 999;
  notes[0].path = "mutated.ts";
  notes.push({ ...notes[0], id: "not-published" });
  assert.deepEqual(fixture.view.webview.options, { enableScripts: true, localResourceRoots: [] });
  assert.equal(fixture.messages.length, 0);
  assert.doesNotMatch(fixture.view.webview.html, /PRIVATE FEEDBACK|onerror/);
  fixture.send({ type: "ready" });
  const posted = fixture.latestState;
  assert.equal("repoName" in posted, false);
  assert.deepEqual(Object.keys(posted).sort(), [
    "repoKey", "hasFeedback", "commentCount", "busy", "error", "noteError", "notes", "archives", "files", "filesError", "historyVisible",
  ].sort());
  assert.deepEqual(posted.notes, [note({ preview: "Visible preview\nVisible second line" })]);
  assert.equal("context" in posted.notes[0], false);
  assert.equal(posted.noteError, "Some notes are stale");
  assert.equal(posted.archives.length, 10);
  assert.equal(posted.archives[0].id, "11");
  assert.equal(posted.archives[0].commentCount, 11);
  assert.equal(posted.archives[9].id, "2");
  assert.deepEqual(Object.keys(posted.archives[0]).sort(), ["commentCount", "createdAt", "id"]);
  assert.doesNotMatch(JSON.stringify(posted), /PRIVATE|rawText|snapshot|anchor|body/);
  dashboard.update(state({ busy: true }));
  fixture.show();
  assert.equal(fixture.latestState.busy, true);
  assert.equal(fixture.htmlWrites, 1);
  dashboard.dispose();
});

test("provider normalizes the first two source lines to LF and bounds previews to 320 characters", () => {
  const dashboard = new ReviewDashboard(() => {});
  const fixture = viewFixture();
  fixture.resolve(dashboard);
  fixture.send({ type: "ready" });
  for (const newline of ["\n", "\r\n", "\r"]) {
    for (const [first, second] of [
      ["", ""], ["first", "second"], ["", "second"], ["first", ""],
      ...[159, 160, 318, 319, 320, 321, 400].map(length => ["x".repeat(length), "second"]),
      ...[313, 314, 315, 400].map(length => ["first", "y".repeat(length)]),
    ]) {
      dashboard.update(state({ notes: [note({ preview: first + newline + second + newline + "PRIVATE THIRD LINE" })] }));
      assert.equal(fixture.latestState.notes[0].preview, (first + "\n" + second).slice(0, 320));
      assert.doesNotMatch(JSON.stringify(fixture.latestState), /PRIVATE THIRD LINE/);
    }
  }
  dashboard.dispose();
});

test("file count badge updates before ready, while hidden and on replacement resolution", () => {
  const dashboard = new ReviewDashboard(() => {});
  dashboard.update(state());
  const fixture = viewFixture();
  fixture.resolve(dashboard);
  assert.deepEqual(fixture.view.badge, { value: 1, tooltip: '1 file to review · 2 Review Notes' });
  assert.equal(fixture.messages.length, 0);
  fixture.hide();
  dashboard.update(state({ commentCount: 1, files: [{ id: 'a', path: 'a' }, { id: 'b', path: 'b', pending: 'stage' }] }));
  assert.equal(fixture.view.visible, false);
  assert.deepEqual(fixture.view.badge, { value: 2, tooltip: '2 files to review · 1 Review Note' });
  fixture.send({ type: 'ready' });
  dashboard.update(state({ files: [] }));
  assert.equal(fixture.view.badge, undefined);
  dashboard.update(state());
  dashboard.update(state({ repoKey: undefined }));
  assert.equal(fixture.view.badge, undefined, 'no folder hides even a nonempty stale list');
  dashboard.update(state());
  fixture.close();
  dashboard.update(state({ commentCount: 0, files: [{ id: 'other', path: 'other' }, { id: 'new', path: 'new' }] }));
  const replacement = viewFixture();
  replacement.resolve(dashboard);
  assert.deepEqual(replacement.view.badge, { value: 2, tooltip: '2 files to review · 0 Review Notes' });
  dashboard.dispose();
});

test("zero candidates clear retained Activity Bar counts on older VS Code hosts", () => {
  const dashboard = new ReviewDashboard(() => {});
  const fixture = viewFixture();
  type Badge = typeof fixture.view.badge;
  let badge: Badge;
  let activity: Badge = { value: 1, tooltip: 'Previously rendered count' };
  const writes: Badge[] = [];
  // Model the old WebviewViewPane: undefined updates the API value but does
  // not dispose the activity. NumberBadge(0) is hidden by the Activity Bar.
  Object.defineProperty(fixture.view, 'badge', {
    get: (): Badge => badge,
    set: (value: Badge): void => {
      writes.push(value);
      if (badge?.value === value?.value && badge?.tooltip === value?.tooltip) {
        return;
      }
      badge = value;
      if (value) {
        activity = value;
      }
    },
  });

  fixture.resolve(dashboard);
  assert.equal(activity?.value, 0, 'empty startup clears activity retained from an earlier view');
  assert.equal(fixture.view.badge, undefined);

  for (const emptyState of [state({ files: [] }), state({ repoKey: undefined })]) {
    dashboard.update(state());
    assert.equal(activity?.value, 1);
    fixture.hide();
    dashboard.update(emptyState);
    assert.deepEqual(writes.slice(-2), [{ value: 0, tooltip: '' }, undefined]);
    assert.equal(activity?.value, 0, 'the Activity Bar no longer displays the last file count');
    assert.equal(activity?.tooltip, '', 'no stale file or note count remains in the activity tooltip');
    assert.equal(fixture.view.badge, undefined);
    fixture.show();
    fixture.send({ type: 'ready' });
    assert.equal(activity?.value, 0);
  }

  dashboard.update(state());
  assert.equal(activity?.value, 1, 'new candidates restore the badge normally');
  dashboard.dispose();
});

test("file optional metadata is exactly validated and whitelisted in the serialized client protocol", () => {
  const dashboard = new ReviewDashboard(() => {});
  const fixture = viewFixture();
  fixture.resolve(dashboard);
  fixture.send({ type: 'ready' });
  for (const visible of [undefined, false, true]) {
    for (const pending of [undefined, 'stage', 'revert'] as const) {
      const file = { id: 'a', path: 'a', visible, pending };
      const message = { type: 'state', state: state({ files: [file] }) };
      assert.equal(isDashboardHostMessage(message), true);
      const privateFile = { ...file, privateData: 'PRIVATE' };
      dashboard.update(state({ files: [privateFile] }));
      assert.equal(fixture.latestState.files[0].visible, visible);
      assert.equal(fixture.latestState.files[0].pending, pending);
      assert.doesNotMatch(JSON.stringify(fixture.latestState), /PRIVATE|privateData/);
      assert.equal(isDashboardHostMessage({ ...message, state: { ...state(), files: [{ ...file, extra: undefined }] } }), false);
    }
  }
  const client = scriptFixture();
  client.update(state());
  for (const fields of [
    ...[null, 0, 'true', {}, []].map(visible => ({ visible })),
    ...[null, false, 1, '', 'staging', 'reverting', {}, []].map(pending => ({ pending })),
  ]) {
    const message = { type: 'state', state: { ...state(), files: [{ id: 'a', path: 'a', ...fields }] } };
    assert.equal(isDashboardHostMessage(message), false);
    client.receive(message);
    assert.equal(client.element('files').children[0].children[0].title, 'src/example.ts');
  }
  dashboard.dispose();
});

for (const type of ['stageFile', 'revertFile'] as const) test(`${type} publishes targeted pending before owner dispatch and clears it on settlement`, async () => {
  let finish: (() => void) | undefined;
  const fixture = viewFixture();
  const pending = type === 'stageFile' ? 'stage' : 'revert';
  let calls = 0;
  const dashboard = new ReviewDashboard(() => {
    calls++;
    assert.equal(fixture.latestState.busy, true);
    assert.equal(fixture.latestState.files[0].pending, pending);
    assert.equal(fixture.latestState.files[1].pending, undefined);
    return new Promise<void>(resolve => { finish = resolve; });
  });
  const current = state({ files: [{ id: 'a', path: 'a' }, { id: 'b', path: 'b' }] });
  dashboard.update(current);
  fixture.resolve(dashboard);
  fixture.send({ type: 'ready' });
  fixture.send({ type, repoKey: '/other', fileId: 'a' });
  fixture.send({ type, repoKey: '/repo', fileId: 'missing' });
  assert.equal(calls, 0);
  fixture.send({ type, repoKey: '/repo', fileId: 'a' });
  assert.equal(calls, 1);
  dashboard.update(current);
  assert.equal(fixture.latestState.files[0].pending, pending);
  fixture.send({ type, repoKey: '/repo', fileId: 'b' });
  assert.equal(calls, 1);
  dashboard.update({ ...current, repoKey: '/other' });
  assert.equal(fixture.latestState.files[0].pending, undefined, 'never decorate a matching ID in another folder');
  dashboard.update(current);
  assert.ok(finish);
  finish();
  await settle();
  assert.deepEqual(fixture.latestState.files, current.files);
  assert.equal(fixture.latestState.busy, false);
  dashboard.update({ ...current, files: [{ id: 'a', path: 'a', pending }] });
  for (const action of ['openFile', 'stageFile', 'revertFile']) {
    fixture.send({ type: action, repoKey: '/repo', fileId: 'a' });
  }
  assert.equal(calls, 1, 'owner-published pending also rejects row actions');
  dashboard.dispose();
});

test("provider whitelists file metadata, snapshots it and leaves unknown counts optional", () => {
  const dashboard = new ReviewDashboard(() => {});
  const fixture = viewFixture();
  fixture.resolve(dashboard);
  fixture.send({ type: "ready" });
  assert.deepEqual(fixture.latestState.files, []);
  const files = [
    { id: "known", path: "src/a.ts", insertions: 0, deletions: 1, rawText: "PRIVATE", reviewed: true },
    { id: "unknown", path: "image.png", rawText: "PRIVATE", reviewed: false },
  ];
  dashboard.update(state({ files, filesError: "Unable to load some stats" }));
  files[0].path = "changed.ts";
  files.push({ ...files[0], id: "unpublished" });
  const posted = fixture.latestState;
  assert.deepEqual(posted.files, [
    { id: "known", path: "src/a.ts", insertions: 0, deletions: 1 },
    { id: "unknown", path: "image.png" },
  ]);
  assert.equal(posted.filesError, "Unable to load some stats");
  assert.doesNotMatch(JSON.stringify(posted), /PRIVATE|rawText|reviewed/);
  for (const invalid of [undefined, NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    dashboard.update(state({ files: [{ id: "invalid", path: "a", insertions: invalid, deletions: invalid }] }));
    assert.deepEqual(fixture.latestState.files, [{ id: "invalid", path: "a" }]);
  }
  dashboard.dispose();
});

for (const type of ["openFile", "revertFile", "stageFile"]) test(`provider validates exact ${type} keys, scope and live membership independent of feedback and stats`, async () => {
  const actions: unknown[] = [];
  let finish: (() => void) | undefined;
  const dashboard = new ReviewDashboard(action => {
    actions.push(action);
    return new Promise<void>(resolve => { finish = resolve; });
  });
  const fixture = viewFixture();
  const action = { type, repoKey: "/repo", fileId: "files:0" };
  dashboard.update(state({ hasFeedback: false, notes: [], commentCount: 0 }));
  fixture.resolve(dashboard);
  fixture.send(action);
  assert.equal(actions.length, 0);
  fixture.send({ type: "ready" });
  for (const message of [
    null, [], type, {}, { type }, { type, repoKey: "/repo" }, { type, fileId: "files:0" },
    ...[null, 1, {}, [], "", "missing", "src/example.ts", "../outside.ts", undefined].map(fileId => ({ ...action, fileId })),
    ...[null, 1, {}, [], "", "/old", undefined].map(repoKey => ({ ...action, repoKey })),
    ...["noteId", "archiveId", "path", "paths", "fileIds", "insertions", "deletions", "extra"].flatMap(key =>
      ["untrusted", undefined].map(value => ({ ...action, [key]: value }))),
    ...["copy", "restore", "open", "delete"].map(type => ({ ...action, type })),
    { type: "restore", repoKey: "/repo", archiveId: "batch", fileId: "files:0" },
    { type: "open", repoKey: "/repo", noteId: "projection:0", fileId: "files:0" },
  ]) fixture.send(message);
  assert.equal(actions.length, 0);
  for (const hasFeedback of [false, true]) {
    const current = state({ hasFeedback, notes: [], commentCount: 0,
      files: [{ id: "files:0", path: "image.png" }] });
    dashboard.update(current);
    const before: number = actions.length;
    fixture.send(action);
    assert.equal(actions.length, before + 1);
    assert.deepEqual(actions.at(-1), action);
    const count: number = actions.length;
    dashboard.update(current);
    for (const type of ["openFile", "revertFile", "stageFile"]) fixture.send({ ...action, type });
    fixture.send({ ...action, fileId: "image.png" });
    assert.equal(actions.length, count, "in-flight file actions are serialized");
    assert.equal(fixture.latestState.busy, type !== "openFile");
    assert.deepEqual(fixture.latestState.files, current.files.map(file => type === 'openFile' ? file
      : { ...file, pending: type === 'stageFile' ? 'stage' : 'revert' }), "no optimistic candidate removal");
    assert.ok(finish, "Expected a pending file action");
    finish();
    await settle();
    assert.equal(fixture.latestState.busy, false);
    assert.deepEqual(fixture.latestState.files, current.files);
  }
  for (const overrides of [
    { busy: true }, { files: [] }, { files: [{ id: "replacement", path: "src/example.ts" }] },
    { repoKey: "/other" }, { repoKey: undefined },
  ]) {
    dashboard.update(state(overrides));
    fixture.send(action);
  }
  fixture.send({ type, fileId: "files:0" });
  assert.equal(actions.length, 2, "stale IDs, old scopes and busy state must reject actions");
  dashboard.dispose();
});

test("provider validates action schema, repository, feedback mode, archive membership and busy state", async () => {
  const actions: unknown[] = [];
  const dashboard = new ReviewDashboard((action) => { actions.push(action); });
  const fixture = viewFixture();
  dashboard.update(state());
  fixture.resolve(dashboard);
  fixture.send({ type: "copy", repoKey: "/repo" });
  fixture.send({ type: "ready", unexpected: true });
  fixture.send({ type: "copy", repoKey: "/repo" });
  assert.equal(actions.length, 0);
  fixture.send({ type: "ready" });
  for (const message of [
    null, [], "copy", {}, { type: "unknown" },
    { type: "copy" }, { type: "copy", repoKey: 12 },
    { type: "copy", repoKey: "/old" },
    { type: "copy", repoKey: "/repo", extra: true },
    { type: "copy", repoKey: "/repo", archiveId: "batch" },
    { type: "copy", repoKey: "/repo", noteId: "projection:0" },
    { type: "copy", repoKey: "/repo", noteId: undefined },
    { type: "restore", repoKey: "/repo", archiveId: "batch" },
  ]) fixture.send(message);
  assert.equal(actions.length, 0);
  fixture.send({ type: "copy", repoKey: "/repo" });
  await settle();
  assert.deepEqual(actions, [{ type: "copy", repoKey: "/repo" }]);

  dashboard.update(state({ hasFeedback: false }));
  fixture.send({ type: "restore", repoKey: "/repo", archiveId: "batch" });
  assert.equal(actions.length, 1, "a valid archive still requires explicitly opened history");
  fixture.send({ type: "openHistory", repoKey: "/repo" });
  for (const message of [
    { type: "copy", repoKey: "/repo" },
    { type: "restore", repoKey: "/repo" },
    { type: "restore", repoKey: "/repo", archiveId: 1 },
    { type: "restore", repoKey: "/repo", archiveId: "missing" },
    { type: "restore", repoKey: "/old", archiveId: "batch" },
    { type: "restore", repoKey: "/repo", archiveId: "batch", noteId: "projection:0" },
    { type: "restore", repoKey: "/repo", archiveId: "batch", extra: true },
  ]) fixture.send(message);
  assert.equal(actions.length, 1);
  fixture.send({ type: "restore", repoKey: "/repo", archiveId: "batch" });
  await settle();
  assert.deepEqual(actions[1], { type: "restore", repoKey: "/repo", archiveId: "batch" });
  dashboard.update(state({ busy: true, hasFeedback: false }));
  fixture.send({ type: "restore", repoKey: "/repo", archiveId: "batch" });
  dashboard.update(state({ busy: true }));
  fixture.send({ type: "copy", repoKey: "/repo" });
  assert.equal(actions.length, 2);
  dashboard.update(state({ repoKey: undefined, hasFeedback: false }));
  fixture.send({ type: "restore", archiveId: "batch" });
  fixture.send({ type: "copy" });
  dashboard.update(state({ repoKey: undefined }));
  fixture.send({ type: "copy" });
  await settle();
  assert.equal(actions.length, 2);
  dashboard.dispose();
});

test("provider validates note actions and rejects comparison messages even for valid comparison IDs", async () => {
  const actions: unknown[] = [];
  const dashboard = new ReviewDashboard((action) => { actions.push(action); });
  const fixture = viewFixture();
  dashboard.update(state());
  fixture.resolve(dashboard);
  fixture.send({ type: "open", repoKey: "/repo", noteId: "projection:0" });
  assert.equal(actions.length, 0);
  fixture.send({ type: "ready" });
  for (const type of ["open", "delete", "comparison"]) {
    for (const message of [
      { type }, { type, repoKey: "/repo" },
      ...[null, 1, {}, [], "", "missing"].map(noteId => ({ type, repoKey: "/repo", noteId })),
      ...[undefined, null, 1, "", "/other"].map(repoKey => ({ type, repoKey, noteId: "projection:1" })),
      ...["archiveId", "path", "startLine", "snapshot", "extra"].map(key => ({
        type, repoKey: "/repo", noteId: "projection:1", [key]: "untrusted",
      })),
    ]) fixture.send(message);
  }
  for (const noteId of ["projection:0", "projection:1"]) {
    fixture.send({ type: "comparison", repoKey: "/repo", noteId });
    await settle();
    assert.equal(actions.length, 0);
  }
  assert.equal(actions.length, 0);

  for (const overrides of [{ busy: true }, { hasFeedback: false }, { repoKey: undefined }]) {
    dashboard.update(state(overrides));
    for (const type of ["open", "delete", "comparison"]) {
      fixture.send({ type, repoKey: overrides.repoKey ?? "/repo", noteId: "projection:1" });
    }
  }
  assert.equal(actions.length, 0);
  dashboard.update(state({ notes: [note({ stale: true }), note({ id: "projection:1", comparison: true })] }));
  for (const [type, noteId] of [["open", "projection:0"], ["delete", "projection:0"], ["open", "projection:1"], ["delete", "projection:1"]]) {
    const action = { type, repoKey: "/repo", noteId };
    fixture.send(action);
    await settle();
    assert.deepEqual(actions.at(-1), action);
  }
  assert.equal(actions.length, 4);

  dashboard.update(state({ notes: [note({ id: "replacement:0", comparison: true })] }));
  for (const type of ["open", "delete", "comparison"]) {
    fixture.send({ type, repoKey: "/repo", noteId: "projection:1" });
  }
  assert.equal(actions.length, 4, "old projection handles must not resolve by path or range");
  fixture.send({ type: "open", repoKey: "/repo", noteId: "replacement:0" });
  await settle();
  assert.deepEqual(actions.at(-1), { type: "open", repoKey: "/repo", noteId: "replacement:0" });
  dashboard.update(state({ repoKey: "/other", notes: [note({ id: "replacement:0" })] }));
  fixture.send({ type: "open", repoKey: "/repo", noteId: "replacement:0" });
  assert.equal(actions.length, 5);
  dashboard.dispose();
});

test("old repositories and archives outside the newest ten cannot be restored", () => {
  const actions: unknown[] = [];
  const dashboard = new ReviewDashboard((action) => { actions.push(action); });
  const fixture = viewFixture();
  fixture.resolve(dashboard);
  fixture.send({ type: "ready" });
  dashboard.update(state({
    repoKey: "/new", hasFeedback: false,
    archives: Array.from({ length: 11 }, (_, index) => ({
      id: String(index), createdAt: new Date(2026, 0, index + 1).toISOString(), commentCount: 1,
    })),
  }));
  fixture.send({ type: "restore", repoKey: "/repo", archiveId: "10" });
  fixture.send({ type: "openHistory", repoKey: "/new" });
  fixture.send({ type: "restore", repoKey: "/new", archiveId: "0" });
  assert.equal(actions.length, 0);
  dashboard.dispose();
});

for (const type of ["copy", "revertFile", "stageFile"]) test(`in-flight ${type} actions are serialized and callback failures release busy state`, async (t) => {
  const errors: unknown[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { errors.push(args); });
  let reject: ((error: Error) => void) | undefined;
  let calls = 0;
  const dashboard = new ReviewDashboard(() => {
    calls++;
    if (calls > 1) throw new Error("sync failure");
    return new Promise<void>((_resolve, fail) => { reject = fail; });
  });
  const fixture = viewFixture();
  dashboard.update(state());
  fixture.resolve(dashboard);
  fixture.send({ type: "ready" });
  const action = { type, repoKey: "/repo", ...(type !== "copy" ? { fileId: "files:0" } : {}) };
  fixture.send(action);
  fixture.send(action);
  assert.equal(calls, 1);
  assert.equal(fixture.latestState.busy, true);
  assert.ok(reject, "Expected a pending mutation");
  reject(new Error("async failure"));
  await settle();
  assert.equal(errors.length, 1);
  assert.equal(fixture.latestState.busy, false);
  assert.deepEqual(fixture.latestState.files, state().files, "failed actions retain the candidate");
  fixture.send(action);
  await settle();
  assert.equal(errors.length, 2);
  assert.equal(calls, 2, "failed actions can be retried");
  assert.equal(fixture.latestState.busy, false);
  assert.deepEqual(fixture.latestState.files, state().files);
  dashboard.dispose();
});

for (const type of ["openFile", "open"] as const) test(`pending ${type} serializes actions without UI busy flicker and releases its guard after failures`, async (t) => {
  const errors: unknown[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { errors.push(args); });
  const actions: DashboardAction[] = [];
  let reject: ((error: Error) => void) | undefined;
  const dashboard = new ReviewDashboard(action => {
    actions.push(action);
    if (actions.length === 1) return new Promise<void>((_resolve, fail) => { reject = fail; });
    if (actions.length === 2) throw new Error("sync navigation failure");
  });
  t.after(() => dashboard.dispose());
  const fixture = viewFixture();
  fixture.resolve(dashboard);
  dashboard.update(state());
  fixture.send({ type: "ready" });
  const action = { type, repoKey: "/repo", ...(type === "openFile" ? { fileId: "files:0" } : { noteId: "projection:0" }) };
  fixture.send(action);
  assert.deepEqual(actions, [action]);
  for (const next of [state(), state({ filesError: "Stats unavailable" }), state({ noteError: "Refresh warning" })]) {
    dashboard.update(next);
    fixture.show();
    for (const request of [action, { type: "copy", repoKey: "/repo" }, { type: "addGeneral", repoKey: "/repo" },
      ...["openFile", "stageFile", "revertFile"].map(type => ({ type, repoKey: "/repo", fileId: "files:0" })),
      ...["open", "edit", "delete"].map(type => ({ type, repoKey: "/repo", noteId: "projection:1" }))]) fixture.send(request);
    assert.equal(actions.length, 1, "updates must not release host serialization even though the UI remains enabled");
  }
  assert.ok(fixture.messages.every(message => !message.state.busy), "no transient navigation busy payload");
  dashboard.update(state({ busy: true }));
  assert.equal(fixture.latestState.busy, true, "navigation must not mask owner-supplied busy state");
  dashboard.update(state());
  const before = fixture.messages.length;
  assert.ok(reject, "Expected pending navigation");
  reject(new Error("async navigation failure"));
  await settle();
  fixture.send(action);
  await settle();
  assert.equal(errors.length, 2);
  fixture.send(action);
  await settle();
  assert.deepEqual(actions, [action, action, action], "both asynchronous and synchronous failures permit retry");
  assert.ok(fixture.messages.slice(before).every(message => !message.state.busy));
  assert.deepEqual(fixture.latestState.notes, state().notes);
  assert.deepEqual(fixture.latestState.files, state().files);
  assert.equal(fixture.htmlWrites, 1);
});

test("opening a general card remains a busy editor action rather than navigation", async () => {
  let finish: (() => void) | undefined;
  const dashboard = new ReviewDashboard(action => {
    assert.equal(action.type, "edit");
    return new Promise<void>(resolve => { finish = resolve; });
  });
  const fixture = viewFixture();
  fixture.resolve(dashboard);
  fixture.send({ type: "ready" });
  dashboard.update(state({ notes: [generalNote()] }));
  fixture.send({ type: "open", repoKey: "/repo", noteId: "projection:0" });
  assert.equal(fixture.latestState.busy, true);
  dashboard.update(state({ notes: [generalNote()], editor: editor() }));
  assert.equal(fixture.latestState.busy, true);
  assert.ok(finish, "Expected a pending editor action");
  finish();
  await settle();
  assert.equal(fixture.latestState.busy, false);
  dashboard.dispose();
});

test("disposed views detach listeners and replacement views get a fresh nonce and latest state", () => {
  const dashboard = new ReviewDashboard(() => assert.fail("disposed listener invoked"));
  const first = viewFixture();
  first.resolve(dashboard);
  first.send({ type: "ready" });
  first.close();
  const count = first.messages.length;
  dashboard.update(state());
  first.send({ type: "copy", repoKey: "/repo" });
  assert.equal(first.messages.length, count);
  const second = viewFixture();
  second.resolve(dashboard);
  assert.notEqual(first.view.webview.html, second.view.webview.html);
  assert.equal(second.messages.length, 0);
  second.send({ type: "ready" });
  assert.equal(second.messages[0].state.repoKey, "/repo");
  assert.deepEqual(second.messages[0].state.notes, state().notes);
  dashboard.dispose();
  dashboard.dispose();
  second.send({ type: "copy", repoKey: "/repo" });
  dashboard.update(state());
  assert.equal(second.messages.length, 1);
});

test("connected busy-transition input is rejected, retained across reconstruction and resynchronized only when idle", async () => {
  let current = state({ editor: editor({ body: "host text" }) });
  const accepted: DashboardAction[] = [];
  const dashboard = new ReviewDashboard(action => {
    accepted.push(action);
    if (action.type === "input") {
      current = { ...current, editor: editor({ body: action.body }) };
      dashboard.update(current);
    }
  });
  const cache: { value?: unknown } = {};
  const client = scriptFixture(cache);
  const host = viewFixture();
  dashboard.update(current);
  host.resolve(dashboard);
  host.send(client.messages[0]);
  for (const message of host.transport.splice(0)) client.receive(message);

  // Host acquires busy before its publication reaches the textarea.
  dashboard.update({ ...current, busy: true });
  client.element("editor-body").value = "last keystroke";
  client.element("editor-body").dispatch("input");
  host.send(lastMessage(client.messages));
  assert.deepEqual(accepted, [], "busy input never reaches the owner");
  for (const message of host.transport.splice(0)) client.receive(message);
  assert.equal(client.element("editor-body").value, "last keystroke");
  assert.equal(client.element("editor-body").disabled, true);

  host.close();
  const replacement = scriptFixture(cache);
  const replacementHost = viewFixture();
  replacementHost.resolve(dashboard);
  replacementHost.send(replacement.messages[0]);
  for (const message of replacementHost.transport.splice(0)) replacement.receive(message);
  assert.equal(replacement.element("editor-body").value, "last keystroke");
  assert.equal(replacement.messages.length, 1, "reconstruction must not send input while busy");

  dashboard.update(current);
  for (const message of replacementHost.transport.splice(0)) replacement.receive(message);
  replacementHost.send(lastMessage(replacement.messages));
  await settle();
  for (const message of replacementHost.transport.splice(0)) replacement.receive(message);
  assert.deepEqual(accepted, [{ type: "input", repoKey: "/repo", editorId: "editor:0", body: "last keystroke" }]);
  assert.equal(current.editor?.body, "last keystroke");
  assert.equal(cache.value, undefined, "host echo acknowledges and clears the transport-only cache");
  dashboard.dispose();
});

for (const type of ["saveEdit", "cancelEdit"] as const) {
  for (const busy of [false, true]) {
    test(`undelivered ${type} reconciles after teardown with busy=${busy}, retaining text without resubmission`, async (t) => {
      let current = state({ editor: editor({ body: "host text" }) });
      const actions: DashboardAction[] = [];
      const dashboard = new ReviewDashboard(action => {
        actions.push(action);
        if (action.type === "input") {
          current = { ...current, editor: editor({ body: action.body }) };
          dashboard.update(current);
        }
      });
      t.after(() => dashboard.dispose());
      const cache: { value?: unknown } = {};
      const client = scriptFixture(cache);
      const host = viewFixture();
      dashboard.update(current);
      host.resolve(dashboard);
      host.send(client.messages[0]);
      for (const message of host.transport.splice(0)) {
        client.receive(message);
      }

      const typedBody = "Typed but never delivered\nincluding the last keystroke";
      client.element("editor-body").value = typedBody;
      client.element("editor-body").dispatch("input");
      const undeliveredInput = lastMessage(client.messages);
      client.element(type === "saveEdit" ? "save-edit" : "cancel-edit").click();
      const undelivered = lastMessage(client.messages);
      assert.equal(undelivered.type, type);
      assert.ok(undelivered.requestId);
      assert.equal(client.element("editor-body").disabled, true);
      host.close();
      dashboard.update({ ...current, busy });

      const replacement = scriptFixture(cache);
      const replacementHost = viewFixture();
      replacementHost.resolve(dashboard);
      replacementHost.send(replacement.messages[0]);
      for (const message of replacementHost.transport.splice(0)) {
        replacement.receive(message);
      }
      const query = lastMessage(replacement.messages);
      assert.deepEqual({ ...query }, {
        type: "editorRequestStatus", repoKey: "/repo", editorId: "editor:0", requestId: undelivered.requestId,
      });
      assert.equal(replacement.element("editor-body").value, typedBody);
      assert.equal(replacement.element("editor-body").disabled, true, "wait for correlated status, not an idle publication");
      replacementHost.send(query);
      assert.deepEqual(replacementHost.transport, [{
        type: "editorSettled", repoKey: "/repo", editorId: "editor:0", requestId: undelivered.requestId,
      }]);
      for (const message of replacementHost.transport.splice(0)) {
        replacement.receive(message);
      }
      assert.equal(replacement.element("editor-body").disabled, busy);

      // Late delivery stays bound to the disposed view, never the replacement.
      host.send(undeliveredInput);
      host.send(undelivered);
      assert.deepEqual(actions, []);
      if (busy) {
        dashboard.update(current);
        for (const message of replacementHost.transport.splice(0)) {
          replacement.receive(message);
        }
      }
      const resync = lastMessage(replacement.messages);
      assert.equal(resync.type, "input");
      assert.equal(resync.body, typedBody);
      assert.notEqual(resync.requestId, undeliveredInput.requestId);
      replacementHost.send(resync);
      await settle();
      for (const message of replacementHost.transport.splice(0)) {
        replacement.receive(message);
      }
      assert.deepEqual(actions, [{ type: "input", repoKey: "/repo", editorId: "editor:0", body: typedBody }]);
      assert.deepEqual(replacement.messages.map(message => message.type), ["ready", "editorRequestStatus", "input"]);
      assert.equal(cache.value, undefined);
      assert.equal(replacement.element("note-editor").open, true);
      assert.equal(replacement.element("editor-body").value, typedBody);
      assert.equal(replacement.element("editor-body").disabled, false);
      assert.equal(replacement.element("save-edit").disabled, false);
      assert.equal(replacement.element("cancel-edit").disabled, false);
      assert.equal(replacement.document.activeElement, replacement.element("editor-body"));
    });
  }
}

test("request status validates exact scope/session and preserves completed status when answering unknown requests", async (t) => {
  const actions: DashboardAction[] = [];
  const dashboard = new ReviewDashboard(action => {
    actions.push(action);
  });
  t.after(() => dashboard.dispose());
  const host = viewFixture();
  dashboard.update(state({ editor: editor() }));
  host.resolve(dashboard);
  const query = { type: "editorRequestStatus", repoKey: "/repo", editorId: "editor:0", requestId: "unknown" };
  host.send(query);
  assert.deepEqual(host.transport, [], "queries require ready");
  host.send({ type: "ready" });
  host.transport.splice(0);
  for (const field of ["repoKey", "editorId", "requestId"]) {
    for (const value of [undefined, null, 1, {}, [], ""]) {
      host.send({ ...query, [field]: value });
    }
  }
  for (const extra of ["body", "noteId", "extra"]) {
    host.send({ ...query, [extra]: undefined });
  }
  host.send({ ...query, repoKey: "/other" });
  host.send({ ...query, editorId: "old-session" });
  assert.deepEqual(host.transport, []);

  host.send({ type: "saveEdit", repoKey: "/repo", editorId: "editor:0", requestId: "completed", body: "saved" });
  await settle();
  host.transport.splice(0);
  host.send(query);
  host.send({ ...query, requestId: "completed" });
  assert.deepEqual(host.transport, [
    { type: "editorSettled", repoKey: "/repo", editorId: "editor:0", requestId: "unknown" },
    { type: "editorSettled", repoKey: "/repo", editorId: "editor:0", requestId: "completed" },
  ]);
  host.transport.splice(0);
  host.send({ type: "ready" });
  assert.deepEqual(host.transport.at(-1), {
    type: "editorSettled", repoKey: "/repo", editorId: "editor:0", requestId: "completed",
  }, "unknown reconciliation does not replace the retained completion");

  for (const next of [state({ editor: editor({ id: "replacement" }) }), state(), state({ repoKey: "/other" })]) {
    dashboard.update(next);
    host.transport.splice(0);
    host.send(query);
    assert.deepEqual(host.transport, []);
  }
  assert.deepEqual(actions, [{ type: "saveEdit", repoKey: "/repo", editorId: "editor:0", body: "saved" }]);
});

for (const type of ["saveEdit", "cancelEdit"] as const) {
  test(`delivered ${type} stays frozen through recreation and request-status reconciliation until processing ends`, async (t) => {
    let finish: (() => void) | undefined;
    const actions: DashboardAction[] = [];
    const dashboard = new ReviewDashboard(action => {
      actions.push(action);
      return new Promise<void>(resolve => {
        finish = resolve;
      });
    });
    t.after(() => dashboard.dispose());
    const cache: { value?: unknown } = {};
    const client = scriptFixture(cache);
    const host = viewFixture();
    dashboard.update(state({ editor: editor({ body: "submitted" }) }));
    host.resolve(dashboard);
    host.send(client.messages[0]);
    for (const message of host.transport.splice(0)) {
      client.receive(message);
    }
    client.element(type === "saveEdit" ? "save-edit" : "cancel-edit").click();
    const request = lastMessage(client.messages);
    host.send(request);
    host.close();

    const replacement = scriptFixture(cache);
    const replacementHost = viewFixture();
    replacementHost.resolve(dashboard);
    replacementHost.send(replacement.messages[0]);
    for (const message of replacementHost.transport.splice(0)) {
      replacement.receive(message);
    }
    const query = lastMessage(replacement.messages);
    assert.equal(query.type, "editorRequestStatus");
    assert.equal(query.requestId, request.requestId);
    replacementHost.send(query);
    assert.deepEqual(replacementHost.transport, [], "in-flight processing owns settlement");
    assert.equal(replacement.element("editor-body").disabled, true);
    replacement.element("save-edit").click();
    replacement.element("cancel-edit").click();
    assert.deepEqual(replacement.messages.map(message => message.type), ["ready", "editorRequestStatus"]);
    assert.equal(actions.length, 1);

    assert.ok(finish);
    finish();
    await settle();
    for (const message of replacementHost.transport.splice(0)) {
      replacement.receive(message);
    }
    assert.equal(replacement.element("editor-body").disabled, false);
    assert.equal(replacement.element("editor-body").value, "submitted");
    assert.equal(lastMessage(replacement.messages).type, "input", "processing end resyncs input, not Save/Cancel");
    assert.equal(actions.length, 1);
  });
}

test("connected Save freezes its submitted body through stale updates and recovers failed-save focus after acknowledgement", async () => {
  let current = state({ editor: editor({ body: "initial" }) });
  let finish: (() => void) | undefined;
  const submitted: string[] = [];
  const dashboard = new ReviewDashboard(async action => {
    if (action.type === "input") {
      const session = current.editor;
      assert.ok(session);
      if (action.body !== session.body) {
        session.error = undefined;
      }
      session.body = action.body;
      dashboard.update(current);
    }
    if (action.type === "saveEdit") {
      const body = action.body;
      submitted.push(body);
      current = { ...current, editor: editor({ body }) };
      await new Promise<void>(resolve => { finish = resolve; });
      assert.equal(action.body, body);
      current = { ...current, editor: editor({ body, error: "Save failed" }) };
      dashboard.update(current);
    }
  });
  const host = viewFixture();
  const client = scriptFixture();
  dashboard.update(current);
  host.resolve(dashboard);
  host.send(client.messages[0]);
  for (const message of host.transport.splice(0)) client.receive(message);
  const body = client.element("editor-body");
  body.value = "submitted";
  body.dispatch("input");
  host.send(lastMessage(client.messages));
  for (const message of host.transport.splice(0)) client.receive(message);
  client.element("save-edit").focus();
  client.element("save-edit").click();
  const save = lastMessage(client.messages);
  assert.equal(body.disabled, true, "freeze immediately, before any host round trip");
  body.value = "late event";
  body.dispatch("input");
  assert.equal(body.value, "submitted");
  client.update(current);
  assert.equal(body.disabled, true, "an idle state queued before Save cannot unlock it");
  host.send(save);
  for (const message of host.transport.splice(0)) client.receive(message);
  host.send({ type: "input", repoKey: "/repo", editorId: "editor:0", body: "late host overwrite", requestId: "late" });
  assert.equal(current.editor?.body, "submitted");
  assert.ok(finish);
  finish();
  await settle();
  client.document.activeElement = client.document.root;
  const beforeSettlement = client.messages.length;
  for (const message of host.transport.splice(0)) {
    client.receive(message);
  }
  const resync = client.messages.slice(beforeSettlement);
  assert.equal(resync.length, 1);
  assert.equal(resync[0].type, "input");
  assert.equal(resync[0].body, "submitted");
  host.send(resync[0]);
  await settle();
  const resyncResponses = host.transport.splice(0);
  assert.ok(resyncResponses.some(message => message.type === "inputAccepted" && message.requestId === resync[0].requestId));
  for (const message of resyncResponses) {
    client.receive(message);
  }
  assert.equal(client.messages.length, beforeSettlement + 1, "resync and acknowledgement exchange is drained");
  assert.deepEqual(submitted, ["submitted"]);
  assert.equal(body.value, "submitted");
  assert.equal(body.disabled, false);
  assert.equal(client.element("editor-error").textContent, "Save failed");
  assert.equal(current.editor?.error, "Save failed", "unchanged-body resync preserves the host error");
  assert.equal(client.document.activeElement, body, "explicit focus recovery does not rely on disabled-control browser behavior");
  assert.equal(client.element("note-editor").open, true);
  body.value = "changed after failure";
  body.dispatch("input");
  host.send(lastMessage(client.messages));
  await settle();
  for (const message of host.transport.splice(0)) {
    client.receive(message);
  }
  assert.equal(current.editor?.error, undefined);
  assert.equal(client.element("editor-error").hidden, true);
  dashboard.dispose();
});

test("cached transport input never crosses folder or session boundaries or revives a closed editor", () => {
  for (const next of [
    state({ editor: editor({ id: "replacement", body: "new session" }) }),
    state({ repoKey: "/other", editor: editor({ repoKey: "/other", body: "new folder" }) }),
    state(),
  ]) {
    const cache: { value?: unknown } = { value: {
      instanceKey: "test-instance",
      input: { repoKey: "/repo", editorId: "editor:0", body: "PRIVATE PENDING", requestId: "pending" },
    } };
    const client = scriptFixture(cache);
    client.update(next);
    assert.notEqual(client.element("editor-body").value, "PRIVATE PENDING");
    assert.equal(cache.value, undefined);
    assert.equal(client.messages.length, 1);
    assert.equal(client.element("note-editor").open, !!next.editor);
  }
  const cache: { value?: unknown } = { value: {
    instanceKey: "previous-instance",
    input: { repoKey: "/repo", editorId: "editor:0", body: "OLD EXTENSION INPUT", requestId: "pending" },
  } };
  const reloaded = scriptFixture(cache);
  reloaded.update(state({ editor: editor({ body: "new extension session" }) }));
  assert.equal(reloaded.element("editor-body").value, "new extension session");
  assert.equal(cache.value, undefined);
});

test("Save rejected across a busy transition unlocks on settlement and resynchronizes without automatically retrying Save", async () => {
  const current = state({ editor: editor({ body: "host" }) });
  const accepted: DashboardAction[] = [];
  const dashboard = new ReviewDashboard(action => { accepted.push(action); });
  const client = scriptFixture();
  const host = viewFixture();
  dashboard.update(current);
  host.resolve(dashboard);
  host.send(client.messages[0]);
  for (const message of host.transport.splice(0)) client.receive(message);

  dashboard.update({ ...current, busy: true });
  client.element("editor-body").value = "unsynchronized submission";
  client.element("save-edit").click();
  host.send(lastMessage(client.messages));
  for (const message of host.transport.splice(0)) client.receive(message);
  assert.deepEqual(accepted, []);
  assert.equal(client.element("editor-body").disabled, true);

  dashboard.update(current);
  for (const message of host.transport.splice(0)) client.receive(message);
  host.send(lastMessage(client.messages));
  await settle();
  assert.deepEqual(accepted, [{ type: "input", repoKey: "/repo", editorId: "editor:0", body: "unsynchronized submission" }]);
  assert.equal(client.element("editor-body").disabled, false);
  assert.equal(client.document.activeElement, client.element("editor-body"));
  dashboard.dispose();
});

test("duplicate Save rejections do not acknowledge an in-flight submission and old session acknowledgements cannot unlock a replacement", async () => {
  let finish: (() => void) | undefined;
  const dashboard = new ReviewDashboard(() => new Promise<void>(resolve => { finish = resolve; }));
  const host = viewFixture();
  dashboard.update(state({ editor: editor() }));
  host.resolve(dashboard);
  host.send({ type: "ready" });
  const save = { type: "saveEdit", repoKey: "/repo", editorId: "editor:0", body: "frozen", requestId: "save" };
  host.send(save);
  host.send(save);
  assert.equal(host.transport.some(message => message.type === "editorSettled"), false);
  assert.ok(finish);
  finish();
  await settle();
  assert.equal(host.transport.filter(message => message.type === "editorSettled").length, 1);
  dashboard.dispose();

  const client = scriptFixture();
  client.update(state({ editor: editor({ id: "replacement" }) }));
  client.element("save-edit").click();
  const requestId = lastMessage(client.messages).requestId;
  assert.ok(requestId, 'Expected a submission request identity');
  client.receive({ type: "editorSettled", repoKey: "/repo", editorId: "editor:0", requestId });
  client.receive({ type: "editorSettled", repoKey: "/other", editorId: "replacement", requestId });
  assert.equal(client.element("editor-body").disabled, true);
  client.receive({ type: "editorSettled", repoKey: "/repo", editorId: "replacement", requestId });
  assert.equal(client.element("editor-body").disabled, false);
});

test("connected A-B-A input keeps the latest request through old state and acknowledgement delivery and recreation", async () => {
  let current = state({ editor: editor({ body: "initial" }) });
  const accepted: DashboardAction[] = [];
  const dashboard = new ReviewDashboard(action => {
    accepted.push(action);
    if (action.type === "input") {
      current = { ...current, editor: editor({ body: action.body }) };
      dashboard.update(current);
    }
  });
  const cache: { value?: unknown } = {};
  const client = scriptFixture(cache);
  const host = viewFixture();
  dashboard.update(current);
  host.resolve(dashboard);
  host.send(client.messages[0]);
  for (const message of host.transport.splice(0)) {
    client.receive(message);
  }

  client.element("editor-body").value = "A";
  client.element("editor-body").dispatch("input");
  const firstA = lastMessage(client.messages);
  host.send(firstA);
  await settle();
  const queuedA = host.transport.splice(0);

  client.element("editor-body").value = "B";
  client.element("editor-body").dispatch("input");
  const inputB = lastMessage(client.messages);
  host.send(inputB);
  await settle();
  const queuedB = host.transport.splice(0);

  dashboard.update({ ...current, busy: true });
  client.element("editor-body").value = "A";
  client.element("editor-body").dispatch("input");
  const latestA = lastMessage(client.messages);
  assert.ok(latestA.requestId);
  assert.ok(firstA.requestId);
  assert.notEqual(latestA.requestId, firstA.requestId);
  host.send(latestA);
  await settle();
  assert.equal(accepted.length, 2, "the latest A is rejected while busy");

  // Neither text equality nor an older request's explicit acknowledgement can
  // clear the latest A, even though all three inputs belong to the same editor.
  for (const message of [...queuedA, ...queuedB, ...host.transport.splice(0)]) {
    client.receive(message);
  }
  assert.equal(client.element("editor-body").value, "A");
  assert.ok(cache.value);

  host.close();
  const replacement = scriptFixture(cache);
  const replacementHost = viewFixture();
  replacementHost.resolve(dashboard);
  replacementHost.send(replacement.messages[0]);
  for (const message of replacementHost.transport.splice(0)) {
    replacement.receive(message);
  }
  assert.equal(replacement.element("editor-body").value, "A");
  assert.equal(replacement.element("editor-body").disabled, true);

  dashboard.update(current);
  for (const message of replacementHost.transport.splice(0)) {
    replacement.receive(message);
  }
  assert.equal(lastMessage(replacement.messages).requestId, latestA.requestId, "resync preserves the unacknowledged request identity");
  replacementHost.send(lastMessage(replacement.messages));
  await settle();
  const acceptedLatest = replacementHost.transport.splice(0);
  for (const message of acceptedLatest) {
    if (message.type === "state") {
      replacement.receive(message);
    }
  }
  assert.ok(cache.value, "even a matching current body is not an acknowledgement");
  for (const message of acceptedLatest) {
    if (message.type === "inputAccepted") {
      replacement.receive(message);
    }
  }
  assert.equal(cache.value, undefined);
  assert.deepEqual(accepted, [
    { type: "input", repoKey: "/repo", editorId: "editor:0", body: "A" },
    { type: "input", repoKey: "/repo", editorId: "editor:0", body: "B" },
    { type: "input", repoKey: "/repo", editorId: "editor:0", body: "A" },
  ], "request tokens never reach the owner");
  dashboard.dispose();
});

test("connected consecutive Saves across recreation ignore delayed settlement from Save1 while Save2 stays frozen", async () => {
  let current = state({ editor: editor({ body: "first submission" }) });
  let finish: (() => void) | undefined;
  const saves: string[] = [];
  const dashboard = new ReviewDashboard(async action => {
    if (action.type === "input") {
      current = { ...current, editor: editor({ body: action.body }) };
      dashboard.update(current);
    }
    if (action.type === "saveEdit") {
      saves.push(action.body);
      current = { ...current, editor: editor({ body: action.body }) };
      await new Promise<void>(resolve => { finish = resolve; });
      if (saves.length === 1) {
        current = { ...current, editor: editor({ body: action.body, error: "Save1 failed" }) };
      } else {
        current = { ...current, editor: undefined };
      }
      dashboard.update(current);
    }
  });
  const cache: { value?: unknown } = {};
  const client = scriptFixture(cache);
  const host = viewFixture();
  dashboard.update(current);
  host.resolve(dashboard);
  host.send(client.messages[0]);
  for (const message of host.transport.splice(0)) {
    client.receive(message);
  }
  client.element("save-edit").click();
  const save1 = lastMessage(client.messages);
  host.send(save1);
  host.close();

  const replacement = scriptFixture(cache);
  const replacementHost = viewFixture();
  replacementHost.resolve(dashboard);
  replacementHost.send(replacement.messages[0]);
  for (const message of replacementHost.transport.splice(0)) {
    replacement.receive(message);
  }
  assert.equal(replacement.element("editor-body").disabled, true);
  assert.equal(replacement.element("editor-body").value, "first submission");
  assert.ok(finish);
  finish();
  await settle();
  const completion1 = replacementHost.transport.splice(0);
  const settlement1 = completion1.find(message => message.type === "editorSettled");
  assert.ok(settlement1);
  for (const message of completion1) {
    if (message.type === "state") {
      replacement.receive(message);
    }
  }
  assert.equal(replacement.element("editor-body").disabled, true, "idle state alone cannot unlock the reconstructed submission");
  replacement.element("save-edit").click();
  assert.deepEqual(replacement.messages.map(message => message.type), ["ready", "editorRequestStatus"]);

  replacement.receive(settlement1);
  replacementHost.send(lastMessage(replacement.messages));
  await settle();
  for (const message of replacementHost.transport.splice(0)) {
    replacement.receive(message);
  }
  replacement.element("editor-body").value = "second submission";
  replacement.element("editor-body").dispatch("input");
  replacementHost.send(lastMessage(replacement.messages));
  await settle();
  for (const message of replacementHost.transport.splice(0)) {
    replacement.receive(message);
  }
  replacement.element("save-edit").click();
  const save2 = lastMessage(replacement.messages);
  assert.ok(save1.requestId);
  assert.ok(save2.requestId);
  assert.notEqual(save1.requestId, save2.requestId);
  replacementHost.send(save2);

  replacement.receive(settlement1);
  assert.equal(replacement.element("editor-body").disabled, true, "delayed Save1 acknowledgement cannot unlock Save2");
  replacement.element("editor-body").value = "late text that must not be accepted";
  replacement.element("editor-body").dispatch("input");
  assert.equal(replacement.element("editor-body").value, "second submission");
  assert.ok(finish);
  finish();
  await settle();
  for (const message of replacementHost.transport.splice(0)) {
    replacement.receive(message);
  }
  assert.deepEqual(saves, ["first submission", "second submission"]);
  assert.equal(replacement.element("note-editor").open, false);
  assert.equal(cache.value, undefined);
  dashboard.dispose();
});

test("provider republishes exact completed submission acknowledgement when the view was absent at completion", async () => {
  let finish: (() => void) | undefined;
  const dashboard = new ReviewDashboard(() => new Promise<void>(resolve => { finish = resolve; }));
  const host = viewFixture();
  const cache: { value?: unknown } = {};
  const client = scriptFixture(cache);
  dashboard.update(state({ editor: editor() }));
  host.resolve(dashboard);
  host.send(client.messages[0]);
  for (const message of host.transport.splice(0)) {
    client.receive(message);
  }
  client.element("save-edit").click();
  const save = lastMessage(client.messages);
  host.send(save);
  host.close();
  assert.ok(finish);
  finish();
  await settle();

  const replacement = scriptFixture(cache);
  const replacementHost = viewFixture();
  replacementHost.resolve(dashboard);
  replacementHost.send(replacement.messages[0]);
  assert.ok(save.requestId);
  assert.deepEqual(replacementHost.transport.at(-1), {
    type: "editorSettled", repoKey: "/repo", editorId: "editor:0", requestId: save.requestId,
  });
  for (const message of replacementHost.transport) {
    replacement.receive(message);
  }
  assert.equal(replacement.element("editor-body").disabled, false);
  dashboard.dispose();
});

test("Cancel acknowledgements require their own request identity across reconstruction", () => {
  const cache: { value?: unknown } = {};
  const client = scriptFixture(cache);
  client.update(state({ editor: editor() }));
  client.element("cancel-edit").click();
  const cancel1 = lastMessage(client.messages);
  assert.ok(cancel1.requestId);
  assert.equal("body" in cancel1, false, "Cancel's exact transport schema does not include editable text");

  const replacement = scriptFixture(cache);
  replacement.update(state({ editor: editor() }));
  assert.equal(replacement.element("editor-body").disabled, true);
  const acknowledgement = {
    type: "editorSettled", repoKey: "/repo", editorId: "editor:0", requestId: cancel1.requestId,
  };
  replacement.receive(acknowledgement);
  assert.equal(replacement.element("editor-body").disabled, false);
  replacement.element("cancel-edit").click();
  const cancel2 = lastMessage(replacement.messages);
  assert.ok(cancel2.requestId);
  assert.notEqual(cancel1.requestId, cancel2.requestId);
  replacement.receive(acknowledgement);
  assert.equal(replacement.element("editor-body").disabled, true);
  replacement.receive({ ...acknowledgement, requestId: cancel2.requestId });
  assert.equal(replacement.element("editor-body").disabled, false);
});

test("provider does not acknowledge rejected or failed owner input as accepted", async (t) => {
  t.mock.method(console, "error", () => {});
  const dashboard = new ReviewDashboard(action => {
    if (action.type === "input" && action.body === "failure") {
      throw new Error("input failed");
    }
  });
  const host = viewFixture();
  dashboard.update(state({ editor: editor({ body: "unchanged" }) }));
  host.resolve(dashboard);
  host.send({ type: "ready" });
  for (const body of ["unchanged", "rejected", "failure"]) {
    host.send({ type: "input", repoKey: "/repo", editorId: "editor:0", body, requestId: body });
    await settle();
  }
  assert.equal(host.transport.some(message => message.type === "inputAccepted"), false);
  dashboard.dispose();
});

test("client validates unknown host envelopes and every consumed state shape before rendering or acknowledging", () => {
  const valid = state({ editor: editor() });
  assert.equal(isDashboardHostMessage({ type: "state", state: valid }), true);
  const invalid: unknown[] = [
    null, [], {}, { type: "unknown" }, { type: "state" },
    { type: "state", state: valid, extra: undefined },
    ...[null, [], {}, { ...valid, extra: undefined }, { ...valid, busy: "false" },
      { ...valid, repoKey: 1 }, { ...valid, commentCount: -1 }, { ...valid, historyVisible: 1 },
      { ...valid, error: {} }, { ...valid, noteError: [] }, { ...valid, filesError: false },
      { ...valid, files: null }, { ...valid, notes: {} }, { ...valid, archives: "bad" },
      ...["files", "notes", "archives"].map(key => ({ ...valid, [key]: [null] })),
      { ...valid, files: [{ id: "file", path: "x", insertions: -1 }] },
      { ...valid, files: [{ id: "file", path: [], deletions: 1 }] },
      { ...valid, notes: [{ ...note(), preview: {} }] },
      { ...valid, notes: [{ ...note(), startLine: 0 }] },
      { ...valid, notes: [{ ...note(), comparison: 1 }] },
      { ...valid, notes: [{ ...generalNote(), path: "invented" }] },
      { ...valid, archives: [{ id: "batch", createdAt: 1, commentCount: 1 }] },
      { ...valid, editor: { ...editor(), body: {} } },
      { ...valid, editor: { ...editor(), repoKey: "/other" } },
      { ...valid, editor: { ...editor(), snapshot: "PRIVATE" } },
    ].map(state => ({ type: "state", state })),
    ...["inputAccepted", "editorSettled"].flatMap(type => [
      { type, repoKey: "/repo", editorId: "editor:0" },
      { type, repoKey: "/repo", editorId: "editor:0", requestId: "" },
      { type, repoKey: "/repo", editorId: "editor:0", requestId: "request", extra: undefined },
    ]),
  ];
  const client = scriptFixture();
  client.update(valid);
  for (const message of invalid) {
    assert.equal(isDashboardHostMessage(message), false);
    assert.doesNotThrow(() => client.receive(message));
  }
  assert.equal(client.element("editor-body").value, valid.editor?.body);
  assert.equal(client.element("note-editor").open, true);
  assert.equal(client.messages.length, 1);
});

test("archives are discoverable only through More actions, with keyboard opening, closing and scope resets", () => {
  const { element, document, messages, update, showArchives } = scriptFixture();
  const empty = state({ hasFeedback: false, notes: [] });
  update(empty);
  assert.equal(element("history").hidden, true);
  assert.equal(element("more-menu").hidden, true);
  assert.equal(element("more").attributes.get("aria-label"), "More actions");
  element("show-archives").click();
  element("archives").children[0].children[1].click();
  assert.equal(element("history").hidden, true);
  assert.equal(messages.length, 1);
  assert.equal(element("more").dispatch("keydown", "ArrowDown"), true);
  assert.equal(element("more-menu").hidden, false);
  assert.equal(element("more").attributes.get("aria-expanded"), "true");
  assert.equal(document.activeElement, element("show-archives"));
  assert.equal(element("more-menu").dispatch("keydown", "End"), true);
  assert.equal(document.root.dispatch("keydown", "Escape"), true);
  assert.equal(element("more-menu").hidden, true);
  assert.equal(document.activeElement, element("more"));
  showArchives();
  assert.deepEqual({ ...lastMessage(messages) }, { type: "openHistory", repoKey: "/repo" });
  assert.equal(element("history").hidden, true, "opening waits for host acknowledgement");
  update({ ...empty, historyVisible: true });
  assert.equal(element("history").hidden, false);
  assert.equal(element("more-menu").hidden, true);
  assert.equal(document.activeElement, element("close-history"));
  update({ ...empty, historyVisible: true });
  assert.equal(element("history").hidden, false, "ordinary refresh retains explicit history visibility");
  element("close-history").click();
  assert.deepEqual({ ...lastMessage(messages) }, { type: "closeHistory", repoKey: "/repo" });
  assert.equal(element("history").hidden, false, "closing waits for host acknowledgement");
  update(empty);
  assert.equal(element("history").hidden, true);
  assert.equal(document.activeElement, element("more"));
  showArchives();
  update({ ...empty, historyVisible: true });
  assert.equal(document.root.dispatch("keydown", "Escape"), true);
  assert.deepEqual({ ...lastMessage(messages) }, { type: "closeHistory", repoKey: "/repo" });
  assert.equal(element("history").hidden, false);
  update(empty);
  assert.equal(element("history").hidden, true);
  showArchives();
  update({ ...empty, historyVisible: true });
  update(state({ hasFeedback: true, notes: [], commentCount: 0 }));
  assert.equal(element("history").hidden, true, "meaningful raw feedback blocks history even with zero parsed notes");
  showArchives();
  assert.equal(element("show-archives").disabled, false);
  assert.equal(element("show-archives").attributes.get("aria-disabled"), "true");
  assert.equal(element("history").hidden, true);
  document.root.dispatch("keydown", "Escape");
  update(empty);
  assert.equal(element("history").hidden, true);
  showArchives();
  update({ ...empty, historyVisible: true });
  update({ ...empty, repoKey: "/other" });
  assert.equal(element("history").hidden, true);
  showArchives();
  update({ ...empty, repoKey: "/other", historyVisible: true });
  update({ ...empty, repoKey: "/other", editor: editor({ repoKey: "/other" }) });
  assert.equal(element("history").hidden, true);
  assert.equal(element("more").disabled, true);
  assert.deepEqual(messages.slice(1).map(message => ({ ...message })), [
    { type: "openHistory", repoKey: "/repo" }, { type: "closeHistory", repoKey: "/repo" },
    { type: "openHistory", repoKey: "/repo" }, { type: "closeHistory", repoKey: "/repo" },
    { type: "openHistory", repoKey: "/repo" }, { type: "openHistory", repoKey: "/repo" },
    { type: "openHistory", repoKey: "/other" },
  ]);
});

for (const activation of ["click", "Enter", " "]) test(`unavailable archives explain meaningful zero-note feedback on ${activation === " " ? "Space" : activation} without sending an action`, () => {
  const { element, document, messages, update } = scriptFixture();
  const current = state({ hasFeedback: true, notes: [], commentCount: 0, noteError: "Malformed synthetic metadata" });
  const snapshot = JSON.stringify(current);
  const unavailable = element("archive-unavailable");
  const archives = element("show-archives");
  update(current);
  assert.equal(unavailable.hidden, true);
  assert.equal(unavailable.attributes.get("role"), "status");
  assert.equal(archives.disabled, false, "unavailable is not natively disabled, so its explanation is reachable");
  assert.equal(archives.attributes.get("aria-disabled"), "true");
  assert.equal(archives.attributes.get("role"), "menuitem");
  assert.equal(element("more").dispatch("keydown", "ArrowDown"), true);
  assert.equal(document.activeElement, archives);
  assert.equal(element("more-menu").hidden, false);
  if (activation === "click") archives.click();
  else { archives.dispatch("keydown", activation); archives.dispatch("keyup", activation); }
  assert.equal(element("more-menu").hidden, true);
  assert.equal(element("more").attributes.get("aria-expanded"), "false");
  assert.equal(document.activeElement, element("more"));
  assert.equal(unavailable.hidden, false);
  assert.equal(unavailable.textContent, "Recent Archives are available when there are no current saved Review Notes. Finish your review, then use Copy Review Notes & Clear to view or recover an earlier batch.");
  assert.equal(unavailable.children.length, 0);
  assert.equal(element("history").hidden, true);
  assert.equal(element("copy").hidden, false);
  assert.equal(element("copy").disabled, false);
  assert.equal(JSON.stringify(current), snapshot, "explaining availability must not mutate feedback or archive metadata");
  assert.deepEqual(messages.map(message => message.type), ["ready"], "no history, recovery, copy or feedback mutation action");
  update(current);
  assert.equal(unavailable.hidden, false, "ordinary refresh retains the explanation");
  for (const reset of [{ ...current, hasFeedback: false }, { ...current, repoKey: "/other" }, { ...current, repoKey: undefined }]) {
    update(reset);
    assert.equal(unavailable.hidden, true);
    assert.equal(unavailable.textContent, "", "hiding clears the live status text");
    assert.equal(element("history").hidden, true);
    if (!reset.hasFeedback) assert.equal(archives.attributes.get("aria-disabled"), "false");
    update(current);
    assert.equal(unavailable.hidden, true, "returning to feedback or the old scope must not revive the explanation");
    element("more").click(); archives.click();
    assert.equal(unavailable.hidden, false);
  }
  assert.equal(messages.length, 1);
});

test("reconstructed webviews display only host-authorized history and block busy open, close and recovery", () => {
  const { element, document, messages, update } = scriptFixture();
  const current = state({ hasFeedback: false, historyVisible: true, notes: [] });
  update(current);
  assert.equal(element("history").hidden, false, "a fresh webview restores provider-held visibility without a local toggle");
  assert.equal(document.activeElement, element("close-history"));
  const recover = element("archives").children[0].children[1];
  update({ ...current, busy: true });
  assert.equal(element("history").hidden, false);
  assert.equal(element("close-history").disabled, true);
  assert.equal(recover.disabled, true);
  element("close-history").invokeListener("click");
  element("show-archives").invokeListener("click");
  recover.invokeListener("click");
  document.root.dispatch("keydown", "Escape");
  assert.equal(messages.length, 1);
  update(current);
  element("close-history").click();
  assert.deepEqual({ ...lastMessage(messages) }, { type: "closeHistory", repoKey: "/repo" });
  assert.equal(element("history").hidden, false);
  update({ ...current, historyVisible: false });
  assert.equal(element("history").hidden, true);
  recover.invokeListener("click");
  assert.equal(messages.length, 2);
  for (const overrides of [{ hasFeedback: true }, { repoKey: undefined }, { editor: editor() }]) {
    update({ ...current, ...overrides });
    assert.equal(element("history").hidden, true);
    element("close-history").invokeListener("click");
    element("show-archives").invokeListener("click");
    assert.equal(messages.length, 2);
  }
});

test("general cards edit rather than navigate and toolbar opens an explicit general session", () => {
  const { element, messages, update } = scriptFixture();
  update(state({ notes: [generalNote()] }));
  const [open, edit, remove] = element("notes").children[0].children;
  assert.equal(open.children[0].textContent, "General Review Note");
  assert.equal(open.title, "Edit Review Note: General Review Note");
  assert.equal(edit.title, "Edit Review Note");
  assert.equal(edit.attributes.get("aria-label"), "Edit Review Note");
  assert.equal(remove.title, "Delete Review Note");
  assert.equal(remove.attributes.get("aria-label"), "Delete Review Note");
  open.click();
  edit.click();
  element("add-general").click();
  assert.deepEqual(messages.slice(1).map(message => ({ ...message })), [
    { type: "edit", repoKey: "/repo", noteId: "projection:0" },
    { type: "edit", repoKey: "/repo", noteId: "projection:0" },
    { type: "addGeneral", repoKey: "/repo" },
  ]);
  update(state({ hasFeedback: false, editor: editor({ title: "Add General Review Note", body: "" }) }));
  assert.equal(element("note-editor").open, true);
  assert.equal(element("editor-title").textContent, "Add General Review Note");
  assert.equal(element("save-edit").disabled, true);
  const count = messages.length;
  for (const id of ["add-general", "more", "copy", "show-archives"]) {
    element(id).invokeListener("click");
  }
  assert.equal(messages.length, count);
});

test("modal preserves arbitrary text and cursor on refresh, displays errors as text, and restores its live invoker after host closure", () => {
  const { element, document, messages, update, receive } = scriptFixture();
  const current = state();
  update(current);
  const edit = element("notes").children[0].children[1];
  edit.focus();
  edit.click();
  const unsafe = '<script>alert("no")</script>\nsecond\nthird' + "x".repeat(1000);
  const session = editor({ body: unsafe, title: unsafe });
  update({ ...current, editor: session, busy: true });
  const dialog = element("note-editor");
  const body = element("editor-body");
  assert.equal(dialog.open, true);
  assert.equal(dialog.showModalCalls, 1);
  assert.equal(body.value, unsafe);
  assert.equal(element("editor-title").textContent, unsafe);
  assert.equal(element("editor-title").children.length, 0);
  update({ ...current, editor: session });
  assert.equal(document.activeElement, body, "focus waits until the opening action releases busy state");
  body.value = "  changed\n## heading\n```\n" + "a".repeat(2000);
  body.selectionStart = 3;
  body.selectionEnd = 9;
  body.dispatch("input");
  const input = lastMessage(messages);
  assert.ok(input.requestId);
  assert.deepEqual({ ...input }, { type: "input", repoKey: "/repo", editorId: session.id, body: body.value, requestId: input.requestId });
  const typed = body.value;
  update({ ...current, notes: [], hasFeedback: false, editor: { ...session, body: "older host echo", error: unsafe } });
  assert.equal(body.value, typed);
  assert.equal(body.selectionStart, 3);
  assert.equal(body.selectionEnd, 9);
  assert.equal(document.activeElement, body);
  assert.equal(dialog.showModalCalls, 1);
  assert.equal(element("editor-error").textContent, unsafe);
  assert.equal(element("editor-error").children.length, 0);
  assert.equal(element("editor-error").hidden, false);
  element("save-edit").click();
  const save = lastMessage(messages);
  assert.ok(save.requestId);
  assert.deepEqual({ ...save }, { type: "saveEdit", repoKey: "/repo", editorId: session.id, body: typed, requestId: save.requestId });
  assert.equal(dialog.open, true, "save does not close until the host removes the session");
  update({ ...current, editor: { ...session, error: "Save failed" } });
  receive({ type: "editorSettled", repoKey: session.repoKey, editorId: session.id, requestId: save.requestId });
  assert.equal(body.value, typed);
  assert.equal(dialog.open, true);
  body.value = " \n\t";
  body.dispatch("input");
  assert.equal(element("save-edit").disabled, true);
  const count = messages.length;
  element("save-edit").invokeListener("click");
  assert.equal(messages.length, count, "empty saves are blocked even with direct handler invocation");
  assert.equal(dialog.dispatch("cancel"), true);
  const cancel = lastMessage(messages);
  assert.ok(cancel.requestId);
  assert.deepEqual({ ...cancel }, { type: "cancelEdit", repoKey: "/repo", editorId: session.id, requestId: cancel.requestId });
  assert.equal(dialog.open, true, "native Escape is prevented pending host cancellation");
  update(current);
  assert.equal(dialog.open, false);
  assert.equal(body.value, "");
  assert.notEqual(document.activeElement, edit, "a removed/reintroduced card cannot regain old focus");

  const liveEdit = element("notes").children[0].children[1];
  liveEdit.click();
  update({ ...current, editor: editor({ id: "next" }) });
  element("save-edit").click();
  update({ ...current, busy: true });
  assert.equal(dialog.open, false);
  update(current);
  assert.equal(document.activeElement, liveEdit, "focus restoration waits for the saving busy guard to release");
});

test("successful modal save with replacement card handles restores toolbar focus after busy clears", () => {
  const { element, document, messages, update } = scriptFixture();
  const current = state();
  update(current);
  const oldCard = element("notes").children[0];
  const invoker = oldCard.children[1];
  invoker.focus();
  invoker.click();
  const session = editor();
  update({ ...current, editor: session });
  const body = element("editor-body");
  body.value = "Saved replacement body";
  body.dispatch("input");
  element("save-edit").focus();
  element("save-edit").click();
  const save = lastMessage(messages);
  assert.ok(save.requestId);
  assert.deepEqual({ ...save }, {
    type: "saveEdit", repoKey: "/repo", editorId: session.id, body: body.value, requestId: save.requestId,
  });
  update({ ...current, editor: { ...session, body: body.value }, busy: true });
  assert.equal(element("note-editor").open, true);

  const saved = state({ notes: current.notes.map((note, index) => ({
    ...note, id: `saved-snapshot:${index}`, ...(index === 0 ? { preview: body.value } : {}),
  })) });
  update({ ...saved, busy: true });
  const toolbar = element("add-general");
  assert.equal(element("note-editor").open, false);
  assert.equal(oldCard.isConnected, false);
  assert.equal(invoker.isConnected, false);
  assert.notEqual(element("notes").children[0], oldCard);
  assert.equal(toolbar.disabled, true);
  assert.notEqual(document.activeElement, toolbar, "fallback focus must wait for the saving busy guard");

  update(saved);
  assert.equal(toolbar.disabled, false);
  assert.equal(document.activeElement, toolbar, "detached card invokers fall back to Add General Review Note");
  assert.notEqual(document.activeElement, element("notes").children[0].children[1], "replacement handles must not retarget focus to another card");
});

test("modal cancel buttons, busy guards, new session initialization and cross-folder focus safety", () => {
  const { element, document, messages, update } = scriptFixture();
  const current = state();
  update(current);
  element("add-general").click();
  update({ ...current, editor: editor() });
  for (const id of ["cancel-edit", "close-editor"]) {
    element(id).click();
    const cancel = lastMessage(messages);
    assert.ok(cancel.requestId);
    assert.deepEqual({ ...cancel }, { type: "cancelEdit", repoKey: "/repo", editorId: "editor:0", requestId: cancel.requestId });
    assert.equal(element("note-editor").open, true);
  }
  update({ ...current, busy: true, editor: editor() });
  const count = messages.length;
  for (const id of ["cancel-edit", "close-editor", "save-edit"]) {
    assert.equal(element(id).disabled, true);
    element(id).invokeListener("click");
  }
  element("editor-body").dispatch("input");
  assert.equal(element("note-editor").dispatch("cancel"), true);
  for (const row of [...element("files").children, ...element("notes").children]) {
    for (const button of row.children.filter(child => child.tagName === 'button')) {
      assert.equal(button.disabled, true);
      button.invokeListener("click");
    }
  }
  assert.equal(messages.length, count);
  update({ ...current, editor: editor({ id: "replacement", body: "new text" }) });
  assert.equal(element("editor-body").value, "new text");
  assert.equal(document.activeElement, element("editor-body"));
  assert.equal(element("note-editor").showModalCalls, 1);
  update({ ...current, repoKey: "/other" });
  assert.equal(element("note-editor").open, false);
  assert.notEqual(document.activeElement, element("add-general"));
  element("cancel-edit").invokeListener("click");
  assert.equal(messages.length, count);
  update(current);
  element("add-general").click();
  update({ ...current, editor: editor({ id: "general", body: "" }) });
  element("cancel-edit").click();
  update(current);
  assert.equal(document.activeElement, element("add-general"));
});

test("webview script safely updates text, dates, buttons and archive nodes without replacing the shell", () => {
  const { elements, element, messages, update, showArchives } = scriptFixture();
  const unsafe = '</script><img src=x onerror="bad">';
  const current = state({ error: unsafe, noteError: unsafe });
  update(current);
  assert.equal(elements.has("repository"), false);
  assert.equal(elements.has("select-repository"), false);
  assert.equal([...elements.values()].some((node) => node.tagName === "h1"), false);
  assert.equal(element("error").textContent, unsafe);
  assert.equal(element("note-error").textContent, unsafe);
  assert.equal(element("note-error").hidden, false);
  assert.equal(element("error").children.length, 0);
  assert.equal(element("note-error").children.length, 0);
  assert.equal(element("count").textContent, "2 review notes");
  assert.equal(element("copy").hidden, false);
  assert.equal(elements.has("explanation"), false);
  assert.equal(element("copy").disabled, false);
  assert.equal(element("history").hidden, true);
  element("copy").click();
  assert.deepEqual({ ...lastMessage(messages) }, { type: "copy", repoKey: "/repo" });

  const empty = state({ hasFeedback: false, commentCount: 0, notes: [] });
  update(empty);
  assert.equal(element("copy").disabled, true);
  assert.equal(element("copy").hidden, true);
  assert.equal(element("history").hidden, true);
  showArchives();
  update({ ...empty, historyVisible: true });
  assert.equal(element("history").hidden, false);
  assert.equal(element("error").hidden, true);
  assert.equal(element("note-error").hidden, true);
  assert.equal(element("note-error").textContent, "");
  const row = element("archives").children[0];
  const date = row.children[0].children[0];
  const recover = row.children[1];
  assert.equal(date.tagName, "time");
  assert.equal(date.dateTime, new Date(empty.archives[0].createdAt).toISOString());
  assert.equal(date.textContent, new Date(empty.archives[0].createdAt).toLocaleString());
  assert.equal(row.children[0].children[1].textContent, "3 review notes");
  assert.equal(recover.textContent, "Recover");
  recover.click();
  assert.deepEqual({ ...lastMessage(messages) }, { type: "restore", repoKey: "/repo", archiveId: "batch" });
  update({ ...empty, historyVisible: true, busy: true });
  assert.equal(element("archives").children[0], row);
  assert.equal(row.children[1], recover);
  assert.equal(recover.disabled, true);
  recover.click();
  assert.equal(messages.length, 4);
  assert.equal(element("dashboard").attributes.get("aria-busy"), "true");
  update(state({ commentCount: 1, busy: true }));
  assert.equal(element("count").textContent, "1 review note");
  assert.equal(element("copy").hidden, false);
  assert.equal(element("copy").disabled, true);
  element("copy").click();
  assert.equal(messages.length, 4);
  update(state({ commentCount: 0, hasFeedback: true, notes: [] }));
  assert.equal(element("copy").hidden, false, "raw notes must remain exportable without parsed blocks");
  assert.equal(element("copy").disabled, false);
  assert.equal(element("history").hidden, true);
  assert.equal(element("notes").children.length, 0);
  update({ ...empty, archives: Array.from({ length: 12 }, (_, index) => ({
    id: unsafe + index, createdAt: "invalid", commentCount: 1,
  })) });
  assert.equal(element("archives").children.length, 10);
  assert.equal(element("archives").children[0].children[0].children[0].textContent, "Unknown date");
  for (const count of [0, 1]) {
    update({ ...empty, archives: [{ ...empty.archives[0], commentCount: count }] });
    assert.equal(element("archives").children[0].children[0].children[1].textContent,
      count === 1 ? "1 review note" : "0 review notes");
  }
  update({ ...empty, archives: [] });
  assert.equal(element("no-archives").hidden, false);
  update({ ...empty, repoKey: undefined });
  assert.equal(element("archives").children.length, 0);
  assert.equal(element("history").hidden, true);
  assert.equal(element("empty").hidden, false);
  assert.equal(element("empty").textContent, "Open a local project folder in VS Code to start reviewing.");
  assert.equal(element("copy").disabled, true);
  assert.equal(element("copy").hidden, true);
  element("copy").click();
  assert.deepEqual(messages.map((message) => message.type), ["ready", "copy", "openHistory", "restore"]);
});

test("busy transitions reuse keyed rows and all descendants while disabling controls and rejecting clicks", () => {
  const { element, messages, update } = scriptFixture();
  const current = state();
  update(current);
  const nodes: Array<{ node: Element; children: Element[] }> = [];
  const capture = (node: Element) => {
    nodes.push({ node, children: [...node.children] });
    node.children.forEach(capture);
  };
  capture(element("dashboard"));
  const controls = [element("copy"), element("add-general"), element("more"), element("show-archives"),
    ...element("files").children.flatMap(row => row.children.filter(child => child.tagName === 'button')),
    ...element("notes").children.flatMap(row => row.children)];
  for (const busy of [true, false, true, false]) {
    update({ ...current, busy });
    assert.equal(element("dashboard").attributes.get("aria-busy"), String(busy));
    for (const { node, children } of nodes) {
      assert.equal(node.isConnected, true);
      assert.equal(node.children.length, children.length);
      children.forEach((child, index) => assert.equal(node.children[index], child, "busy changes must not replace keyed rows, controls or icons"));
    }
    for (const control of controls) {
      assert.equal(control.disabled, busy);
      if (busy) {
        control.click();
        control.invokeListener("click");
      }
    }
    assert.equal(messages.length, 1, "both native-disabled clicks and direct handler calls are rejected while busy");
    assert.equal(element("archive-unavailable").hidden, true);
    assert.equal(element("history").hidden, true);
  }
  element("files").children[0].children[2].click();
  assert.deepEqual({ ...lastMessage(messages) }, { type: "stageFile", repoKey: "/repo", fileId: "files:0" });
});

test("file heading counts confirmed candidates and visible/pending metadata updates only the targeted keyed row", () => {
  const client = scriptFixture();
  const files: DashboardState['files'] = [{ id: 'a', path: 'a', visible: true }, { id: 'b', path: 'b' }];
  client.update(state({ files }));
  assert.equal(client.element('files-title').textContent, 'Files to Review (2)');
  const [first, second] = client.element('files').children;
  const fileLabel = first.children[0].children[0];
  const eye = fileLabel.children[0];
  assert.equal(fileLabel.className, 'file-label');
  assert.equal(fileLabel.children[1].className, 'file-name', 'eye precedes the filename inside a shared nonwrapping label');
  assert.equal(first.className, 'file-row file-in-editor');
  assert.equal(eye.tagName, 'span');
  assert.equal(eye.title, 'Visible in editor');
  assert.equal(eye.attributes.get('aria-hidden'), 'true');
  assert.equal(eye.hidden, false);
  assert.equal(eye.listeners.size, 0);
  assert.match(first.children[0].attributes.get('aria-label') || '', /Visible in editor/);
  assert.equal(second.children[0].children[0].children[0].hidden, true);
  for (const pending of ['stage', 'revert'] as const) {
    client.update(state({ files: [{ ...files[0], pending }, files[1]], busy: true }));
    assert.equal(client.element('files').children[0], first);
    assert.equal(first.className, 'file-row file-in-editor file-pending');
    assert.equal(first.attributes.get('aria-busy'), 'true');
    assert.equal(first.children[3].attributes.get('role'), 'status');
    assert.equal(first.children[3].hidden, false);
    assert.equal(first.children[3].textContent, pending === 'stage' ? 'Staging file' : 'Reverting file');
    assert.equal(second.className, 'file-row');
    assert.equal(second.children[3].hidden, true);
    for (const row of [first, second]) {
      for (const button of row.children.slice(0, 3)) {
        assert.equal(button.disabled, true);
        button.invokeListener('click');
      }
    }
    client.update(state({ files: [{ ...files[0], pending }, files[1]] }));
    first.children[0].invokeListener('click');
    assert.equal(first.children[0].disabled, true, 'pending row is read-only independently of global busy');
    assert.equal(second.children[0].disabled, false);
    assert.equal(client.messages.length, 1);
  }
  client.update(state({ files: [{ ...files[0], visible: false }, files[1]] }));
  assert.equal(first.className, 'file-row');
  assert.equal(first.children[3].hidden, true);
  assert.equal(eye.hidden, true);
  assert.doesNotMatch(first.children[0].attributes.get('aria-label') || '', /Visible in editor/);
  assert.equal(first.children[0].disabled, false);
  client.update(state({ files: [] }));
  assert.equal(client.element('files-title').textContent, 'Files to Review (0)');
});

test("confirmed removals collapse actual row boxes, stay inert and clean up on animation settlement", async () => {
  const client = scriptFixture();
  client.setReducedMotion(false);
  client.update(state());
  const row = client.element('files').children[0];
  row.height = 93;
  row.children[2].click();
  assert.equal(row.animations.length, 0, 'a click is not confirmed removal');
  client.update(state({ busy: true, files: [{ ...state().files[0], pending: 'stage' }] }));
  assert.equal(row.animations.length, 0, 'pending is not confirmed removal');
  client.update(state({ files: [] }));
  assert.equal(row.isConnected, true);
  assert.equal(row.inert, true);
  assert.equal(row.attributes.get('aria-hidden'), 'true');
  assert.equal(client.element('files-title').textContent, 'Files to Review (0)');
  assert.equal(client.element('no-files').hidden, false);
  for (const button of row.children.slice(0, 3)) {
    assert.equal(button.disabled, true);
    button.invokeListener('click');
  }
  assert.equal(client.messages.length, 2, 'exiting handles have no candidate membership');
  const animation = row.animations[0];
  assert.deepEqual({ ...animation.options }, { duration: 160, easing: 'ease-out', fill: 'forwards' });
  assert.deepEqual({ ...animation.frames[0] }, {
    height: '93px', opacity: 1, paddingTop: '10px', paddingBottom: '10px', marginTop: '0px', marginBottom: '0px',
    borderTopWidth: '0px', borderBottomWidth: '1px',
  });
  assert.deepEqual({ ...animation.frames[1] }, {
    height: '0px', opacity: 0, paddingTop: '0px', paddingBottom: '0px', marginTop: '0px', marginBottom: '0px',
    borderTopWidth: '0px', borderBottomWidth: '0px',
  });
  client.update(state({ files: [] }));
  assert.equal(row.animations.length, 1, 'refresh must not restart an exit');
  animation.finish();
  await Promise.resolve();
  assert.equal(row.isConnected, false);
  assert.equal(animation.cancelled, true);
  assert.equal(client.element('files').children.length, 0);
});

test("concurrent exits survive reorder, reappearing rows cancel and reuse, and old settlements cannot remove new rows", async () => {
  const client = scriptFixture();
  client.setReducedMotion(false);
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(id => ({ id, path: id }));
  client.update(state({ files: [a, b, c, d] }));
  const [rowA, rowB, rowC, rowD] = client.element('files').children;
  client.update(state({ files: [a, c] }));
  assert.deepEqual(client.element('files').children, [rowA, rowB, rowC, rowD], 'exits keep their layout positions');
  client.update(state({ files: [c, a, b] }));
  assert.equal(rowB.animations[0].cancelled, true);
  assert.equal(rowB.inert, false);
  assert.equal(rowB.attributes.has('aria-hidden'), false);
  assert.equal(rowB.children[0].disabled, false);
  assert.deepEqual(client.element('files').children.filter(row => !row.inert), [rowC, rowA, rowB]);
  assert.equal(client.element('files-title').textContent, 'Files to Review (3)');
  client.update(state({ files: [c, a] }));
  assert.equal(rowB.animations.length, 2);
  await Promise.resolve();
  assert.equal(rowB.isConnected, true, 'cancelled first animation cannot clean up the second exit');
  rowD.animations[0].finish();
  await Promise.resolve();
  assert.equal(rowD.isConnected, false);
  assert.equal(rowB.isConnected, true);
  rowB.animations[1].cancel();
  await Promise.resolve();
  assert.equal(rowB.isConnected, false, 'external cancellation cleans up without an unhandled rejection');
  assert.deepEqual(client.element('files').children, [rowC, rowA]);
});

test("folder changes and reduced motion immediately clear exits and never animate across scopes", async () => {
  const client = scriptFixture();
  client.setReducedMotion(false);
  client.update(state());
  const old = client.element('files').children[0];
  client.update(state({ files: [] }));
  client.update(state({ repoKey: '/other' }));
  const replacement = client.element('files').children[0];
  assert.notEqual(old, replacement);
  assert.equal(old.isConnected, false);
  assert.equal(old.animations[0].cancelled, true);
  await Promise.resolve();
  assert.equal(replacement.isConnected, true);
  client.update(state({ repoKey: '/other', files: [] }));
  client.setReducedMotion(true);
  assert.equal(replacement.isConnected, false);
  assert.equal(replacement.animations[0].cancelled, true);
  client.update(state());
  const reduced = client.element('files').children[0];
  client.update(state({ files: [] }));
  assert.equal(reduced.isConnected, false);
  assert.equal(reduced.animations.length, 0);
  client.setReducedMotion(false);
  client.update(state());
  const noFolder = client.element('files').children[0];
  client.update(state({ repoKey: undefined }));
  assert.equal(noFolder.isConnected, false);
  assert.equal(noFolder.animations.length, 0);
  assert.equal(client.element('files-title').textContent, 'Files to Review (0)');
  await Promise.resolve();
});

test("files without feedback render text-only stats and sibling accessible revert/stage icons without optimistic removal", () => {
  const { element, document, messages, update } = scriptFixture();
  const unsafe = '<img src=x onerror="bad">';
  const files = [
    { id: "known", path: `src/${unsafe}.ts`, insertions: 2, deletions: 1 },
    { id: "unknown", path: "assets/image.png" },
    { id: "partial", path: "partial.ts", insertions: 0 },
  ];
  const current = state({ hasFeedback: false, notes: [], commentCount: 0, files, filesError: unsafe });
  update(current);
  assert.equal(element("copy").hidden, true);
  assert.equal(element("history").hidden, true);
  assert.equal(element("notes").children.length, 0);
  assert.equal(element("files-section").hidden, false);
  assert.equal(element("no-files").hidden, true);
  assert.equal(element("files-error").textContent, unsafe);
  assert.equal(element("files-error").hidden, false);
  assert.equal(element("files-error").children.length, 0);
  const order = element("dashboard").children;
  assert.equal(order.indexOf(element("files-section")), order.indexOf(element("copy")) + 1);
  assert.equal(order.indexOf(element("count")), order.indexOf(element("files-section")) + 1);
  assert.ok(order.indexOf(element("count")) < order.indexOf(element("notes")));
  const rows = element("files").children;
  assert.equal(rows.length, 3);
  for (const [index, row] of rows.entries()) {
    assert.equal(row.className, "file-row");
    assert.deepEqual(row.children.map(node => [node.tagName, node.className, node.type]), [
      ["button", "file-open", "button"], ["button", "file-action file-revert", "button"],
      ["button", "file-action file-stage", "button"],
      ["span", "file-progress", ""],
    ]);
    const [open, revert, stage] = row.children;
    assert.equal(open.title, files[index].path);
    const filename = open.children[0].children[1];
    for (const child of [filename, ...open.children.slice(1)]) {
      assert.equal(child.children.length, 0, "metadata stays text-only");
    }
    for (const [button, action, label] of [[revert, "revert", "Revert File"], [stage, "stage", "Stage File"]] as const) {
      const template = element(`${action}-icon`).content;
      assert.ok(template);
      const templateSvg = template.children[0];
      assert.equal(button.title, label);
      assert.equal(button.attributes.get("aria-label"), label);
      assert.equal(button.textContent, "", `${action} is icon-only`);
      assert.equal(button.hidden, false, "opacity must not remove the button from keyboard navigation");
      assert.equal(button.disabled, false);
      assert.equal(button.attributes.has("tabindex"), false, "native buttons stay in the tab order");
      assert.equal(button.children.length, 1);
      const svg = button.children[0];
      assert.equal(svg.tagName, "svg");
      assert.notEqual(svg, templateSvg);
      assert.deepEqual(svg.attributes, templateSvg.attributes);
      assert.equal(svg.attributes.get("aria-hidden"), "true");
      assert.equal(svg.attributes.get("focusable"), "false");
      assert.equal(svg.children.length, 1);
      assert.equal(svg.children[0].tagName, "path");
      assert.notEqual(svg.children[0], templateSvg.children[0]);
      assert.deepEqual(svg.children[0].attributes, templateSvg.children[0].attributes);
      if (index > 0) assert.notEqual(svg, rows[0].children[action === "revert" ? 1 : 2].children[0]);
      button.focus();
      assert.equal(document.activeElement, button);
      for (const target of [button, svg.children[0]]) {
        const before = messages.length;
        target.click();
        assert.deepEqual(messages.slice(before).map(message => ({ ...message })), [
          { type: `${action}File`, repoKey: "/repo", fileId: files[index].id },
        ], `${action} clicks, including its SVG, must emit only that action without navigation`);
        assert.equal(element("files").children[index], row, "wait for host state before removing candidates");
      }
    }
    open.click();
    assert.deepEqual({ ...lastMessage(messages) }, { type: "openFile", repoKey: "/repo", fileId: files[index].id });
  }
  const known = rows[0].children[0];
  assert.equal(known.children[0].children[1].textContent, `${unsafe}.ts`);
  assert.equal(known.children[1].textContent, "+2");
  assert.equal(known.children[1].className, "file-insertions");
  assert.equal(known.children[2].textContent, "-1");
  assert.equal(known.children[2].className, "file-deletions");
  assert.equal(known.children[3].hidden, true);
  assert.equal(known.attributes.get("aria-label"), `Open file: src/${unsafe}.ts, 2 insertions, 1 deletion`);
  const unknown = rows[1].children[0];
  assert.equal(unknown.children[1].hidden, true);
  assert.equal(unknown.children[2].hidden, true);
  assert.equal(unknown.children[3].hidden, false);
  assert.equal(unknown.children[3].textContent, "Stats unavailable");
  assert.equal(unknown.attributes.get("aria-label"), "Open file: assets/image.png, Stats unavailable");
  const partial = rows[2].children[0];
  assert.equal(partial.children[1].textContent, "+0");
  assert.equal(partial.children[1].hidden, false);
  assert.equal(partial.children[2].hidden, true);
  assert.equal(partial.children[3].hidden, false);
  update({ ...current, busy: true });
  for (const row of rows) {
    assert.equal(row.isConnected, true);
    for (const button of row.children.filter(child => child.tagName === 'button')) {
      assert.equal(button.disabled, true);
      button.click();
      button.invokeListener("click");
    }
  }
  assert.equal(messages.length, 16);
  update({ ...current, filesError: "File action failed" });
  assert.equal(element("files-error").textContent, "File action failed");
  assert.equal(element("files").children.length, 3);
  assert.equal(element("files").children[0], rows[0]);
  for (const button of rows[0].children.filter(child => child.tagName === 'button')) assert.equal(button.disabled, false, "actions can be retried after busy clears");
  update({ ...current, files: [], filesError: undefined });
  assert.equal(element("files-section").hidden, false);
  assert.equal(element("files").children.length, 0);
  assert.equal(element("no-files").hidden, false);
  assert.equal(element("files-error").hidden, true);
  update({ ...current, repoKey: undefined });
  assert.equal(element("files-section").hidden, true);
  assert.equal(element("files").children.length, 0);
});

for (const [buttonIndex, type] of ["openFile", "revertFile", "stageFile"].entries()) test(`keyed file rows preserve ${type} focus and reject detached or cross-folder clicks`, () => {
  const { element, document, messages, update } = scriptFixture();
  const first = { id: "first", path: "src/first.ts", insertions: 1, deletions: 0 };
  const second = { id: "second", path: "src/second.ts" };
  const current = state({ files: [first, second], hasFeedback: false });
  update(current);
  const [firstRow, secondRow] = element("files").children;
  const open = firstRow.children[0];
  const button = firstRow.children[buttonIndex];
  button.focus();
  update(current);
  assert.equal(element("files").children[0], firstRow);
  assert.equal(firstRow.children[buttonIndex], button);
  assert.equal(document.activeElement, button);
  const changed = { id: first.id, path: "renamed.ts" };
  update({ ...current, files: [second, changed] });
  assert.deepEqual(element("files").children, [secondRow, firstRow]);
  assert.equal(document.activeElement, button);
  assert.equal(open.title, "renamed.ts");
  assert.equal(open.children[0].children[1].textContent, "renamed.ts");
  assert.equal(open.children[1].textContent, "");
  assert.equal(open.children[1].hidden, true);
  assert.equal(open.children[3].hidden, false);
  update({ ...current, busy: true });
  assert.notEqual(document.activeElement, button, "moved disabled controls must not regain focus");
  update(current);
  button.focus();
  update({ ...current, files: [second] });
  assert.equal(firstRow.isConnected, false);
  assert.notEqual(document.activeElement, button);
  button.click();
  update(current);
  assert.notEqual(element("files").children[0], firstRow);
  button.click();
  assert.equal(messages.length, 1, "reintroduced IDs must not revive detached handlers");
  const oldOpen = element("files").children[0].children[buttonIndex];
  oldOpen.focus();
  update({ ...current, repoKey: "/other" });
  assert.notEqual(document.activeElement, oldOpen);
  oldOpen.click();
  element("files").children[0].children[buttonIndex].click();
  assert.deepEqual({ ...lastMessage(messages) }, { type, repoKey: "/other", fileId: "first" });
  update(current);
  oldOpen.click();
  assert.equal(messages.length, 2, "returning to a scope must not revive its detached handlers");
  const currentOpen = element("files").children[0].children[buttonIndex];
  assert.ok(currentOpen.parent);
  currentOpen.parent.remove();
  currentOpen.click();
  assert.equal(messages.length, 2, "even a still-keyed detached row must not send an action");
  update({ ...current, repoKey: undefined });
  currentOpen.invokeListener("click");
  assert.equal(messages.length, 2);
});

test("note cards contain only title and two-line text preview plus sibling accessible edit then delete icons", () => {
  const { element, messages, update } = scriptFixture();
  const unsafe = '<img src=x onerror="bad">';
  const notes = [
    note({ path: `unsafe/${unsafe}.ts`, preview: unsafe + "\r\n**second line**\r\nPRIVATE THIRD LINE" }),
    note({ id: "comparison", path: "compare.ts", startLine: 8, endLine: 8, comparison: true }),
    note({ id: "stale", path: "missing.ts", stale: true, comparison: true, preview: "" }),
  ];
  update(state({ notes, commentCount: 3 }));
  const cards = element("notes").children;
  assert.equal(cards.length, 3);
  const [open, edit, remove] = cards[0].children;
  const [title, preview] = open.children;
  const deleteTemplate = element("delete-icon").content;
  const editTemplate = element("edit-icon").content;
  assert.ok(deleteTemplate);
  assert.ok(editTemplate);
  const templateSvg = deleteTemplate.children[0];
  for (const [index, card] of cards.entries()) {
    assert.equal(card.className, "note-card");
    assert.deepEqual(card.children.map(node => [node.tagName, node.className, node.type]), [
      ["button", "note-open", "button"], ["button", "note-action note-edit", "button"], ["button", "note-action note-delete", "button"],
    ], "no action container or extra comparison button");
    assert.deepEqual(card.children[0].children.map(node => [node.tagName, node.className]), [
      ["span", "note-title"], ["span", "note-preview"],
    ], "no directory, context or status DOM");
    for (const node of card.children[0].children) assert.equal(node.children.length, 0, "preview and title are text-only");
    const deleteButton = card.children[2];
    assert.equal(deleteButton.textContent, "", "delete is icon-only");
    assert.equal(deleteButton.children.length, 1);
    const svg = deleteButton.children[0];
    assert.equal(svg.tagName, "svg");
    assert.notEqual(svg, templateSvg);
    assert.deepEqual(svg.attributes, templateSvg.attributes);
    assert.equal(svg.attributes.get("aria-hidden"), "true");
    assert.equal(svg.attributes.get("focusable"), "false");
    assert.equal(svg.children.length, 1);
    assert.equal(svg.children[0].tagName, "path");
    assert.notEqual(svg.children[0], templateSvg.children[0]);
    assert.deepEqual(svg.children[0].attributes, templateSvg.children[0].attributes);
    if (index > 0) assert.notEqual(svg, cards[0].children[2].children[0]);
    assert.equal(deleteButton.title, "Delete Review Note");
    assert.equal(deleteButton.attributes.get("aria-label"), deleteButton.title);
    const editButton = card.children[1];
    assert.equal(editButton.title, "Edit Review Note");
    assert.equal(editButton.attributes.get("aria-label"), editButton.title);
    assert.deepEqual(editButton.children[0].attributes, editTemplate.children[0].attributes);
    for (const button of [editButton, deleteButton]) {
      assert.equal(button.hidden, false);
      assert.equal(button.attributes.has("tabindex"), false);
    }
  }
  assert.equal(title.textContent, `${unsafe}.ts:4-6`);
  assert.equal(preview.textContent, unsafe + "\n**second line**");
  assert.equal(preview.hidden, false);
  assert.equal(open.attributes.get("aria-description"), "Go to code");
  assert.equal(open.title, `Go to code: unsafe/${unsafe}.ts:4-6`);

  const comparisonOpen = cards[1].children[0];
  assert.equal(comparisonOpen.children[0].textContent, "compare.ts:8");
  assert.equal(comparisonOpen.attributes.get("aria-description"), "Open code comparison");
  assert.equal(comparisonOpen.title, "Open code comparison: compare.ts:8");
  const staleOpen = cards[2].children[0];
  assert.equal(staleOpen.children[1].hidden, true);
  assert.equal(staleOpen.attributes.get("aria-description"), "Open saved Review Note");
  assert.equal(staleOpen.title, "Open saved Review Note: missing.ts:4-6");
  assert.equal(staleOpen.disabled, false);
  open.click();
  edit.children[0].children[0].click();
  remove.click();
  comparisonOpen.click();
  staleOpen.click();
  assert.deepEqual(messages.slice(1).map(message => ({ ...message })), [
    { type: "open", repoKey: "/repo", noteId: "projection:0" },
    { type: "edit", repoKey: "/repo", noteId: "projection:0" },
    { type: "delete", repoKey: "/repo", noteId: "projection:0" },
    { type: "open", repoKey: "/repo", noteId: "comparison" },
    { type: "open", repoKey: "/repo", noteId: "stale" },
  ]);
  update(state({ notes, busy: true }));
  for (const card of cards) {
    for (const button of card.children) {
      assert.equal(button.disabled, true);
      button.click();
      button.invokeListener("click");
    }
  }
  assert.equal(messages.length, 6, "busy guards apply even to directly invoked handlers");
  for (const newline of ["\n", "\r\n", "\r"]) {
    for (const [first, second] of [["first", "second"], ["", "second"], ["first", ""], ["", ""]]) {
      update(state({ notes: [note({ preview: `${first}${newline}${second}${newline}PRIVATE THIRD LINE` })] }));
      assert.equal(element("notes").children[0].children[0].children[1].textContent, `${first}\n${second}`);
    }
  }
  assert.equal(messages.some(message => message.type === "comparison"), false);
});

test("keyed note cards reuse and reorder nodes, update metadata and preserve only eligible focus", () => {
  const { element, document, update } = scriptFixture();
  const first = note();
  const second = note({ id: "second", comparison: true });
  update(state({ notes: [first, second] }));
  const [firstCard, secondCard] = element("notes").children;
  const open = firstCard.children[0];
  const remove = firstCard.children[2];
  open.focus();
  update(state({ notes: [first, second], noteError: "Refresh warning" }));
  assert.equal(element("notes").children[0], firstCard);
  assert.equal(firstCard.children[0], open);
  assert.equal(document.activeElement, open);
  remove.focus();
  update(state({ notes: [first, second] }));
  assert.equal(firstCard.children[2], remove);
  assert.equal(document.activeElement, remove);
  open.focus();
  const changed = { ...first, path: "renamed.ts", startLine: 12, endLine: 12, preview: "Updated", comparison: true };
  update(state({ notes: [second, changed] }));
  assert.equal(element("notes").children[0], secondCard);
  assert.equal(element("notes").children[1], firstCard);
  assert.equal(open.children[0].textContent, "renamed.ts:12");
  assert.equal(open.children[1].textContent, "Updated");
  assert.equal(open.children[1].hidden, false);
  assert.equal(document.activeElement, open);
  assert.equal(remove.title, "Delete Review Note");
  assert.equal(remove.attributes.get("aria-label"), remove.title);
  assert.equal(remove.disabled, false);
  remove.focus();
  update(state({ notes: [changed, second] }));
  assert.equal(document.activeElement, remove, "moving the focused row restores delete focus");
  update(state({ notes: [second, changed] }));
  update(state({ notes: [changed, second], busy: true }));
  assert.notEqual(document.activeElement, remove, "a moved disabled control must not regain focus");
  update(state({ notes: [second, changed] }));
  remove.focus();
  update(state({ notes: [first, second] }));
  assert.equal(document.activeElement, remove, "comparison metadata changes must not replace delete controls");
  open.focus();
  update(state({ notes: [second] }));
  assert.equal(firstCard.isConnected, false);
  assert.notEqual(document.activeElement, open, "removed note controls must not regain focus");
});

test("folder resets and projection replacements reject old detached note and archive clicks", () => {
  const { element, messages, update, showArchives } = scriptFixture();
  update(state());
  const oldCard = element("notes").children[1];
  const oldButtons = [...oldCard.children];
  update(state({ notes: [note({ id: "replacement", comparison: true })] }));
  assert.equal(oldCard.isConnected, false);
  for (const button of oldButtons) button.click();
  assert.equal(messages.length, 1);
  update(state());
  assert.notEqual(element("notes").children[1], oldCard);
  for (const button of oldButtons) button.click();
  assert.equal(messages.length, 1, "reintroduced IDs must not revive detached listeners");

  const currentCard = element("notes").children[1];
  update(state({ repoKey: "/other" }));
  assert.equal(currentCard.isConnected, false);
  assert.notEqual(element("notes").children[1], currentCard);
  for (const button of currentCard.children) button.click();
  assert.equal(messages.length, 1);
  element("notes").children[1].children[0].click();
  assert.deepEqual({ ...lastMessage(messages) }, { type: "open", repoKey: "/other", noteId: "projection:1" });
  update(state({ repoKey: undefined }));
  assert.equal(element("notes").children.length, 0);
  update(state({ hasFeedback: false }));
  assert.equal(element("notes").children.length, 0);
  const archive = element("archives").children[0];
  const recover = archive.children[1];
  update(state({ repoKey: "/other", hasFeedback: false }));
  assert.equal(archive.isConnected, false);
  assert.notEqual(element("archives").children[0], archive);
  recover.click();
  assert.equal(messages.length, 2);
  update(state({ hasFeedback: false }));
  recover.click();
  assert.equal(messages.length, 2, "returning to the old folder must not revive detached archive listeners");
  const currentRecover = element("archives").children[0].children[1];
  update(state({ hasFeedback: false, archives: [] }));
  currentRecover.click();
  assert.equal(messages.length, 2);
  update(state({ hasFeedback: false }));
  currentRecover.click();
  assert.equal(messages.length, 2, "reintroduced archive IDs must not revive detached listeners");
  showArchives();
  update(state({ hasFeedback: false, historyVisible: true }));
  element("archives").children[0].children[1].click();
  assert.deepEqual({ ...lastMessage(messages) }, { type: "restore", repoKey: "/repo", archiveId: "batch" });
});
