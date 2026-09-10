/// <reference lib="dom" />
import type { DashboardHostMessage, DashboardMessage, DashboardNote, DashboardState } from "./dashboard";

type PendingInput = { repoKey: string; editorId: string; body: string; requestId: string };
type PendingSubmission = PendingInput & { type: 'saveEdit' | 'cancelEdit' };
type TransportCache = { instanceKey: string; input?: PendingInput; submission?: PendingSubmission };
type WebviewApi = {
  postMessage(message: DashboardMessage): void;
  getState(): unknown;
  setState(state: TransportCache | undefined): void;
};

/** Runtime boundary for host publications; serialized alongside the client without imports. */
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
    return record(data) && keys(data, ['id', 'path'], ['insertions', 'deletions'])
      && text(data.id) && typeof data.path === 'string'
      && (data.insertions === undefined || count(data.insertions))
      && (data.deletions === undefined || count(data.deletions));
  }
  function note(data: unknown): boolean {
    if (!record(data) || !text(data.id) || typeof data.preview !== 'string') {
      return false;
    }
    if (data.general === true) {
      return keys(data, ['id', 'general', 'preview']);
    }
    return keys(data, ['id', 'path', 'startLine', 'endLine', 'preview', 'stale', 'comparison'], ['general'])
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

/** Serialized after TypeScript compilation; keep all runtime dependencies inside this function. */
export function dashboardClient(
  acquireVsCodeApi: () => WebviewApi,
  instanceKey: string,
  validHostMessage: typeof isDashboardHostMessage,
): void {
  type File = DashboardState["files"][number];
  type Archive = DashboardState["archives"][number];
  type FileRow = {
    item: HTMLLIElement;
    open: HTMLButtonElement;
    revert: HTMLButtonElement;
    stage: HTMLButtonElement;
    name: HTMLSpanElement;
    insertions: HTMLSpanElement;
    deletions: HTMLSpanElement;
    unknown: HTMLSpanElement;
    current: File;
    repoKey: string | undefined;
  };
  type NoteRow = {
    item: HTMLLIElement;
    open: HTMLButtonElement;
    edit: HTMLButtonElement;
    remove: HTMLButtonElement;
    title: HTMLSpanElement;
    preview: HTMLSpanElement;
    current: DashboardNote;
    repoKey: string | undefined;
  };
  type ArchiveRow = {
    item: HTMLLIElement;
    date: HTMLTimeElement;
    count: HTMLSpanElement;
    recover: HTMLButtonElement;
    current: Archive;
    repoKey: string | undefined;
  };

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
  const copy = button('copy');
  const more = button('more');
  const dialog = byId('note-editor') as HTMLDialogElement;
  const body = byId('editor-body') as HTMLTextAreaElement;
  const noteRows = new Map<string, NoteRow>();
  const fileRows = new Map<string, FileRow>();
  const archiveRows = new Map<string, ArchiveRow>();
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
    return count + (count === 1 ? ' review note' : ' review notes');
  }

  function send(type: 'copy' | 'addGeneral' | 'openHistory' | 'closeHistory'): void {
    if (!state?.repoKey || state.busy || state.editor) {
      return;
    }
    vscode.postMessage({ type, repoKey: state.repoKey });
  }

  function sendNote(type: 'open' | 'edit' | 'delete', row: NoteRow, invoker?: HTMLElement): void {
    if (!state?.repoKey || state.busy || state.editor || !state.hasFeedback || row.repoKey !== state.repoKey) {
      return;
    }
    if (!row.item.isConnected || noteRows.get(row.current.id) !== row) {
      return;
    }
    if (!state.notes.some(note => note.id === row.current.id)) {
      return;
    }
    if (type === 'edit') {
      editorInvoker = invoker;
      editorRepoKey = state.repoKey;
    }
    vscode.postMessage({ type, repoKey: state.repoKey, noteId: row.current.id });
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
        byId('archive-unavailable').textContent = 'Recent Archives are available when there are no current saved Review Notes. Finish your review, then use Copy Review Notes & Clear to view or recover an earlier batch.';
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

  function sendFile(type: 'openFile' | 'revertFile' | 'stageFile', row: FileRow): void {
    if (!state?.repoKey || state.busy || state.editor || row.repoKey !== state.repoKey) {
      return;
    }
    if (!row.item.isConnected || fileRows.get(row.current.id) !== row) {
      return;
    }
    if (!state.files.some(file => file.id === row.current.id)) {
      return;
    }
    vscode.postMessage({ type, repoKey: state.repoKey, fileId: row.current.id });
  }

  function createFileRow(file: File, repoKey: string | undefined): FileRow {
    const item = document.createElement('li');
    item.className = 'file-row';
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'file-open';
    const name = document.createElement('span');
    name.className = 'file-name';
    const insertions = document.createElement('span');
    insertions.className = 'file-insertions';
    const deletions = document.createElement('span');
    deletions.className = 'file-deletions';
    const unknown = document.createElement('span');
    unknown.className = 'muted';
    unknown.textContent = 'Stats unavailable';
    open.append(name, insertions, deletions, unknown);

    const revert = document.createElement('button');
    revert.type = 'button';
    revert.className = 'file-action file-revert';
    revert.title = 'Revert File';
    revert.setAttribute('aria-label', 'Revert File');
    revert.append(icon('revert-icon'));
    const stage = document.createElement('button');
    stage.type = 'button';
    stage.className = 'file-action file-stage';
    stage.title = 'Stage File';
    stage.setAttribute('aria-label', 'Stage File');
    stage.append(icon('stage-icon'));
    item.append(open, revert, stage);

    const row: FileRow = {
      item, open, revert, stage, name, insertions, deletions, unknown, current: file, repoKey,
    };
    open.addEventListener('click', () => sendFile('openFile', row));
    revert.addEventListener('click', () => sendFile('revertFile', row));
    stage.addEventListener('click', () => sendFile('stageFile', row));
    return row;
  }

  function updateFileRow(row: FileRow, file: File, blocked: boolean): void {
    row.current = file;
    row.name.textContent = file.path.slice(file.path.lastIndexOf('/') + 1);
    row.open.title = file.path;

    const labels: string[] = [];
    for (const key of ['insertions', 'deletions'] as const) {
      const count = file[key];
      const known = typeof count === 'number' && Number.isSafeInteger(count) && count >= 0;
      row[key].hidden = !known;
      if (known) {
        const sign = key === 'insertions' ? '+' : '-';
        row[key].textContent = sign + count;
        labels.push(count + ' ' + (count === 1 ? key.slice(0, -1) : key));
      } else {
        row[key].textContent = '';
      }
    }
    row.unknown.hidden = labels.length === 2;
    if (!row.unknown.hidden) {
      labels.push('Stats unavailable');
    }
    row.open.setAttribute('aria-label', 'Open file: ' + file.path + ', ' + labels.join(', '));
    row.open.disabled = blocked;
    row.revert.disabled = blocked;
    row.stage.disabled = blocked;
  }

  function renderFiles(current: DashboardState, blocked: boolean): void {
    const list = byId('files');
    byId('files-section').hidden = !current.repoKey;
    byId('files-error').textContent = current.filesError || '';
    byId('files-error').hidden = !current.filesError;
    const files = current.repoKey ? current.files : [];
    byId('no-files').hidden = files.length > 0;
    const ids = new Set(files.map(file => file.id));
    for (const [id, row] of fileRows) {
      if (!ids.has(id)) {
        row.item.remove();
        fileRows.delete(id);
      }
    }
    files.forEach((file, index) => {
      let row = fileRows.get(file.id);
      if (!row) {
        row = createFileRow(file, current.repoKey);
        fileRows.set(file.id, row);
      }
      updateFileRow(row, file, blocked);
      if (list.children[index] !== row.item) {
        list.insertBefore(row.item, list.children[index] || null);
      }
    });
  }

  function createNoteRow(note: DashboardNote, repoKey: string | undefined): NoteRow {
    const item = document.createElement('li');
    item.className = 'note-card';
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'note-open';
    const title = document.createElement('span');
    title.className = 'note-title';
    const preview = document.createElement('span');
    preview.className = 'note-preview';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'note-action note-delete';
    remove.title = 'Delete Review Note';
    remove.setAttribute('aria-label', 'Delete Review Note');
    remove.append(icon('delete-icon'));
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'note-action note-edit';
    edit.title = 'Edit Review Note';
    edit.setAttribute('aria-label', 'Edit Review Note');
    edit.append(icon('edit-icon'));
    open.append(title, preview);
    item.append(open, edit, remove);

    const row: NoteRow = { item, open, title, preview, edit, remove, current: note, repoKey };
    open.addEventListener('click', () => sendNote(row.current.general ? 'edit' : 'open', row, open));
    edit.addEventListener('click', () => sendNote('edit', row, edit));
    remove.addEventListener('click', () => sendNote('delete', row));
    return row;
  }

  function updateNoteRow(row: NoteRow, note: DashboardNote, blocked: boolean): void {
    row.current = note;
    let label = 'General Review Note';
    let target = label;
    let destination = 'Edit Review Note';
    if (!note.general) {
      const range = note.startLine === note.endLine ? String(note.startLine) : note.startLine + '-' + note.endLine;
      label = note.path.slice(note.path.lastIndexOf('/') + 1) + ':' + range;
      target = note.path + ':' + range;
      destination = 'Go to code';
      if (note.comparison) {
        destination = 'Open code comparison';
      }
      if (note.stale) {
        destination = 'Open saved Review Note';
      }
    }

    row.title.textContent = label;
    row.preview.textContent = note.preview.split(/\r\n|\r|\n/, 2).join('\n');
    row.preview.hidden = !row.preview.textContent;
    row.open.title = destination + ': ' + target;
    row.open.setAttribute('aria-description', destination);
    row.open.disabled = blocked;
    row.edit.disabled = blocked;
    row.remove.disabled = blocked;
  }

  function renderNotes(current: DashboardState, blocked: boolean): void {
    const list = byId('notes');
    const notes = current.repoKey && current.hasFeedback ? current.notes : [];
    const ids = new Set(notes.map(note => note.id));
    for (const [id, row] of noteRows) {
      if (!ids.has(id)) {
        row.item.remove();
        noteRows.delete(id);
      }
    }
    notes.forEach((note, index) => {
      let row = noteRows.get(note.id);
      if (!row) {
        row = createNoteRow(note, current.repoKey);
        noteRows.set(note.id, row);
      }
      updateNoteRow(row, note, blocked);
      if (list.children[index] !== row.item) {
        list.insertBefore(row.item, list.children[index] || null);
      }
    });
  }

  function createArchiveRow(archive: Archive, repoKey: string | undefined): ArchiveRow {
    const item = document.createElement('li');
    const details = document.createElement('div');
    details.className = 'archive-details';
    const date = document.createElement('time');
    const count = document.createElement('span');
    count.className = 'archive-count muted';
    const recover = document.createElement('button');
    recover.type = 'button';
    recover.textContent = 'Recover';

    const row: ArchiveRow = { item, date, count, recover, current: archive, repoKey };
    recover.addEventListener('click', () => {
      if (!state?.repoKey || state.busy || state.editor || !state.historyVisible || state.hasFeedback) {
        return;
      }
      if (byId('history').hidden || row.repoKey !== state.repoKey || archiveRows.get(row.current.id) !== row) {
        return;
      }
      if (!state.archives.slice(0, 10).some(entry => entry.id === row.current.id)) {
        return;
      }
      vscode.postMessage({ type: 'restore', repoKey: state.repoKey, archiveId: row.current.id });
    });
    details.append(date, count);
    item.append(details, recover);
    return row;
  }

  function updateArchiveRow(row: ArchiveRow, archive: Archive, current: DashboardState, blocked: boolean): void {
    row.current = archive;
    const date = new Date(archive.createdAt);
    const validDate = !Number.isNaN(date.getTime());
    row.date.textContent = validDate ? date.toLocaleString() : 'Unknown date';
    if (validDate) {
      row.date.dateTime = date.toISOString();
    } else {
      row.date.removeAttribute('datetime');
    }
    row.count.textContent = countLabel(archive.commentCount);
    row.recover.disabled = blocked || !current.historyVisible || current.hasFeedback || !current.repoKey;
    row.recover.setAttribute('aria-label', 'Recover ' + countLabel(archive.commentCount) + ' from ' + row.date.textContent);
  }

  function renderArchives(current: DashboardState, blocked: boolean): void {
    const list = byId('archives');
    const archives = current.repoKey ? current.archives.slice(0, 10) : [];
    byId('no-archives').hidden = archives.length > 0;
    const ids = new Set(archives.map(archive => archive.id));
    for (const [id, row] of archiveRows) {
      if (!ids.has(id)) {
        row.item.remove();
        archiveRows.delete(id);
      }
    }
    archives.forEach((archive, index) => {
      let row = archiveRows.get(archive.id);
      if (!row) {
        row = createArchiveRow(archive, current.repoKey);
        archiveRows.set(archive.id, row);
      }
      updateArchiveRow(row, archive, current, blocked);
      if (list.children[index] !== row.item) {
        list.insertBefore(row.item, list.children[index] || null);
      }
    });
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
      ? 'No current review notes. Add a general review note or a review note in the editor.'
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
    for (const row of archiveRows.values()) {
      row.item.remove();
    }
    archiveRows.clear();
    for (const row of noteRows.values()) {
      row.item.remove();
    }
    noteRows.clear();
    for (const row of fileRows.values()) {
      row.item.remove();
    }
    fileRows.clear();
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
  window.addEventListener('message', receiveHostMessage);
  vscode.postMessage({ type: 'ready' });
}
