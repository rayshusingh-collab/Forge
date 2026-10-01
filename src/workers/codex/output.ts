/**
 * Parses `codex exec --json` output: one JSON event per line. Observed with
 * codex-cli 0.157.0:
 *
 *   {"type":"thread.started","thread_id":"…"}
 *   {"type":"turn.started"}
 *   {"type":"item.completed","item":{"type":"agent_message","text":"…"}}
 *   {"type":"item.completed","item":{"type":"file_change","changes":[…],"status":"completed"}}
 *   {"type":"item.completed","item":{"type":"command_execution","command":"…","status":"completed"}}
 *   {"type":"error","message":"Reconnecting… 2/5 (…)"}          (transient)
 *   {"type":"turn.completed","usage":{"input_tokens":…,"output_tokens":…}}
 *   {"type":"turn.failed","error":{"message":"…"}}
 *
 * The final answer is the LAST agent message (the same text `codex exec -o`
 * writes). Everything here is untrusted provider output: it is summarized,
 * bounded, and never interpreted as an instruction.
 */

export interface CodexRunReport {
  /** `completed` (turn.completed seen), `failed` (turn.failed), or `incomplete` (neither). */
  readonly status: 'completed' | 'failed' | 'incomplete';
  /** The final agent message, or null. */
  readonly message: string | null;
  readonly threadId: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  /** The failure reason from `turn.failed`, or the last error event. */
  readonly error: string | null;
  readonly fileChanges: number;
  readonly commands: number;
}

export type CodexOutputParse = { readonly ok: true; readonly report: CodexRunReport } | { readonly ok: false; readonly problem: string };

/** Lines that are not JSON objects make the whole output invalid (Codex must not be mixed with other output). */
export function parseCodexEvents(stdout: string): CodexOutputParse {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length === 0) {
    return { ok: false, problem: 'Codex produced no output' };
  }
  let status: CodexRunReport['status'] = 'incomplete';
  let message: string | null = null;
  let threadId: string | null = null;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let error: string | null = null;
  let fileChanges = 0;
  let commands = 0;

  for (const [index, line] of lines.entries()) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return { ok: false, problem: `Codex output line ${index + 1} is not JSON` };
    }
    if (!isObject(event) || typeof event['type'] !== 'string') {
      return { ok: false, problem: `Codex output line ${index + 1} is not an event` };
    }
    switch (event['type']) {
      case 'thread.started':
        threadId = typeof event['thread_id'] === 'string' ? event['thread_id'] : threadId;
        break;
      case 'item.completed': {
        const item = event['item'];
        if (!isObject(item)) {
          break;
        }
        if (item['type'] === 'agent_message' && typeof item['text'] === 'string') {
          message = item['text'];
        } else if (item['type'] === 'file_change') {
          fileChanges += 1;
        } else if (item['type'] === 'command_execution') {
          commands += 1;
        }
        break;
      }
      case 'turn.completed': {
        status = 'completed';
        const usage = event['usage'];
        if (isObject(usage)) {
          inputTokens = typeof usage['input_tokens'] === 'number' ? usage['input_tokens'] : null;
          outputTokens = typeof usage['output_tokens'] === 'number' ? usage['output_tokens'] : null;
        }
        break;
      }
      case 'turn.failed': {
        status = 'failed';
        const failure = event['error'];
        error = isObject(failure) && typeof failure['message'] === 'string' ? failure['message'] : (error ?? 'turn failed');
        break;
      }
      case 'error':
        error = typeof event['message'] === 'string' ? event['message'] : error;
        break;
      default:
        // Other events (turn.started, item.started, item.updated, …) carry nothing Forge needs.
        break;
    }
  }
  return { ok: true, report: { status, message, threadId, inputTokens, outputTokens, error, fileChanges, commands } };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
