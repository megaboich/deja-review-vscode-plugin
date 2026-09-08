import { randomBytes } from "node:crypto";
import type * as vscode from "vscode";
import { renderDashboard } from "./dashboardHtml";

export interface DashboardState {
  repoKey?: string;
  repoName?: string;
  hasFeedback: boolean;
  commentCount: number;
  busy: boolean;
  archives: Array<{ id: string; createdAt: string; commentCount: number }>;
  error?: string;
}

export class ReviewDashboard implements vscode.WebviewViewProvider, vscode.Disposable {
  private state: DashboardState = {
    hasFeedback: false, commentCount: 0, busy: false, archives: [],
  };
  private view?: vscode.WebviewView;
  private listeners: vscode.Disposable[] = [];
  private ready = false;
  private disposed = false;
  private handlingAction = false;

  constructor(private readonly onAction: (action: {
    type: "copy" | "restore" | "selectRepository";
    repoKey?: string;
    archiveId?: string;
  }) => void | Promise<void>) {}

  update(state: DashboardState): void {
    if (this.disposed) return;
    // Snapshot only display metadata; never forward raw feedback or archive contents.
    this.state = {
      repoKey: state.repoKey,
      repoName: state.repoName,
      hasFeedback: state.hasFeedback,
      commentCount: state.commentCount,
      busy: state.busy,
      error: state.error,
      archives: state.archives
        .map(({ id, createdAt, commentCount }) => ({ id, createdAt, commentCount }))
        .sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0))
        .slice(0, 10),
    };
    this.pushState();
  }

  resolveWebviewView(
    view: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    if (this.disposed) return;
    this.releaseView();
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    this.listeners.push(
      view.webview.onDidReceiveMessage((message: unknown) => {
        if (this.view === view) void this.receiveMessage(message);
      }),
      view.onDidDispose(() => {
        if (this.view === view) this.releaseView();
      }),
      view.onDidChangeVisibility(() => {
        if (view.visible && this.view === view) this.pushState();
      }),
    );
    view.webview.html = renderDashboard(randomBytes(32).toString("hex"));
  }

  private async receiveMessage(message: unknown): Promise<void> {
    if (this.disposed || !message || typeof message !== "object" || Array.isArray(message)) return;
    const data = message as Record<string, unknown>;
    const keys = Object.keys(data);
    if (data.type === "ready" && keys.length === 1) {
      this.ready = true;
      this.pushState();
      return;
    }
    if (!this.ready || this.state.busy || this.handlingAction) return;
    if (data.type !== "copy" && data.type !== "restore" && data.type !== "selectRepository") return;
    if (keys.some((key) => !["type", "repoKey", "archiveId"].includes(key))) return;
    if (data.repoKey !== undefined && (typeof data.repoKey !== "string" || !data.repoKey)) return;
    if (data.repoKey !== this.state.repoKey) return;
    if (data.type === "restore") {
      if (!this.state.repoKey || this.state.hasFeedback || typeof data.archiveId !== "string"
        || !this.state.archives.some((archive) => archive.id === data.archiveId)) return;
    } else {
      if ("archiveId" in data) return;
      if (data.type === "copy" && (!this.state.repoKey || !this.state.hasFeedback)) return;
    }

    this.handlingAction = true;
    this.pushState();
    try {
      await this.onAction({
        type: data.type,
        repoKey: this.state.repoKey,
        ...(data.type === "restore" ? { archiveId: data.archiveId as string } : {}),
      });
    } catch (error) {
      // The owner supplies user-facing errors through update(); never leak a rejected callback.
      console.error("DejaReview dashboard action failed", error);
    } finally {
      this.handlingAction = false;
      this.pushState();
    }
  }

  private pushState(): void {
    if (!this.view || !this.ready || this.disposed) return;
    try {
      void Promise.resolve(this.view.webview.postMessage({
        type: "state",
        state: { ...this.state, busy: this.state.busy || this.handlingAction },
      })).catch((error: unknown) => console.error("DejaReview dashboard update failed", error));
    } catch (error) {
      console.error("DejaReview dashboard update failed", error);
    }
  }

  private releaseView(): void {
    this.view = undefined;
    this.ready = false;
    for (const listener of this.listeners.splice(0)) listener.dispose();
  }

  dispose(): void {
    this.disposed = true;
    this.releaseView();
  }
}
