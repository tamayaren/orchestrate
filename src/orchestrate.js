import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const DEFAULT_HOME = fileURLToPath(new URL('../', import.meta.url));
const RESERVED = new Set(['record', 'ls', 'archive', 'completion', '__complete', 'help']);

// Explicit project configuration only: never copy a user's global home automatically.
export const AGENT_PATHS = [
  'AGENT.md', 'AGENTS.md', 'AGENTS.override.md', '.agents', '.codex',
  'CLAUDE.md', 'CLAUDE.local.md', '.claude', '.mcp.json',
  '.opencode', 'opencode.json', 'opencode.jsonc',
  '.cursor', '.cursorrules', '.windsurf', '.windsurfrules',
  '.cline', '.clinerules', '.roo', '.roorules',
  'GEMINI.md', '.gemini', '.aider.conf.yml', '.aiderignore',
  '.continue', '.junie', '.kiro', '.trae',
  '.github/copilot-instructions.md', '.github/instructions',
  '.github/prompts', '.github/agents',
];

const log = message => console.log(`[orchestrate] ${message}`);
async function stat(file) {
  try { return await fs.lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function validateName(name) {
  if (!name || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) || name.endsWith('.')) {
    throw new Error('Profile names must start with a letter or number and contain only letters, numbers, dots, hyphens, or underscores (no trailing dot).');
  }
  if (RESERVED.has(name.toLowerCase()) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(name)) {
    throw new Error(`Reserved profile name: ${name}`);
  }
}
function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
async function assertNoLinks(file) {
  const absolute = path.resolve(file);
  const root = path.parse(absolute).root;
  let current = root;
  for (const piece of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, piece);
    const entry = await stat(current);
    if (entry?.isSymbolicLink()) throw new Error(`Symbolic links/junctions are not supported: ${current}`);
  }
}
async function ensureDirectory(directory) {
  await assertNoLinks(directory);
  await fs.mkdir(directory, { recursive: true });
}
async function profileNames(home) {
  const entries = await fs.readdir(path.join(home, 'profiles'), { withFileTypes: true });
  return entries.filter(entry => {
    if (!entry.isDirectory() || entry.name.startsWith('.')) return false;
    try { validateName(entry.name); return true; } catch { return false; }
  }).map(entry => entry.name).sort();
}
async function exactProfile(home, name) {
  validateName(name);
  if (!(await profileNames(home)).includes(name)) throw new Error(`Profile not found (names are exact and case-sensitive): ${name}`);
  return path.join(home, 'profiles', name);
}
// Build a full plan first so conflicts and unsafe paths are found before writes.
async function walk(source, relative = '') {
  await assertNoLinks(source);
  const entry = await stat(source);
  if (!entry) throw new Error(`Source does not exist: ${source}`);
  if (entry.isFile()) return [{ source, relative, directory: false, mode: entry.mode }];
  if (!entry.isDirectory()) throw new Error(`Unsupported file type: ${source}`);
  const result = relative ? [{ source, relative, directory: true, mode: entry.mode }] : [];
  for (const child of (await fs.readdir(source)).sort()) {
    if (!relative && child === 'description.txt') continue;
    result.push(...await walk(path.join(source, child), path.join(relative, child)));
  }
  return result;
}
async function preflight(plan, destination) {
  const overwrites = [];
  for (const item of plan) {
    const target = path.join(destination, item.relative);
    await assertNoLinks(target);
    const existing = await stat(target);
    if (existing && (item.directory ? !existing.isDirectory() : !existing.isFile())) {
      throw new Error(`File/directory type conflict: ${target}. Resolve this before applying the profile.`);
    }
    if (existing && !item.directory) overwrites.push(item.relative);
  }
  return overwrites;
}
async function copyPlan(plan, destination) {
  for (const item of plan) {
    const target = path.join(destination, item.relative);
    if (item.directory) {
      await fs.mkdir(target, { recursive: true });
      log(`Directory: ${item.relative}`);
    } else {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(item.source, target);
      await fs.chmod(target, item.mode);
      log(`Copied: ${item.relative}`);
    }
  }
}
async function confirmOverwrite(files) {
  console.log('Files will be overwritten, would you like to continue');
  for (const file of files) console.log(`  ${file}`);
  process.stdout.write('Continue? [y/N] ');
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    const answer = await input[Symbol.asyncIterator]().next();
    return !answer.done && /^(y|yes)$/i.test(answer.value.trim());
  } finally { input.close(); }
}

export function completion(shell) {
  if (shell === 'powershell') return `Register-ArgumentCompleter -Native -CommandName orchestrate,orchestrate.cmd -ScriptBlock {
    param($wordToComplete, $commandAst, $cursorPosition)
    $parts = @($commandAst.CommandElements | ForEach-Object { $_.Extent.Text })
    $isFirst = $parts.Count -le 1 -or ($parts.Count -eq 2 -and $wordToComplete -ne '')
    $isArchive = $parts.Count -ge 2 -and $parts[1] -eq 'archive' -and ($parts.Count -eq 2 -or ($parts.Count -eq 3 -and $wordToComplete -ne ''))
    if ($isFirst -or $isArchive) {
        $executable = if ($env:OS -eq 'Windows_NT') { 'orchestrate.cmd' } else { 'orchestrate' }
        $candidates = @(& $executable __complete)
        if ($isFirst) { $candidates += @('record', 'ls', 'archive', 'completion', 'help') }
        $candidates | Where-Object { $_.StartsWith($wordToComplete, [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object {
            [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
        }
    }
}`;
  if (shell === 'bash') return `_orchestrate_complete() {
    local cur="\u0024{COMP_WORDS[COMP_CWORD]}"
    COMPREPLY=()
    if [[ $COMP_CWORD -eq 1 ]]; then
        COMPREPLY=( $(compgen -W "$(orchestrate __complete) record ls archive completion help" -- "$cur") )
    elif [[ $COMP_CWORD -eq 2 && "\u0024{COMP_WORDS[1]}" == archive ]]; then
        COMPREPLY=( $(compgen -W "$(orchestrate __complete)" -- "$cur") )
    fi
}
complete -F _orchestrate_complete orchestrate`;
  if (shell === 'zsh') return `_orchestrate_complete() {
    local -a profiles
    profiles=("\u0024{(@f)$(orchestrate __complete)}")
    if (( CURRENT == 2 )); then
        compadd -- "\u0024{profiles[@]}" record ls archive completion help
    elif (( CURRENT == 3 )) && [[ "\u0024{words[2]}" == archive ]]; then
        compadd -- "\u0024{profiles[@]}"
    fi
}
compdef _orchestrate_complete orchestrate`;
  throw new Error('Choose a completion shell: powershell, bash, or zsh.');
}

const HELP = `orchestrate — local coding-agent profiles

Usage:
  orchestrate <name> [description]         Apply an exact profile to the current directory
  orchestrate record <name> [description]  Record agent configuration as a new profile
  orchestrate ls                          List profiles and descriptions
  orchestrate archive <name>              Move a profile to archived/
  orchestrate completion <shell>          Print powershell, bash, or zsh completion setup
  orchestrate help                        Show this help

Quote descriptions containing spaces. An apply description is an optional log label;
record saves its description to description.txt. All operations log verbosely.
Matching files require confirmation before any destination files are changed.
Storage defaults to profiles/ and archived/ in the CLI repository root.
Set ORCHESTRATE_HOME to use another storage root. Requires Node.js 20+.`;

export async function main(args = process.argv.slice(2)) {
  const requestedHome = path.resolve(process.env.ORCHESTRATE_HOME || DEFAULT_HOME);
  await fs.mkdir(requestedHome, { recursive: true });
  // Canonicalize the user-selected roots (macOS /var and /tmp are symlinks).
  // Links within profile contents and destination configuration remain rejected.
  const home = await fs.realpath(requestedHome);
  const cwd = await fs.realpath(process.cwd());
  await ensureDirectory(path.join(home, 'profiles'));
  await ensureDirectory(path.join(home, 'archived'));
  const [command, ...rest] = args;

  if (!command || ['help', '--help', '-h'].includes(command)) { console.log(HELP); return; }
  if (command === '__complete') { console.log((await profileNames(home)).join('\n')); return; }
  if (command === 'completion') {
    if (rest.length !== 1) throw new Error('Usage: orchestrate completion <powershell|bash|zsh>');
    console.log(completion(rest[0])); return;
  }

  log(`Profile storage: ${home}`);

  if (command === 'ls') {
    if (rest.length) throw new Error('Usage: orchestrate ls');
    const names = await profileNames(home);
    for (const name of names) {
      const descriptionPath = path.join(home, 'profiles', name, 'description.txt');
      await assertNoLinks(descriptionPath);
      const description = await stat(descriptionPath) ? (await fs.readFile(descriptionPath, 'utf8')).trim().replace(/\s+/g, ' ') : '(no description)';
      console.log(`${name}\t${description || '(no description)'}`);
    }
    log(`${names.length} profile(s).`); return;
  }

  if (command === 'archive') {
    if (rest.length !== 1) throw new Error('Usage: orchestrate archive <name>');
    const source = await exactProfile(home, rest[0]);
    const target = path.join(home, 'archived', rest[0]);
    if (await stat(target)) throw new Error(`Archived profile already exists: ${rest[0]}`);
    await fs.rename(source, target);
    log(`Archived ${rest[0]} → ${target}`); return;
  }

  if (command === 'record') {
    const [name, ...description] = rest;
    validateName(name);
    const target = path.join(home, 'profiles', name);

    if (await stat(target)) throw new Error(`Profile already exists: ${name}. Choose a new name or archive it first.`);
    if (inside(path.join(home, 'profiles'), cwd) || inside(path.join(home, 'archived'), cwd)) {
      throw new Error('Record from a project directory outside profiles/ and archived/.');
    }

    const plan = [];
    for (const relative of AGENT_PATHS) {
      const source = path.join(cwd, relative);
      await assertNoLinks(source);
      if (await stat(source)) {
        log(`Found: ${relative}`);
        plan.push(...await walk(source, relative));
      }
    }

    if (!plan.length) throw new Error('No supported agent configuration found in the current directory.');

    // Stage new profiles so a failed copy never leaves a partial visible profile.
    const staging = await fs.mkdtemp(path.join(home, 'profiles', '.record-'));
    try {
      await copyPlan(plan, staging);
      await fs.writeFile(path.join(staging, 'description.txt'), description.join(' ') + '\n');
      if (await stat(target)) throw new Error(`Profile already exists: ${name}`);
      await fs.rename(staging, target);
    } finally { await fs.rm(staging, { recursive: true, force: true }); }
    log(`Recorded ${name} → ${target}`); return;
  }

  const source = await exactProfile(home, command);
  if (inside(path.join(home, 'profiles'), cwd) || inside(path.join(home, 'archived'), cwd)) {
    throw new Error('Apply to a project directory outside profiles/ and archived/.');
  }

  log(`Applying ${command} → ${cwd}${rest.length ? ` (${rest.join(' ')})` : ''}`);

  const plan = await walk(source);
  for (const item of plan) {
    const target = path.join(cwd, item.relative);
    if (inside(path.join(home, 'profiles'), target) || inside(path.join(home, 'archived'), target)) {
      throw new Error(`Profile contents cannot overwrite profile/archive storage: ${target}`);
    }
  }

  const overwrites = await preflight(plan, cwd);
  if (overwrites.length && !await confirmOverwrite(overwrites)) {
    log('Cancelled. No destination files were changed.');
    process.exitCode = 1;
    return;
  }
  await copyPlan(plan, cwd);
  log(`Applied ${command}: ${plan.filter(item => !item.directory).length} file(s).`);
}
