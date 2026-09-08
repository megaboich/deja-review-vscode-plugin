/** Static shell only: repository metadata arrives over postMessage, never inside script source. */
export function renderDashboard(nonce: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(nonce)) throw new Error("Invalid dashboard nonce");
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
    button:disabled { cursor: default; opacity: 0.6; }
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
    #explanation { font-size: 0.95em; }
    #error { color: var(--vscode-errorForeground); }
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
    @media (max-width: 220px) {
      body { padding: 8px; }
      li button { width: 100%; }
    }
  </style>
</head>
<body>
  <main id="dashboard" aria-busy="false">
    <p id="count" role="status" aria-live="polite">0 review notes</p>
    <button id="copy" type="button" aria-describedby="explanation" hidden disabled>Copy Review Notes &amp; Clear</button>
    <p id="explanation" class="muted" hidden>Copies your review notes to the clipboard, archives this batch, and clears the current review notes.</p>
    <p id="empty" class="muted">Open a local project folder in VS Code to start reviewing.</p>
    <p id="error" role="alert" hidden></p>
    <section id="history" aria-labelledby="history-title" hidden>
      <h2 id="history-title">Recent Archives</h2>
      <p class="muted">Recover a batch to make its review notes active again.</p>
      <p id="no-archives" class="muted">No archived batches yet.</p>
      <ul id="archives" aria-label="Archived review note batches"></ul>
    </section>
  </main>
  <script nonce="${nonce}">
    (() => {
      const vscode = acquireVsCodeApi();
      const byId = (id) => document.getElementById(id);
      const copy = byId('copy');
      const list = byId('archives');
      const rows = new Map();
      let state;
      let renderedRepoKey;
      const countLabel = (count) => count + (count === 1 ? ' review note' : ' review notes');
      const send = (type, archiveId) => {
        if (!state || state.busy) return;
        vscode.postMessage({ type, repoKey: state.repoKey, ...(archiveId === undefined ? {} : { archiveId }) });
      };
      copy.addEventListener('click', () => {
        if (state && state.repoKey && state.hasFeedback) send('copy');
      });
      window.addEventListener('message', (event) => {
        if (!event.data || event.data.type !== 'state') return;
        state = event.data.state;
        byId('dashboard').setAttribute('aria-busy', String(state.busy));
        byId('count').textContent = countLabel(state.commentCount);
        copy.hidden = !state.repoKey || !state.hasFeedback;
        byId('explanation').hidden = copy.hidden;
        copy.disabled = state.busy || !state.repoKey || !state.hasFeedback;
        byId('empty').hidden = state.hasFeedback;
        byId('empty').textContent = state.repoKey
          ? 'No current review notes. Add review notes in the editor or recover an archived batch.'
          : 'Open a local project folder in VS Code to start reviewing.';
        byId('error').textContent = state.error || '';
        byId('error').hidden = !state.error;
        byId('history').hidden = state.hasFeedback || !state.repoKey;
        const archives = state.repoKey ? state.archives.slice(0, 10) : [];
        byId('no-archives').hidden = archives.length > 0;
        if (renderedRepoKey !== state.repoKey) {
          for (const row of rows.values()) row.item.remove();
          rows.clear();
          renderedRepoKey = state.repoKey;
        }
        const ids = new Set(archives.map((archive) => archive.id));
        for (const [id, row] of rows) {
          if (!ids.has(id)) { row.item.remove(); rows.delete(id); }
        }
        archives.forEach((archive, index) => {
          let row = rows.get(archive.id);
          if (!row) {
            const item = document.createElement('li');
            const details = document.createElement('div');
            details.className = 'archive-details';
            const date = document.createElement('time');
            const count = document.createElement('span');
            count.className = 'archive-count muted';
            const recover = document.createElement('button');
            recover.type = 'button';
            recover.textContent = 'Recover';
            recover.addEventListener('click', () => {
              if (state && state.repoKey && !state.hasFeedback) send('restore', archive.id);
            });
            details.append(date, count);
            item.append(details, recover);
            row = { item, date, count, recover };
            rows.set(archive.id, row);
          }
          const date = new Date(archive.createdAt);
          const validDate = !Number.isNaN(date.getTime());
          row.date.textContent = validDate ? date.toLocaleString() : 'Unknown date';
          if (validDate) row.date.dateTime = date.toISOString();
          else row.date.removeAttribute('datetime');
          row.count.textContent = countLabel(archive.commentCount);
          row.recover.disabled = state.busy || state.hasFeedback || !state.repoKey;
          row.recover.setAttribute('aria-label', 'Recover ' + countLabel(archive.commentCount) + ' from ' + row.date.textContent);
          // Keep existing nodes in place during ordinary updates to preserve keyboard focus.
          if (list.children[index] !== row.item) list.insertBefore(row.item, list.children[index] || null);
        });
      });
      vscode.postMessage({ type: 'ready' });
    })();
  </script>
</body>
</html>`;
}
