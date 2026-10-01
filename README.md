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

**Milestone 4 — Task & Milestone Engine**

- manually created, ordered milestones and tasks with dependencies (validated as an acyclic graph)
- a deterministic state machine with explicit legal transitions
- derived runnability (ready / waiting / blocked / retryable / exhausted / interrupted)
- `forge task run`: one explicit command executes exactly one attempt of one task
- `awaiting-validation` after a successful worker run, with manual accept and reject
- bounded retry accounting, explicit crash recovery, and state schema v3 (migrated from v2)

**Milestone 5 — Deterministic Validation & Git Safety**

- a human-managed validation profile (`forge validation add|list|show|remove|run`), stored as protected Forge metadata
- sequential, deterministic validation that decides task success; worker claims never count
- a Git baseline before each edit-enabled task, with change attribution that keeps pre-existing user work separate
- scope checks, plus a `.forge/` integrity re-check after validation
- `forge task validate`, `forge task override --reason` (audited), and `forge task commit` (safe, local, attributed files only)
- npm and npx launchers run without a shell; state schema v4 (migrated from v3)

**Milestone 6 — AI Planning & Review**

- provider-independent AI roles: the planner and the reviewer are chosen per command and recorded by provider ID
- `forge plan create|list|show|apply|reject|context`: AI plans are stored as **proposals** and become work only when a human applies them
- `forge task review|review-show|review-accept|review-reject`: advisory AI review of validated tasks, plus recorded human decisions
- bounded, Git-aware project context: ignored files (such as `.env`) are never read, and secret-like paths are withheld
- planning and review are read-only: no tools, verified afterwards; state schema v5 (migrated from v4)

**Milestone 7 — Autonomous Orchestration Loop**

- `forge run`: a bounded loop that selects the next runnable task, runs the implementer, validates deterministically, optionally reviews, repairs within an explicit budget, commits locally when allowed, completes milestones, and stops with a typed reason
- `forge run step` (exactly one workflow step), `forge run --dry-run` (changes nothing), `forge run status`
- explicit orchestration policy with conservative defaults and hard maximums (refused, never clamped)
- one orchestration run per project (lease), bounded run history, state schema v6 (migrated from v5)

**Milestone 8 — Human Control & Production Hardening**

- first-class **approvals**: Forge records a request when it stops for a human; only a human resolves it (`forge approval`); an approval is single-use and bound by fingerprint to the evidence it authorizes
- `forge pause` / `forge resume`, explicit **lease recovery** (`forge run recover`), `forge preflight`, `forge status`, `forge explain`, `forge audit`
- typed project configuration (`.forge/config.json`, `forge config`) with documented precedence; provider health by role (`forge provider`); safe onboarding (`forge init`)
- redacted, actionable error output; state schema v7 (migrated from v6)

**Milestone 9 — Multi-Provider Execution**

- **OpenAI Codex CLI** is a second first-class provider next to Claude Code, for every role: implementer, planner and reviewer
- each role is chosen independently (`providers.implementer|planner|reviewer`); mixed configurations such as Claude planner → Codex implementer → Claude reviewer run through the same pipeline
- provider health per role, no silent fallback, provider identity recorded in runs, plans, reviews and the audit
- timeouts and Ctrl+C now terminate the whole process tree on Windows, so a provider's child processes cannot keep editing files

**Auto-decision (optional)**

- an AI **decision-maker** role (`providers.decisionMaker`) judges reviews that would otherwise stop for a human, and Forge applies its verdict (accept / remediate / escalate) under stricter deterministic rules: see [Auto-decision](#auto-decision)
- structured, persistent **remediation requirements** follow a task across attempts and restarts; every later attempt receives them, including manual `forge task run` retries

Nothing autonomous happens unless you run `forge run`, and it does only what its printed policy allows. It never pushes.

> **Planner proposes. Worker implements. Validator proves deterministic checks. Reviewer critiques. Orchestrator coordinates. Forge state machine decides. Human approves consequential exceptions.**

```
Human
  ↓  approvals, pause/resume, configuration, lease recovery, acknowledgements (never AI)
Forge policy + approvals
  ↓
Orchestrator / state machine
  ↓
Deterministic validation / Git safety
  ↓
AI planner / worker / reviewer   (output is data; never authority)
```

## Prerequisites

- **Node.js ≥ 22.18.0** (Node 24 LTS recommended). Development and tests run TypeScript directly via Node's built-in type stripping, which is enabled by default from 22.18.
- npm (bundled with Node)
- **Git** on `PATH` (required to register projects; the test suite creates temporary repositories)
- **Claude Code** (verified with 2.1.x), installed and logged in with `claude auth login`. Required only for roles that use Claude.
- **OpenAI Codex CLI** (verified with codex-cli 0.157.0), installed and logged in with `codex login`. Required only for roles that use Codex.
- The automated tests use fake CLIs and never call either provider.

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
| `FORGE_CODEX_EXECUTABLE`   | absolute path to the Codex CLI       | `codex` on `PATH` |

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

forge milestone add --title <text> [--description <text>]
forge milestone list | show <m> | complete <m> | cancel <m> [--reason <text>]

forge task add --milestone <m> --title <text> --instruction <text>
      [--context <text>] [--depends-on <task>]... [--max-attempts <n>]
forge task list [--milestone <m>] | show <task> | ready
forge task run <task> [--worker claude] [--timeout <seconds>] [--allow-edits]
      [--acknowledge-integrity-violation]
forge task validate <task>
forge task override <task> --reason <text>
forge task accept-repair <task> --reason <text> [--acknowledge-integrity-violation]
forge task reject <task> --reason <text>
forge task commit <task>

forge validation add --name <id> --executable <program> [--cwd <dir>] [--timeout <seconds>]
      [--optional] [-- <args>...]
forge validation list | show <id> | remove <id> | run

forge plan create --goal <text> [--planner <name>] [--timeout <seconds>]
forge plan list | show <plan> | apply <plan> | context
forge plan reject <plan> --reason <text>

forge task review <task> [--reviewer <name>] [--timeout <seconds>]
forge task review-show <task>
forge task review-accept <task> --reason <text>
forge task review-reject <task> --reason <text>
forge task cancel <task> [--reason <text>]
forge task recover <task> [--force]

forge run [--allow-edits] [--worker <name>] [--timeout <seconds>]
          [--max-tasks <n>] [--max-steps <n>]
          [--repair] [--repair-review] [--max-repairs <n>]
          [--review] [--reviewer <name>] [--review-timeout <seconds>]
          [--continue-on-concerns] [--continue-without-review]
          [--auto-decide] [--decision-maker <name>] [--decision-timeout <seconds>]
          [--auto-commit] [--dry-run]
forge run step [same options]
forge run status
forge run recover --reason <text> [--force]

forge init [<path>] [--name <name>] [--description <text>]
forge status [--no-providers]
forge preflight [--no-providers]
forge explain
forge audit [--limit <n>]
forge approval list [--all] | show <id>
forge approval approve <id> --reason <text>
forge approval reject <id> --reason <text>
forge pause --reason <text>
forge resume --reason <text>
forge config show | get <key> | set <key> <value> | reset <key> | validate
forge provider list | check [--role planner|implementer|reviewer|decision-maker] [<provider>]
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
| `orchestration.lock` | Exists only while a `forge run` controls the project (see Autonomous orchestration)   |
| `config.json`  | Human-chosen defaults for roles and orchestration (`forge config`); never credentials  |

`.forge/` holds **Forge metadata only — never credentials**, and no logs or raw worker output. Both documents carry a `schemaVersion`. They are validated whenever they are read, because they may have been edited by hand. Forge refuses (rather than repairs) malformed, unsupported-version, or relocated metadata. Older state is migrated step by step on load (v1 → v2 → … → v7). Version 2 placeholder tasks, which no Forge command ever created, are refused rather than guessed at.

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

## Codex CLI provider

Forge drives the OpenAI Codex CLI you already have installed and logged in, as an external process, exactly as it drives Claude Code. Forge never asks for, stores, forwards or prints OpenAI credentials, and has no login flow: authentication belongs to Codex (`codex login`).

```sh
forge provider check codex --role implementer
forge config set providers.implementer codex      # or providers.planner / providers.reviewer
```

**How Forge runs it.** `codex exec --json` (non-interactive), with the prompt on stdin (`-`), never as an argument and never through a shell. Every invocation:

| Setting | Why |
| --- | --- |
| `--ignore-user-config --ignore-rules` | Your `~/.codex/config.toml` can enable plugins, MCP servers, notify hooks and computer use; Forge inherits none of it and sets what it needs explicitly |
| `--sandbox workspace-write` (edit) / `read-only` (read-only runs, planner, reviewer) | Codex's own sandbox: writes only inside the working directory |
| `sandbox_workspace_write.network_access=false`, `exclude_tmpdir_env_var=true`, `exclude_slash_tmp=true` | No network; the temp directories are NOT writable (by default Codex allows writing there, outside the project) |
| `approval_policy=never` | Codex never escalates out of the sandbox; refused actions just fail |
| `windows.sandbox=unelevated` | Codex's Windows sandbox mode that needs no per-machine admin setup (without the user config, workspace writes would otherwise be impossible on Windows) |
| `shell_environment_policy.inherit=core` | Commands the model runs get a minimal environment |
| edit runs: `sandbox_workspace_write.writable_roots=['<scratch>']`, `shell_environment_policy.set={ TMP, TEMP, TMPDIR, npm_config_cache, YARN_CACHE_FOLDER, pnpm_config_store_dir, XDG_CACHE_HOME → <scratch>\…, npm_config_update_notifier=false }` | A fresh per-run scratch directory **outside the project** (in the OS temp directory) is the only extra writable place, for temp files and tool caches; it is deleted after the run. Without it, npm and similar tools had no writable cache and a model could put one inside the project or in `.forge/` |
| `--disable` apps, plugins, remote_plugin, browser_use, browser_use_external, computer_use, image_generation, in_app_browser, multi_agent, tool_suggest, skill_search, hooks, worktrees | High-risk features are off |
| planner/reviewer additionally: `--disable shell_tool unified_exec view_image`, fresh empty temp directory | AI roles cannot run commands; they work only from the input Forge sends |
| `--ephemeral --color never` | No saved session; plain output |

Forge never passes `--dangerously-bypass-approvals-and-sandbox`, `danger-full-access`, `--approve-for-me`, `--search`, `--add-dir`, `--worktree`, `--remote` or `--oss`. Health checks (`forge provider check`, `forge doctor`) run only `codex --version`, `codex exec --help` (every option above must exist) and `codex login status` (only the logged-in verdict is used); they make no AI call and touch no project.

**Differences from Claude, stated honestly.** The Codex implementer can run shell commands (tests, builds) inside its sandbox; the Claude implementer cannot run commands at all. Codex's sandbox restricts writes and network, not reads: a Codex worker can read files outside the project that your user account can read (the Claude worker's file tools are confined to the working directory). Codex has no separate system-prompt channel, so Forge's rules are placed first in the input, before the fenced task data. In both cases Forge's own guarantees do not depend on the provider: changes are attributed from Git, `.forge/` is integrity-checked, validation decides success, and only the safe-commit rules commit.

**Output.** Forge parses Codex's JSONL events and keeps only the final agent message (the worker's summary, a claim), the thread ID, token counts, and counts of file changes and commands. A failed turn, a non-zero exit, a missing final message, non-JSON output or output over 8 MiB is never success. Codex reports no model identifier and no cost, so none is recorded.

## Provider roles

Forge has four AI roles and two providers. Each role is configured independently, with the M8 precedence (command line > project configuration > default `claude`):

| Role | Setting | CLI option | Providers |
| --- | --- | --- | --- |
| implementer | `providers.implementer` | `--worker` | `claude` (Claude Code), `codex` |
| planner | `providers.planner` | `--planner` | `claude`, `codex` |
| reviewer | `providers.reviewer` | `--reviewer` | `claude`, `codex` |
| decision-maker | `providers.decisionMaker` | `--decision-maker` | `claude` (recommended), `codex`; only used with `--auto-decide` |

- `forge config set providers.<role> <name>` refuses names the role's registry does not know.
- **Mixed providers are supported**: any combination runs through the same tasks, attempts, changeset attribution, validation, review, approvals and safe commit. The provider never changes Forge's workflow semantics.
- **No fallback**: if the chosen provider is missing, logged out or unusable, preflight fails and `forge run` refuses (`forge task run` reports it); Forge never substitutes another provider.
- **No ranking or routing**: Forge does not judge providers; the choice is yours.
- **Identity**: worker runs record `claude-code` or `codex`; plans and reviews record their provider; `forge audit` shows the worker of every attempt. Model identifiers are recorded only if a provider reports one reliably (neither does today).
- `forge provider list`, `forge status`, `forge run --dry-run` and the `forge run` header show which provider fills each role and where the choice came from.

## Milestones and tasks

**AI workers execute work. Forge owns workflow state.** Workers never set task or milestone status, resolve dependencies, count attempts, or decide what runs next. They return a structured result, and Forge's deterministic state machine (`src/tasks/transitions.ts`) decides the transition. Worker prose such as "tests passed" is never trusted.

```sh
forge milestone add --title "Foundation"
forge task add --milestone 1 --title "Config loader" --instruction "Implement the configuration loader..."
forge task add --milestone 1 --title "Loader tests" --instruction "Add tests..." --depends-on 1.1
forge task ready                        # only 1.1 is runnable
forge validation add --name test --executable npm -- test
forge task run 1.1 --allow-edits        # ONE attempt of ONE task: worker, then validation, then stop
forge task ready                        # 1.2 is runnable only if 1.1's validation passed; nothing started it
forge task commit 1.1                   # optional: commit exactly 1.1's own changes, locally
```

**References.** A task can be referred to by its key (`1.2` means milestone 1, task 2), its full ID, or a unique ID prefix of at least 4 characters. A milestone can be referred to by its number, full ID, or prefix. An ambiguous prefix fails and lists the candidates; Forge never guesses.

**Stored statuses and transitions.** Anything not listed below is rejected.

| Task | Allowed next |
| --- | --- |
| `pending` | `running`, `cancelled` |
| `running` | `succeeded` (worker succeeded and required validation passed), `awaiting-validation` (validation not completed), `failed` |
| `awaiting-validation` | `succeeded` (validation passed on re-run, or audited override), `failed` (validation failed on re-run, or rejected) |
| `failed` | `running` (explicit retry, while attempts remain), `cancelled` |
| `succeeded`, `cancelled` | — (terminal) |

| Milestone | Allowed next |
| --- | --- |
| `pending` | `active` (its first task starts), `cancelled` |
| `active` | `completed` (only if every task is succeeded or cancelled and at least one succeeded), `cancelled` |
| `completed`, `cancelled` | — (terminal) |

**Derived conditions.** These are shown by `task list`, `task ready`, and `project status`, and are computed from state, never stored:

| Condition | Meaning |
| --- | --- |
| `ready` | Pending, and every dependency succeeded |
| `waiting` | Pending, and some dependency hasn't succeeded yet |
| `blocked` | Pending, and some dependency can never succeed (cancelled, out of attempts, or itself blocked) |
| `retryable` / `exhausted` | Failed, with attempts left / with none left |
| `interrupted` | Recorded as running, but its Forge process is gone |

Tasks are always listed in milestone order, then task order.

**Dependencies.** A dependency must be an existing, non-cancelled task, listed at most once. A task can't depend on itself, and cycles are rejected. The whole graph is re-validated every time state is loaded or written. A dependency is satisfied only when that task has `succeeded`, meaning it passed validation or was explicitly overridden. A task that is merely `awaiting-validation` does not satisfy its dependents.

**Execution** (`forge task run`). Forge performs these steps in order:
1. Checks that the task is runnable and has attempts left.
2. Runs the worker's health check. If the worker is unavailable, the command fails before any attempt is recorded.
3. Records the new attempt and its worker run in a single state write, and moves the task to `running`.
4. For edit-enabled runs, captures the Git baseline.
5. Invokes the worker with the task's instruction and context, which are sent as data, never as shell text.
6. For edit-enabled runs, captures the changes and runs deterministic validation (see below).
7. Records Forge's decision in one atomic state write and stops.

Result mapping:
- Worker `failed`, `timeout`, `cancelled` (Ctrl+C), `unavailable`, or `invalid-output` → `failed`. Validation does not run.
- `.forge/` modified, whether by the worker or by a validation command → `failed` (`integrity-violation`), even if every check passed. A retry requires `--acknowledge-integrity-violation`.
- HEAD or the branch moved, or changes appeared outside the task's working directory → `failed` (`scope-violation`). A retry requires the same acknowledgement.
- Worker `success` and required validation passed → `succeeded` (`validated`).
- Worker `success` and required validation failed or timed out → `failed` (`validation-failed`, retryable).
- Worker `success` but validation couldn't finish (cancelled, a check misconfigured, or a program failed to start) → `awaiting-validation`.
- Worker `success` with no required checks configured, or a read-only task → `awaiting-validation`.

`forge task run` exits with 0 when the task ended `succeeded` or `awaiting-validation`, and 1 when it ended `failed`.

Forge never starts another task and never retries on its own.

**Attempts and retries.**
- Every started execution consumes one attempt. The default budget is 3; set it with `--max-attempts` (1–10).
- After a failure or rejection, the task is `retryable` while attempts remain, but it is only re-run by another explicit `forge task run`. When the budget is used up, the task is `exhausted`.
- Each attempt links to exactly one worker run (`workerRuns` in `state.json`). Worker runs made for tasks are kept for as long as their task exists; manual `forge worker run` history is capped at 100.

**Leaving `awaiting-validation`.**
- `forge task validate` re-runs the configured checks. It invokes no worker and consumes no attempt.
- `forge task override --reason` marks the task succeeded without validation. This is an explicit human decision: the reason is recorded, and the task shows as `overridden`.
- `forge task reject --reason` fails the task.
- A task whose validation **failed** is `failed`, never awaiting validation, so it can't be overridden. The Milestone 4 `forge task accept` has been removed.

**Repairing an exhausted task by hand.** `forge task accept-repair <task> --reason <text>` accepts a task that used all its attempts after you fixed it yourself. It is not an override: Forge accepts it only on its own fresh evidence, and records nothing unless all of the following hold.
- The task is `exhausted`. A task with attempts left is retried instead; interrupted or running tasks are refused.
- No orchestration run controls the project, the project is not paused, and no other Forge operation holds the state lock (it runs under the same lease as `task validate`).
- At least one **required** validation check is configured, and all required checks pass when Forge runs them now. Optional checks never count. `.forge/` must be unchanged while they run.
- The changes are measured against the task's own recorded Git baseline. HEAD and the branch must not have moved, nothing may be out of scope, and something must have changed. If the last attempt ended in an integrity or scope violation, you must add `--acknowledge-integrity-violation`.

The task becomes `succeeded` and its dependents unblock. Every attempt keeps its original (failed) outcome and the budget is not touched; the repair is recorded separately with your reason, the validation evidence and the changeset, and appears in `forge task show` and `forge audit` as a human repair. Nothing is committed. `forge task commit <task>` applies the usual safe-commit rules to the repair's changeset: files that already had uncommitted changes before the task began (for example another task's uncommitted work) are `mixed` and are never committed by Forge. Auto-commit in `forge run` never commits a human repair.

**Crash recovery.**
- Before invoking the worker, Forge records which Forge process (process ID and host) is executing the attempt.
- If that process disappears, for example after a crash or a closed terminal, the task shows as `interrupted`. It is never re-run automatically, and success is never inferred from files on disk.
- `forge task recover <task>` marks the attempt `interrupted`, which moves the task to `failed`. You then decide whether to run it again, if attempts remain, or cancel it.
- `--force` exists for executions Forge can't check, such as one recorded on another machine.
- An edit run that crashed may also leave `.forge/state.lock` behind. Delete it once no Forge process is running.

**Concurrency.** There is exactly one lock: the project's state lock.
- Every workflow change re-checks its rules against the latest state while holding the lock, so two Forge processes can't both start the same task.
- A read-only task run takes the lock briefly at start and at finish.
- An edit-enabled run holds it for the whole run, as required by the Milestone 3 integrity lease. Other Forge commands that write state wait up to 5 seconds and then fail with a lock conflict, instead of interleaving.
- No operation waits for the lock while already holding it, so these cannot deadlock.

## Validation

**Trust model.** Worker output is a claim; validator output is evidence; Forge's workflow state is the decision.
- A task succeeds only when the required checks Forge runs pass, or when a human explicitly overrides it.
- No AI model takes part in validation.
- The checks are executable configuration, so only a human changes them, through `forge validation`.
- They're stored as Forge control metadata in `.forge/validation.json`, which the integrity guard protects: every byte after an edit-enabled run, and this file after read-only runs. A worker that alters the checks fails its task with `integrity-violation`, and the altered checks are never run.
- Task text and worker output never become commands.

```sh
forge validation add --name test --executable npm --timeout 300 -- test
forge validation add --name typecheck --executable node_modules/.bin/tsc -- --noEmit
forge validation add --name lint --executable npm --optional -- run lint
forge validation run        # try the checks now; records nothing
```

**Checks.**
- Each check is a program plus an argument array. There is no shell, and anything that looks like shell syntax (`&&`, `|`, quotes, `$`) is refused.
- The program can be:
  - a name on `PATH` (`npm`, `node`);
  - an absolute path;
  - a path inside the project (`node_modules/.bin/tsc`), checked against the project boundary, including link escapes.
- On Windows, npm-generated `.cmd` launchers, including npm's own `npm.cmd` and `npx.cmd`, are unwrapped and run directly without `cmd.exe`. Any other `.cmd` or `.bat` is refused.
- Every check has a timeout (default 10 minutes) and a working directory inside the project (default: the root).
- Checks are required unless `--optional`. The program is resolved when you add the check, so typos fail immediately.

**Running.**
- Checks run one at a time, in the configured order, and all of them run even after a failure, so the evidence is complete.
- Ctrl+C stops the running check and skips the rest.
- The overall result comes from the required checks only, by priority: cancelled > configuration error > execution error > timed out > failed > passed. Optional failures are recorded but never fail a task.
- Checks inherit Forge's environment, plus `CI=true`, `NO_COLOR=1` and `FORCE_COLOR=0`. Nothing from the environment is logged or stored.
- For each non-passing check, only a 500-character tail of its output is stored.

**No checks, no success.** If no required checks are configured, an edit-enabled task ends `awaiting-validation`. Forge never treats "nothing was checked" as "validated". Read-only tasks produce no code and always end `awaiting-validation`.

## Git safety

**Baseline and attribution.** Before an edit-enabled task, Forge records HEAD, the branch, and every path Git reports as modified, staged, deleted, renamed or untracked, with a SHA-256 fingerprint of each file's content. After the worker, it compares:
- A path that was clean before and changed after is the task's.
- A path that was dirty before and is unchanged is your pre-existing work. It is left alone and never attributed to the task.
- A path that was dirty before and changed again is **mixed**. Forge knows it was touched, not whose lines are whose, and never pretends otherwise.
- Retries keep attributing earlier attempts' edits to the task, because Forge never reverts a failed attempt. A file you edit between attempts becomes yours or mixed. If HEAD moved between attempts, Forge starts from a fresh baseline.
- Forge never stashes, resets, cleans, or checks out over your changes.

**Safe commit** (`forge task commit <task>`, never automatic).
- Only for a task whose latest attempt passed validation; overridden tasks are excluded.
- Before committing, Forge re-verifies:
  - HEAD and the branch are unchanged;
  - there are no merge conflicts;
  - every attributed file still has exactly the validated content and isn't staged by someone else.
- It stages only the task's new files, by literal path (never `git add .`), and runs `git commit --only -- <those paths>`. Changes you had staged, modified or left untracked stay exactly as they were.
- The message is deterministic: `forge: complete task 1.2 - <task title>`, followed by `Forge-Task`, `Forge-Attempt` and `Forge-Validation` trailers. It never contains worker output.
- `.forge/` and `.git/` are never committed.
- It refuses when any file is mixed, when too many paths exist to attribute, when a rename was staged, or when anything drifted since validation. Commit those changes yourself.
- Repository hooks run as for any commit.
- Nothing is ever pushed. The Git layer has no push, reset, clean, checkout, stash, rebase, merge or amend operations at all.

## AI planning and review

**Roles and providers.**
- Forge has two AI roles, the **planner** and the **reviewer**. Both are Forge code: each builds a request, calls a provider, and validates the answer.
- Providers are chosen per command (`--planner`, `--reviewer`; default `claude`) and recorded by ID with every plan and review. Nothing assumes the planner, the implementer and the reviewer are the same provider, so another provider can take a role later without schema changes.
- AI output is treated as untrusted: a proposal or an opinion. Deterministic validation is the objective evidence; Forge's state machine holds the authority; a human approves plans.

**Read-only by construction.**
- The Claude provider runs planning and review with **no tools** (`--tools=""`) and `--restricted`, with Forge's rules as the whole system prompt, in a fresh empty temporary directory.
- All context arrives on stdin, prepared by Forge. The model can't read or change the project.
- Independently, Forge snapshots `.forge/` metadata and the Git working tree before the call and verifies them afterwards. If anything changed, the result is discarded and nothing is recorded. This also catches your own edits made during the call.
- Planning and review never commit, never run workers, and never change validation checks.

**Context.**
- Files come from `git ls-files --cached --others --exclude-standard`, so Git-ignored files (`.env`, build output, dependencies) are **never listed or read**.
- On top of that, a deny policy withholds secret-like paths (`.env*` except `.env.example`, keys and certificates, `.npmrc`/`.netrc`, credential and secret files, `.ssh`/`.aws`, Terraform variables and state), protected paths (`.git`, `.forge`), generated files (lockfiles, `dist`, `node_modules`) and binaries.
- Limits are deterministic: 40 files, 150 KB in total, 12 KB per file, and 400 tree entries. Manifests come first, then shallower files. Truncation is shown to the model and recorded.
- `forge plan context` shows exactly what a planner would receive.
- This is **not** secret detection: a secret pasted into ordinary source code would be sent. Keep secrets in ignored files.

**Prompt-injection resistance.**
- Repository content, task text, diffs and worker output are placed in `<forge-…>` data blocks. Any Forge-looking tags inside them are neutralized, and the rules say that data is never instructions.
- Answers must be exactly one JSON object and are validated against a strict schema; unknown fields such as `command` or `setTaskStatus` are rejected. So even a successful injection can only produce a proposal or an opinion, never an action.

**Plans** (`forge plan create --goal "..."`).
- The planner answers with milestones, tasks, dependencies, assumptions, risks and informational `suggestedValidation`.
- Forge validates the answer strictly:
  - 1–10 milestones and 1–50 tasks;
  - bounded text;
  - unique IDs;
  - every milestone has a task;
  - a task may depend only on tasks listed earlier, so there are no cycles and the order is deterministic;
  - no unknown fields.
- A failed, malformed, oversized or refused answer stores nothing.
- A valid plan is stored as a **proposal**, which is not work. `forge plan apply` creates its milestones and tasks atomically, with dependencies mapped to real IDs, and starts nothing. It never changes files or validation checks: suggested checks are never configured automatically.
- `forge plan reject --reason` records why; a rejected plan can never be applied.

**Reviews** (`forge task review <task>`).
- Only a task whose latest attempt **passed deterministic validation** is reviewed. Failed validation already decides the outcome.
- The reviewer receives a bounded packet:
  - the task;
  - the validation results;
  - the worker's summary, labeled as a claim;
  - diffs of the task-attributed files against the task's baseline commit (50 files, 100 KB in total, 8 KB per file).
- In the packet, mixed files are labeled as containing pre-existing changes, and secret-like or binary paths are withheld.
- Forge derives the status from the findings' severities, not from the model's verdict: `clear` (info only), `concerns` (any warning), `blocking-concerns` (any error or critical).
- Failed calls are recorded as `unavailable`, `timeout`, `cancelled`, `failed` or `invalid-output`.
- **Reviews are advisory.** They never change task status, never erase validation evidence, and never trigger repairs or re-runs.

**Review decisions** (human, recorded with a reason).
- `forge task review-accept`: the implementation stands despite the review. Nothing else changes.
- `forge task review-reject`: remediation is required. The attempt becomes `review-rejected` and keeps its validation evidence; the task becomes `failed` (retryable if attempts remain), and dependents go back to waiting.
  - It's refused if a dependent task has already run on top of it, or its milestone is completed; add a follow-up task instead.
  - Nothing starts; re-run the task explicitly.

## Autonomous orchestration

`forge run` turns the manual commands into a bounded loop. **Forge owns the loop, not an AI provider.** Each iteration loads the persisted state, decides the ONE next action with a pure function of that state and the policy, performs it through the existing services, records it, and decides again:

1. stop if anything needs a human or is unsafe (see below);
2. follow up on work this orchestration produced: AI review (if enabled), then local commit (if enabled);
3. complete a milestone once the existing completion rule holds;
4. take the first runnable task in milestone/task order: execute it, or repair it if policy allows;
5. otherwise say exactly why nothing can run.

The trust model is unchanged: **worker output is a claim, validator output is evidence, a review is an opinion, and Forge's state machine decides.** Worker summaries, review text, validation output and repository content are data; none of them can change the policy, start an action, or become a command.

**Commands.**
- `forge run` loops until the workflow is complete, a stop condition is hit, or a limit is reached.
- `forge run step` performs at most one workflow step (execute or repair one task, review one task, commit one task, or complete one milestone).
- `forge run --dry-run` prints the effective policy, the next runnable task, the expected next action and pipeline, and the reasons Forge would stop. It performs zero worker/reviewer calls, file changes, commits, or transitions.
- `forge run status` shows whether a run is active, the last run, its stop reason, counters and recent events, the next runnable task, blockers, and the default policy.

**Policy and budgets.** Every automatic behavior comes from an explicit policy printed before the run and recorded (with a SHA-256 hash) in the run history. Defaults are conservative:

| Option | Default | Hard maximum |
| --- | --- | --- |
| `--allow-edits` (implementer may modify files) | read-only (tasks then stop for manual validation) | — |
| `--max-tasks <n>` distinct tasks per run | 5 | 50 |
| `--max-steps <n>` workflow steps per run | 30 | 200 |
| `--repair` / `--repair-review` | off | — |
| `--max-repairs <n>` repairs per task, across runs | 2 | 5 (and the task's own attempt budget) |
| `--review` / `--reviewer <name>` | off | — |
| `--continue-on-concerns` | off: review warnings stop for a human | — |
| `--continue-without-review` | off: an unavailable reviewer stops the run | — |
| `--auto-commit` | off | — |

Values outside the limits are **refused, never clamped**; there is no "0 means unlimited". Existing bounds still apply: worker attempt budgets, worker and validation timeouts, and AI output limits.

**Repair.** When validation fails and `--repair` is set, Forge re-runs the **same implementer** through the normal task engine with a Forge-built `<forge-repair-evidence>` block: failed check IDs, statuses, exit codes, the stored output excerpts, and the files the attempt changed. With `--repair-review`, blocking review findings trigger a repair the same way: Forge records a remediation decision marked `by: policy` (never by the reviewer), then repairs, re-validates and re-reviews. The task instruction itself is unchanged. The evidence is fenced data, and the rules state it is not instructions; check command lines are never included. Each repair consumes an attempt, is recorded on the attempt (trigger, source attempt, review ID, short evidence summary), and counts against the per-task budget. When the budget is spent, Forge stops.

**AI review in the loop.** Review runs only after deterministic validation passed and never changes task status. `clear` continues; `concerns` stop for a human unless `--continue-on-concerns`; `blocking-concerns` stop unless `--repair-review`. An unavailable, timed-out, cancelled or invalid review is never treated as clear: the run stops (a later run retries the review) unless `--continue-without-review`. A human `review-accept` lets the next run continue.

**Automatic local commits.** With `--auto-commit`, a task validated in this run is committed with exactly the M5 `forge task commit` rules: only task-attributed paths, re-verified against the working tree, `git commit --only`. Your other dirty or staged files stay as they are. Mixed attribution, drift, renames or staged changes during the task make Forge **stop**; it never forces, stashes, resets, amends, or pushes. To continue after such a stop, commit the changes yourself and run `forge run` without `--auto-commit`.

**Always stops for** (whatever the policy): integrity or scope violations (never acknowledged automatically), interrupted or concurrently running tasks, tasks awaiting manual validation (validation is never overridden), failed worker invocations (not a validation failure, so not repaired), exhausted repair budgets or attempts, unresolved merge conflicts, commit refusals, an implementer that is unavailable, blocked dependencies, milestones that cannot complete, limits, and Ctrl+C. `COMPLETE` means every milestone is completed or cancelled and every task succeeded or was cancelled. It is reported separately from `BLOCKED`, `NO RUNNABLE TASK`, `RETRY EXHAUSTED`, `LIMIT REACHED` and the rest.

**Interruption and recovery.** Ctrl+C cancels the active worker or reviewer through the normal cancellation path. The attempt is recorded truthfully (`cancelled`), the loop stops, and nothing else starts. A cancelled or crashed attempt is never re-run or committed automatically: the next `forge run` stops with `WORKER FAILED` or `INTERRUPTED TASK` (`forge task recover`). A run record left `running` by a dead process is marked `interrupted` by the next run.

**One run at a time.** A run holds `.forge/orchestration.lock` (run ID, process, host, random token). A second `forge run` is refused. A lock whose owner is gone is reported as probably stale, but **never taken over** automatically: recover it with `forge run recover` (see Human control). Forge checks before every step that the lock is still its own; if it was removed or replaced, the run stops and leaves it alone. The lock is separate from the state lock, which the task engine keeps using per operation, so the two cannot deadlock.

**History.** `state.json` keeps the last 50 runs, each with at most 200 events (action, task, attempt, outcome code, a detail of at most 300 characters), counters, the policy and its hash, and the stop reason. Prompts, diffs, validation output, worker claims and provider text are never stored there.

**Manual vs autonomous.** Every manual command (`forge task run|validate|review|review-accept|review-reject|commit`, `forge plan …`, `forge validation …`) works exactly as before. Manually started attempts carry no orchestration origin, so `forge run` never auto-commits them and does not auto-review them, with one exception: a validated attempt that answers OPEN remediation is reviewed (and, with `--auto-decide`, decided) when review is enabled, because remediation is only ever confirmed by a review decision. It does include them in selection and repair decisions based on their recorded outcome.

## Auto-decision

Without it, review concerns stop the run for a human (`REVIEW DECISION REQUIRED`), exactly as before. With `--auto-decide` (or `forge config set run.autoDecide true`), a separate AI role, the **decision-maker**, judges those reviews so long builds don't stop for routine engineering calls.

```
forge config set providers.decisionMaker claude      # default; any AI provider works, never a fallback
forge run --allow-edits --review --auto-decide --repair --repair-review --max-repairs 3 --auto-commit
forge run --review --auto-decide --decision-maker codex --decision-timeout 600 ...
```

Settings: `run.autoDecide` (requires `run.review`), `providers.decisionMaker`, `run.decisionTimeoutSeconds`. Naming a decision-maker on the command line enables it; naming one only in the project configuration does not.

**Roles stay separate.** The reviewer finds problems. The decision-maker judges, from Forge's evidence, whether the work should be accepted, sent back, or handed to a human. It is told to evaluate each finding itself, not to echo the reviewer's recommendation.

**When it is consulted.** Only where the run would otherwise stop for a human review decision: a review with concerns, or blocking concerns when `--repair-review` is off (with it, policy repair keeps precedence). It only ever sees attempts that passed required deterministic validation. In auto mode, a clear review of an attempt that answers open human- or AI-required remediation is also decided, because a clear review alone does not prove the remediation happened.

**Evidence it receives** (bounded, deterministic, fenced as data):
- the task and its instruction, with attempt and repair counts;
- the validation results and the configured checks, with the program each one runs;
- Forge's scope, integrity, attribution and safe-commit status;
- the worker's summary, labelled **UNTRUSTED CLAIM**;
- the review, with numbered findings and the reviewer's (advisory) recommendation;
- outstanding remediation requirements, with which attributed files changed since each was made;
- earlier attempts, reviews and AI decisions;
- the attributed diffs (secret-like, protected and binary files withheld).

Nothing else from the repository.

**Evidence hierarchy.** Forge's deterministic evidence (checks it ran, attributed changes) > reviewer findings (advisory) > worker claims (never evidence). "Tests pass" with no check that runs tests, or "added tests" with no test file in the changes, is not proven.

**Contract.** One JSON object with:
- `decision`: accept, reject or escalate;
- `confidence`: low, medium or high;
- `reason`;
- an assessment of every warning-or-worse finding and every outstanding requirement (R1, R2, …);
- `requiredActions`, given exactly for reject;
- `humanReason`, given exactly for escalate.

Anything else (prose, extra fields, a missing assessment) is invalid and escalates. It never becomes acceptance.

**Forge's rules (acceptance needs stronger evidence than rejection).**

| Verdict | Applied when | Otherwise |
| --- | --- | --- |
| accept | high confidence, required validation passed, no critical finding, every blocking finding assessed resolved / not applicable, no warning left unresolved, every outstanding requirement assessed satisfied, and attributed files actually changed since each requirement was made | escalate |
| reject | medium or high confidence, and a repair is still possible (repair budget and attempts left) | escalate |
| escalate, no answer, invalid answer, timeout, Ctrl+C | — | stop for a human |

- **ACCEPT** records an `accepted` review decision `by: ai` (the same transition as `forge task review-accept`) and resolves the task's open remediation. The run then continues; with `--auto-commit` the normal safe-commit rules decide whether to commit. An AI acceptance never bypasses them.
- **REJECT** records a `remediation-required` decision `by: ai`, persists `requiredActions` as a remediation record, and reopens the task. The next step repairs it with the review evidence and the outstanding requirements (repair budget and attempt limits apply), validates, reviews and decides again.
- **ESCALATE** (and every failure) stops with `AI DECISION ESCALATED` or `DECISION-MAKER UNAVAILABLE` and a review-acceptance approval request carrying the reason. Decide with `forge approval approve|reject` or `forge task review-accept|review-reject`. An escalation is never re-asked; a provider failure is retried once per later run, at most 3 times per review.

**Hard boundaries the decision-maker never reaches or changes:**
- integrity and scope violations (never acknowledged);
- failed or missing required validation (the normal repair path applies; validation is never overridden);
- unsafe Git attribution (safe-commit refuses), a moved HEAD, and merge conflicts;
- exhausted attempts or repair budgets (it cannot add or reset any);
- interrupted or concurrent tasks, and paused projects;
- approval gates and lease recovery;
- provider authentication.

Its instructions also tell it to escalate product ambiguity, major scope expansion, and anything security-, credential- or destructive-operation-related.

**Remediation tracking.** Every remediation-required review decision (human, policy or AI) creates a structured remediation record. It survives restarts and appears in `forge task show`, `forge status` and `forge audit`. It stays open until a later attempt's review is accepted. Every later worker attempt receives the open requirements, including a manual `forge task run`. The reviewer and the decision-maker are shown them too.

**Provider health.** With auto-decision on, the decision-maker's health is a critical preflight check: if it is unavailable or logged out, `forge run` refuses to start. If it fails during a run, Forge records the failure and stops for a human. It never switches provider and never treats the failure as acceptance.

**Visibility.**
- `forge status`: whether auto-decision is configured and was active in the last run, plus open remediation.
- `forge task show`: remediation and AI decisions.
- `forge task review-show`: each decision with its reason, Forge's rule and required actions.
- `forge explain`: what the decision-maker decided during the last run, and why Forge stopped.
- `forge audit`: each AI decision (provider, model when known, verdict, confidence, effect, reason, review), and each remediation required and satisfied.

## Human control

**Authority.** Approvals, rejections, pause/resume, configuration changes, lease recovery, violation acknowledgements, policy selection and every forced operation are deterministic human actions through the CLI. No AI provider, worker output, review finding, validation output, or repository file can start or authorize any of them.

**Approvals.** When `forge run` stops for a human, it records an approval request (and `FORGE RUN RESULT` prints its ID):

| Type | Requested when | Approving lets the next run… |
| --- | --- | --- |
| `review-acceptance` | review concerns / blocking concerns need a decision | record a human review acceptance, then continue |
| `violation-acknowledgement` | an integrity or scope violation needs acknowledgement | retry the task once, acknowledging the violation |
| `task-retry` | validation failed and repair is not permitted, the repair budget is spent, a worker failed, or remediation was required | run ONE more attempt (a repair with evidence when applicable) |
| `interrupted-recovery` | an execution was interrupted | mark the attempt failed (same as `forge task recover`; never re-runs) |
| `lease-recovery` | `forge run recover --force` on a lock whose owner cannot be proven gone | remove that exact lock |

- `forge approval list | show <id>` shows the bounded evidence (IDs, statuses, finding titles, short excerpts) and exactly what approving allows.
- `forge approval approve|reject <id> --reason "..."` needs an explicit subcommand and a reason; there is no prompt, default answer, or timeout. **Approving performs no work.**
- Each approval is bound to a SHA-256 **fingerprint** of the evidence (task status, attempt and outcome, review ID and status and decision, or the exact lock bytes). If that evidence changes, the approval is **invalidated** and can never be used; a decision on a stale request is refused.
- A later `forge run` uses an approved request **at most once**, in its own recorded `apply-approval` step (consumption is recorded atomically with the fingerprint check), then the authorized action happens through the normal services and is validated normally. A rejected request makes the run stop with `APPROVAL REJECTED` while the evidence is unchanged.
- The manual paths still exist (`forge task review-accept`, `forge task run --acknowledge-integrity-violation`, `forge task recover`); using them makes the pending request stale.

**Pause / resume.** `forge pause --reason "..."` records who (a human), why and when. While paused, `forge run` refuses to start, a running orchestration stops before its next step, and new worker runs, AI planner/reviewer calls, validation runs and commits are refused. Inspection, approvals, configuration, cancellations and recovery still work. Pausing never interrupts a worker that is already running (use Ctrl+C in its terminal); while an edit-enabled task holds the project lock, `forge pause` cannot be recorded and says so. `forge resume --reason "..."` starts nothing.

**Lease recovery.** `forge run recover --reason "..."` removes a crashed run's `orchestration.lock` only when Forge can **prove** the owner is gone: the lock names a process on this machine that no longer exists and a run this project's state knows. A live owner is always refused (even with `--force`). Anything unprovable (another host, unreadable owner, unknown run) needs `--force`, which requests a `lease-recovery` approval bound to the exact lock bytes, including the owner's random token; after a human approves it, run `forge run recover --force` again. The lock is re-read and must be byte-identical before removal; replacing it invalidates the approval. A crash during an edit-enabled task also leaves `.forge/state.lock` behind (that task holds it for its whole run); recovery removes it under the same rule (its owner must be provably gone on this machine; a lock without a recorded host, from an older Forge, must be removed by hand). Recovery marks the dead run `interrupted`, records a control event, and never re-runs a task.

**Preflight.** `forge preflight` checks metadata, state and invariants, configuration, the project boundary, Git (conflicts fail; a detached HEAD, no commits or a dirty tree warn), well-known secret files that are tracked or not ignored (path-based only), validation checks, pause, the orchestration lease, pending approvals, tasks needing attention, and provider health per role. Each check is PASS, WARN or FAIL; a WARN is never shown as PASS. `forge run` runs the same checks first and refuses to start while any **critical** check fails.

**Configuration.** `.forge/config.json` holds human-chosen defaults: `providers.implementer|planner|reviewer` and `run.allowEdits, run.maxTasks, run.maxSteps, run.repairOnValidationFailure, run.repairOnBlockingReview, run.maxRepairsPerTask, run.review, run.continueOnConcerns, run.continueWithoutReview, run.autoCommit, run.workerTimeoutSeconds, run.reviewTimeoutSeconds`. Keys are flat and typed; unknown keys, wrong types, out-of-range values, and credential-like keys or values are refused; writes are atomic and validated; the file is protected Forge metadata. `forge config show` shows each effective value with its source.

**Precedence:** hard safety limits (never overridable) > command-line option > project configuration > environment (`FORGE_WORKER_TIMEOUT_MS`, timeouts only) > conservative default. Boolean options have `--no-<option>` forms so the command line can turn a project default off. A reviewer named in the configuration never enables review by itself. AI output and repository content are never configuration sources. `forge run --dry-run` and the run header list which settings came from the command line and which from the project.

**Status, explain, audit.** `forge status` is a concise operational view (pause, active run, current milestone, next task, blockers, interrupted tasks, approvals, last run, validation, Git, uncommitted succeeded tasks, providers, the human action required). `forge explain` says in plain language why Forge stopped (deterministic validation, AI review, repair policy, the related approval) and the next safe commands; it is built from stored records, never by an AI. `forge audit` is a chronological history derived from the authoritative records (plans, attempts, validation, reviews, commits, approvals, runs, human control events); there is no second log that could disagree.

**Providers by role.** `forge provider list` shows the planner, implementer and reviewer and where each choice comes from; `forge provider check [--role r]` runs local health checks (no AI call). Claude Code and Codex are both available for every role (see Provider roles).

**Onboarding.** `forge init` registers the project (or preserves an existing registration), creates an empty configuration, and reports Git safety, validation checks and provider availability. It only *suggests* validation commands from `package.json` scripts; it never adds or runs them, never runs `git init`, never installs dependencies, and never starts a worker. `forge project add` is unchanged.

**Inspection is read-only.** `status`, `preflight`, `explain`, `audit`, `config show|get|validate`, `provider list|check`, `approval list|show`, `run status` and `run --dry-run` never change state, configuration, metadata, source files or Git (tested byte-for-byte). Provider checks launch local processes only.

**Failure output.** Expected failures print one actionable line (with the relevant task, approval or run ID and the next safe command) and no stack trace. Unexpected errors are reported as `internal error`, never swallowed, with details only under `FORGE_LOG_LEVEL=debug`. Values of credential-like environment variables (names containing TOKEN, SECRET, PASSWORD, API_KEY, …) are redacted from error output; configuration, state and history never store credentials or environment values.

**Metadata backups.** Forge does not keep automatic backups of `.forge/`. Its documents are validated on every read and write and written atomically, invalid metadata is refused rather than repaired, and nothing is ever restored automatically. Copy `.forge/state.json` and `.forge/config.json` yourself if you want a backup.

## Current limitations

- **Control-state guard is detective, not preventive:** Claude's file tools are not blocked from `.forge/`, because Forge doesn't rely on unverified path-rule syntax. Instead, the guard described below detects any change. It does not prevent the change or undo it.
- **Long edit runs block other writers:** while an edit-enabled run is in progress, other Forge processes cannot update that project's state; they fail with a lock conflict after 5 seconds.
- **Prompt rules are advisory:** the rules Forge sends ("stay in scope, don't commit") are instructions to the model. What is actually enforced is the tool and permission set above, together with the working-directory confinement Claude applies.
- **Worker environment:** workers inherit Forge's environment variables. The Claude worker has no tool that could read them; Codex's own model-run commands get only a minimal (`core`) environment, but the Codex process itself inherits Forge's.
- **Codex reads:** Codex's sandbox restricts writes and network, not reads; a Codex worker or role could read files outside the project that your account can read (role runs cannot run commands, so they cannot read anything at all).
- **Codex sandbox mode:** on Windows, Forge uses Codex's `unelevated` sandbox (no admin setup required), not the stronger `elevated` mode, which needs per-machine setup Forge cannot verify.
- **Codex login status** reflects what `codex login status` reports; an expired token may only show up as a failed run (reported as `failed`, never success).
- **Process-tree termination** on timeout/Ctrl+C is implemented for Windows (`taskkill /T`); on other platforms only the direct child is signalled.
- **Interrupted manual runs:** a `forge worker run` interrupted by a crash (not by Ctrl+C) stays recorded as `running`. Task executions are detected as `interrupted` and recovered with `forge task recover`.
- **Interruption detection is local:** Forge checks whether the recorded process ID is still alive on the same host. An executor on another host can't be checked (use `--force`), and a reused process ID could make a dead execution look alive.
- **AI context is best-effort about secrets:** ignored files and secret-like paths are excluded, but a secret inside ordinary tracked source would be included.
- **Concurrent edits during AI calls:** planning and review can't tell your concurrent edits from AI changes, so editing files during a call discards its result.
- **No model identifier:** neither the Claude CLI's JSON result nor Codex's event stream reliably reports the model used, so none is recorded.
- **Orchestration is sequential and local:** one task at a time, one implementer, one project per run. There are no worktrees, no parallelism, no background service, and no push.
- **Manual commands during a run:** a manual `forge task …` command in another terminal is serialized by the state lock, not refused. The orchestrator re-reads state before every step and stops if it finds a task running elsewhere.
- **Approvals stop at the first human-blocked task:** independent tasks are not run around a task waiting for a human decision.
- **Pause during an edit-enabled task** cannot be recorded until that task's step finishes (the task holds the project lock); use Ctrl+C to stop it immediately.
- **Lease recovery across machines** always needs `--force` and a human approval: Forge cannot check processes on another host.
- **Auto-commit refusals need you:** after a commit refusal, commit the changes yourself and continue without `--auto-commit`. Forge cannot tell that you committed them.
- **Ignored files are invisible:** attribution and scope checks rely on `git status`, so a worker writing to a Git-ignored path (`dist/`, `.env`) isn't observed. Forge verifies what Git and the file system show inside the project, not the whole machine.
- **Validation runs project code:** a check such as `npm test` executes code the worker may have changed. Forge protects the check definitions, not the code they run. V1 is not a sandbox.
- **Concurrent profile edits:** changing validation checks while a read-only task is running is reported as an integrity violation.
- **Interleaved edits:** edits you make in the same files while an edit-enabled task runs are attributed to the task. Forge can't tell who typed them.
- **No task editing:** tasks can't be edited or re-parented after creation, and dependencies can't be changed. Cancel a task and add a new one instead.
- **Windows launchers:** only npm "cmd-shim" launchers are unwrapped. Any other `.cmd`/`.bat` (including npm's own `npm.cmd`) is refused; point Forge at the underlying executable instead.

Carried over from Milestone 2:

- **Path safety:** the boundary resolves links for the parts of a path that exist. Components that don't exist yet can't be resolved, and a link created between the check and the use (time-of-check/time-of-use) isn't prevented. The boundary is a guard for Forge's own operations, not an OS sandbox.
- **Case sensitivity:** Windows paths compare case-insensitively. Elsewhere comparison is case-sensitive, so on case-insensitive macOS volumes a differently-cased path is conservatively treated as outside.
- **Moving a project:** moving a registered project directory invalidates its metadata, which records the original root. Re-registering requires removing `.forge/` manually.
- **Stale locks:** a stale `.forge/state.lock` left by a crashed process is not removed automatically. Delete it manually when no Forge process is running. (A stale `orchestration.lock` is recovered with `forge run recover`.)
- **No project list:** there is no global registry of projects; each project is found through its own `.forge/`.
- **Inherited Git variables:** `GIT_DIR`/`GIT_WORK_TREE` set in Forge's own environment are passed through to Git and would affect repository detection.
