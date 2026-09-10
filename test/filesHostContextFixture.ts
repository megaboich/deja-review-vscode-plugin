import * as assert from 'node:assert/strict';
import type * as vscode from 'vscode';
import { Uri } from './filesHostPrimitives';

type GlobalState = vscode.ExtensionContext['globalState'];

class SuggestionState implements GlobalState {
  constructor(private readonly isSuggested: () => boolean) {}

  get<T>(key: string): T | undefined;
  get<T>(key: string, fallback: T): T;
  get<T>(_key: string, _fallback?: T): T {
    // Memento's caller chooses T without a runtime schema. This fixture stores
    // only the gitignore suggestion flag, read live so tests can change it.
    return this.isSuggested() as T;
  }

  keys(): readonly string[] { return []; }
  async update(_key: string, _value: unknown): Promise<void> {}
  setKeysForSync(): void { assert.fail('Suggestion state must not enable synchronization'); }
}

// Only activation's actual context dependencies are supported. Unexpected
// service access fails here instead of receiving an incomplete cast-built mock.
export function activationContext(
  subscriptions: vscode.Disposable[],
  isSuggested: () => boolean,
): vscode.ExtensionContext {
  return {
    subscriptions,
    globalStorageUri: Uri.file('/synthetic/storage'),
    globalState: new SuggestionState(isSuggested),
    get workspaceState(): vscode.Memento { return assert.fail('Unexpected workspace state access'); },
    get secrets(): vscode.SecretStorage { return assert.fail('Unexpected secret storage access'); },
    get extensionUri(): vscode.Uri { return assert.fail('Unexpected extension URI access'); },
    get extensionPath(): string { return assert.fail('Unexpected extension path access'); },
    get environmentVariableCollection(): vscode.GlobalEnvironmentVariableCollection {
      return assert.fail('Unexpected terminal environment access');
    },
    asAbsolutePath(): string { return assert.fail('Unexpected extension resource access'); },
    get storageUri(): vscode.Uri | undefined { return assert.fail('Unexpected workspace storage access'); },
    get storagePath(): string | undefined { return assert.fail('Unexpected workspace storage path access'); },
    get globalStoragePath(): string { return assert.fail('Unexpected deprecated storage path access'); },
    get logUri(): vscode.Uri { return assert.fail('Unexpected log URI access'); },
    get logPath(): string { return assert.fail('Unexpected log path access'); },
    get extensionMode(): vscode.ExtensionMode { return assert.fail('Unexpected extension mode access'); },
    get extension(): vscode.Extension<unknown> { return assert.fail('Unexpected extension metadata access'); },
    get languageModelAccessInformation(): vscode.LanguageModelAccessInformation {
      return assert.fail('Unexpected language model access');
    },
  };
}
