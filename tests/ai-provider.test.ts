import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { after, before, describe, it } from 'node:test';

import { ClaudeCodeAiProvider, createAiProviderRegistry, extractJsonObject } from '../src/ai/index.ts';
import { DEFAULT_CONFIG } from '../src/config/index.ts';
import { ProcessRunner } from '../src/execution/index.ts';
import { silentLogger } from '../src/logging/index.ts';
import { CLAUDE_TOOLS, FORBIDDEN_CLAUDE_OPTIONS, buildClaudeArgs, buildClaudeRoleArgs } from '../src/workers/index.ts';
import { TempDirs } from './fixtures.ts';
import { installFakeClaude } from './worker-fixtures.ts';
import type { FakeClaude } from './worker-fixtures.ts';

const temp = new TempDirs();
after(() => temp.cleanup());
const runner = new ProcessRunner({ defaultTimeoutMs: 60_000, killGraceMs: 300 });

describe('Claude role invocation', () => {
  it('grants NO tools, replaces the system prompt, and never bypasses permissions', () => {
    const args = buildClaudeRoleArgs('RULES');
    assert.deepEqual(args, [
      '--print',
      '--output-format=json',
      '--restricted',
      '--tools=',
      '--permission-mode=dontAsk',
      '--permission-prompts=none',
      '--strict-mcp-config',
      '--disable-slash-commands',
      '--no-session-persistence',
      '--system-prompt=RULES',
    ]);
    for (const arg of args.filter((a) => !a.startsWith('--system-prompt='))) {
      for (const forbidden of FORBIDDEN_CLAUDE_OPTIONS) {
        assert.ok(!arg.includes(forbidden));
      }
    }
  });

  it('leaves the implementer permission model unchanged', () => {
    assert.deepEqual(CLAUDE_TOOLS, { 'read-only': ['Read', 'Glob', 'Grep'], edit: ['Read', 'Glob', 'Grep', 'Edit', 'Write'] });
    assert.ok(buildClaudeArgs({ access: 'edit', instructions: 'x' }).includes('--permission-mode=acceptEdits'));
  });
});

describe('ClaudeCodeAiProvider with a fake CLI', () => {
  let fake: FakeClaude;
  before(async () => {
    fake = await installFakeClaude(temp);
  });

  function provider(): ClaudeCodeAiProvider {
    return new ClaudeCodeAiProvider({ runner, resolve: (name) => fake.resolve(name) });
  }

  const request = { role: 'planner' as const, requestId: 'r1', instructions: 'You are the planner.', input: '<forge-goal>\nx\n</forge-goal>', timeoutMs: 30_000 };

  it('sends the input on stdin from an empty temporary directory, with no tools', async () => {
    await fake.configure({ mode: 'success', result: '{"ok":true}' });
    const response = await provider().complete(request);
    assert.equal(response.outcome, 'success');
    assert.equal(response.text, '{"ok":true}');
    assert.equal(response.call.provider, 'claude-code');
    const invocation = await fake.lastInvocation();
    assert.ok(invocation.argv.includes('--tools='));
    assert.ok(invocation.argv.includes('--system-prompt=You are the planner.'));
    assert.ok(!invocation.argv.some((arg) => arg.startsWith('--tools=Read')));
    assert.equal(invocation.stdin, request.input);
    assert.ok(invocation.cwd.startsWith(tmpdir()) && /forge-ai-/.test(invocation.cwd), 'runs in a scratch directory, not the project');
    await assert.rejects(access(invocation.cwd), 'the scratch directory is removed afterwards');
  });

  it('maps provider failures without throwing', async () => {
    await fake.configure({ mode: 'error' });
    assert.equal((await provider().complete(request)).outcome, 'failed');
    await fake.configure({ mode: 'garbage' });
    assert.equal((await provider().complete(request)).outcome, 'invalid-output');
    await fake.configure({ mode: 'sleep' });
    assert.equal((await provider().complete({ ...request, timeoutMs: 800 })).outcome, 'timeout');
  });

  it('is unavailable when the CLI lacks role options', async () => {
    await fake.configure({ help: '--print --output-format "json" --permission-mode acceptEdits' });
    const response = await provider().complete(request);
    assert.equal(response.outcome, 'unavailable');
    assert.match(response.diagnostic ?? '', /lacks required options/);
  });

  it('is registered by default under "claude"', () => {
    const registry = createAiProviderRegistry({ config: DEFAULT_CONFIG, runner, logger: silentLogger });
    assert.equal(registry.create('claude')?.id, 'claude-code');
    assert.equal(registry.create('openai'), undefined);
  });
});

describe('structured answer extraction', () => {
  it('accepts exactly one JSON object, optionally fenced', () => {
    assert.deepEqual(extractJsonObject('{"a":1}'), { ok: true, value: { a: 1 } });
    assert.deepEqual(extractJsonObject('```json\n{"a":1}\n```'), { ok: true, value: { a: 1 } });
  });

  for (const text of ['Sure, here: {"a":1}', '[1,2]', '{"a":1}{"b":2}', '', '```\nnot json\n```']) {
    it(`rejects ${JSON.stringify(text)}`, () => {
      assert.equal(extractJsonObject(text).ok, false);
    });
  }
});
