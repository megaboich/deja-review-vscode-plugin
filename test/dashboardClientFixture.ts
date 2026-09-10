import * as assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import type { DashboardState } from "../src/dashboard";
import { renderDashboard } from "../src/dashboardHtml";

type KeyEvent = { key?: string; preventDefault(): void };
type Listener = (event?: KeyEvent) => void;
type Document = { activeElement?: Element; root: Element };

// Only the DOM surface consumed by the dashboard, not a browser/layout emulator.
export class Element {
  children: Element[] = [];
  content?: Element;
  parent?: Element;
  textContent = "";
  hidden = false;
  disabled = false;
  dateTime = "";
  className = "";
  type = "";
  title = "";
  value = "";
  selectionStart = 0;
  selectionEnd = 0;
  open = false;
  showModalCalls = 0;
  closeCalls = 0;
  attributes = new Map<string, string>();
  listeners = new Map<string, Listener>();

  constructor(readonly tagName: string, private readonly document: Partial<Document>) {}

  get isConnected(): boolean {
    return this === this.document.root || !!this.parent?.isConnected;
  }

  contains(element: Element): boolean {
    return this === element || this.children.some(child => child.contains(element));
  }

  closest(selector: string): Element | null {
    assert.equal(selector, "[hidden]");
    return this.hidden ? this : this.parent?.closest(selector) ?? null;
  }

  focus(_options?: { preventScroll: boolean }): void {
    this.document.activeElement = this;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  addEventListener(name: string, callback: Listener): void {
    this.listeners.set(name, callback);
  }

  // Deliberately bypass native disabled-button handling to test client-side guards.
  invokeListener(name: string): void {
    const listener = this.listeners.get(name);
    assert.ok(listener, `Expected ${name} listener on ${this.tagName}`);
    listener();
  }

  showModal(): void {
    assert.equal(this.open, false);
    this.open = true;
    this.showModalCalls++;
  }

  close(): void {
    this.open = false;
    this.closeCalls++;
  }

  dispatch(name: string, key?: string): boolean {
    let prevented = false;
    this.listeners.get(name)?.({ key, preventDefault() { prevented = true; } });
    // Native button activation is intentionally left to the browser by the client.
    const activatesButton = (name === "keydown" && key === "Enter") || (name === "keyup" && key === " ");
    if (!prevented && this.tagName === "button" && this.document.activeElement === this && activatesButton) {
      this.click();
    }
    return prevented;
  }

  append(...children: Element[]): void {
    for (const child of children) {
      this.insertBefore(child, null);
    }
  }

  cloneNode(deep: boolean): Element {
    const clone = new Element(this.tagName, this.document);
    clone.textContent = this.textContent;
    clone.attributes = new Map(this.attributes);
    if (deep) {
      clone.append(...this.children.map(child => child.cloneNode(true)));
    }
    return clone;
  }

  insertBefore(child: Element, before: Element | null): void {
    if (child.tagName === "#document-fragment") {
      for (const node of [...child.children]) {
        this.insertBefore(node, before);
      }
      return;
    }
    child.remove();
    this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, child);
    child.parent = this;
  }

  remove(): void {
    if (this.document.activeElement && this.contains(this.document.activeElement)) {
      this.document.activeElement = this.document.root;
    }
    if (this.parent) {
      this.parent.children.splice(this.parent.children.indexOf(this), 1);
    }
    this.parent = undefined;
  }

  click(): void {
    if (this.disabled) {
      return;
    }
    for (let node: Element | undefined = this; node; node = node.parent) {
      node.listeners.get("click")?.();
    }
  }
}

// Keep raw client output rather than decoding with the production validator:
// exact-message assertions must still catch missing or unexpected keys.
type ClientMessage = {
  type: string;
  repoKey?: string;
  archiveId?: string;
  noteId?: string;
  fileId?: string;
  editorId?: string;
  body?: string;
  requestId?: string;
};

export function lastMessage(messages: readonly ClientMessage[]): ClientMessage {
  const message = messages.at(-1);
  assert.ok(message, 'Expected a captured client message');
  return message;
}

function isClientMessage(message: unknown): message is ClientMessage {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return false;
  }
  if (!("type" in message) || typeof message.type !== "string") {
    return false;
  }
  for (const key of ["repoKey", "archiveId", "noteId", "fileId", "editorId", "body", "requestId"]) {
    if (key in message && typeof Reflect.get(message, key) !== "string") {
      return false;
    }
  }
  return true;
}

type ClientFixture = {
  elements: Map<string, Element>;
  element(id: string): Element;
  messages: ClientMessage[];
  document: Document;
  receive(message: unknown): void;
  showArchives(): void;
  update(next: DashboardState): void;
};

let clientSequence = 0;

export function scriptFixture(cache: { value?: unknown } = {}, instanceKey = "test-instance"): ClientFixture {
  const fixtureSequence = ++clientSequence;
  const html = renderDashboard("test-nonce", instanceKey);
  const elements = new Map<string, Element>();
  const document: Partial<Document> = {};
  const root = new Element("body", document);
  const completeDocument = Object.assign(document, { root });

  function element(id: string): Element {
    const node = elements.get(id);
    assert.ok(node, `Expected dashboard element #${id}`);
    return node;
  }

  for (const match of html.matchAll(/<([a-z0-9]+) id="([^"]+)"([^>]*)>/g)) {
    const node = new Element(match[1], document);
    node.hidden = /\bhidden\b/.test(match[3]);
    node.disabled = /\bdisabled\b/.test(match[3]);
    for (const attribute of match[3].matchAll(/([\w-]+)="([^"]*)"/g)) {
      node.setAttribute(attribute[1], attribute[2]);
    }
    elements.set(match[2], node);
  }
  for (const template of html.matchAll(/<template id="([^"]+)">([\s\S]*?)<\/template>/g)) {
    const icon = element(template[1]);
    icon.content = new Element("#document-fragment", document);
    let parent = icon.content;
    for (const match of template[2].matchAll(/<(svg|path)\b([^>]*)>/g)) {
      const node = new Element(match[1], document);
      for (const attribute of match[2].matchAll(/([\w-]+)="([^"]*)"/g)) {
        node.setAttribute(attribute[1], attribute[2]);
      }
      parent.append(node);
      parent = node;
    }
  }
  root.append(element("dashboard"));
  for (const [id, node] of elements) {
    if (id !== "dashboard") {
      element("dashboard").append(node);
    }
  }
  for (const id of ["history-title", "close-history", "no-archives", "archives"]) {
    element("history").append(element(id));
  }
  for (const id of ["files-title", "files-error", "no-files", "files"]) {
    element("files-section").append(element(id));
  }
  for (const id of ["add-general", "more", "more-menu"]) {
    element("toolbar").append(element(id));
  }
  element("more-menu").append(element("show-archives"));
  root.append(element("note-editor"));
  for (const id of ["editor-title", "editor-label", "editor-body", "editor-error", "close-editor", "cancel-edit", "save-edit"]) {
    element("note-editor").append(element(id));
  }

  const messages: ClientMessage[] = [];
  let receive: ((event: { data: unknown }) => void) | undefined;
  let requestSequence = 0;
  const script = html.match(/<script nonce="test-nonce">([\s\S]*?)<\/script>/);
  assert.ok(script, "Expected a nonce-protected dashboard client script");
  runInNewContext(script[1], {
    acquireVsCodeApi: () => ({
      postMessage(message: unknown) {
        assert.ok(isClientMessage(message), "Expected string fields in client transport output");
        messages.push(message);
      },
      getState: () => cache.value,
      setState: (value: unknown) => { cache.value = value; },
    }),
    document: Object.assign(document, {
      getElementById: element,
      createElement: (tag: string) => new Element(tag, document),
      addEventListener: root.addEventListener.bind(root),
    }),
    window: { addEventListener: (_name: string, listener: typeof receive) => { receive = listener; } },
    crypto: { randomUUID: () => instanceKey + ":" + ++requestSequence + ":" + fixtureSequence },
  });
  assert.equal(messages[0]?.type, "ready");
  assert.ok(receive, "Expected the dashboard client to register its host-message listener");
  const receiveMessage = receive;

  return {
    elements, element, messages, document: completeDocument,
    receive: (message: unknown) => receiveMessage({ data: message }),
    showArchives() {
      element("more").click();
      element("show-archives").click();
    },
    update: (next: DashboardState) => receiveMessage({ data: { type: "state", state: next } }),
  };
}
