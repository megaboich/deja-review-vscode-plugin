import { randomBytes } from "node:crypto";
import type * as vscode from "vscode";
import { renderDashboard } from "./dashboardHtml";

export type DashboardNote = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  preview: string;
  stale: boolean;
  comparison: boolean;
  general?: false;
} | { id: string; general: true; preview: string };

export interface DashboardState {
  repoKey?: string;
  hasFeedback: boolean;
  commentCount: number;
  busy: boolean;
  files: Array<{
    id: string; path: string; insertions?: number; deletions?: number;
    visible?: boolean; pending?: 'stage' | 'revert'; statisticsPending?: boolean;
  }>;
  filesError?: string;
  notes: DashboardNote[];
  noteError?: string;
  archives: Array<{ id: string; createdAt: string; commentCount: number }>;
  error?: string;
  historyVisible?: boolean;
  editor?: { id: string; repoKey: string; title: string; body: string; error?: string };
}

export type DashboardAction =
  | { type: "copy"; repoKey: string }
  | { type: "addGeneral"; repoKey: string }
  | { type: "restore"; repoKey: string; archiveId: string }
  | { type: "open" | "edit" | "delete"; repoKey: string; noteId: string }
  | { type: "openFile" | "revertFile" | "stageFile"; repoKey: string; fileId: string }
  | { type: "input" | "saveEdit"; repoKey: string; editorId: string; body: string }
  | { type: "cancelEdit"; repoKey: string; editorId: string };

type EditorAction = Extract<DashboardAction, { editorId: string }>;
type EditorRequest = EditorAction & { requestId: string };

export type DashboardMessage = Exclude<DashboardAction, EditorAction> | EditorRequest
  | { type: "ready" }
  | { type: "editorRequestStatus"; repoKey: string; editorId: string; requestId: string }
  | { type: "openHistory"; repoKey: string }
  | { type: "closeHistory"; repoKey: string };

/**
 * inputAccepted confirms the owner's synchronous publication of this input's body.
 * editorSettled means Save/Cancel processing ended, not that it succeeded.
 * On recreation, editorRequestStatus waits for an in-flight request, replays a
 * matching settlement, or settles an unknown request without executing it.
 * The client retains its body and never automatically resubmits Save/Cancel.
 */
export type DashboardHostMessage =
  | { type: "state"; state: DashboardState }
  | { type: "inputAccepted" | "editorSettled"; repoKey: string; editorId: string; requestId: string };

/** Shape validation only. Folder, membership, session and busy checks belong to the live provider. */
export function decodeDashboardMessage(message: unknown): DashboardMessage | undefined {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return;
  }
  const data = message as Record<string, unknown>;
  const keys = Object.keys(data);
  const exactKeys = (...allowed: string[]): boolean =>
    keys.length === allowed.length && keys.every(key => allowed.includes(key));

  if (data.type === "ready") {
    return exactKeys("type") ? { type: "ready" } : undefined;
  }
  if (typeof data.repoKey !== "string" || !data.repoKey) {
    return;
  }
  const repoKey = data.repoKey;

  switch (data.type) {
    case "copy":
    case "addGeneral":
    case "openHistory":
    case "closeHistory":
      if (exactKeys("type", "repoKey")) {
        return { type: data.type, repoKey };
      }
      return;
    case "restore":
      if (exactKeys("type", "repoKey", "archiveId") && typeof data.archiveId === "string" && data.archiveId) {
        return { type: data.type, repoKey, archiveId: data.archiveId };
      }
      return;
    case "open":
    case "edit":
    case "delete":
      if (exactKeys("type", "repoKey", "noteId") && typeof data.noteId === "string" && data.noteId) {
        return { type: data.type, repoKey, noteId: data.noteId };
      }
      return;
    case "openFile":
    case "revertFile":
    case "stageFile":
      if (exactKeys("type", "repoKey", "fileId") && typeof data.fileId === "string" && data.fileId) {
        return { type: data.type, repoKey, fileId: data.fileId };
      }
      return;
    case "input":
    case "saveEdit":
      if (exactKeys("type", "repoKey", "editorId", "body", "requestId")
        && typeof data.editorId === "string" && data.editorId && typeof data.body === "string"
        && typeof data.requestId === "string" && data.requestId) {
        return { type: data.type, repoKey, editorId: data.editorId, body: data.body, requestId: data.requestId };
      }
      return;
    case "cancelEdit":
    case "editorRequestStatus":
      if (exactKeys("type", "repoKey", "editorId", "requestId") && typeof data.editorId === "string" && data.editorId
        && typeof data.requestId === "string" && data.requestId) {
        return { type: data.type, repoKey, editorId: data.editorId, requestId: data.requestId };
      }
      return;
    default:
      return;
  }
}

export class ReviewDashboard implements vscode.WebviewViewProvider, vscode.Disposable {
  private state: DashboardState = {
    hasFeedback: false,
    commentCount: 0,
    busy: false,
    archives: [],
    notes: [],
    files: [],
  };
  private view?: vscode.WebviewView;
  private listeners: vscode.Disposable[] = [];
  private ready = false;
  private disposed = false;
  private handlingAction?: DashboardAction['type'];
  private handlingFile?: { repoKey: string; fileId: string; pending: 'stage' | 'revert' };
  private handlingRequestId?: string;
  private settledEditor?: Extract<DashboardHostMessage, { requestId: string }>;
  private publication = 0;
  private historyVisible = false;
  private readonly instanceKey = randomBytes(32).toString("hex");

  constructor(private readonly onAction: (action: DashboardAction) => void | Promise<void>) {}

  update(state: DashboardState): void {
    if (this.disposed) {
      return;
    }
    this.publication++;
    if (state.repoKey !== this.state.repoKey || !state.repoKey || state.hasFeedback
      || state.editor?.repoKey === state.repoKey) {
      this.historyVisible = false;
    }
    if (state.repoKey !== this.state.repoKey || state.editor?.id !== this.state.editor?.id) {
      this.settledEditor = undefined;
    }

    this.state = this.projectState(state);
    this.pushState();
  }

  private projectState(state: DashboardState): DashboardState {
    const files = state.files.map(({ id, path, insertions, deletions, visible, pending, statisticsPending }) => {
      const file: DashboardState['files'][number] = { id, path };
      if (typeof insertions === "number" && Number.isSafeInteger(insertions) && insertions >= 0) {
        file.insertions = insertions;
      }
      if (typeof deletions === "number" && Number.isSafeInteger(deletions) && deletions >= 0) {
        file.deletions = deletions;
      }
      if (typeof visible === "boolean") {
        file.visible = visible;
      }
      if (typeof statisticsPending === "boolean") {
        file.statisticsPending = statisticsPending;
      }
      if (pending === 'stage' || pending === 'revert') {
        file.pending = pending;
      }
      return file;
    });
    const notes = state.notes.map((note): DashboardNote => {
      const preview = note.preview.split(/\r\n|\r|\n/, 2).join('\n').slice(0, 320);
      if (note.general) {
        return { id: note.id, general: true, preview };
      }
      const { id, path, startLine, endLine, stale, comparison } = note;
      return { id, path, startLine, endLine, preview, stale, comparison };
    });
    const archives = state.archives
      .map(({ id, createdAt, commentCount }) => ({ id, createdAt, commentCount }))
      .sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0))
      .slice(0, 10);

    const projection: DashboardState = {
      repoKey: state.repoKey,
      hasFeedback: state.hasFeedback,
      commentCount: state.commentCount,
      busy: state.busy,
      error: state.error,
      noteError: state.noteError,
      filesError: state.filesError,
      files,
      notes,
      archives,
    };

    // Full bodies are allowed only for the explicit editor in the current folder.
    if (state.repoKey && state.editor?.repoKey === state.repoKey) {
      const { id, repoKey, title, body, error } = state.editor;
      projection.editor = { id, repoKey, title, body };
      if (error !== undefined) {
        projection.editor.error = error;
      }
    }
    return projection;
  }

  resolveWebviewView(
    view: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    if (this.disposed) {
      return;
    }
    this.releaseView();
    this.view = view;
    this.pushState();
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    this.listeners.push(
      view.webview.onDidReceiveMessage((message: unknown) => {
        if (this.view === view) {
          void this.receiveMessage(message);
        }
      }),
      view.onDidDispose(() => {
        if (this.view === view) {
          this.releaseView();
        }
      }),
      view.onDidChangeVisibility(() => {
        if (view.visible && this.view === view) {
          this.pushState();
        }
      }),
    );
    view.webview.html = renderDashboard(randomBytes(32).toString("hex"), this.instanceKey);
  }

  private async receiveMessage(message: unknown): Promise<void> {
    if (this.disposed) {
      return;
    }
    const decoded = decodeDashboardMessage(message);
    if (!decoded) {
      return;
    }
    if (decoded.type === "ready") {
      this.ready = true;
      this.pushState();
      if (this.settledEditor && this.settledEditor.repoKey === this.state.repoKey
        && this.settledEditor.editorId === this.state.editor?.id) {
        this.postEditorAcknowledgement(this.settledEditor);
      }
      return;
    }
    if (!this.ready || !this.state.repoKey || decoded.repoKey !== this.state.repoKey) {
      return;
    }
    if (decoded.type === "editorRequestStatus") {
      const editor = this.state.editor;
      if (!editor || editor.repoKey !== decoded.repoKey || editor.id !== decoded.editorId) {
        return;
      }
      if (decoded.requestId === this.handlingRequestId) {
        // The delivered request will settle through its existing finally block.
        return;
      }
      if (this.settledEditor?.repoKey === decoded.repoKey && this.settledEditor.editorId === decoded.editorId
        && this.settledEditor.requestId === decoded.requestId) {
        this.postEditorAcknowledgement(this.settledEditor);
        return;
      }

      // A cached request may never have reached the disposed view's listener.
      // Its identity guard rejects late delivery. Do not replace retained completion
      // status or execute a submission when answering an unknown request.
      this.postEditorAcknowledgement({
        type: "editorSettled",
        repoKey: decoded.repoKey,
        editorId: decoded.editorId,
        requestId: decoded.requestId,
      });
      return;
    }
    if (this.state.busy || this.handlingAction) {
      // A keystroke or Save may cross a busy publication in transit. Publish the
      // rejection state so the client can retain and resynchronize, never accept input here.
      switch (decoded.type) {
        case "input":
          this.pushState();
          break;
        case "saveEdit":
        case "cancelEdit":
          this.pushState();
          if (decoded.requestId !== this.handlingRequestId) {
            this.settleEditor(decoded);
          }
          break;
      }
      return;
    }
    switch (decoded.type) {
      case "openHistory":
      case "closeHistory":
        if (this.state.editor || this.state.hasFeedback) {
          return;
        }
        this.historyVisible = decoded.type === "openHistory";
        this.pushState();
        return;
    }

    const action = this.authorizeAction(decoded);
    if (!action) {
      return;
    }

    // Input is delivered synchronously so the owner can preserve each keystroke without busy flicker.
    const input = action.type === "input";
    if (!input) {
      this.handlingAction = action.type;
      if (action.type === 'stageFile' || action.type === 'revertFile') {
        this.handlingFile = {
          repoKey: action.repoKey, fileId: action.fileId,
          pending: action.type === 'stageFile' ? 'stage' : 'revert',
        };
      }
      this.handlingRequestId = 'requestId' in decoded ? decoded.requestId : undefined;
      this.pushState();
    }
    try {
      const beforeInput = this.publication;
      const result = this.onAction(action);
      // The owner accepts input synchronously and republishes its host-held body.
      // Capture acceptance before awaiting so a later input cannot acknowledge this request.
      const editor = this.state.editor;
      const acceptedInput = action.type === "input" && this.publication !== beforeInput && editor?.id === action.editorId
        && editor.repoKey === action.repoKey && editor.body === action.body;
      await result;
      if (acceptedInput && 'requestId' in decoded) {
        this.postEditorAcknowledgement({
          type: "inputAccepted",
          repoKey: decoded.repoKey,
          editorId: decoded.editorId,
          requestId: decoded.requestId,
        });
      }
    } catch (error) {
      // The owner supplies user-facing errors through update(); never leak a rejected callback.
      console.error("DejaReview dashboard action failed", error);
    } finally {
      if (!input) {
        this.handlingAction = undefined;
        this.handlingFile = undefined;
        this.handlingRequestId = undefined;
        this.pushState();
        if (decoded.type === "saveEdit" || decoded.type === "cancelEdit") {
          this.settleEditor(decoded);
        }
      }
    }
  }

  private settleEditor(action: EditorRequest): void {
    this.settledEditor = {
      type: "editorSettled",
      repoKey: action.repoKey,
      editorId: action.editorId,
      requestId: action.requestId,
    };
    this.postEditorAcknowledgement(this.settledEditor);
  }

  private postEditorAcknowledgement(message: Extract<DashboardHostMessage, { requestId: string }>): void {
    if (!this.view || !this.ready || this.disposed) {
      return;
    }
    try {
      void Promise.resolve(this.view.webview.postMessage(message))
        .catch(() => console.error("DejaReview dashboard editor acknowledgement failed"));
    } catch {
      console.error("DejaReview dashboard editor acknowledgement failed");
    }
  }

  private authorizeAction(action: DashboardAction): DashboardAction | undefined {
    switch (action.type) {
      case "input":
      case "saveEdit":
      case "cancelEdit": {
        const editor = this.state.editor;
        if (!editor || editor.repoKey !== action.repoKey || editor.id !== action.editorId) {
          return;
        }
        if (action.type === "saveEdit" && !action.body.trim()) {
          return;
        }
        if (action.type === "cancelEdit") {
          return { type: action.type, repoKey: action.repoKey, editorId: action.editorId };
        }
        return { type: action.type, repoKey: action.repoKey, editorId: action.editorId, body: action.body };
      }
    }
    if (this.state.editor) {
      return;
    }

    switch (action.type) {
      case "openFile":
      case "revertFile":
      case "stageFile":
        return this.state.files.some(file => file.id === action.fileId && !file.pending) ? action : undefined;
      case "restore":
        if (!this.historyVisible || this.state.hasFeedback) {
          return;
        }
        return this.state.archives.some(archive => archive.id === action.archiveId) ? action : undefined;
      case "copy":
        return this.state.hasFeedback ? action : undefined;
      case "addGeneral":
        return action;
      case "open":
      case "edit":
      case "delete": {
        if (!this.state.hasFeedback) {
          return;
        }
        const note = this.state.notes.find(note => note.id === action.noteId);
        if (!note) {
          return;
        }
        if (action.type === "open" && note.general) {
          return { type: "edit", repoKey: action.repoKey, noteId: action.noteId };
        }
        return action;
      }
    }
  }

  private pushState(): void {
    if (!this.view || this.disposed) {
      return;
    }
    const count = this.state.repoKey ? this.state.files.length : 0;
    const filesLabel = count + (count === 1 ? ' file to review' : ' files to review');
    const notesLabel = this.state.commentCount + (this.state.commentCount === 1 ? ' Review Note' : ' Review Notes');
    // VS Code 1.96 leaves the old activity visible on undefined alone. A zero
    // NumberBadge hides it first, then undefined clears the public badge state.
    this.view.badge = { value: count, tooltip: count > 0 ? `${filesLabel} · ${notesLabel}` : '' };
    if (count === 0) {
      this.view.badge = undefined;
    }
    if (!this.ready) {
      return;
    }
    const handlingMutation = !!this.handlingAction && this.handlingAction !== 'openFile' && this.handlingAction !== 'open';
    const pending = this.handlingFile;
    const files = this.state.files.map(file => pending && pending.repoKey === this.state.repoKey && pending.fileId === file.id
      ? { ...file, pending: pending.pending } : file);
    try {
      void Promise.resolve(this.view.webview.postMessage({
        type: "state",
        state: {
          ...this.state,
          files,
          historyVisible: this.historyVisible,
          busy: this.state.busy || handlingMutation,
        },
      })).catch((error: unknown) => console.error("DejaReview dashboard update failed", error));
    } catch (error) {
      console.error("DejaReview dashboard update failed", error);
    }
  }

  private releaseView(): void {
    this.view = undefined;
    this.ready = false;
    for (const listener of this.listeners.splice(0)) {
      listener.dispose();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.releaseView();
  }
}
