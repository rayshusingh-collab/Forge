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



\---



\## State Manager



Persists orchestration state.



Forge must be able to recover from:



\- terminal closure

\- crashes

\- machine restart

\- worker failure



State should not exist only in memory.



\---



\## Planner



Converts a high-level objective into structured milestones and tasks.



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



\---



\## Reviewer



Evaluates whether implementation satisfies the task.



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

