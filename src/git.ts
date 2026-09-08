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
  readonly onDidOpenRepository?: vscode.Event<Repository>;
  readonly onDidCloseRepository?: vscode.Event<Repository>;
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
  private readonly repositoryChanges = new vscode.EventEmitter<void>();
  readonly onDidChangeRepositories = this.repositoryChanges.event;
  private readonly subscriptions: vscode.Disposable[] = [];
  private api: GitAPI | undefined;
  private initialization: Promise<void> | undefined;
  private stopWaiting: (() => void) | undefined;
  private disposed = false;
  private readonly workspaceAdapters = new Map<string, Repository>();

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
        if (api.onDidOpenRepository) { this.subscriptions.push(api.onDidOpenRepository(() => this.repositoryChanges.fire())); }
        if (api.onDidCloseRepository) { this.subscriptions.push(api.onDidCloseRepository(() => this.repositoryChanges.fire())); }
      })();
    }
    try { await this.initialization; }
    catch (error) { this.initialization = undefined; throw error; }
  }

  get repositories(): readonly Repository[] {
    return this.disposed ? [] : this.api?.repositories ?? [];
  }

  private containingRepository(file: vscode.Uri): Repository | undefined {
    return this.repositories.filter(repo => relative(file, repo) !== undefined)
      .sort((a, b) => b.rootUri.fsPath.length - a.rootUri.fsPath.length)[0];
  }

  async workspaceRepository(): Promise<Repository | undefined> {
    await this.initialize();
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!folder || folder.scheme !== 'file') { return undefined; }
    const repository = this.containingRepository(folder);
    if (!repository) { return undefined; }
    const root = repository.rootUri.toString();
    const key = JSON.stringify([root, folder.toString()]);
    let adapter = this.workspaceAdapters.get(key);
    if (!adapter) {
      // Git can return fresh wrappers. Keep folder identity stable, but metadata live.
      const actual = (): Repository => this.repositories.find(repo => repo.rootUri.toString() === root) ?? repository;
      adapter = {
        rootUri: folder,
        get state() { return actual().state; },
        show: (ref, filePath) => actual().show(ref, filePath),
        getCommit: ref => actual().getCommit(ref),
      };
      this.workspaceAdapters.set(key, adapter);
    }
    return adapter;
  }

  async repositoryFor(uri?: vscode.Uri): Promise<Repository | undefined> {
    const file = uri ? source(uri)?.file : undefined;
    const repo = await this.workspaceRepository();
    if (!uri) { return repo; }
    if (!repo || !file || relative(file, repo) === undefined) { return undefined; }
    const owner = this.containingRepository(file);
    const actual = this.containingRepository(repo.rootUri);
    return owner?.rootUri.toString() === actual?.rootUri.toString() ? repo : undefined;
  }

  async resource(uri: vscode.Uri, repo: Repository): Promise<Resource | undefined> {
    const value = source(uri);
    if (!value) { return undefined; }
    const filePath = relative(value.file, repo);
    if (!filePath) { return undefined; }
    const owner = this.containingRepository(value.file);
    const actual = this.containingRepository(repo.rootUri) ?? repo;
    if (owner && owner.rootUri.toString() !== actual.rootUri.toString()) { return undefined; }
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
    const owner = this.containingRepository(file);
    const actual = this.containingRepository(repo.rootUri) ?? repo;
    if (owner && owner.rootUri.toString() !== actual.rootUri.toString()) {
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
    this.workspaceAdapters.clear();
    this.subscriptions.forEach(item => item.dispose());
    this.repositoryChanges.dispose();
  }
}
