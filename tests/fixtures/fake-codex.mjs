// Stand-in for the OpenAI Codex CLI used by the automated tests. It mimics
// the subset Forge relies on (`--version`, `exec --help`, `login status`,
// `codex exec --json` with the prompt on stdin), records how it was invoked,
// and never contacts any service. Event shapes follow codex-cli 0.157.0.
// Behavior is read from `fake-codex.config.json` beside this file.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';

const here = new URL('.', import.meta.url);
const config = JSON.parse(readFileSync(new URL('fake-codex.config.json', here), 'utf8'));
const args = process.argv.slice(2);

const EXEC_HELP = `Run Codex non-interactively

Usage: codex exec [OPTIONS] [PROMPT]

Options:
  -c, --config <key=value>   Override a configuration value
      --enable <FEATURE>     Enable a feature (repeatable)
      --disable <FEATURE>    Disable a feature (repeatable)
  -s, --sandbox <SANDBOX_MODE>  [possible values: read-only, workspace-write, danger-full-access]
      --dangerously-bypass-approvals-and-sandbox
  -C, --cd <DIR>             Tell the agent to use the specified directory as its working root
      --skip-git-repo-check  Allow running Codex outside a Git repository
      --ephemeral            Run without persisting session files to disk
      --ignore-user-config   Do not load $CODEX_HOME/config.toml
      --ignore-rules         Do not load user or project execpolicy .rules files
      --color <COLOR>        [possible values: always, never, auto]
      --json                 Print events to stdout as JSONL
`;

if (args.includes('--version')) {
  process.stdout.write(`codex-cli ${config.version ?? '0.157.0'}\n`);
  process.exit(0);
}
if (args[0] === 'exec' && args.includes('--help')) {
  process.stdout.write(config.execHelp ?? EXEC_HELP);
  process.exit(0);
}
if (args[0] === 'login' && args[1] === 'status') {
  if (config.loggedIn === false) {
    process.stderr.write('Not logged in\n');
    process.exit(1);
  }
  process.stderr.write('Logged in using ChatGPT\n');
  process.exit(0);
}
if (args[0] !== 'exec') {
  process.stderr.write('fake-codex: only exec is supported\n');
  process.exit(64);
}

const event = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

/**
 * Mimics the model running npm inside the real sandbox (as seen in a real
 * run): npm always writes a cache with `_logs/`. When Forge sanctioned a
 * cache (`npm_config_cache` in `shell_environment_policy.set`, inside the
 * extra writable root) it goes there. Otherwise the model improvised
 * `npm --cache .forge/npm-cache`, a Git-ignored path in the working directory.
 */
function runNpmLikeCommand() {
  const setting = args.find((arg) => arg.startsWith('shell_environment_policy.set='));
  const roots = args.find((arg) => arg.startsWith('sandbox_workspace_write.writable_roots='));
  const sanctioned = setting === undefined ? undefined : /npm_config_cache = '([^']*)'/.exec(setting)?.[1];
  const root = roots === undefined ? undefined : /\['([^']*)'\]/.exec(roots)?.[1];
  const cache = sanctioned !== undefined && root !== undefined && sanctioned.startsWith(root) ? sanctioned : join(process.cwd(), '.forge', 'npm-cache');
  mkdirSync(join(cache, '_logs'), { recursive: true });
  writeFileSync(join(cache, '_logs', '2026-10-01T12_04_04_062Z-debug-0.log'), 'verbose title npm install\n');
  writeFileSync(join(cache, '_update-notifier-last-checked'), '');
  writeFileSync(new URL('codex-npm-cache.txt', here), cache);
}

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  stdin += chunk;
});
process.stdin.on('end', () => {
  const role = stdin.includes('You are the planner for Forge') ? 'planner' : stdin.includes('You are the code reviewer for Forge') ? 'reviewer' : 'worker';
  const record = { argv: args, stdin, cwd: process.cwd(), role };
  writeFileSync(new URL('codex-invocation.json', here), JSON.stringify(record));
  writeFileSync(new URL(`codex-${role}-invocation.json`, here), JSON.stringify(record));
  const calls = new URL(`codex-${role}-calls.txt`, here);
  let count = 0;
  try {
    count = Number(readFileSync(calls, 'utf8'));
  } catch {
    count = 0;
  }
  writeFileSync(calls, String(count + 1));
  const answer = role === 'planner' ? config.plannerResult : role === 'reviewer' ? config.reviewerResult : undefined;

  const mode = config.mode ?? 'success';
  if (!['empty', 'garbage', 'crash', 'flood'].includes(mode)) {
    event({ type: 'thread.started', thread_id: '01a0f702-0000-7000-8000-000000000001' });
    event({ type: 'turn.started' });
  }
  switch (mode) {
    case 'success': {
      if (role === 'worker' && config.npmCache === true) {
        runNpmLikeCommand();
      }
      for (const [path, content] of Object.entries(role === 'worker' ? (config.writes ?? {}) : {})) {
        mkdirSync(dirname(join(process.cwd(), path)), { recursive: true });
        writeFileSync(join(process.cwd(), path), content);
        event({ type: 'item.completed', item: { id: 'item_1', type: 'file_change', changes: [{ path, kind: 'add' }], status: 'completed' } });
      }
      event({ type: 'error', message: 'Reconnecting... 1/5 (transient)' });
      event({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'Working on it.' } });
      event({ type: 'item.completed', item: { id: 'item_3', type: 'agent_message', text: answer ?? config.result ?? 'Done. All tests pass.' } });
      event({ type: 'turn.completed', usage: { input_tokens: 120, cached_input_tokens: 0, output_tokens: 30 } });
      process.stderr.write('2026-10-01T00:00:00Z ERROR codex_models_manager::manager: failed to refresh available models (noise)\n');
      process.exit(0);
      break;
    }
    case 'error':
      event({ type: 'error', message: 'unexpected status 401 Unauthorized' });
      event({ type: 'turn.failed', error: { message: config.failMessage ?? 'unexpected status 401 Unauthorized' } });
      process.exit(1);
      break;
    case 'garbage':
      process.stdout.write('this is not json\n');
      process.exit(0);
      break;
    case 'empty':
      process.exit(0);
      break;
    case 'incomplete':
      event({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'half' } });
      process.exit(0);
      break;
    case 'crash':
      process.stderr.write(`boom: ${config.secretEcho ?? 'something broke'}\n`);
      process.exit(3);
      break;
    case 'sleep':
      setInterval(() => {}, 1000);
      break;
    case 'grandchild': {
      // Starts a descendant that would write a file later, then hangs: tests tree termination.
      const marker = config.marker;
      // Detached: outside Node's own job object, like the children of a native CLI.
      spawn(process.execPath, ['-e', `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'late'), 3000)`], { stdio: 'ignore', detached: true }).unref();
      setInterval(() => {}, 1000);
      break;
    }
    case 'flood':
      process.stdout.write('x'.repeat(9 * 1024 * 1024), () => process.exit(0));
      break;
    default:
      process.stderr.write(`fake-codex: unknown mode ${config.mode}\n`);
      process.exit(70);
  }
});
