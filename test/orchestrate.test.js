import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { completion } from '../src/orchestrate.js';

const cli = fileURLToPath(new URL('../bin/orchestrate.js', import.meta.url));
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orchestrate-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'storage');
  const cwd = path.join(root, 'project');
  await fs.mkdir(cwd);
  const write = async (relative, content = 'test') => {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  };
  const run = (args, input = '') => spawnSync(process.execPath, [cli, ...args], {
    cwd, env: { ...process.env, ORCHESTRATE_HOME: home }, input, encoding: 'utf8', timeout: 10000,
  });
  const read = relative => fs.readFile(path.join(root, relative), 'utf8');
  const exists = async relative => fs.access(path.join(root, relative)).then(() => true, () => false);
  return { root, cwd, home, write, run, read, exists };
}

test('initializes storage and reports empty listing', async t => {
  const f = await fixture(t);
  const result = f.run(['ls']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /0 profile\(s\)/);
  assert.ok(await f.exists('storage/profiles'));
  assert.ok(await f.exists('storage/archived'));
});

test('records supported agent files, lists description, and archives', async t => {
  const f = await fixture(t);
  for (const name of ['AGENT.md', 'AGENTS.md', '.codex/config.toml', '.agents/skills/test/SKILL.md', 'CLAUDE.md', '.claude/settings.json', '.opencode/agents/test.md', 'opencode.jsonc', '.github/agents/test.agent.md']) {
    await f.write(`project/${name}`, name);
  }
  await f.write('project/unrelated.txt');
  await f.write('project/.github/workflows/build.yml');
  const recorded = f.run(['record', 'demo', 'My profile']);
  assert.equal(recorded.status, 0, recorded.stderr);
  assert.equal(await f.read('storage/profiles/demo/.opencode/agents/test.md'), '.opencode/agents/test.md');
  assert.equal(await f.read('storage/profiles/demo/.codex/config.toml'), '.codex/config.toml');
  assert.equal(await f.read('storage/profiles/demo/description.txt'), 'My profile\n');
  assert.equal(await f.exists('storage/profiles/demo/unrelated.txt'), false);
  assert.equal(await f.exists('storage/profiles/demo/.github/workflows'), false);
  assert.match(f.run(['ls']).stdout, /demo\tMy profile/);
  assert.equal(f.run(['archive', 'demo']).status, 0);
  assert.ok(await f.exists('storage/archived/demo/CLAUDE.md'));
  assert.equal(await f.exists('storage/profiles/demo'), false);
});

test('apply merges content, omits root metadata, and preserves nested description files', async t => {
  const f = await fixture(t);
  await f.write('storage/profiles/demo/AGENTS.md', 'new');
  await f.write('storage/profiles/demo/description.txt', 'metadata');
  await f.write('storage/profiles/demo/.agents/description.txt', 'actual config');
  await f.write('project/unrelated.txt', 'keep');
  await f.write('project/description.txt', 'project description');
  const result = f.run(['demo', 'setup label']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await f.read('project/AGENTS.md'), 'new');
  assert.equal(await f.read('project/description.txt'), 'project description');
  assert.equal(await f.read('project/.agents/description.txt'), 'actual config');
  assert.equal(await f.read('project/unrelated.txt'), 'keep');
});

test('declining overwrite lists all collisions and leaves even new files untouched', async t => {
  const f = await fixture(t);
  await f.write('storage/profiles/demo/AGENTS.md', 'new');
  await f.write('storage/profiles/demo/.codex/config.toml', 'new config');
  await f.write('storage/profiles/demo/NEW.md', 'new file');
  await f.write('project/AGENTS.md', 'old');
  await f.write('project/.codex/config.toml', 'old config');
  const result = f.run(['demo'], 'n\n');
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Files will be overwritten, would you like to continue/);
  assert.match(result.stdout, /AGENTS\.md/);
  assert.ok(result.stdout.includes(path.join('.codex', 'config.toml')));
  assert.equal(await f.read('project/AGENTS.md'), 'old');
  assert.equal(await f.read('project/.codex/config.toml'), 'old config');
  assert.equal(await f.exists('project/NEW.md'), false);
});

test('explicit yes overwrites; empty input and EOF cancel', async t => {
  const f = await fixture(t);
  await f.write('storage/profiles/demo/AGENTS.md', 'new');
  await f.write('project/AGENTS.md', 'old');
  for (const input of ['', '\n', 'maybe\n']) {
    assert.equal(f.run(['demo'], input).status, 1);
    assert.equal(await f.read('project/AGENTS.md'), 'old');
  }
  const result = f.run(['demo'], 'yes\n');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await f.read('project/AGENTS.md'), 'new');
});

test('rejects path traversal, reserved names, and inexact profile names', async t => {
  const f = await fixture(t);
  await f.write('storage/profiles/Demo/AGENTS.md');
  for (const name of ['../escape', 'CON', 'archive', 'unarchive', 'delete', 'bad/name', 'trailing.']) {
    assert.equal(f.run(['record', name]).status, 1, name);
  }
  assert.equal(f.run(['demo']).status, 1);
  assert.equal(f.run(['missing']).status, 1);
});

test('record refuses empty sources and duplicate profiles', async t => {
  const f = await fixture(t);
  assert.equal(f.run(['record', 'empty']).status, 1);
  assert.equal(await f.exists('storage/profiles/empty'), false);
  await f.write('project/CLAUDE.md', 'original');
  assert.equal(f.run(['record', 'demo']).status, 0);
  await f.write('project/CLAUDE.md', 'changed');
  assert.equal(f.run(['record', 'demo']).status, 1);
  assert.equal(await f.read('storage/profiles/demo/CLAUDE.md'), 'original');
});

test('record --all captures arbitrary, hidden, and empty paths and applies them', async t => {
  const f = await fixture(t);
  for (const relative of ['src/app.js', '.git/config', 'node_modules/example/index.js', '.env', 'nested/description.txt', 'profiles/local.txt', 'archived/local.txt']) {
    await f.write(`project/${relative}`, relative);
  }
  await f.write('project/description.txt', 'original root description');
  await fs.mkdir(path.join(f.cwd, 'empty'));
  const result = f.run(['record', 'full', 'Full project', '--all']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await f.read('storage/profiles/full/src/app.js'), 'src/app.js');
  assert.equal(await f.read('storage/profiles/full/.git/config'), '.git/config');
  assert.equal(await f.read('storage/profiles/full/node_modules/example/index.js'), 'node_modules/example/index.js');
  assert.equal(await f.read('storage/profiles/full/.env'), '.env');
  assert.equal(await f.read('storage/profiles/full/nested/description.txt'), 'nested/description.txt');
  assert.equal(await f.read('storage/profiles/full/description.txt'), 'Full project\n');
  assert.ok(await f.exists('storage/profiles/full/empty'));
  assert.ok(await f.exists('storage/profiles/full/profiles/local.txt'));
  assert.ok(await f.exists('storage/profiles/full/archived/local.txt'));
  assert.equal(await f.read('project/description.txt'), 'original root description');
  const destination = path.join(f.root, 'destination');
  await fs.mkdir(destination);
  const applied = spawnSync(process.execPath, [cli, 'full'], {
    cwd: destination, env: { ...process.env, ORCHESTRATE_HOME: f.home }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(await f.read('destination/src/app.js'), 'src/app.js');
  assert.ok(await f.exists('destination/empty'));
  assert.equal(await f.exists('destination/description.txt'), false);
});

test('record --all works before the name and excludes nested profile storage', async t => {
  const f = await fixture(t);
  await f.write('storage/profiles/existing/AGENTS.md', 'existing');
  await f.write('storage/archived/old/AGENTS.md', 'archived');
  await f.write('project/app.txt', 'app');
  const result = spawnSync(process.execPath, [cli, 'record', '--all', 'full'], {
    cwd: f.root, env: { ...process.env, ORCHESTRATE_HOME: f.home }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await f.read('storage/profiles/full/project/app.txt'), 'app');
  assert.equal(await f.exists('storage/profiles/full/storage/profiles'), false);
  assert.equal(await f.exists('storage/profiles/full/storage/archived'), false);
  assert.equal(await f.read('storage/profiles/existing/AGENTS.md'), 'existing');
  assert.equal(await f.read('storage/archived/old/AGENTS.md'), 'archived');
  assert.equal(await f.read('storage/profiles/full/description.txt'), '\n');
});

test('record --all rejects empty sources, duplicates, and links without partial profiles', async t => {
  const f = await fixture(t);
  assert.equal(f.run(['record', 'empty', '--all']).status, 1);
  assert.equal(await f.exists('storage/profiles/empty'), false);
  await f.write('project/app.txt', 'original');
  assert.equal(f.run(['record', 'full', '--all']).status, 0);
  await f.write('project/app.txt', 'changed');
  assert.equal(f.run(['record', 'full', '--all']).status, 1);
  assert.equal(await f.read('storage/profiles/full/app.txt'), 'original');
  await f.write('outside/file.txt', 'outside');
  await fs.symlink(path.join(f.root, 'outside'), path.join(f.cwd, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(f.run(['record', 'linked', '--all']).status, 1);
  assert.equal(await f.exists('storage/profiles/linked'), false);
});

test('archive refuses to replace an existing archived profile', async t => {
  const f = await fixture(t);
  await f.write('storage/profiles/demo/AGENTS.md', 'active');
  await f.write('storage/archived/demo/AGENTS.md', 'archived');
  assert.equal(f.run(['archive', 'demo']).status, 1);
  assert.equal(await f.read('storage/profiles/demo/AGENTS.md'), 'active');
  assert.equal(await f.read('storage/archived/demo/AGENTS.md'), 'archived');
});

test('file/directory conflict fails before writing any destination files', async t => {
  const f = await fixture(t);
  await f.write('storage/profiles/demo/AAA.md', 'new');
  await f.write('storage/profiles/demo/CLAUDE.md', 'new');
  await fs.mkdir(path.join(f.cwd, 'CLAUDE.md'));
  const result = f.run(['demo']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /type conflict/);
  assert.equal(await f.exists('project/AAA.md'), false);
});

test('destination junctions or symlinks cannot redirect writes', async t => {
  const f = await fixture(t);
  await f.write('storage/profiles/demo/.codex/config.toml', 'new');
  const outside = path.join(f.root, 'outside');
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(f.cwd, '.codex'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = f.run(['demo']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Symbolic links\/junctions/);
  assert.equal(await f.exists('outside/config.toml'), false);
});

test('completion names have no logs and exclude archived profiles', async t => {
  const f = await fixture(t);
  await f.write('storage/profiles/demo/AGENTS.md');
  await f.write('storage/archived/old/AGENTS.md');
  assert.equal(f.run(['__complete']).stdout, 'demo\n');
  assert.equal(f.run(['__complete', 'unarchive']).stdout, 'old\n');
  assert.equal(f.run(['__complete', 'delete']).stdout, 'demo\nold\n');
  for (const shell of ['powershell', 'bash', 'zsh']) {
    const result = f.run(['completion', shell]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), completion(shell));
    assert.doesNotMatch(result.stdout, /\[orchestrate\]/);
  }
  assert.equal(f.run(['completion', 'invalid']).status, 1);
});

test('unarchive restores content and metadata without overwriting active profiles', async t => {
  const f = await fixture(t);
  await f.write('storage/archived/demo/AGENTS.md', 'restored');
  await f.write('storage/archived/demo/description.txt', 'description');
  await f.write('storage/profiles/demo/AGENTS.md', 'active');
  assert.equal(f.run(['unarchive', 'demo']).status, 1);
  assert.equal(await f.read('storage/profiles/demo/AGENTS.md'), 'active');
  assert.equal(await f.read('storage/archived/demo/AGENTS.md'), 'restored');
  assert.equal(f.run(['delete', 'demo', '--active']).status, 0);
  const result = f.run(['unarchive', 'demo']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await f.read('storage/profiles/demo/AGENTS.md'), 'restored');
  assert.equal(await f.read('storage/profiles/demo/description.txt'), 'description');
  assert.equal(await f.exists('storage/archived/demo'), false);
  assert.equal(f.run(['unarchive', 'demo']).status, 1);
});

test('delete removes a unique active or archived profile and preserves project files', async t => {
  const f = await fixture(t);
  await f.write('project/AGENTS.md', 'project');
  for (const folder of ['profiles', 'archived']) {
    await f.write(`storage/${folder}/demo/.agents/skills/test/SKILL.md`, 'content');
    const result = f.run(['delete', 'demo']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await f.exists(`storage/${folder}/demo`), false);
    assert.ok(await f.exists(`storage/${folder}`));
  }
  assert.equal(await f.read('project/AGENTS.md'), 'project');
  assert.equal(f.run(['delete', 'demo']).status, 1);
});

test('delete requires an explicit scope when both copies exist', async t => {
  const f = await fixture(t);
  await f.write('storage/profiles/demo/AGENTS.md', 'active');
  await f.write('storage/archived/demo/AGENTS.md', 'archived');
  const result = f.run(['delete', 'demo']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Choose --active or --archived/);
  assert.equal(await f.read('storage/profiles/demo/AGENTS.md'), 'active');
  assert.equal(await f.read('storage/archived/demo/AGENTS.md'), 'archived');
  assert.equal(f.run(['delete', 'demo', '--archived']).status, 0);
  assert.ok(await f.exists('storage/profiles/demo'));
  assert.equal(await f.exists('storage/archived/demo'), false);
  assert.equal(f.run(['delete', 'demo', '--archived']).status, 1);
  assert.ok(await f.exists('storage/profiles/demo'));
});

test('new commands reject unsafe names, inexact names, and invalid arguments', async t => {
  const f = await fixture(t);
  await f.write('storage/profiles/Demo/AGENTS.md', 'active');
  await f.write('storage/archived/Demo/AGENTS.md', 'archived');
  for (const command of ['delete', 'unarchive']) {
    for (const args of [[], ['../Demo'], ['demo'], ['missing'], ['Demo', '--invalid'], ['Demo', 'extra', 'extra']]) {
      assert.equal(f.run([command, ...args]).status, 1);
    }
  }
  assert.equal(await f.read('storage/profiles/Demo/AGENTS.md'), 'active');
  assert.equal(await f.read('storage/archived/Demo/AGENTS.md'), 'archived');
});

test('delete and unarchive reject profile-root links', async t => {
  const f = await fixture(t);
  await f.write('outside/AGENTS.md', 'keep');
  f.run(['ls']);
  for (const folder of ['profiles', 'archived']) {
    await fs.symlink(path.join(f.root, 'outside'), path.join(f.home, folder, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  }
  assert.equal(f.run(['delete', 'linked']).status, 1);
  assert.equal(f.run(['unarchive', 'linked']).status, 1);
  assert.equal(await f.read('outside/AGENTS.md'), 'keep');
});

test('storage root may use a canonical OS symlink without allowing links in contents', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.home);
  const alias = path.join(f.root, 'storage-alias');
  await fs.symlink(f.home, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const result = spawnSync(process.execPath, [cli, 'ls'], {
    cwd: f.cwd, env: { ...process.env, ORCHESTRATE_HOME: alias }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
});

test('profile contents cannot modify profile storage when applying from its parent', async t => {
  const f = await fixture(t);
  await f.write('storage/profiles/demo/profiles/other/AGENTS.md', 'bad');
  const result = spawnSync(process.execPath, [cli, 'demo'], {
    cwd: f.home, env: { ...process.env, ORCHESTRATE_HOME: f.home }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot overwrite profile\/archive storage/);
  assert.equal(await f.exists('storage/profiles/other'), false);
});
