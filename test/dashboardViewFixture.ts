import * as assert from "node:assert/strict";
import type * as vscode from "vscode";
import type { DashboardHostMessage, DashboardState } from "../src/dashboard";

type StateMessage = Extract<DashboardHostMessage, { type: "state" }>;

export type DashboardViewFixture = {
  view: vscode.WebviewView;
  messages: StateMessage[];
  transport: DashboardHostMessage[];
  readonly htmlWrites: number;
  readonly latestState: DashboardState;
  send(message: unknown): void;
  close(): void;
  show(): void;
  hide(): void;
  resolve(provider: vscode.WebviewViewProvider): void | Thenable<void>;
};

// Transport and lifecycle only. Tests explicitly choose when queued messages reach the client.
export function viewFixture(): DashboardViewFixture {
  let receive: ((message: unknown) => void) | undefined;
  let close: (() => void) | undefined;
  let visibility: (() => void) | undefined;
  const messages: StateMessage[] = [];
  const transport: DashboardHostMessage[] = [];
  let html = "";
  let htmlWrites = 0;
  let visible = true;
  const view: vscode.WebviewView = {
    viewType: "dejareview.dashboard",
    get visible() { return visible; },
    show() { visible = true; visibility?.(); },
    webview: {
      options: {},
      cspSource: "test-webview:",
      asWebviewUri() { return assert.fail("Dashboard must not load external resources"); },
      get html() { return html; },
      set html(value: string) {
        html = value;
        htmlWrites++;
      },
      postMessage(message: DashboardHostMessage) {
        transport.push(message);
        if (message.type === "state") {
          messages.push(message);
        }
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
    view, messages, transport,
    get htmlWrites() { return htmlWrites; },
    get latestState() {
      const message = messages.at(-1);
      assert.ok(message, "Expected a published dashboard state");
      return message.state;
    },
    send(message: unknown) { receive?.(message); },
    close() { close?.(); },
    show() { view.show(); },
    hide() { visible = false; visibility?.(); },
    resolve(provider: vscode.WebviewViewProvider) {
      return provider.resolveWebviewView(view, { state: undefined }, {
        isCancellationRequested: false,
        onCancellationRequested: () => ({ dispose() {} }),
      });
    },
  };
}
