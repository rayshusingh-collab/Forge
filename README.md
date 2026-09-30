# Forge

Forge is a local-first AI software-development orchestrator. You describe a software project or development goal, and Forge coordinates AI coding workers to plan, implement, validate, review, and progressively complete that work — never treating a worker's "done" as proof that the work is correct.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the intended design and [`CLAUDE.md`](CLAUDE.md) for engineering rules.

## Status

Early development. Implemented so far:

**Milestone 1 — Foundation Runtime**

- typed, validated configuration from environment variables
- lightweight leveled logging (human-readable, stderr, secret-key redaction)
- a controlled process runner (no shell, explicit validated working directory, captured output, timeouts, cancellation, structured results)
- a small typed error model
- a minimal CLI (`--help`, `--version`, `doctor`)

**Milestone 2 — Project & Persistent State**

- registering a local Git repository as a Forge project with a stable ID
- versioned, validated, atomically written project metadata and state under `.forge/`
- lost-update protection for concurrent writers
- a project path boundary (traversal, prefix, case, and symlink/junction checks)
- project discovery from anywhere inside a project
- `forge project add | show | status`

**Milestone 3 — Claude Code Worker**

- a provider-independent worker interface with explicit outcomes (success, failed, timeout, cancelled, unavailable, invalid-output)
- a Claude Code adapter using the headless CLI, restricted permissions, and validated JSON output
- safe executable resolution on Windows (npm `.cmd` launchers are unwrapped, never run through a shell)
- bounded records of manual worker runs in project state
- `forge worker list | check | run`, and a Claude check in `forge doctor`

Planning, the task engine, validation, review, and autonomous execution are **not** implemented yet. Workers run only when you invoke them explicitly, one run at a time.

## Prerequisites

- **Node.js ≥ 22.18.0** (Node 24 LTS recommended). Development and tests run TypeScript directly via Node's built-in type stripping, which is enabled by default from 22.18.
- npm (bundled with Node)
- **Git** on `PATH` (required to register projects; the test suite creates temporary repositories)
- **Claude Code** (verified with 2.1.x), installed and logged in with `claude auth login`. Required only to run the Claude worker; the automated tests use a fake CLI and never call Claude.

## Installation

```sh
npm install
npm run build
```

Optionally make the `forge` command available globally from this checkout:

```sh
npm link
```

## Configuration

Forge reads configuration from environment variables. `npm run dev` and `npm start` also load a local `.env` file if present — copy [`.env.example`](.env.example) to get started. Never commit `.env`.

| Variable                   | Values                               | Default      |
| -------------------------- | ------------------------------------ | ------------ |
| `FORGE_LOG_LEVEL`          | `debug`, `info`, `warn`, `error`     | `info`       |
| `FORGE_PROCESS_TIMEOUT_MS` | integer, 1 – 86400000                | `120000`     |
| `FORGE_ENV`                | `development`, `production`, `test`  | `production` |
| `FORGE_WORKER_TIMEOUT_MS`  | integer, 1 – 86400000                | `600000`     |
| `FORGE_CLAUDE_EXECUTABLE`  | absolute path to Claude Code         | `claude` on `PATH` |

Invalid values are reported together with a clear error; run `forge doctor` to check them.

## Development commands

| Command             | Purpose                                                  |
| ------------------- | -------------------------------------------------------- |
| `npm run dev -- …`  | Run the CLI from source, e.g. `npm run dev -- doctor`    |
| `npm run build`     | Clean and compile to `dist/`                             |
| `npm start -- …`    | Run the compiled CLI, e.g. `npm start -- --help`         |
| `npm run typecheck` | Strict type check of sources and tests                   |
| `npm test`          | Run the test suite (`node:test`)                         |
| `npm run check`     | Typecheck, test, and build                               |

No linter is configured yet; strict TypeScript settings cover most correctness checks for now.

## CLI

```text
forge --help                   Show help
forge --version                Show version
forge doctor                   Check the local runtime: Node, configuration, process runner, Git, workers
forge project add <path>       Register a Git work tree root as a project
      [--name <name>]          Display name (default: directory name)
      [--description <text>]   Optional description
forge project show             Show the project containing the current directory
forge project status           Show that project's persisted state summary
forge worker list              List available workers
forge worker check <worker>    Check a worker's installation and login (no AI call)
forge worker run <worker> --task <text>
      [--context <text>]       Supporting information, kept separate from the task
      [--cwd <dir>]            Directory inside the project (default: project root)
      [--timeout <seconds>]    Default: FORGE_WORKER_TIMEOUT_MS
      [--allow-edits]          Allow file changes (default: read-only)
```

Exit codes: `0` success, `1` failure, `2` usage error.

## Projects

Register the **root** of an existing Git work tree:

```sh
forge project add ../my-app --name "My App"
cd ../my-app/src
forge project status
```

`show` and `status` find the project by walking up from the current directory to the nearest `.forge/`.

Registration only creates `<project-root>/.forge/`. It does not initialize or configure Git, commit, push, install packages, run project scripts, or change any other file. It fails if the path does not exist, is not a directory, is not the root of a Git work tree, or is already registered (or contains a `.forge/` Forge doesn't recognize).

### What `.forge/` contains

| File           | Purpose                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------- |
| `project.json` | Project identity: stable ID, name, description, canonical root path, status, timestamps     |
| `state.json`   | Orchestration state: lifecycle phase, milestones, tasks, attempts, decisions, validation summaries, and a `revision` counter |
| `.gitignore`   | Contains `*`, so Git ignores all Forge metadata without touching the project's own `.gitignore` |
| `state.lock`   | Exists only briefly while state is being written                                             |

`.forge/` holds **Forge metadata only — never credentials**, and no logs or raw worker output. Both documents carry a `schemaVersion`. They are validated whenever they are read, because they may have been edited by hand. Forge refuses (rather than repairs) malformed, unsupported-version, or relocated metadata. State written by Milestone 2 (schema v1) is migrated to v2 automatically on load.

## Claude Code worker

```sh
cd my-app
forge worker check claude
forge worker run claude --task "Inspect this repository and summarize its purpose. Do not modify any files."
```

- **Authentication:** Forge uses your existing Claude Code installation and login. It never reads, stores, or passes API keys. The health check reads only the `loggedIn` flag from `claude auth status`.
- **Health:** `forge worker check claude` and `forge doctor` confirm the executable, its version, that it supports the headless options Forge needs, and whether you are logged in. They never make an AI call.
- **Where it runs:** only inside a registered project, found from the current directory. `--cwd` must pass the project path boundary (no traversal, outside paths, or link/junction escapes), and runs inside `.forge/` or `.git/` are refused. The task is sent on stdin, never as a command-line argument or through a shell.
- **Control-state guard:** `.forge/` belongs to Forge, not to workers.
  - **Edit-enabled runs:** Forge holds the state lock for the entire run. It records the run as `running`, snapshots every entry in `.forge/` (SHA-256), runs the worker, and verifies the snapshot, all before recording the outcome. Because no Forge process can write state during that time, any change to `.forge/` (metadata, state, the lock, added or removed files) must have come from something else.
  - **On a violation:** the run is marked `integrity-violation`, is never reported as success, and exits with code 1. Forge restores nothing and runs no Git or destructive commands. It writes an evidence report, containing the changes and the original file contents, to the OS temp directory, outside the project. The violation is recorded in state only if `state.json`, the lock, and `.forge/` itself are provably untouched; otherwise Forge fails closed and writes nothing.
  - **Read-only runs:** these have no write tools, so only the immutable `project.json` and `.gitignore` are checked.
- **Output:** Forge reads Claude's JSON result (`--output-format json`) and validates it as untrusted data. Output is capped at 4 MiB per stream, and the summary shown is capped at 20,000 characters. Each run is recorded in `.forge/state.json` as bounded metadata: status, timestamps, duration, a 200-character task excerpt, a 1,000-character summary and a diagnostic. The last 100 runs are kept. Transcripts and raw output are never stored.
- **Timeouts and cancellation:** every run has a timeout (`--timeout`, default `FORGE_WORKER_TIMEOUT_MS` = 10 minutes). On timeout, or on Ctrl+C, Claude is stopped and the outcome is recorded as `timeout` or `cancelled`.

### Permission model

Forge never uses `--dangerously-skip-permissions` or `bypassPermissions`, and never changes your Claude settings. Every run uses:

| Option | Effect |
| --- | --- |
| `--print --output-format=json` | Headless, a single structured result |
| `--restricted` | Removes command-running tools (Bash, PowerShell, …) and WebFetch; confines file tools to the working directory; ignores user/project/local settings files (so a repository cannot grant itself permissions or hooks) |
| `--tools=Read,Glob,Grep` (read-only), or `…,Edit,Write` with `--allow-edits` | Only these file tools exist for the run |
| `--permission-mode=acceptEdits --permission-prompts=none` | Edits inside the working directory are applied; anything else that would need approval is denied automatically instead of waiting |
| `--strict-mcp-config`, `--disable-slash-commands`, `--no-session-persistence` | No MCP servers, no skills, no saved session |

**What this means:**
- The worker cannot run commands, tests, builds, or Git. Running those is Forge's job, in later milestones.
- Runs are read-only unless you pass `--allow-edits`.
- If a task needs something the policy denies, the run still finishes, and Forge reports the denied tool requests.

## Current limitations

- **Control-state guard is detective, not preventive:** Claude's file tools are not blocked from `.forge/`, because Forge doesn't rely on unverified path-rule syntax. Instead, the guard described below detects any change. It does not prevent the change or undo it.
- **Long edit runs block other writers:** while an edit-enabled run is in progress, other Forge processes cannot update that project's state; they fail with a lock conflict after 5 seconds.
- **Prompt rules are advisory:** the rules Forge sends ("stay in scope, don't commit") are instructions to the model. What is actually enforced is the tool and permission set above, together with the working-directory confinement Claude applies.
- **Worker environment:** the worker inherits Forge's environment variables. It has no tool that could read them.
- **Interrupted runs:** a run interrupted by a crash (not by Ctrl+C) stays recorded as `running`.
- **Windows launchers:** only npm "cmd-shim" launchers are unwrapped. Any other `.cmd`/`.bat` (including npm's own `npm.cmd`) is refused; point Forge at the underlying executable instead.

Carried over from Milestone 2:

- **Path safety:** the boundary resolves links for the parts of a path that exist. Components that don't exist yet can't be resolved, and a link created between the check and the use (time-of-check/time-of-use) isn't prevented. The boundary is a guard for Forge's own operations, not an OS sandbox.
- **Case sensitivity:** Windows paths compare case-insensitively. Elsewhere comparison is case-sensitive, so on case-insensitive macOS volumes a differently-cased path is conservatively treated as outside.
- **Moving a project:** moving a registered project directory invalidates its metadata, which records the original root. Re-registering requires removing `.forge/` manually.
- **Stale locks:** a stale `.forge/state.lock` left by a crashed process is not removed automatically. Delete it manually when no Forge process is running.
- **No project list:** there is no global registry of projects; each project is found through its own `.forge/`.
- **Inherited Git variables:** `GIT_DIR`/`GIT_WORK_TREE` set in Forge's own environment are passed through to Git and would affect repository detection.
