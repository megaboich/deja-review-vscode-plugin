import * as assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { validateSingleFilePathspec } from '../src/gitPath';

const execute = promisify(execFile);

test('bracket path verification uses Git matching in a disposable repository', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'dejareview-pathspec-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = await fs.realpath(temporary);
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) {
      delete env[key];
    }
  }
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = os.devNull;
  // The production helper inherits the same environment as the bundled Git API.
  const originalEnv = process.env;
  process.env = env;
  t.after(() => { process.env = originalEnv; });
  const git = async (...args: string[]): Promise<string> => {
    const result = await execute('git', args, { cwd: root, env, timeout: 10_000 });
    return result.stdout;
  };
  await git('init', '--template=');

  for (const prefix of ['', 'packages/app/']) {
    for (const route of ['[versionId]', '[...slug]', '[[...slug]]']) {
      await t.test(`accepts only the literal ${prefix}${route} across Git states`, async () => {
        const name = `${prefix}pages/projects/${route}/opportunities/page.ts`;
        const target = path.join(root, name);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, 'base\n');

        await validateSingleFilePathspec('git', root, target);
        await git('--literal-pathspecs', 'add', '--', target);
        await fs.writeFile(target, 'changed\n');
        const indexBefore = await git('ls-files', '--stage', '-z');
        await validateSingleFilePathspec('git', root, target);
        assert.equal(await git('ls-files', '--stage', '-z'), indexBefore);
        assert.equal(await fs.readFile(target, 'utf8'), 'changed\n');

        await fs.unlink(target);
        await validateSingleFilePathspec('git', root, target);
        assert.equal(await git('ls-files', '--stage', '-z'), indexBefore);
      });
    }
  }

  await t.test('rejects matching untracked or tracked siblings, even when unchanged', async () => {
    const target = path.join(root, 'collision/[ab].ts');
    const sibling = path.join(root, 'collision/a.ts');
    await fs.mkdir(path.dirname(target));
    await fs.writeFile(target, 'selected\n');
    await fs.writeFile(sibling, 'sibling\n');

    await assert.rejects(validateSingleFilePathspec('git', root, target), /could match other files/);
    await git('--literal-pathspecs', 'add', '--', target, sibling);
    const indexBefore = await git('ls-files', '--stage', '-z');
    await assert.rejects(validateSingleFilePathspec('git', root, target), /could match other files/);
    assert.equal(await git('ls-files', '--stage', '-z'), indexBefore);
    assert.equal(await fs.readFile(sibling, 'utf8'), 'sibling\n');
  });

  await t.test('rejects a pattern that only matches a different path or no path', async () => {
    await assert.rejects(validateSingleFilePathspec('git', root, path.join(root, 'collision/[a].ts')),
      /could match other files/);
    await assert.rejects(validateSingleFilePathspec('git', root, path.join(root, 'missing/[id].ts')),
      /could match other files/);
  });

  await t.test('unavailable Git fails without publishing raw command output', async () => {
    await assert.rejects(validateSingleFilePathspec(path.join(root, 'missing-git'), root, path.join(root, '[id].ts')),
      { message: 'Cannot verify that Git targets only this file. Refresh Files to Review and retry.' });
  });
});
