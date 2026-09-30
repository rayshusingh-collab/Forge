\# Forge — Claude Code Engineering Rules



\## 1. Project Purpose



Forge is a local-first AI software-development orchestrator.



Its purpose is to allow a user to describe a software project or development goal and have Forge coordinate AI coding workers to plan, implement, validate, review, and progressively complete that work with minimal manual intervention.



Forge is NOT tied to any specific application, game, framework, or repository.



Forge must eventually support multiple AI workers. Claude Code will be the first worker. Other workers, including Codex, may be added later.



\---



\## 2. Core Principle



Forge must never treat an AI worker saying "done" as proof that work is correct.



Work must pass through:



Plan

→ Execute

→ Validate

→ Review

→ Fix if necessary

→ Revalidate

→ Accept

→ Commit

→ Continue



Validation is a first-class part of the system.



\---



\## 3. Architecture Rules



The codebase must remain:



\- modular

\- strongly typed

\- testable

\- understandable

\- extensible

\- provider-independent where practical



Do not build Forge as one giant script.



Major responsibilities must remain separated.



Expected conceptual components include:



\- CLI

\- configuration

\- project management

\- persistent state

\- planning

\- task/milestone management

\- worker abstraction

\- Claude Code worker

\- process execution

\- validation

\- review

\- retry handling

\- Git operations

\- logging

\- approval/escalation handling



Exact implementation details may evolve, but separation of concerns must be preserved.



\---



\## 4. Worker Abstraction



Claude Code must not become permanently hard-coded into the orchestration engine.



Use an abstraction that allows future workers such as:



\- Claude Code

\- Codex

\- other coding agents



The orchestrator should interact with a common worker interface wherever practical.



Provider-specific behavior belongs inside provider adapters.



\---



\## 5. Local-First



Forge V1 runs locally on the user's machine.



It may interact with:



\- local repositories

\- Git

\- local development tools

\- test runners

\- compilers

\- linters

\- build systems

\- Claude Code



Cloud infrastructure is not required for V1.



Do not introduce unnecessary cloud services.



\---



\## 6. Safety Boundaries



Forge must default to conservative permissions.



Never automatically:



\- force-push

\- rewrite Git history

\- delete branches

\- delete repositories

\- delete arbitrary user files

\- execute destructive filesystem operations

\- expose credentials

\- commit secrets

\- modify files outside explicitly authorized project directories

\- merge unverified work into protected branches



Potentially destructive operations must require explicit user approval.



Forge must validate paths before allowing filesystem or process operations.



\---



\## 7. Git Safety



Before substantial autonomous modification, Forge should ensure a recoverable Git state exists.



Worker changes should eventually support isolated branches or worktrees.



Never use destructive Git commands such as:



git reset --hard

git clean -fd

git push --force



unless an explicitly designed approval mechanism authorizes the operation.



Do not automatically push to remote repositories in V1.



\---



\## 8. Secrets



Secrets must never be committed.



Files such as `.env` must remain ignored.



Use environment variables for credentials and tokens.



`.env.example` may document variable names but must contain no real credentials.



Logs must avoid leaking credentials.



\---



\## 9. Process Execution



Do not design unrestricted arbitrary shell execution as the default behavior.



Commands should execute:



\- within an authorized working directory

\- through a controlled process runner

\- with captured stdout

\- with captured stderr

\- with exit codes

\- with configurable timeouts



Execution results must be recorded sufficiently for debugging.



\---



\## 10. Validation



A task is not complete simply because a worker claims success.



Forge should be capable of validating work using appropriate project commands such as:



\- tests

\- type checking

\- linting

\- builds

\- application-specific checks



Validation results must be represented explicitly.



Failed validation must prevent automatic acceptance.



\---



\## 11. Review



Implementation and acceptance should be conceptually separate.



The review layer should evaluate:



\- task requirements

\- validation results

\- relevant code changes

\- architecture constraints

\- regressions

\- unresolved failures



A worker must not be trusted solely to approve its own output.



\---



\## 12. Retry Policy



Failures may be returned to a worker with relevant diagnostics.



Retries must be bounded.



Forge must never create an infinite autonomous repair loop.



After the configured retry limit, the task should stop or escalate for user input.



\---



\## 13. Human Approval



Forge should minimize unnecessary interruptions while preserving human control.



User approval should be required for important situations such as:



\- destructive actions

\- major architectural deviations

\- ambiguous product decisions

\- changes outside authorized scope

\- exhausted retries

\- operations explicitly configured as approval-required



Normal implementation details should not require constant approval.



\---



\## 14. Persistent State



Important orchestration state must survive process restarts.



Forge should eventually persist information such as:



\- project identity

\- project path

\- project instructions

\- milestones

\- tasks

\- task status

\- attempts

\- validation results

\- decisions

\- worker activity

\- errors

\- approvals required



Do not depend entirely on conversation history or in-memory state.



\---



\## 15. Observability



Forge must clearly communicate what it is doing.



Important operations should be logged.



Logs should make it possible to understand:



\- what task was attempted

\- which worker performed it

\- what command was executed

\- whether it succeeded

\- why something failed

\- what Forge decided next



Avoid noisy logging that obscures useful information.



\---



\## 16. Testing



New core behavior should have tests.



Important safety behavior requires tests.



At minimum, eventually test:



\- configuration validation

\- state persistence

\- path authorization

\- process execution

\- worker invocation

\- timeout behavior

\- retry limits

\- validation handling

\- Git safety behavior



Do not remove or weaken tests merely to make a failing implementation pass.



\---



\## 17. Scope Discipline



Implement only the current approved milestone.



Do not prematurely build later phases.



Do not add:



\- web dashboards

\- cloud infrastructure

\- distributed workers

\- databases

\- unnecessary frameworks

\- unrelated features



unless the current milestone requires them.



Prefer the smallest clean implementation that preserves the intended architecture.



\---



\## 18. Dependencies



Keep dependencies minimal.



Before adding a dependency, consider whether Node.js or the existing stack already provides the required capability.



Dependencies should have a clear purpose.



Avoid introducing large frameworks for small problems.



\---



\## 19. Code Quality



Prefer:



\- explicit types

\- small focused modules

\- meaningful names

\- clear error handling

\- dependency injection where useful

\- deterministic behavior where possible



Avoid:



\- giant files

\- hidden global state

\- duplicated logic

\- unnecessary abstraction

\- premature optimization

\- unexplained magic values



Comments should explain reasoning, constraints, or non-obvious behavior rather than restating code.



\---



\## 20. Change Discipline



Before implementing a milestone:



1\. Inspect the existing repository.

2\. Understand relevant code.

3\. Identify affected components.

4\. Preserve existing working behavior.



After implementation:



1\. Run appropriate validation.

2\. Report what changed.

3\. Report tests/checks performed.

4\. Report failures honestly.

5\. Do not claim success if validation failed.



\---



\## 21. V1 Priorities



Forge V1 prioritizes:



1\. reliability

2\. safety

3\. recoverability

4\. understandable architecture

5\. autonomous execution

6\. extensibility



Autonomy must not come at the cost of the first four priorities.



\---



\## 22. Current Development Rule



Claude Code is currently helping BUILD Forge.



Do not confuse this with Claude Code being controlled BY Forge.



During early development, implement only the milestone explicitly provided by the user.



Do not independently begin later milestones.



Do not commit changes unless the current prompt explicitly authorizes committing.



At the end of each milestone, provide a concise structured report containing:



\- files changed

\- functionality implemented

\- tests/checks run

\- results

\- unresolved issues

\- recommended next step



Then stop and wait.

