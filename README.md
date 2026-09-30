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

Automatic retries, autonomous remediation, and autonomous execution are **not** implemented yet. Nothing runs unless you explicitly ask for it, one task at a time.

> **Planner proposes. Worker implements. Validator proves deterministic checks. Reviewer critiques. Forge controls state. Human approves consequential AI decisions.**

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

forge milestone add --title <text> [--description <text>]
forge milestone list | show <m> | complete <m> | cancel <m> [--reason <text>]

forge task add --milestone <m> --title <text> --instruction <text>
      [--context <text>] [--depends-on <task>]... [--max-attempts <n>]
forge task list [--milestone <m>] | show <task> | ready
forge task run <task> [--worker claude] [--timeout <seconds>] [--allow-edits]
      [--acknowledge-integrity-violation]
forge task validate <task>
forge task override <task> --reason <text>
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

`.forge/` holds **Forge metadata only — never credentials**, and no logs or raw worker output. Both documents carry a `schemaVersion`. They are validated whenever they are read, because they may have been edited by hand. Forge refuses (rather than repairs) malformed, unsupported-version, or relocated metadata. Older state is migrated step by step on load (v1 → v2 → v3). Version 2 placeholder tasks, which no Forge command ever created, are refused rather than guessed at.

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

## Current limitations

- **Control-state guard is detective, not preventive:** Claude's file tools are not blocked from `.forge/`, because Forge doesn't rely on unverified path-rule syntax. Instead, the guard described below detects any change. It does not prevent the change or undo it.
- **Long edit runs block other writers:** while an edit-enabled run is in progress, other Forge processes cannot update that project's state; they fail with a lock conflict after 5 seconds.
- **Prompt rules are advisory:** the rules Forge sends ("stay in scope, don't commit") are instructions to the model. What is actually enforced is the tool and permission set above, together with the working-directory confinement Claude applies.
- **Worker environment:** the worker inherits Forge's environment variables. It has no tool that could read them.
- **Interrupted manual runs:** a `forge worker run` interrupted by a crash (not by Ctrl+C) stays recorded as `running`. Task executions are detected as `interrupted` and recovered with `forge task recover`.
- **Interruption detection is local:** Forge checks whether the recorded process ID is still alive on the same host. An executor on another host can't be checked (use `--force`), and a reused process ID could make a dead execution look alive.
- **AI context is best-effort about secrets:** ignored files and secret-like paths are excluded, but a secret inside ordinary tracked source would be included.
- **Concurrent edits during AI calls:** planning and review can't tell your concurrent edits from AI changes, so editing files during a call discards its result.
- **No model identifier:** the Claude CLI's JSON output doesn't reliably report the model used, so none is recorded.
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
- **Stale locks:** a stale `.forge/state.lock` left by a crashed process is not removed automatically. Delete it manually when no Forge process is running.
- **No project list:** there is no global registry of projects; each project is found through its own `.forge/`.
- **Inherited Git variables:** `GIT_DIR`/`GIT_WORK_TREE` set in Forge's own environment are passed through to Git and would affect repository detection.
