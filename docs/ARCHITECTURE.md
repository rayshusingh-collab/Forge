\# Forge Architecture



\## Mission



Forge is a local-first autonomous software-development orchestrator.



A user provides a project, requirements, or development objective. Forge converts that objective into controlled development work and coordinates coding agents to execute it.



The long-term workflow is:



User Goal

→ Project Understanding

→ Planning

→ Milestones

→ Tasks

→ Worker Execution

→ Validation

→ Review

→ Repair

→ Acceptance

→ Git Checkpoint

→ Next Task



\---



\# High-Level Architecture



&#x20;                   User

&#x20;                    │

&#x20;                    ▼

&#x20;               Forge CLI

&#x20;                    │

&#x20;                    ▼

&#x20;            Orchestration Engine

&#x20;                    │

&#x20;      ┌─────────────┼─────────────┐

&#x20;      │             │             │

&#x20;      ▼             ▼             ▼

&#x20;   Planner      State Manager   Approval

&#x20;      │

&#x20;      ▼

&#x20;  Task Manager

&#x20;      │

&#x20;      ▼

&#x20;  Worker Router

&#x20;      │

&#x20;      ├──────── Claude Code Worker

&#x20;      │

&#x20;      └──────── Future Codex Worker

&#x20;                    │

&#x20;                    ▼

&#x20;             Project Repository

&#x20;                    │

&#x20;         ┌──────────┼──────────┐

&#x20;         ▼          ▼          ▼

&#x20;     Validator   Reviewer   Git Manager

&#x20;         │          │          │

&#x20;         └──────────┼──────────┘

&#x20;                    │

&#x20;                    ▼

&#x20;            Orchestration Engine

&#x20;                    │

&#x20;            PASS / RETRY / STOP

&#x20;                    │

&#x20;                    ▼

&#x20;                 Next Task



\---



\# Core Components



\## CLI



Human interface to Forge.



Eventually responsible for commands such as:



\- initialize project

\- start work

\- resume work

\- inspect status

\- pause execution

\- approve actions



The CLI must remain separate from orchestration logic.



\---



\## Configuration



Loads and validates Forge configuration.



Configuration may eventually include:



\- worker configuration

\- timeouts

\- retry limits

\- authorized paths

\- validation commands

\- Git behavior

\- approval policies



\---



\## Project Manager



Represents a software project controlled by Forge.



Stores project-level information and ensures operations remain within the authorized project.



Implemented (Milestone 2): a project is the root of a Git work tree, identified by a stable UUID. Its metadata lives in `<project-root>/.forge/`, which is Git-ignored by a `.forge/.gitignore` so registration never changes the user's working tree. Metadata records its canonical root path; metadata that has been moved or copied elsewhere is refused.



The project path boundary (`src/projects/path-boundary.ts`) is the single authority on whether a path is inside a project. It checks paths lexically (normalized, case-insensitive on Windows, no string-prefix matching), then resolves existing links so a symlink or junction pointing outside the project is rejected.



\---



\## State Manager



Persists orchestration state.



Forge must be able to recover from:



\- terminal closure

\- crashes

\- machine restart

\- worker failure



State should not exist only in memory.



Implemented (Milestone 2): state is a versioned JSON document per project (`.forge/state.json`), validated on every load and before every write. It is written atomically (temp file then rename). Concurrent writers are handled with an optimistic `revision` checked under a short-lived exclusive lock file, so a stale writer gets a conflict instead of silently overwriting. Documents from unsupported schema versions are rejected; migrations are added at a single version boundary.



\---



\## Planner



Converts a high-level objective into structured milestones and tasks.



Implemented (Milestone 6, `src/planning/`, `src/ai/`, `src/context/`): the planner is a Forge role backed by any registered `AiProvider`. It receives bounded, Git-aware project context: ignored files are never read, and secret-like and protected paths are withheld. Its answer must be one JSON object that passes a strict schema (bounded counts, unique IDs, dependencies only on earlier tasks, no unknown fields), and it is stored as a **proposal**. Only `forge plan apply`, a human decision, turns a proposal into milestones and tasks, atomically and through the normal task transitions. Planning is read-only: the provider has no tools and runs in an empty scratch directory, and Forge verifies `.forge/` and the working tree before and after.



Planning and implementation should remain separate concepts.



\---



\## Task Manager



Tracks task lifecycle.



Potential states include:



PENDING

RUNNING

VALIDATING

REVIEWING

RETRYING

BLOCKED

COMPLETED

FAILED



Implemented (Milestone 4, `src/tasks/`): AI workers execute work; Forge owns workflow state.

The stored task statuses are `pending`, `running`, `awaiting-validation`, `succeeded`, `failed` and `cancelled`. Readiness, blocking, retryability, exhaustion and interruption are derived from dependencies, attempt budgets and executor liveness, and are never stored, so they cannot drift. The conceptual VALIDATING / REVIEWING / RETRYING / BLOCKED states map onto these: VALIDATING is `awaiting-validation`, RETRYING is a `failed` task that still has attempts left, and BLOCKED is derived.

All transitions live in `transitions.ts` as pure `state -> state` functions with explicit transition tables. They are applied through `StateStore.update`, so every rule is re-checked against the latest state under the state lock. Invariants (dependency DAG, ordering, status/attempt consistency, attempt ↔ worker-run links) are enforced on every load and write.

A task execution is one attempt linked to exactly one worker run. Worker `success` moves the task to `awaiting-validation`, which is the seam where Milestone 5's deterministic validator decides `succeeded` or `failed`; until then, manual accept and reject stand in for it. One command executes at most one attempt of one task, and there is no automatic continuation or retry.



\---



\## Worker Interface



Common interface for coding agents.



Conceptually:



Worker

&#x20; execute(task, context)

&#x20; cancel()

&#x20; healthCheck()



Specific workers implement this interface.



Initial implementation:



ClaudeCodeWorker



Future:



CodexWorker



Implemented (Milestone 3): `src/workers/` defines `Worker` (`id`, `capabilities`, `healthCheck()`, `execute(request, { signal })`), with cancellation through an `AbortSignal` rather than a separate `cancel()`. `execute` resolves with a `WorkerResult` for every runtime outcome: success, failed, timeout, cancelled, unavailable or invalid-output. Requests can only be built by `prepareWorkerRequest`, which authorizes the working directory through the project path boundary. The Forge prompt envelope separates Forge's rules from the fenced task and context. Standalone runs are persisted as bounded `workerRuns` in state (schema v2). Provider specifics (CLI flags, output format, permission policy) live only in adapters: `ClaudeCodeWorker` invokes the headless Claude Code CLI through the `ProcessRunner`, with the task sent on stdin.



`.forge/` is Forge's control plane, never worker-owned. Edit-enabled worker runs hold the state lease (the state lock) for the whole run, so no legitimate Forge write can occur between the pre-run snapshot and post-run verification. Any byte change under `.forge/` is therefore attributed to something other than Forge. It yields an `integrity-violation` verdict that overrides the worker's own outcome, with evidence preserved and nothing restored. State is written afterwards only if it is provably untouched (`src/projects/control-integrity.ts`, `src/workers/run-recorder.ts`).



Executables are resolved to absolute programs before spawning (`src/execution/executable-resolver.ts`). Windows npm `.cmd` launchers are unwrapped to the program they wrap, so no shell is ever needed.



\---



\## Process Runner



Controlled interface for launching external processes.



Responsibilities:



\- working-directory enforcement

\- stdout capture

\- stderr capture

\- exit code capture

\- timeout handling

\- cancellation

\- structured results



The rest of Forge should avoid spawning uncontrolled processes directly.



\---



\## Validator



Runs deterministic checks whenever possible.



Examples:



\- test suite

\- type checker

\- linter

\- build

\- application-specific smoke tests



Worker statements are not substitutes for validation.



Implemented (Milestone 5, `src/validation/`): worker output is a claim, validator output is evidence, and Forge's workflow state is the decision. Checks are human-managed executable configuration (program plus argument array, no shell), stored as protected control metadata in `.forge/validation.json`. They run sequentially in a deterministic order, and the overall status is decided by the required checks only. Inside one `task run`, under the integrity lease: the worker runs, `.forge/` is verified, the changeset and scope are checked, validation runs, `.forge/` is verified again, and then a single state write records the decision (`validated` → succeeded, `validation-failed` → failed; incomplete validation or no required checks → awaiting validation). Only an explicit, audited human override can succeed a task without passing validation.



\---



\## Reviewer



Evaluates whether implementation satisfies the task.



Implemented (Milestone 6, `src/review/`): the AI reviewer critiques an attempt that already passed deterministic validation, using a bounded packet: the task, validation results, the worker's claim labeled as such, and task-attributed diffs with mixed files labeled. Its output is **advisory evidence**, kept separate from validation everywhere. Forge derives the review status from finding severities, and a review never changes task status. Only a recorded human decision has consequences: `review-accept` records it; `review-reject` reopens the task (the attempt becomes `review-rejected` with its validation evidence kept) and starts nothing.

Planner proposes. Worker implements. Validator proves deterministic checks. Reviewer critiques. Forge controls state. Human approves consequential AI decisions.



The reviewer should consider:



\- task requirements

\- validation output

\- changed files/diff

\- architecture constraints

\- unresolved errors



Possible decisions:



ACCEPT

RETRY

ESCALATE

REJECT



\---



\## Retry Controller



Controls automated repair attempts.



Retries must be bounded.



Diagnostics from failed validation/review should be supplied to the next attempt.



\---



\## Git Manager



Provides safe Git operations.



Eventually responsible for:



\- repository inspection

\- checkpoints

\- branches

\- worktrees

\- diffs

\- commits

\- rollback-safe workflows



Dangerous operations must not occur automatically.



Implemented (Milestone 5, `src/git/`): `GitClient` is the only way Forge runs Git. It uses a resolved absolute executable, argument arrays, literal pathspecs, porcelain v2 `-z` output and bounded output. It deliberately exposes no push, reset, clean, checkout, stash, rebase, merge or amend. Before an edit-enabled task, a baseline records HEAD, the branch, and a fingerprint of every dirty path. Afterwards the delta attributes each change as `task` (clean before) or `mixed` (already dirty); retries carry the task's baseline forward. `forge task commit` commits only a validated task's `task`-attributed paths with `git commit --only`, after re-verifying them against the live repository, and refuses anything ambiguous.



\---



\## Approval Manager



Stops autonomous execution when human authorization is required.



Examples:



\- destructive operation

\- major architecture change

\- ambiguous requirement

\- exhausted retries



\---



\## Logger



Produces structured and human-readable activity records.



Secrets must be redacted.



\---



\# Proposed Source Layout



The exact layout may evolve as implementation teaches us more.



src/

&#x20; cli/

&#x20; config/

&#x20; core/

&#x20; projects/

&#x20; state/

&#x20; planning/

&#x20; tasks/

&#x20; workers/

&#x20; execution/

&#x20; validation/

&#x20; review/

&#x20; git/

&#x20; approvals/

&#x20; logging/

&#x20; types/



tests/



docs/



projects/



\---



\# Initial Technology



Runtime:

Node.js



Language:

TypeScript



Initial worker:

Claude Code



Version control:

Git



Persistence:

Start lightweight and local. Do not introduce a database until requirements justify one.



\---



\# Design Principle



Forge is not an AI model.



Forge is the control system around AI models and coding agents.



Its primary responsibility is making autonomous software-development work:



safe,

observable,

recoverable,

testable,

and progressively executable.

