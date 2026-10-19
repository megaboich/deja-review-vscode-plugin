/// <reference lib="dom" />
import { render as renderInto, type VNode } from "preact";
import type { DashboardHostMessage, DashboardMessage, DashboardNote, DashboardState } from "./dashboard";

type PendingInput = { repoKey: string; editorId: string; body: string; requestId: string };
type PendingSubmission = PendingInput & { type: 'saveEdit' | 'cancelEdit' };
type TransportCache = { instanceKey: string; input?: PendingInput; submission?: PendingSubmission };
export type WebviewApi = {
  postMessage(message: DashboardMessage): void;
  getState(): unknown;
  setState(state: TransportCache | undefined): void;
};

/** Runtime boundary for host publications. */
export function isDashboardHostMessage(value: unknown): value is DashboardHostMessage {
  function record(data: unknown): data is Record<string, unknown> {
    return !!data && typeof data === 'object' && !Array.isArray(data);
  }
  function keys(data: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
    return required.every(key => Object.hasOwn(data, key))
      && Object.keys(data).every(key => required.includes(key) || optional.includes(key));
  }
  function text(data: unknown): data is string {
    return typeof data === 'string' && data.length > 0;
  }
  function count(data: unknown): data is number {
    return typeof data === 'number' && Number.isSafeInteger(data) && data >= 0;
  }
  function file(data: unknown): boolean {
    return record(data) && keys(data, ['id', 'path'], ['insertions', 'deletions', 'visible', 'pending', 'statisticsPending', 'changeKind'])
      && text(data.id) && typeof data.path === 'string'
      && (data.changeKind === undefined || data.changeKind === 'added' || data.changeKind === 'removed' || data.changeKind === 'renamed')
      && (data.insertions === undefined || count(data.insertions))
      && (data.deletions === undefined || count(data.deletions))
      && (data.visible === undefined || typeof data.visible === 'boolean')
      && (data.statisticsPending === undefined || typeof data.statisticsPending === 'boolean')
      && (data.pending === undefined || data.pending === 'stage' || data.pending === 'revert');
  }
  function note(data: unknown): boolean {
    if (!record(data) || !text(data.id) || typeof data.preview !== 'string') {
      return false;
    }
    if (data.general === true) {
      return keys(data, ['id', 'general', 'preview']);
    }
    return keys(data, ['id', 'path', 'startLine', 'endLine', 'preview', 'stale', 'comparison'], ['general', 'wholeFile'])
      && (data.wholeFile === undefined || typeof data.wholeFile === 'boolean')
      && (data.general === undefined || data.general === false) && typeof data.path === 'string'
      && count(data.startLine) && data.startLine > 0 && count(data.endLine) && data.endLine >= data.startLine
      && typeof data.stale === 'boolean' && typeof data.comparison === 'boolean';
  }
  function archive(data: unknown): boolean {
    return record(data) && keys(data, ['id', 'createdAt', 'commentCount'])
      && text(data.id) && typeof data.createdAt === 'string' && count(data.commentCount);
  }
  function editor(data: unknown, repoKey: unknown): boolean {
    return record(data) && keys(data, ['id', 'repoKey', 'title', 'body'], ['error'])
      && text(data.id) && text(data.repoKey) && data.repoKey === repoKey
      && typeof data.title === 'string' && typeof data.body === 'string'
      && (data.error === undefined || typeof data.error === 'string');
  }

  if (!record(value)) {
    return false;
  }
  switch (value.type) {
    case 'inputAccepted':
    case 'editorSettled':
      return keys(value, ['type', 'repoKey', 'editorId', 'requestId'])
        && text(value.repoKey) && text(value.editorId) && text(value.requestId);
    case 'state': {
      if (!keys(value, ['type', 'state']) || !record(value.state)) {
        return false;
      }
      const state = value.state;
      return keys(state, ['hasFeedback', 'commentCount', 'busy', 'files', 'notes', 'archives'],
        ['repoKey', 'filesError', 'noteError', 'error', 'historyVisible', 'editor'])
        && (state.repoKey === undefined || text(state.repoKey))
        && typeof state.hasFeedback === 'boolean' && count(state.commentCount) && typeof state.busy === 'boolean'
        && (state.historyVisible === undefined || typeof state.historyVisible === 'boolean')
        && ['filesError', 'noteError', 'error'].every(key => state[key] === undefined || typeof state[key] === 'string')
        && Array.isArray(state.files) && state.files.every(file)
        && Array.isArray(state.notes) && state.notes.every(note)
        && Array.isArray(state.archives) && state.archives.every(archive)
        && (state.editor === undefined || editor(state.editor, state.repoKey));
    }
    default:
      return false;
  }
}

/**
 * Bundled into the inline webview script by `scripts/buildClient.mjs`. Ordinary imports
 * are permitted here; the host message validator is injected so tests can substitute it.
 */
export function dashboardClient(
  acquireVsCodeApi: () => WebviewApi,
  instanceKey: string,
  validHostMessage: typeof isDashboardHostMessage,
): void {
  type File = DashboardState["files"][number];
  type Archive = DashboardState["archives"][number];
  type ExitingFile = { file: File; index: number; animation?: Animation };

  const vscode = acquireVsCodeApi();
  function byId(id: string): HTMLElement {
    const element = document.getElementById(id);
    if (!element) {
      throw new Error("Missing dashboard element: " + id);
    }
    return element;
  }
  // These casts describe the static shell, not untrusted message data.
  const button = (id: string): HTMLButtonElement => byId(id) as HTMLButtonElement;
  const icon = (id: string): Node => (byId(id) as HTMLTemplateElement).content.cloneNode(true);
  /**
   * Attaches a cloned icon template to a button Preact renders without children.
   *
   * The callbacks are cached so their identity is stable across renders, which stops Preact
   * from detaching and reattaching them; the guard covers a node reused by keyed diffing.
   */
  const iconRefs = new Map<string, (node: HTMLElement | null) => void>();
  function iconRef(id: string): (node: HTMLElement | null) => void {
    let attach = iconRefs.get(id);
    if (!attach) {
      attach = (node) => {
        if (node && !node.firstChild) {
          node.append(icon(id));
        }
      };
      iconRefs.set(id, attach);
    }
    return attach;
  }
  const copy = button('copy');
  const more = button('more');
  const dialog = byId('note-editor') as HTMLDialogElement;
  const body = byId('editor-body') as HTMLTextAreaElement;
  const exitingFiles = new Map<string, ExitingFile>();
  /** Live file rows from the last render, so the next one can tell which rows left. */
  let renderedFiles: readonly File[] = [];
  const fileNodes = new Map<string, HTMLLIElement>();
  const fileNodeRefs = new Map<string, (node: HTMLLIElement | null) => void>();
  /**
   * Records each row's element for exit measurement; identities are stable across renders.
   * Keyed by id, not folder: when a folder switch replaces a same-id row, Preact detaches the
   * old row's ref before attaching the new one, so the map ends at the new node.
   */
  function fileNodeRef(id: string): (node: HTMLLIElement | null) => void {
    let ref = fileNodeRefs.get(id);
    if (!ref) {
      ref = (node) => {
        if (node) {
          fileNodes.set(id, node);
        } else {
          fileNodes.delete(id);
        }
      };
      fileNodeRefs.set(id, ref);
    }
    return ref;
  }
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let state: DashboardState | undefined;
  let renderedRepoKey: string | undefined;
  let editorId: string | undefined;
  let editorRepoKey: string | undefined;
  let editorInvoker: HTMLElement | undefined;
  let restoreEditorFocus = false;
  let focusEditor = false;
  let submission: PendingSubmission | undefined;
  let pendingInput: PendingInput | undefined;

  function isPendingInput(value: unknown): value is PendingInput {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }
    const data = value as Record<string, unknown>;
    return typeof data.repoKey === 'string' && !!data.repoKey && typeof data.editorId === 'string' && !!data.editorId
      && typeof data.body === 'string' && typeof data.requestId === 'string' && !!data.requestId;
  }

  function restoreTransport(): void {
    const restored = vscode.getState();
    if (!restored || typeof restored !== 'object' || Array.isArray(restored)) {
      return;
    }
    const saved = restored as Record<string, unknown>;
    if (saved.instanceKey !== instanceKey) {
      return;
    }
    if (!Object.keys(saved).every(key => ['instanceKey', 'input', 'submission'].includes(key))) {
      return;
    }

    if (isPendingInput(saved.input) && Object.keys(saved.input).length === 4) {
      pendingInput = saved.input;
    }
    if (isPendingInput(saved.submission) && Object.keys(saved.submission).length === 5 && 'type' in saved.submission
      && (saved.submission.type === 'saveEdit' || saved.submission.type === 'cancelEdit')) {
      submission = { ...saved.submission, type: saved.submission.type };
    }
  }

  function rememberTransport(): void {
    if (!pendingInput && !submission) {
      vscode.setState(undefined);
      return;
    }
    // Preserve request identities, not just text, across same-instance recreation.
    vscode.setState({ instanceKey, input: pendingInput, submission });
  }

  function captureInput(): PendingInput | undefined {
    if (!editorId || !editorRepoKey) {
      return;
    }
    pendingInput = { repoKey: editorRepoKey, editorId, body: body.value, requestId: crypto.randomUUID() };
    rememberTransport();
    return pendingInput;
  }

  function countLabel(count: number): string {
    return count + (count === 1 ? ' Review Note' : ' Review Notes');
  }

  /**
   * Keyed-list identity for a projection row.
   *
   * Projection ids are scoped to one publication, so the same id names a different row in
   * another folder. Folding the folder into the key replaces nodes across folders instead of
   * reusing them, which would carry focus and animation state into unrelated content.
   */
  function rowKey(repoKey: string | undefined, id: string): string {
    return (repoKey ?? '') + '\u0000' + id;
  }

  function send(type: 'copy' | 'addGeneral' | 'openHistory' | 'closeHistory'): void {
    if (!state?.repoKey || state.busy || state.editor) {
      return;
    }
    vscode.postMessage({ type, repoKey: state.repoKey });
  }

  function sendNote(type: 'open' | 'edit' | 'delete', note: DashboardNote, repoKey: string | undefined,
    node: HTMLElement, invoker?: HTMLElement): void {
    if (!state?.repoKey || state.busy || state.editor || !state.hasFeedback || repoKey !== state.repoKey) {
      return;
    }
    // A detached node belongs to a superseded projection or folder; its handler outlives removal.
    if (!node.isConnected) {
      return;
    }
    if (!state.notes.some(entry => entry.id === note.id)) {
      return;
    }
    if (type === 'edit') {
      editorInvoker = invoker;
      editorRepoKey = state.repoKey;
    }
    vscode.postMessage({ type, repoKey: state.repoKey, noteId: note.id });
  }

  function closeMenu(): void {
    byId('more-menu').hidden = true;
    more.setAttribute('aria-expanded', 'false');
  }

  function closeHistory(): void {
    if (!state || state.hasFeedback || !state.historyVisible) {
      return;
    }
    send('closeHistory');
  }

  function setupToolbarEvents(): void {
    more.addEventListener('click', () => {
      if (!state?.repoKey || state.busy || state.editor) {
        return;
      }
      const opening = byId('more-menu').hidden;
      closeMenu();
      if (opening) {
        byId('more-menu').hidden = false;
        more.setAttribute('aria-expanded', 'true');
        byId('show-archives').focus();
      }
    });
    more.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        more.click();
      }
    });
    byId('more-menu').addEventListener('keydown', event => {
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        byId('show-archives').focus();
      }
      if (event.key === 'Tab') {
        closeMenu();
      }
    });
    byId('show-archives').addEventListener('click', () => {
      if (!state?.repoKey || state.busy || state.editor || byId('more-menu').hidden) {
        return;
      }
      closeMenu();
      more.focus();
      if (state.hasFeedback) {
        byId('archive-unavailable').textContent = 'Restore Last Copied Review Notes is available when there are no current Review Notes in this checkout. Finish your review, then use Copy Review Notes & Clear.';
        byId('archive-unavailable').hidden = false;
        return;
      }
      send('openHistory');
    });
    byId('close-history').addEventListener('click', closeHistory);
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || dialog.open) {
        return;
      }
      if (!byId('more-menu').hidden) {
        event.preventDefault();
        closeMenu();
        more.focus();
      } else if (!byId('history').hidden) {
        event.preventDefault();
        closeHistory();
      }
    });
    byId('add-general').addEventListener('click', () => {
      if (!state?.repoKey || state.busy || state.editor) {
        return;
      }
      editorInvoker = byId('add-general');
      editorRepoKey = state.repoKey;
      send('addGeneral');
    });
    copy.addEventListener('click', () => {
      if (state?.hasFeedback) {
        send('copy');
      }
    });
  }

  function editorControls(): void {
    const blocked = !state || state.busy || submission !== undefined;
    body.disabled = blocked;
    button('save-edit').disabled = blocked || !body.value.trim();
    button('cancel-edit').disabled = blocked;
    button('close-editor').disabled = blocked;
    dialog.setAttribute('aria-busy', String(blocked));
  }

  function sendEditor(type: 'input' | 'saveEdit' | 'cancelEdit'): void {
    const editor = state?.editor;
    if (!state || !editor || state.busy || submission || editor.repoKey !== state.repoKey
      || editor.id !== editorId || editor.repoKey !== editorRepoKey) {
      return;
    }
    if (type === 'saveEdit' && !body.value.trim()) {
      return;
    }
    if (type === 'input') {
      if (pendingInput) {
        vscode.postMessage({ type, ...pendingInput });
      }
      return;
    }
    submission = {
      type, repoKey: editor.repoKey, editorId: editor.id, body: body.value, requestId: crypto.randomUUID(),
    };
    rememberTransport();
    editorControls();
    if (type === 'cancelEdit') {
      vscode.postMessage({ type, repoKey: editor.repoKey, editorId: editor.id, requestId: submission.requestId });
      return;
    }
    vscode.postMessage({ ...submission, type });
  }

  function setupEditorEvents(): void {
    body.addEventListener('input', () => {
      if (submission) {
        body.value = submission.body;
        return;
      }
      captureInput();
      editorControls();
      sendEditor('input');
    });
    byId('save-edit').addEventListener('click', () => sendEditor('saveEdit'));
    byId('cancel-edit').addEventListener('click', () => sendEditor('cancelEdit'));
    byId('close-editor').addEventListener('click', () => sendEditor('cancelEdit'));
    dialog.addEventListener('cancel', event => {
      event.preventDefault();
      sendEditor('cancelEdit');
    });
  }

  function sendFile(type: 'openFile' | 'revertFile' | 'addFileNote' | 'stageFile', file: File,
    repoKey: string | undefined, node: HTMLElement): void {
    if (!state?.repoKey || state.busy || state.editor || file.pending || repoKey !== state.repoKey) {
      return;
    }
    // A detached node belongs to a superseded projection or folder; its handler outlives removal.
    if (!node.isConnected) {
      return;
    }
    if (!state.files.some(entry => entry.id === file.id)) {
      return;
    }
    vscode.postMessage({ type, repoKey: state.repoKey, fileId: file.id });
  }

  /** Change-kind label, per-side counts and the assembled accessible description for a row. */
  function fileLabels(file: File): {
    kind: string;
    counts: { hidden: boolean; text: string }[];
    unknown: { hidden: boolean; text: string };
    description: string;
  } {
    const kind = file.changeKind === 'added' ? 'Added'
      : file.changeKind === 'removed' ? 'Removed'
        : file.changeKind === 'renamed' ? 'Renamed' : '';
    const labels: string[] = kind ? [kind] : [];
    let knownCounts = 0;
    const counts = (['insertions', 'deletions'] as const).map(key => {
      const count = file[key];
      const known = typeof count === 'number' && Number.isSafeInteger(count) && count >= 0;
      if (!known) {
        return { hidden: true, text: '' };
      }
      knownCounts++;
      labels.push(count + ' ' + (count === 1 ? key.slice(0, -1) : key));
      return {
        // Omit redundant zeroes for status-labelled rows, but keep nonzero counts on both
        // sides when a labelled change also modifies content.
        hidden: !!kind && count === 0,
        text: (key === 'insertions' ? '+' : '-') + count,
      };
    });
    const unknown = {
      hidden: knownCounts === 2,
      text: file.statisticsPending ? 'Loading stats' : 'Stats unavailable',
    };
    if (!unknown.hidden) {
      labels.push(unknown.text);
    }
    if (file.visible) {
      labels.push('Visible in editor');
    }
    return { kind, counts, unknown, description: 'Open file: ' + file.path + ', ' + labels.join(', ') };
  }

  function FileRow({ file, repoKey, blocked, exiting }: {
    file: File; repoKey: string | undefined; blocked: boolean; exiting: boolean;
  }): VNode {
    const { kind, counts, unknown, description } = fileLabels(file);
    const disabled = blocked || !!file.pending || exiting;
    const pending = file.pending === 'stage' ? 'Staging file' : file.pending === 'revert' ? 'Reverting file' : '';
    let className = 'file-row';
    if (file.visible) {
      className += ' file-in-editor';
    }
    if (file.pending) {
      className += ' file-pending';
    }
    if (exiting) {
      className += ' file-exiting';
    }
    const action = (type: 'revertFile' | 'addFileNote' | 'stageFile', style: string, label: string, template: string): VNode => (
      <button
        type="button"
        class={'file-action ' + style}
        title={label}
        aria-label={label}
        disabled={disabled}
        ref={iconRef(template)}
        onClick={(event) => sendFile(type, file, repoKey, event.currentTarget)}
      />
    );
    return (
      <li
        class={className}
        aria-busy={!!file.pending}
        inert={exiting}
        aria-hidden={exiting ? 'true' : undefined}
        ref={fileNodeRef(file.id)}
      >
        <button
          type="button"
          class="file-open"
          title={file.path}
          aria-label={description}
          disabled={disabled}
          onClick={(event) => sendFile('openFile', file, repoKey, event.currentTarget)}
        >
          <span class="file-label"><span class="file-name">{file.path.slice(file.path.lastIndexOf('/') + 1)}</span></span>
          <span class="file-insertions" hidden={counts[0].hidden}>{counts[0].text}</span>
          <span class="file-deletions" hidden={counts[1].hidden}>{counts[1].text}</span>
          <span class="muted" hidden={unknown.hidden}>{unknown.text}</span>
          <span class="file-change-kind" hidden={!kind}>{kind}</span>
        </button>
        {action('revertFile', 'file-revert', 'Revert File', 'revert-icon')}
        {action('addFileNote', 'file-note', 'Add File Review Note', 'note-icon')}
        {action('stageFile', 'file-stage', 'Stage File', 'stage-icon')}
        <span class="file-progress" role="status" hidden={!file.pending}>{pending}</span>
      </li>
    );
  }

  /**
   * Collapses a row that left the list, then drops it.
   *
   * The row stays rendered and inert until the animation settles so the list does not jump. A
   * row that reappears meanwhile cancels its animation and is reused, which is why the entry —
   * not the node — decides whether a settlement may still remove anything.
   */
  function collapseFileRow(id: string, entry: ExitingFile, node: HTMLLIElement): void {
    const height = node.getBoundingClientRect().height;
    const style = window.getComputedStyle(node);
    // Border-box height alone cannot collapse padding/borders. Block layout keeps
    // the content from recentering or shrinking while the outer row is clipped.
    const animation = node.animate([
      {
        height: height + 'px', opacity: 1,
        paddingTop: style.paddingTop, paddingBottom: style.paddingBottom,
        marginTop: style.marginTop, marginBottom: style.marginBottom,
        borderTopWidth: style.borderTopWidth, borderBottomWidth: style.borderBottomWidth,
      },
      {
        height: '0px', opacity: 0, paddingTop: '0px', paddingBottom: '0px',
        marginTop: '0px', marginBottom: '0px', borderTopWidth: '0px', borderBottomWidth: '0px',
      },
    ], { duration: 160, easing: 'ease-out', fill: 'forwards' });
    entry.animation = animation;
    const cleanup = (): void => {
      if (exitingFiles.get(id)?.animation !== animation) {
        return;
      }
      exitingFiles.delete(id);
      animation.cancel();
      refreshFiles();
    };
    void animation.finished.then(cleanup, cleanup);
  }

  /** Re-renders the file list alone, for exits that settle between host publications. */
  function refreshFiles(): void {
    if (state) {
      renderFiles(state, state.busy || !!state.editor);
    }
  }

  function renderFiles(current: DashboardState, blocked: boolean): void {
    byId('files-section').hidden = !current.repoKey;
    byId('files-error').textContent = current.filesError || '';
    byId('files-error').hidden = !current.filesError;
    const files = current.repoKey ? current.files : [];
    byId('files-title').textContent = 'Files to Review (' + files.length + ')';
    byId('no-files').hidden = files.length > 0;

    const live = new Set(files.map(file => file.id));
    for (const [id, entry] of exitingFiles) {
      // A row that came back cancels its exit and is reused, keeping focus and identity.
      if (live.has(id)) {
        entry.animation?.cancel();
        exitingFiles.delete(id);
      }
    }
    if (!reducedMotion.matches) {
      renderedFiles.forEach((file, index) => {
        if (!live.has(file.id) && !exitingFiles.has(file.id)) {
          exitingFiles.set(file.id, { file, index });
        }
      });
    }
    renderedFiles = files;

    const rows = files.map(file => ({ file, exiting: false }));
    for (const entry of [...exitingFiles.values()].sort((a, b) => a.index - b.index)) {
      rows.splice(Math.min(entry.index, rows.length), 0, { file: entry.file, exiting: true });
    }
    renderInto(
      <>
        {rows.map(row => (
          <FileRow
            key={rowKey(current.repoKey, row.file.id)}
            file={row.file}
            repoKey={current.repoKey}
            blocked={blocked}
            exiting={row.exiting}
          />
        ))}
      </>,
      byId('files'),
    );

    // Animations start after the render that marks a row inert, so the collapse measures the
    // row as the user last saw it.
    for (const [id, entry] of exitingFiles) {
      const node = fileNodes.get(id);
      if (!entry.animation && node) {
        collapseFileRow(id, entry, node);
      }
    }
  }
  /** Display strings for a note card: list label, full target and what opening it does. */
  function noteLabels(note: DashboardNote): { label: string; target: string; destination: string } {
    if (note.general) {
      return { label: 'General Review Note', target: 'General Review Note', destination: 'Edit Review Note' };
    }
    const range = note.startLine === note.endLine ? String(note.startLine) : note.startLine + '-' + note.endLine;
    const name = note.path.slice(note.path.lastIndexOf('/') + 1);
    let destination = note.comparison ? 'Open code comparison' : 'Go to code';
    if (note.stale && !note.wholeFile) {
      destination = 'Open saved Review Note';
    }
    return note.wholeFile
      ? { label: name, target: note.path, destination }
      : { label: name + ':' + range, target: note.path + ':' + range, destination };
  }

  function NoteCard({ note, repoKey, blocked }: {
    note: DashboardNote; repoKey: string | undefined; blocked: boolean;
  }): VNode {
    const { label, target, destination } = noteLabels(note);
    const preview = note.preview.split(/\r\n|\r|\n/, 2).join('\n');
    return (
      <li class="note-card">
        <button
          type="button"
          class="note-open"
          title={destination + ': ' + target}
          aria-description={destination}
          disabled={blocked}
          onClick={(event) => sendNote(note.general ? 'edit' : 'open', note, repoKey,
            event.currentTarget, event.currentTarget)}
        >
          <span class="note-title">{label}</span>
          <span class="note-preview" hidden={!preview}>{preview}</span>
        </button>
        <button
          type="button"
          class="note-action note-edit"
          title="Edit Review Note"
          aria-label="Edit Review Note"
          disabled={blocked}
          ref={iconRef('edit-icon')}
          onClick={(event) => sendNote('edit', note, repoKey, event.currentTarget, event.currentTarget)}
        />
        <button
          type="button"
          class="note-action note-delete"
          title="Delete Review Note"
          aria-label="Delete Review Note"
          disabled={blocked}
          ref={iconRef('delete-icon')}
          onClick={(event) => sendNote('delete', note, repoKey, event.currentTarget)}
        />
      </li>
    );
  }

  function renderNotes(current: DashboardState, blocked: boolean): void {
    const notes = current.repoKey && current.hasFeedback ? current.notes : [];
    renderInto(
      <>
        {notes.map(note => (
          <NoteCard key={rowKey(current.repoKey, note.id)} note={note} repoKey={current.repoKey} blocked={blocked} />
        ))}
      </>,
      byId('notes'),
    );
  }

  function restoreArchive(archive: Archive, repoKey: string | undefined, node: HTMLElement): void {
    if (!state?.repoKey || state.busy || state.editor || !state.historyVisible || state.hasFeedback) {
      return;
    }
    // A detached node is a row from a superseded projection or folder; its handler survives
    // removal, so reachability is checked rather than assumed.
    if (byId('history').hidden || repoKey !== state.repoKey || !node.isConnected) {
      return;
    }
    if (!state.archives.slice(0, 10).some(entry => entry.id === archive.id)) {
      return;
    }
    vscode.postMessage({ type: 'restore', repoKey: state.repoKey, archiveId: archive.id });
  }

  function ArchiveItem({ archive, repoKey, current, blocked }: {
    archive: Archive; repoKey: string | undefined; current: DashboardState; blocked: boolean;
  }): VNode {
    const date = new Date(archive.createdAt);
    const valid = !Number.isNaN(date.getTime());
    const label = valid ? date.toLocaleString() : 'Unknown date';
    const count = countLabel(archive.commentCount);
    return (
      <li>
        <div class="archive-details">
          <time datetime={valid ? date.toISOString() : undefined}>{label}</time>
          <span class="archive-count muted">{count}</span>
        </div>
        <button
          type="button"
          disabled={blocked || !current.historyVisible || current.hasFeedback || !current.repoKey}
          aria-label={'Restore ' + count + ' from ' + label}
          onClick={(event) => restoreArchive(archive, repoKey, event.currentTarget)}
        >Restore</button>
      </li>
    );
  }

  function renderArchives(current: DashboardState, blocked: boolean): void {
    const archives = current.repoKey ? current.archives.slice(0, 10) : [];
    byId('no-archives').hidden = archives.length > 0;
    renderInto(
      <>
        {archives.map(archive => (
          <ArchiveItem
            key={rowKey(current.repoKey, archive.id)}
            archive={archive}
            repoKey={current.repoKey}
            current={current}
            blocked={blocked}
          />
        ))}
      </>,
      byId('archives'),
    );
  }

  function focusable(element: Element | null | undefined): element is HTMLElement {
    return !!element && element.isConnected && !('disabled' in element && element.disabled) && !element.closest('[hidden]');
  }

  function synchronizeEditor(current: DashboardState, wasBusy: boolean): void {
    const editor = current.editor?.repoKey === current.repoKey ? current.editor : undefined;
    if (!editor) {
      pendingInput = undefined;
      submission = undefined;
      rememberTransport();
      if (editorId !== undefined) {
        editorId = undefined;
        focusEditor = false;
        dialog.close();
        body.value = '';
        byId('editor-error').textContent = '';
        restoreEditorFocus = true;
      }
      return;
    }

    const newSession = editorId !== editor.id || editorRepoKey !== editor.repoKey;
    byId('editor-title').textContent = editor.title;
    byId('editor-error').textContent = editor.error || '';
    byId('editor-error').hidden = !editor.error;
    if (newSession) {
      if (editorRepoKey !== editor.repoKey) {
        editorInvoker = undefined;
      }
      editorId = editor.id;
      editorRepoKey = editor.repoKey;
      restoreEditorFocus = false;
      if (pendingInput?.editorId !== editor.id || pendingInput.repoKey !== editor.repoKey) {
        pendingInput = undefined;
      }
      if (submission?.editorId !== editor.id || submission.repoKey !== editor.repoKey) {
        submission = undefined;
      }
      rememberTransport();

      body.value = submission?.body ?? pendingInput?.body ?? editor.body;
      if (!dialog.open) {
        dialog.showModal();
      }
      focusEditor = true;
    }

    editorControls();
    if (wasBusy && !current.busy) {
      focusEditor = true;
    }
    if (focusEditor && !body.disabled) {
      body.focus();
      focusEditor = false;
    }
    // A busy rejection leaves the local buffer intact. Retry only on resuming
    // or reconstruction, not on arbitrary stale body publications.
    if ((newSession || wasBusy) && !current.busy && pendingInput && !submission) {
      sendEditor('input');
    }
    if (newSession && submission) {
      // A cached Save/Cancel may never have reached the old view's listener.
      // Reconcile only after scope/session validation, even while the host is busy.
      vscode.postMessage({
        type: 'editorRequestStatus',
        repoKey: submission.repoKey,
        editorId: submission.editorId,
        requestId: submission.requestId,
      });
    }
  }

  function restoreInvokerFocus(current: DashboardState): void {
    if (!restoreEditorFocus || current.busy) {
      return;
    }
    if (editorRepoKey === current.repoKey) {
      if (focusable(editorInvoker)) {
        editorInvoker.focus({ preventScroll: true });
      } else if (!button('add-general').disabled) {
        byId('add-general').focus({ preventScroll: true });
      }
    }
    restoreEditorFocus = false;
    editorInvoker = undefined;
  }

  function renderToolbar(current: DashboardState, blocked: boolean): void {
    byId('dashboard').setAttribute('aria-busy', String(current.busy));
    byId('count').textContent = countLabel(current.commentCount);
    copy.hidden = !current.repoKey || !current.hasFeedback;
    copy.disabled = blocked || !current.repoKey || !current.hasFeedback;
    button('add-general').disabled = blocked || !current.repoKey;
    more.disabled = blocked || !current.repoKey;
    button('show-archives').disabled = blocked || !current.repoKey;
    byId('show-archives').setAttribute('aria-disabled', String(blocked || !current.repoKey || current.hasFeedback));
    if (!current.hasFeedback || renderedRepoKey !== current.repoKey) {
      byId('archive-unavailable').hidden = true;
      byId('archive-unavailable').textContent = '';
    }
    button('close-history').disabled = blocked || !current.repoKey || current.hasFeedback;
    if (blocked || renderedRepoKey !== current.repoKey) {
      closeMenu();
    }
  }

  function renderHistoryVisibility(current: DashboardState, blocked: boolean, focused: Element | null): void {
    const historyWasVisible = !byId('history').hidden;
    byId('history').hidden = !current.historyVisible || !current.repoKey || current.hasFeedback || !!current.editor;
    if (historyWasVisible !== !byId('history').hidden && !blocked) {
      if (!byId('history').hidden) {
        byId('close-history').focus();
      } else if (renderedRepoKey === current.repoKey && !more.disabled && byId('history').contains(focused)) {
        more.focus();
      }
    }
  }

  function renderFeedbackStatus(current: DashboardState): void {
    byId('empty').hidden = current.hasFeedback;
    byId('empty').textContent = current.repoKey
      ? 'No current Review Notes. Add a general Review Note or a Review Note in the editor.'
      : 'Open a local project folder in VS Code to start reviewing.';
    byId('error').textContent = current.error || '';
    byId('error').hidden = !current.error;
    byId('note-error').textContent = current.noteError || '';
    byId('note-error').hidden = !current.noteError;
  }

  function clearRowsForFolder(repoKey: string | undefined): void {
    if (renderedRepoKey === repoKey) {
      return;
    }
    // Rows themselves are replaced by the folder-scoped keys; only the exit bookkeeping, which
    // would otherwise resurrect a previous folder's row, has to be dropped explicitly.
    for (const { animation } of exitingFiles.values()) {
      animation?.cancel();
    }
    exitingFiles.clear();
    renderedFiles = [];
    renderedRepoKey = repoKey;
  }

  function render(current: DashboardState): void {
    const wasBusy = state?.busy ?? false;
    state = current;
    const focused = document.activeElement;
    const historyWasVisible = !byId('history').hidden;
    const blocked = current.busy || !!current.editor;

    renderToolbar(current, blocked);
    renderHistoryVisibility(current, blocked, focused);
    renderFeedbackStatus(current);
    clearRowsForFolder(current.repoKey);
    renderFiles(current, blocked);
    renderNotes(current, blocked);
    renderArchives(current, blocked);
    if (historyWasVisible === !byId('history').hidden && !dialog.open && !current.editor
      && focused !== document.activeElement && focusable(focused)) {
      focused.focus({ preventScroll: true });
    }
    synchronizeEditor(current, wasBusy);
    restoreInvokerFocus(current);
  }

  function receiveHostMessage(event: MessageEvent<unknown>): void {
    const message = event.data;
    if (!validHostMessage(message)) {
      return;
    }
    switch (message.type) {
      case 'state':
        render(message.state);
        return;
      case 'inputAccepted':
        if (message.repoKey === pendingInput?.repoKey && message.editorId === pendingInput.editorId
          && message.requestId === pendingInput.requestId) {
          pendingInput = undefined;
          rememberTransport();
        }
        return;
      case 'editorSettled':
        if (!submission || message.repoKey !== submission.repoKey || message.editorId !== submission.editorId
          || message.requestId !== submission.requestId) {
          return;
        }
        submission = undefined;
        // A rejected Save may contain text whose input message was never accepted.
        // Resync it as a new input request, never automatically resubmit Save/Cancel.
        captureInput();
        rememberTransport();
        focusEditor = true;
        if (state) {
          synchronizeEditor(state, true);
          restoreInvokerFocus(state);
        }
        return;
    }
  }

  restoreTransport();
  setupToolbarEvents();
  setupEditorEvents();
  reducedMotion.addEventListener('change', () => {
    if (!reducedMotion.matches) {
      return;
    }
    for (const { animation } of exitingFiles.values()) {
      animation?.cancel();
    }
    exitingFiles.clear();
    refreshFiles();
  });
  window.addEventListener('message', receiveHostMessage);
  vscode.postMessage({ type: 'ready' });
}
