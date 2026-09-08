import * as assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import type * as vscode from "vscode";
import { ReviewDashboard, type DashboardState } from "../src/dashboard";
import { renderDashboard } from "../src/dashboardHtml";

function state(overrides: Partial<DashboardState> = {}): DashboardState {
  return {
    repoKey: "/repo", repoName: "Repository", hasFeedback: true,
    commentCount: 2, busy: false,
    archives: [{ id: "batch", createdAt: "2026-09-08T10:00:00Z", commentCount: 3 }],
    ...overrides,
  };
}

function viewFixture() {
  let receive: ((message: unknown) => void) | undefined;
  let close: (() => void) | undefined;
  let visibility: (() => void) | undefined;
  const messages: Array<{ type: string; state: DashboardState }> = [];
  let html = "";
  let htmlWrites = 0;
  const view = {
    visible: true,
    webview: {
      options: {},
      get html() { return html; },
      set html(value: string) { html = value; htmlWrites++; },
      postMessage(message: { type: string; state: DashboardState }) {
        messages.push(message);
        return Promise.resolve(true);
      },
      onDidReceiveMessage(listener: (message: unknown) => void) {
        receive = listener;
        return { dispose() { receive = undefined; } };
      },
    },
    onDidDispose(listener: () => void) {
      close = listener;
      return { dispose() { close = undefined; } };
    },
    onDidChangeVisibility(listener: () => void) {
      visibility = listener;
      return { dispose() { visibility = undefined; } };
    },
  };
  return {
    view, messages,
    get htmlWrites() { return htmlWrites; },
    send(message: unknown) { receive?.(message); },
    close() { close?.(); },
    show() { visibility?.(); },
    resolve(dashboard: ReviewDashboard) {
      dashboard.resolveWebviewView(
        view as unknown as vscode.WebviewView,
        {} as vscode.WebviewViewResolveContext,
        {} as vscode.CancellationToken,
      );
    },
  };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("static shell has nonce-only CSP, accessible full-text copy button and responsive native styling", () => {
  const html = renderDashboard("test-nonce");
  assert.match(html, /default-src 'none'; script-src 'nonce-test-nonce'; style-src 'nonce-test-nonce'/);
  assert.match(html, /base-uri 'none'; form-action 'none'/);
  assert.equal((html.match(/nonce="test-nonce"/g) || []).length, 2);
  assert.doesNotMatch(html, /https?:|<script[^>]+src=|<link|unsafe-inline|innerHTML|outerHTML|eval\(/i);
  assert.match(html, /<button id="copy"[^>]+disabled>Copy Comments &amp; Clear<\/button>/);
  assert.match(html, /#copy\s*\{[^}]*justify-content: center;[^}]*width: 100%;[^}]*min-height: 48px;/);
  assert.match(html, /white-space: normal/);
  assert.match(html, /overflow-wrap: anywhere/);
  assert.match(html, /@media \(max-width: 220px\)/);
  assert.match(html, /var\(--vscode-button-background\)/);
  assert.match(html, /:focus-visible \{ outline: 2px solid var\(--vscode-focusBorder\)/);
  assert.match(html, /aria-busy="false"/);
  assert.match(html, /<ul id="archives"/);
  assert.match(html, /role="alert"/);
  assert.throws(() => renderDashboard('x" onclick="bad'), /Invalid dashboard nonce/);
  assert.throws(() => renderDashboard("x'; script-src 'unsafe-inline"), /Invalid dashboard nonce/);
});

test("provider waits for ready, posts latest metadata only, caps newest archives and keeps HTML stable", () => {
  const dashboard = new ReviewDashboard(() => {});
  const fixture = viewFixture();
  const archives = Array.from({ length: 12 }, (_, index) => ({
    id: String(index), createdAt: new Date(2026, 0, index + 1).toISOString(), commentCount: index,
    rawText: "PRIVATE FEEDBACK",
  }));
  const latest = state({ repoName: '</script><img src=x onerror="bad">', archives });
  dashboard.update(state());
  fixture.resolve(dashboard);
  dashboard.update(latest);
  archives[11].commentCount = 999;
  assert.deepEqual(fixture.view.webview.options, { enableScripts: true, localResourceRoots: [] });
  assert.equal(fixture.messages.length, 0);
  assert.doesNotMatch(fixture.view.webview.html, /PRIVATE FEEDBACK|onerror/);
  fixture.send({ type: "ready" });
  const posted = fixture.messages.at(-1)!.state;
  assert.equal(posted.repoName, latest.repoName);
  assert.equal(posted.archives.length, 10);
  assert.equal(posted.archives[0].id, "11");
  assert.equal(posted.archives[0].commentCount, 11);
  assert.equal(posted.archives[9].id, "2");
  assert.doesNotMatch(JSON.stringify(posted), /PRIVATE FEEDBACK|rawText/);
  dashboard.update(state({ busy: true }));
  fixture.show();
  assert.equal(fixture.messages.at(-1)!.state.busy, true);
  assert.equal(fixture.htmlWrites, 1);
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
    { type: "restore", repoKey: "/repo", archiveId: "batch" },
    { type: "selectRepository", repoKey: "/old" },
  ]) fixture.send(message);
  assert.equal(actions.length, 0);
  fixture.send({ type: "copy", repoKey: "/repo" });
  await settle();
  assert.deepEqual(actions, [{ type: "copy", repoKey: "/repo" }]);

  dashboard.update(state({ hasFeedback: false }));
  for (const message of [
    { type: "copy", repoKey: "/repo" },
    { type: "restore", repoKey: "/repo" },
    { type: "restore", repoKey: "/repo", archiveId: 1 },
    { type: "restore", repoKey: "/repo", archiveId: "missing" },
  ]) fixture.send(message);
  assert.equal(actions.length, 1);
  fixture.send({ type: "restore", repoKey: "/repo", archiveId: "batch" });
  await settle();
  assert.deepEqual(actions[1], { type: "restore", repoKey: "/repo", archiveId: "batch" });
  dashboard.update(state({ busy: true, hasFeedback: false }));
  fixture.send({ type: "restore", repoKey: "/repo", archiveId: "batch" });
  fixture.send({ type: "selectRepository", repoKey: "/repo" });
  dashboard.update(state({ busy: true }));
  fixture.send({ type: "copy", repoKey: "/repo" });
  assert.equal(actions.length, 2);
  dashboard.update(state({ repoKey: undefined, hasFeedback: false }));
  fixture.send({ type: "restore", archiveId: "batch" });
  fixture.send({ type: "selectRepository" });
  await settle();
  assert.deepEqual(actions[2], { type: "selectRepository", repoKey: undefined });
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
  fixture.send({ type: "restore", repoKey: "/new", archiveId: "0" });
  assert.equal(actions.length, 0);
  dashboard.dispose();
});

test("in-flight actions are serialized and callback failures are caught", async (t) => {
  const errors: unknown[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { errors.push(args); });
  let reject!: (error: Error) => void;
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
  fixture.send({ type: "copy", repoKey: "/repo" });
  fixture.send({ type: "copy", repoKey: "/repo" });
  assert.equal(calls, 1);
  assert.equal(fixture.messages.at(-1)!.state.busy, true);
  reject(new Error("async failure"));
  await settle();
  assert.equal(errors.length, 1);
  assert.equal(fixture.messages.at(-1)!.state.busy, false);
  fixture.send({ type: "copy", repoKey: "/repo" });
  await settle();
  assert.equal(errors.length, 2);
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
  assert.equal(second.messages[0].state.repoName, "Repository");
  dashboard.dispose();
  dashboard.dispose();
  second.send({ type: "copy", repoKey: "/repo" });
  dashboard.update(state());
  assert.equal(second.messages.length, 1);
});

// Minimal DOM surface used by the inline script; no browser or third-party DOM dependency.
class Element {
  children: Element[] = [];
  parent?: Element;
  textContent = "";
  hidden = false;
  disabled = false;
  dateTime = "";
  className = "";
  type = "";
  attributes = new Map<string, string>();
  listeners = new Map<string, () => void>();
  constructor(readonly tagName: string) {}
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  addEventListener(name: string, callback: () => void) { this.listeners.set(name, callback); }
  append(...children: Element[]) { for (const child of children) this.insertBefore(child, null); }
  insertBefore(child: Element, before: Element | null) {
    child.remove();
    this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, child);
    child.parent = this;
  }
  remove() {
    if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = undefined;
  }
  click() { if (!this.disabled) this.listeners.get("click")?.(); }
}

test("webview script safely updates text, dates, buttons and archive nodes without replacing the shell", () => {
  const html = renderDashboard("test-nonce");
  const elements = new Map<string, Element>();
  for (const match of html.matchAll(/<([a-z0-9]+) id="([^"]+)"/g)) {
    elements.set(match[2], new Element(match[1]));
  }
  const element = (id: string) => elements.get(id)!;
  const messages: Array<{ type: string; repoKey?: string; archiveId?: string }> = [];
  let receive!: (event: { data: { type: string; state: DashboardState } }) => void;
  runInNewContext(html.match(/<script nonce="test-nonce">([\s\S]*?)<\/script>/)![1], {
    acquireVsCodeApi: () => ({ postMessage: (message: typeof messages[number]) => messages.push(message) }),
    document: { getElementById: element, createElement: (tag: string) => new Element(tag) },
    window: { addEventListener: (_name: string, listener: typeof receive) => { receive = listener; } },
  });
  assert.equal(messages[0].type, "ready");
  const unsafe = '</script><img src=x onerror="bad">';
  const current = state({ repoName: unsafe, error: unsafe });
  const update = (next: DashboardState) => receive({ data: { type: "state", state: next } });
  update(current);
  assert.equal(element("repository").textContent, unsafe);
  assert.equal(element("repository").children.length, 0);
  assert.equal(element("error").textContent, unsafe);
  assert.equal(element("count").textContent, "2 comments");
  assert.equal(element("copy").disabled, false);
  assert.equal(element("history").hidden, true);
  element("copy").click();
  assert.equal(messages.at(-1)!.type, "copy");
  assert.equal(messages.at(-1)!.repoKey, "/repo");

  const empty = state({ hasFeedback: false, commentCount: 0 });
  update(empty);
  assert.equal(element("copy").disabled, true);
  assert.equal(element("history").hidden, false);
  assert.equal(element("error").hidden, true);
  const row = element("archives").children[0];
  const date = row.children[0].children[0];
  const recover = row.children[1];
  assert.equal(date.tagName, "time");
  assert.equal(date.dateTime, new Date(empty.archives[0].createdAt).toISOString());
  assert.equal(date.textContent, new Date(empty.archives[0].createdAt).toLocaleString());
  assert.equal(recover.textContent, "Recover");
  recover.click();
  assert.equal(messages.at(-1)!.type, "restore");
  assert.equal(messages.at(-1)!.archiveId, "batch");
  update({ ...empty, busy: true });
  assert.equal(element("archives").children[0], row);
  assert.equal(row.children[1], recover);
  assert.equal(recover.disabled, true);
  assert.equal(element("dashboard").attributes.get("aria-busy"), "true");
  assert.equal(element("select-repository").disabled, true);
  update({ ...empty, archives: Array.from({ length: 12 }, (_, index) => ({
    id: unsafe + index, createdAt: "invalid", commentCount: 1,
  })) });
  assert.equal(element("archives").children.length, 10);
  assert.equal(element("archives").children[0].children[0].children[0].textContent, "Unknown date");
  update({ ...empty, repoKey: undefined, repoName: undefined });
  assert.equal(element("archives").children.length, 0);
  assert.equal(element("history").hidden, true);
  assert.equal(element("repository").textContent, "No repository selected");
  element("select-repository").click();
  assert.equal(messages.at(-1)!.type, "selectRepository");
});
