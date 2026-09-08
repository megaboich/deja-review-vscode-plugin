import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  const vscodeExecutablePath = process.env.VSCODE_EXECUTABLE_PATH ?? '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
  const extensionDevelopmentPath = path.resolve(__dirname, '../..');
  const extensionTestsPath = path.resolve(__dirname, 'integration/index.js');
  const workspaceTestsPath = path.resolve(__dirname, 'integration/workspace.js');
  await fs.access(vscodeExecutablePath);
  await fs.access(path.join(extensionDevelopmentPath, 'out/src/extension.js'));
  await fs.access(extensionTestsPath);
  await fs.access(workspaceTestsPath);

  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'lr-'));
  try {
    // realpath avoids /var versus /private/var URI mismatches on macOS.
    const root = await fs.realpath(temporary);
    const workspace = path.join(root, 'workspace');
    const project = path.join(workspace, 'project');
    const userData = path.join(root, 'u');
    const extensions = path.join(root, 'extensions');
    await Promise.all([project, extensions, path.join(userData, 'User')].map(dir => fs.mkdir(dir, { recursive: true })));
    await fs.writeFile(path.join(userData, 'User/settings.json'), JSON.stringify({
      'git.enabled': true,
      'git.autoRepositoryDetection': true,
      'git.openRepositoryInParentFolders': 'always',
      'git.autofetch': false,
      'extensions.autoCheckUpdates': false,
      'extensions.autoUpdate': false,
      'telemetry.telemetryLevel': 'off',
      'workbench.startupEditor': 'none',
      'window.restoreWindows': 'none',
      'diffEditor.renderSideBySide': true,
      'diffEditor.useInlineViewWhenSpaceIsLimited': false,
      'chat.disableAIFeatures': true,
    }));

    // Inherited Git overrides must not redirect fixture commands to a user's repo.
    const env = { ...process.env };
    const extensionTestsEnv: Record<string, string | undefined> = {
      DEJAREVIEW_TEST_WORKSPACE: workspace,
      DEJAREVIEW_TEST_SUBFOLDER: undefined,
      ELECTRON_RUN_AS_NODE: undefined,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: os.devNull,
    };
    for (const key of Object.keys(env)) {
      if (key.startsWith('GIT_')) {
        delete env[key];
        if (key !== 'GIT_CONFIG_NOSYSTEM' && key !== 'GIT_CONFIG_GLOBAL') { extensionTestsEnv[key] = undefined; }
      }
    }
    env.GIT_CONFIG_NOSYSTEM = '1';
    env.GIT_CONFIG_GLOBAL = os.devNull;
    const execute = promisify(execFile);
    const git = (...args: string[]) => execute('git', args, { cwd: workspace, env, timeout: 10_000 });
    await git('init', '--template=');
    const sample = path.join(workspace, 'sample.ts');
    await fs.writeFile(sample, "export const version = 'head';\nexport const stable = true;\n");
    await fs.writeFile(path.join(workspace, 'other.ts'), 'export const alternate = true;\n');
    await fs.copyFile(sample, path.join(project, 'sample.ts'));
    await fs.copyFile(path.join(workspace, 'other.ts'), path.join(project, 'other.ts'));
    await git('add', '--', 'sample.ts', 'other.ts', 'project/sample.ts', 'project/other.ts');
    await git('-c', 'user.name=DejaReview Integration', '-c', 'user.email=integration@example.invalid',
      '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${os.devNull}`, 'commit', '-m', 'Initial fixture');
    await fs.writeFile(sample, "export const version = 'staged';\nexport const stable = true;\n");
    await git('add', '--', 'sample.ts');
    await fs.writeFile(sample, "export const version = 'working';\nexport const stable = true;\n");

    // runTests accepts Electron directly; CLI resolution is only needed for CLI commands.
    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath,
      extensionTestsPath,
      extensionTestsEnv,
      launchArgs: [workspace, '--new-window', `--user-data-dir=${userData}`, `--extensions-dir=${extensions}`,
        '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes'],
    });
    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath,
      extensionTestsPath: workspaceTestsPath,
      extensionTestsEnv: { ...extensionTestsEnv, DEJAREVIEW_TEST_SUBFOLDER: '1' },
      launchArgs: [project, '--new-window', `--user-data-dir=${userData}`, `--extensions-dir=${extensions}`,
        '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes'],
    });
  } finally {
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

void main().catch(error => {
  console.error('Extension-host integration tests failed:', error);
  process.exitCode = 1;
});
