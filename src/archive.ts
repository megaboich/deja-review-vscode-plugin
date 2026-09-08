import { createHash, randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { parse } from './parser';

export interface ReviewArchive {
  id: string;
  createdAt: string;
  commentCount: number;
}

interface ArchiveRecord extends ReviewArchive {
  version: 1;
  repoUri: string;
  text: string;
}

export class ReviewArchives {
  private readonly directory: vscode.Uri;
  private readonly repoUri: string;

  constructor(storageUri: vscode.Uri, repoUri: vscode.Uri) {
    this.repoUri = repoUri.toString();
    const hash = createHash('sha256').update(this.repoUri).digest('hex');
    this.directory = vscode.Uri.joinPath(storageUri, 'reviews', hash);
  }

  private uri(id: string): vscode.Uri {
    // Only canonical randomUUID IDs are accepted, never paths or encoded paths.
    if (typeof id !== 'string' || id.length !== 36
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) {
      throw new Error('Invalid review archive ID.');
    }
    return vscode.Uri.joinPath(this.directory, `${id}.json`);
  }

  private async record(id: string): Promise<ArchiveRecord> {
    const uri = this.uri(id);
    const stat = await vscode.workspace.fs.stat(uri);
    if (!(stat.type & vscode.FileType.File) || (stat.type & vscode.FileType.SymbolicLink)) {
      throw new Error('Review archive is not a regular file.');
    }
    const bytes = await vscode.workspace.fs.readFile(uri);
    const record: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!record || typeof record !== 'object') { throw new Error('Invalid review archive record.'); }
    const value = record as Partial<ArchiveRecord>;
    if (value.version !== 1 || value.repoUri !== this.repoUri || value.id !== id
      || typeof value.text !== 'string' || !value.text.trim()
      || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))
      || new Date(value.createdAt).toISOString() !== value.createdAt
      || !Number.isSafeInteger(value.commentCount) || value.commentCount !== parse(value.text).comments.length) {
      throw new Error('Invalid review archive metadata or content.');
    }
    return value as ArchiveRecord;
  }

  async list(): Promise<ReviewArchive[]> {
    let entries: [string, vscode.FileType][];
    try { entries = await vscode.workspace.fs.readDirectory(this.directory); }
    catch (error) {
      if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') { return []; }
      throw error;
    }
    const archives: ReviewArchive[] = [];
    for (const [name] of entries) {
      if (!name.endsWith('.json')) { continue; }
      try {
        const { id, createdAt, commentCount } = await this.record(name.slice(0, -5));
        archives.push({ id, createdAt, commentCount });
      } catch (error) {
        console.warn(`Skipping invalid review archive ${name}:`, error);
      }
    }
    // Limit only the display, not retention; older IDs remain recoverable.
    return archives.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)
      || b.id.localeCompare(a.id)).slice(0, 10);
  }

  async save(text: string): Promise<ReviewArchive> {
    if (!text.trim()) { throw new Error('Cannot archive empty review feedback.'); }
    const archive: ReviewArchive = {
      id: randomUUID(), createdAt: new Date().toISOString(), commentCount: parse(text).comments.length,
    };
    const record: ArchiveRecord = { version: 1, repoUri: this.repoUri, ...archive, text };
    const destination = this.uri(archive.id);
    const temporary = vscode.Uri.joinPath(this.directory, `${archive.id}.${randomUUID()}.tmp`);
    await vscode.workspace.fs.createDirectory(this.directory);
    try {
      await vscode.workspace.fs.writeFile(temporary, new TextEncoder().encode(JSON.stringify(record)));
      await vscode.workspace.fs.rename(temporary, destination, { overwrite: false });
    } catch (error) {
      try { await vscode.workspace.fs.delete(temporary, { recursive: false, useTrash: false }); }
      catch (cleanupError) {
        if (!(cleanupError instanceof vscode.FileSystemError && cleanupError.code === 'FileNotFound')) {
          console.warn('Could not remove temporary review archive:', cleanupError);
        }
      }
      throw error;
    }
    return archive;
  }

  async read(id: string): Promise<string> {
    return (await this.record(id)).text;
  }
}
