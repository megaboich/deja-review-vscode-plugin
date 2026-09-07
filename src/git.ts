import * as path from 'node:path';
import * as vscode from 'vscode';
import { normalizeResource, Resource } from './model';

export interface Repository {
  rootUri: vscode.Uri;
  state: {
    HEAD?: { commit?: string };
    indexChanges?: readonly { readonly uri: vscode.Uri }[];
    onDidChange: vscode.Event<void>;
  };
  show(ref: string, path: string): Promise<string>;
  getCommit(ref: string): Promise<{ hash: string }>;
}

interface GitAPI {
  readonly repositories: readonly Repository[];
  readonly state?: string;
  readonly onDidChangeState?: vscode.Event<string>;
}

interface GitExtension {
  readonly enabled?: boolean;
  getAPI(version: 1): GitAPI;
}

function source(uri: vscode.Uri): { file: vscode.Uri; ref?: string } | undefined {
  if (uri.scheme !== 'file' && uri.scheme !== 'git') { return undefined; }
  let file = uri;
  let ref: string | undefined;
  if (uri.scheme === 'git') {
    let query: unknown;
    try { query = JSON.parse(uri.query); }
    catch { throw new Error('Malformed Git URI: expected a JSON query with path and ref.'); }
    if (!query || typeof query !== 'object' || !('path' in query) || !('ref' in query)
      || typeof query.path !== 'string' || typeof query.ref !== 'string') {
      throw new Error('Malformed Git URI: path and ref must be strings.');
    }
    if ('submoduleOf' in query) {
      throw new Error('Submodule summary documents are not supported; open a file inside the submodule.');
    }
    if (!path.isAbsolute(query.path) || /[\x00-\x1f\x7f]/.test(query.path)
      || query.path.split(/[\\/]/).includes('..')) {
      throw new Error('Git URI path must be absolute and must not contain traversal.');
    }
    file = vscode.Uri.file(query.path);
    ref = query.ref;
    if (uri.authority !== file.authority) {
      throw new Error('Git URI authority does not match its file path.');
    }
  } else if (uri.query || uri.fragment) {
    throw new Error('File URIs with a query or fragment are not supported.');
  }
  if (!path.isAbsolute(file.fsPath) || file.fsPath.split(/[\\/]/).includes('..')) {
    throw new Error('Expected an absolute file path without traversal.');
  }
  return { file, ref };
}

function relative(file: vscode.Uri, repo: Repository): string | undefined {
  if (repo.rootUri.scheme !== 'file' || file.authority !== repo.rootUri.authority) { return undefined; }
  const value = path.relative(repo.rootUri.fsPath, file.fsPath);
  if (path.isAbsolute(value) || value === '..' || value.startsWith(`..${path.sep}`)) { return undefined; }
  return value.split(path.sep).join('/');
}

export class GitResources implements vscode.Disposable {
  private api: GitAPI | undefined;
  private initialization: Promise<void> | undefined;
  private stopWaiting: (() => void) | undefined;
  private disposed = false;

  async initialize(): Promise<void> {
    if (this.disposed) { throw new Error('Git resources have been disposed.'); }
    if (!this.initialization) {
      this.initialization = (async () => {
        const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
        if (!extension) { throw new Error('The bundled VS Code Git extension is unavailable. Enable vscode.git.'); }
        const exports = await extension.activate();
        if (this.disposed) { throw new Error('Git resources have been disposed.'); }
        if (exports.enabled === false) { throw new Error('The VS Code Git extension is disabled. Enable Git and retry.'); }
        const api = exports.getAPI(1);
        if (api.state !== undefined && api.state !== 'initialized') {
          const onDidChangeState = api.onDidChangeState;
          if (!onDidChangeState) { throw new Error('The VS Code Git API is not initialized.'); }
          await new Promise<void>((resolve, reject) => {
            let listener: vscode.Disposable | undefined;
            const finish = (error?: Error): void => {
              listener?.dispose();
              this.stopWaiting = undefined;
              if (error) { reject(error); } else { resolve(); }
            };
            this.stopWaiting = () => finish(new Error('Git initialization was cancelled because resources were disposed.'));
            listener = onDidChangeState(state => { if (state === 'initialized') { finish(); } });
            if (api.state === 'initialized') { finish(); }
          });
        }
        if (this.disposed) { throw new Error('Git resources have been disposed.'); }
        this.api = api;
      })();
    }
    try { await this.initialization; }
    catch (error) { this.initialization = undefined; throw error; }
  }

  get repositories(): readonly Repository[] {
    return this.disposed ? [] : this.api?.repositories ?? [];
  }

  async repositoryFor(uri?: vscode.Uri, ask = false): Promise<Repository | undefined> {
    const candidate = uri ?? vscode.window.activeTextEditor?.document.uri;
    const file = candidate ? source(candidate)?.file : undefined;
    await this.initialize();
    const repositories = this.repositories;
    if (file) {
      const matches = repositories.filter(repo => relative(file, repo) !== undefined)
        .sort((a, b) => b.rootUri.fsPath.length - a.rootUri.fsPath.length);
      if (matches.length) { return matches[0]; }
    }
    // Explicit resources must never be attached to an unrelated repository.
    if (uri) { return undefined; }
    if (repositories.length === 1) { return repositories[0]; }
    if (!ask || !repositories.length) { return undefined; }
    const selected = await vscode.window.showQuickPick(repositories.map(repo => ({
      label: path.basename(repo.rootUri.fsPath), description: repo.rootUri.fsPath, repo,
    })), { placeHolder: 'Choose the repository for review comments', ignoreFocusOut: true });
    return selected?.repo;
  }

  async resource(uri: vscode.Uri, repo: Repository): Promise<Resource | undefined> {
    const value = source(uri);
    if (!value) { return undefined; }
    const filePath = relative(value.file, repo);
    if (!filePath) { return undefined; }
    const owner = this.repositories.filter(item => relative(value.file, item) !== undefined)
      .sort((a, b) => b.rootUri.fsPath.length - a.rootUri.fsPath.length)[0];
    if (owner && owner.rootUri.toString() !== repo.rootUri.toString()) { return undefined; }
    const resource = normalizeResource({ path: filePath, origin: 'changed' });
    const ref = value.ref;
    if (ref === undefined) { return resource; }
    if (ref === '~') {
      // Match bundled Git's sanitizeRef: public change.uri is resourceUri, including renames.
      const indexed = repo.state.indexChanges?.some(change => change.uri.toString() === value.file.toString());
      return { ...resource, origin: indexed ? 'staged' : 'head' };
    }
    if (ref === '') { return { ...resource, origin: 'staged' }; }
    if (ref === 'HEAD' || ref === 'head') { return { ...resource, origin: 'head' }; }
    if (/^(?:~\d|:)/.test(ref) || ref.startsWith('-') || /[\x00-\x20\x7f]/.test(ref)) {
      throw new Error(`Unsupported Git ref ${JSON.stringify(ref)}: merge stages and non-commit revisions cannot be reviewed.`);
    }
    try {
      const commit = await repo.getCommit(ref);
      return normalizeResource({ ...resource, origin: `commit:${commit.hash}` });
    } catch (error) {
      throw new Error(`Cannot resolve Git ref ${JSON.stringify(ref)} to a local commit: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }

  uri(resource: Resource, repo: Repository): vscode.Uri {
    const normalized = normalizeResource(resource);
    if (repo.rootUri.scheme !== 'file') { throw new Error('Only local Git repository resources are supported.'); }
    const file = vscode.Uri.joinPath(repo.rootUri, normalized.path);
    const owner = this.repositories.filter(item => relative(file, item) !== undefined)
      .sort((a, b) => b.rootUri.fsPath.length - a.rootUri.fsPath.length)[0];
    if (owner && owner.rootUri.toString() !== repo.rootUri.toString()) {
      throw new Error('The resource belongs to a nested repository, not the selected repository.');
    }
    if (normalized.origin === 'changed') { return file; }
    const ref = normalized.origin === 'staged' ? '' : normalized.origin === 'head' ? 'HEAD' : normalized.origin.slice(7);
    return vscode.Uri.from({ scheme: 'git', authority: file.authority, path: file.path,
      query: JSON.stringify({ path: file.fsPath, ref }) });
  }

  async content(resource: Resource, repo: Repository): Promise<string> {
    const uri = this.uri(resource, repo);
    try {
      if (uri.scheme === 'file') {
        const document = vscode.workspace.textDocuments.find(doc => !doc.isClosed && doc.uri.toString() === uri.toString());
        if (document) { return document.getText(); }
        return new TextDecoder('utf-8', { fatal: true }).decode(await vscode.workspace.fs.readFile(uri));
      }
      const { path: filePath, ref } = JSON.parse(uri.query) as { path: string; ref: string };
      return await repo.show(ref, filePath);
    } catch (error) {
      throw new Error(`Cannot read ${resource.path} (${resource.origin}): ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stopWaiting?.();
    this.api = undefined;
  }
}
