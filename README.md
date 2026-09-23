# Agent Profile Orchestrator

A dependency-free CLI for recording and applying coding-agent configurations. Windows is the primary platform; the same CLI supports macOS and Linux. Requires **Node.js 20 or newer** and npm.

## Install on PATH

Keep this repository at a permanent location. From its root, run:

```sh
npm link
```

This registers `orchestrate` in npm's global executable directory, creating Windows command wrappers or a macOS/Linux executable link. If your terminal cannot find it, ensure npm's global executable directory is on your user PATH, then open a new terminal. Run `npm prefix -g` to find the prefix: Windows executables live directly there (usually `%APPDATA%\npm`); macOS/Linux executables live in its `bin` subdirectory. Your Node installation must allow writes to that prefix.

On Windows, if PowerShell's execution policy blocks npm's `.ps1` wrappers, use `npm.cmd link` and `orchestrate.cmd` instead. Command Prompt also supports `orchestrate`.

No global install is required to run it directly:

```powershell
node G:\AI\codex-orchestrator\bin\orchestrate.js ls
```

```sh
node /path/to/codex-orchestrator/bin/orchestrate.js ls
```

## Commands

Run commands from the **project directory** you want to record or configure:

```sh
orchestrate record my-profile "My team's agent setup"
orchestrate ls
orchestrate my-profile
orchestrate my-profile "Setting up another project"
orchestrate archive my-profile
```

- `record <name> [description]` copies supported project configuration into a new `profiles/<name>/` and writes its `description.txt`. Existing profiles are never replaced. Recording with no supported files fails without creating a profile.
- `<name> [description]` finds an exact, case-sensitive profile name and merges all its contents into the current directory. The optional description is a log label; it does not change the stored profile. Unrelated destination files remain in place.
- `ls` lists active profiles with their `description.txt`, or `(no description)`.
- `archive <name>` moves the profile to `archived/<name>/`. An existing archive with that name is never replaced. To restore one, move its directory back into `profiles/`.
- `help` displays usage. Every operation logs its storage location, copied files, and outcome. Completion output contains only shell code or names.

When destination files already exist, the CLI displays:

```text
Files will be overwritten, would you like to continue
  .codex/config.toml
  AGENTS.md
Continue? [y/N]
```

Only `y` or `yes` (case-insensitive) permits changes. Blank input, other answers, or end-of-input cancels **before any destination files are written**, including new files. Cancellation returns exit code 1. There is no implicit overwrite flag. File/directory type conflicts fail before copying and must be resolved manually. Applying is not transactional after confirmation: a disk or permissions error during copying can leave some files applied.

Only the **profile-root** `description.txt` is omitted when applying; nested files with that name are copied normally. Supported directories are recorded recursively, including empty directories. Symbolic links and Windows junctions are rejected rather than followed. Record/apply cannot target a directory inside profile or archive storage.

## Recorded configuration

| Agent/tool | Project files and directories |
| --- | --- |
| General / Codex | `AGENT.md`, `AGENTS.md`, `AGENTS.override.md`, `.agents/`, `.codex/` |
| Claude | `CLAUDE.md`, `CLAUDE.local.md`, `.claude/`, `.mcp.json` |
| OpenCode | `.opencode/`, `opencode.json`, `opencode.jsonc` |
| Cursor | `.cursor/`, `.cursorrules` |
| Windsurf | `.windsurf/`, `.windsurfrules` |
| Cline / Roo | `.cline/`, `.clinerules`, `.roo/`, `.roorules` |
| Gemini | `GEMINI.md`, `.gemini/` |
| Aider | `.aider.conf.yml`, `.aiderignore` |
| Continue / Junie / Kiro / Trae | `.continue/`, `.junie/`, `.kiro/`, `.trae/` |
| GitHub Copilot | `.github/copilot-instructions.md`, `.github/instructions/`, `.github/prompts/`, `.github/agents/` |

Recording inspects these paths at the current directory's root. It does not search parent folders, nested projects, or global user settings. Other `.github` content is not recorded. Contents of the listed directories are copied as-is, including any local settings, credentials, or history stored there; review a profile before sharing it. You can add other files manually to a profile and they will be applied as well.

## Tab completion

Install shell completion once after `npm link`. Names are read live, so recording or archiving a profile immediately updates suggestions. Tab completes profile names for `orchestrate <name>` and `orchestrate archive <name>`, along with command names. The new name for `record` is entered manually.

### Windows PowerShell / PowerShell 7

For the current session:

```powershell
orchestrate.cmd completion powershell | Out-String | Invoke-Expression
```

For future sessions, put that line in your PowerShell `$PROFILE`. Create it if needed:

```powershell
New-Item -ItemType Directory -Force (Split-Path $PROFILE) | Out-Null
if (!(Test-Path $PROFILE)) { New-Item -ItemType File $PROFILE | Out-Null }
Add-Content $PROFILE 'orchestrate.cmd completion powershell | Out-String | Invoke-Expression'
. $PROFILE
```

PowerShell must permit loading your profile and completion script. Completion also supports invoking `orchestrate.cmd`. Command Prompt has no equivalent custom argument-completion hook; use PowerShell for profile-name completion.

### Bash (Linux, macOS, Git Bash)

Add this to `~/.bashrc` (or your Bash login startup file on macOS), then reload the shell:

```sh
eval "$(orchestrate completion bash)"
```

### Zsh (macOS default, Linux)

Add this to `~/.zshrc` after your shell's completion initialization, then reload the shell:

```sh
autoload -Uz compinit
compinit
eval "$(orchestrate completion zsh)"
```

## Storage and development

`profiles/` and `archived/` are created automatically in the repository root, independently of the terminal's current directory. For a separate storage location, set `ORCHESTRATE_HOME` to an absolute directory path. Profile names use letters, numbers, dots, underscores, and hyphens, starting with a letter or number; command names, Windows device names, and trailing dots are disallowed for portability.

```sh
npm test
npm run check
```

Tests use temporary storage and do not modify your real profiles. To remove the global command, run `npm unlink -g agent-profile-orchestrator`.
