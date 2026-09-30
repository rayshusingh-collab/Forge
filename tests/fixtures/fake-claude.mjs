// Stand-in for the Claude Code CLI used by the automated tests. It mimics the
// subset of behavior Forge relies on, records how it was invoked, and never
// contacts any service. Behavior is read from `fake-claude.config.json`
// beside this file.
import { readFileSync, writeFileSync } from 'node:fs';

const here = new URL('.', import.meta.url);
const config = JSON.parse(readFileSync(new URL('fake-claude.config.json', here), 'utf8'));
const args = process.argv.slice(2);

const FULL_HELP = `Usage: claude [options] [command] [prompt]
Options:
  --append-system-prompt <prompt>  Append a system prompt
  --disable-slash-commands         Disable all skills
  --no-session-persistence         Disable session persistence
  --output-format <format>         Output format (choices: "text", "json", "stream-json")
  --permission-mode <mode>         Permission mode (choices: "acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan")
  --permission-prompts <target>    Who answers permission prompts
  -p, --print                      Print response and exit
  --restricted                     Restricted mode
  --strict-mcp-config              Only use MCP servers from --mcp-config
  --tools <tools...>               Specify the list of available tools
`;

if (args.includes('--version')) {
  process.stdout.write(`${config.version ?? '2.1.999'} (Claude Code)\n`);
  process.exit(0);
}
if (args.includes('--help')) {
  process.stdout.write(config.help ?? FULL_HELP);
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'status') {
  process.stdout.write(JSON.stringify({ loggedIn: config.loggedIn ?? true, email: 'person@example.com', orgName: 'Secret Org' }));
  process.exit(0);
}
if (!args.includes('--print')) {
  process.stderr.write('fake-claude: interactive mode is not supported\n');
  process.exit(64);
}

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  stdin += chunk;
});
process.stdin.on('end', () => {
  writeFileSync(new URL('invocation.json', here), JSON.stringify({ argv: args, stdin, cwd: process.cwd() }));
  respond();
});

function result(fields) {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 1234,
    duration_api_ms: 900,
    num_turns: 2,
    result: config.result ?? 'Fake summary of the repository.',
    session_id: '3f0c9a3e-1111-4222-8333-444455556666',
    total_cost_usd: 0.0012,
    usage: { input_tokens: 10, output_tokens: 20 },
    permission_denials: config.denials ?? [],
    ...fields,
  });
}

function respond() {
  switch (config.mode ?? 'success') {
    case 'success':
      process.stdout.write(`${result({})}\n`);
      process.exit(0);
      break;
    case 'error':
      process.stdout.write(`${result({ subtype: 'error_during_execution', is_error: true, result: undefined, errors: ['model overloaded'] })}\n`);
      process.exit(1);
      break;
    case 'garbage':
      process.stdout.write('this is not json\n');
      process.exit(0);
      break;
    case 'crash':
      process.stderr.write('boom: something broke\n');
      process.exit(3);
      break;
    case 'sleep':
      setInterval(() => {}, 1000);
      break;
    case 'flood':
      process.stdout.write('x'.repeat(6 * 1024 * 1024), () => process.exit(0));
      break;
    default:
      process.stderr.write(`fake-claude: unknown mode ${config.mode}\n`);
      process.exit(70);
  }
}
