import { dashboardClient, isDashboardHostMessage } from "./dashboardClient";

/** Static shell only: metadata and explicit editor text arrive over postMessage, never inside script source. */
export function renderDashboard(nonce: string, instanceKey = nonce): string {
  if (!/^[A-Za-z0-9_-]+$/.test(nonce)) {
    throw new Error("Invalid dashboard nonce");
  }
  if (!/^[A-Za-z0-9_-]+$/.test(instanceKey)) {
    throw new Error("Invalid dashboard instance key");
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none';">
  <title>Review Notes</title>
  <style nonce="${nonce}">
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 12px;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      overflow-wrap: anywhere;
    }
    [hidden] { display: none !important; }
    main, section { min-width: 0; }
    h2 { font-size: 1em; margin: 16px 0 8px; }
    p { line-height: 1.5; margin: 8px 0; }
    .muted { color: var(--vscode-descriptionForeground); }
    button {
      font: inherit;
      white-space: normal;
      overflow-wrap: anywhere;
      max-width: 100%;
      min-width: 0;
      cursor: pointer;
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 2px;
      padding: 6px 10px;
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }
    button:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
    button:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
    button:disabled { cursor: default; }
    #show-archives[aria-disabled="true"] { color: var(--vscode-disabledForeground); }
    #copy {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      min-height: 48px;
      margin: 12px 0 8px;
      padding: 12px;
      text-align: center;
      font-size: 1.15em;
      font-weight: 600;
      line-height: 1.4;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
    }
    #copy:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
    #error, #note-error, #files-error, #editor-error { color: var(--vscode-errorForeground); }
    .toolbar { display: flex; gap: 8px; align-items: start; position: relative; }
    #add-general { flex: 1; text-align: left; }
    #more { flex: 0 0 32px; padding: 6px; }
    #more-menu {
      position: absolute; right: 0; top: 100%; z-index: 1; padding: 6px;
      max-width: 100%; background: var(--vscode-menu-background, var(--vscode-editor-background));
      border: 1px solid var(--vscode-contrastBorder, var(--vscode-widget-border));
    }
    .section-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    dialog {
      width: min(560px, calc(100% - 24px)); max-width: calc(100% - 24px);
      max-height: calc(100% - 24px); overflow: auto; padding: 16px;
      color: var(--vscode-foreground); background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-contrastBorder, var(--vscode-widget-border));
      border-radius: 4px; box-shadow: 0 4px 16px var(--vscode-widget-shadow);
    }
    dialog::backdrop { background: rgba(0, 0, 0, 0.4); }
    dialog h2 { margin: 0; }
    #editor-body {
      display: block; width: 100%; min-height: 160px; height: 40vh; max-height: 60vh;
      resize: vertical; margin: 8px 0; padding: 8px; font: inherit;
      color: var(--vscode-input-foreground); background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--vscode-contrastBorder, transparent));
    }
    #editor-body:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
    .editor-actions { display: flex; flex-wrap: wrap; justify-content: end; gap: 8px; }
    #save-edit { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    #save-edit:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
    ul { list-style: none; padding: 0; margin: 0; }
    li {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      padding: 10px 0;
      border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-sideBarSectionHeader-border, transparent));
    }
    .archive-details { flex: 1 1 130px; min-width: 0; }
    time, .archive-count { display: block; }
    .file-row { position: relative; }
    .file-open {
      padding-right: 70px;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      width: 100%;
      text-align: left;
      color: var(--vscode-foreground);
      background: transparent;
      border-color: var(--vscode-contrastBorder, transparent);
    }
    .file-open:hover { background: var(--vscode-list-hoverBackground); }
    .file-action {
      position: absolute;
      right: 4px;
      top: 50%;
      transform: translateY(-50%);
      width: 28px;
      height: 28px;
      padding: 6px;
      opacity: 0;
      color: var(--vscode-icon-foreground);
      background: var(--vscode-sideBar-background);
    }
    .file-revert { right: 36px; }
    .file-row:hover .file-action, .file-row:focus-within .file-action { opacity: 1; }
    .file-action svg { display: block; width: 14px; height: 14px; fill: currentColor; }
    .file-name { flex: 1 1 100px; min-width: 0; }
    .file-insertions { color: var(--vscode-gitDecoration-addedResourceForeground, #2ea043); }
    .file-deletions { color: var(--vscode-gitDecoration-deletedResourceForeground, #f85149); }
    #notes { display: grid; gap: 10px; margin-top: 12px; }
    .note-card {
      position: relative;
      display: block;
      min-width: 0;
      padding: 0;
      border: 1px solid var(--vscode-contrastBorder, var(--vscode-widget-border, var(--vscode-sideBarSectionHeader-border, transparent)));
      border-radius: 3px;
      background: var(--vscode-editor-background);
    }
    .note-open {
      display: block;
      width: 100%;
      padding: 10px;
      text-align: left;
      line-height: 1.4;
      color: var(--vscode-foreground);
      background: transparent;
      border-color: transparent;
    }
    .note-open:hover:not(:disabled) { background: var(--vscode-list-hoverBackground); color: var(--vscode-list-hoverForeground); }
    .note-title {
      display: block;
      padding-right: 60px;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .note-preview {
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
      line-clamp: 2;
      max-height: 2.8em;
      overflow: hidden;
      margin-top: 8px;
      white-space: pre-wrap;
    }
    .note-action {
      position: absolute;
      top: 5px;
      right: 5px;
      width: 28px;
      height: 28px;
      padding: 6px;
      opacity: 0;
      color: var(--vscode-icon-foreground);
      background: transparent;
    }
    .note-edit { right: 37px; }
    .note-action:disabled { opacity: 0; }
    .note-card:hover .note-action, .note-card:focus-within .note-action { opacity: 1; }
    .note-action svg { display: block; width: 14px; height: 14px; fill: currentColor; }
    @media (max-width: 220px) {
      body { padding: 8px; }
      #archives li button { width: 100%; }
    }
  </style>
</head>
<body>
  <main id="dashboard" aria-busy="false">
    <div id="toolbar" class="toolbar" role="group" aria-label="Review Note actions">
      <button id="add-general" type="button" disabled>Add General Review Note</button>
      <button id="more" type="button" title="More actions" aria-label="More actions" aria-haspopup="menu" aria-expanded="false" aria-controls="more-menu" disabled>...</button>
      <div id="more-menu" role="menu" aria-label="More actions" hidden>
        <button id="show-archives" type="button" role="menuitem" aria-controls="history">Recent Archives</button>
      </div>
    </div>
    <p id="archive-unavailable" class="muted" role="status" hidden></p>
    <button id="copy" type="button" title="Copies your review notes to the clipboard, archives this batch, and clears the current review notes." aria-description="Copies your review notes to the clipboard, archives this batch, and clears the current review notes." hidden disabled>Copy Review Notes &amp; Clear</button>
    <section id="files-section" aria-labelledby="files-title" hidden>
      <h2 id="files-title">Files to Review</h2>
      <p id="files-error" role="alert" hidden></p>
      <p id="no-files" class="muted">No files to review.</p>
      <ul id="files" aria-label="Files to Review"></ul>
    </section>
    <p id="count" role="status" aria-live="polite">0 review notes</p>
    <p id="empty" class="muted">Open a local project folder in VS Code to start reviewing.</p>
    <p id="note-error" role="alert" hidden></p>
    <ul id="notes" aria-label="Review Notes"></ul>
    <p id="error" role="alert" hidden></p>
    <section id="history" aria-labelledby="history-title" hidden>
      <div class="section-heading">
        <h2 id="history-title">Recent Archives</h2>
        <button id="close-history" type="button" aria-label="Close archives" title="Close archives">Close</button>
      </div>
      <p class="muted">Recover a batch to make its review notes active again.</p>
      <p id="no-archives" class="muted">No archived batches yet.</p>
      <ul id="archives" aria-label="Archived review note batches"></ul>
    </section>
  </main>
  <dialog id="note-editor" aria-labelledby="editor-title">
    <div class="section-heading">
      <h2 id="editor-title">Edit Review Note</h2>
      <button id="close-editor" type="button" aria-label="Close Review Note editor" title="Close Review Note editor">Close</button>
    </div>
    <label id="editor-label" for="editor-body">Review Note</label>
    <textarea id="editor-body" aria-labelledby="editor-label"></textarea>
    <p id="editor-error" role="alert" hidden></p>
    <div class="editor-actions">
      <button id="cancel-edit" type="button">Cancel</button>
      <button id="save-edit" type="button" disabled>Save Review Note</button>
    </div>
  </dialog>
  <template id="edit-icon"><svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="m11 1 4 4-9 9H2v-4l9-9zm0 2-8 8v2h2l8-8-2-2z"/></svg></template>
  <template id="delete-icon"><svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M6 1h4l1 2h3v1H2V3h3l1-2zm0 2h4l-.5-1h-3L6 3zM3 5h1v9h8V5h1v9l-1 1H4l-1-1V5zm3 1h1v6H6V6zm3 0h1v6H9V6z"/></svg></template>
  <template id="revert-icon"><svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M5 2 1 6l4 4V7h5a2 2 0 0 1 0 4H7v2h3a4 4 0 0 0 0-8H5V2z"/></svg></template>
  <template id="stage-icon"><svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M7 2h2v5h5v2H9v5H7V9H2V7h5z"/></svg></template>
  <script nonce="${nonce}">
    (${dashboardClient.toString()})(acquireVsCodeApi, "${instanceKey}", ${isDashboardHostMessage.toString()});
  </script>
</body>
</html>`;
}
