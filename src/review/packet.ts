import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';

import { dataBlock } from '../ai/envelope.ts';
import { classifyPath, looksBinary } from '../context/index.ts';
import { fingerprintPath } from '../git/index.ts';
import type { GitClient } from '../git/index.ts';
import type { ContextSummary, FileChange, ProjectState, TaskAttempt, TaskRecord } from '../state/index.ts';
import type { ValidationProfile } from '../validation/index.ts';

/**
 * The bounded evidence an AI reviewer receives about one validated attempt:
 * the task, Forge's deterministic evidence (validation and changeset), the
 * worker's claim (labelled as such), and diffs of the task-attributed files
 * against the task's baseline commit.
 *
 * - Mixed files are labelled: their diff includes changes that are not the task's.
 * - Secret-like, protected, and binary paths are listed without content.
 * - Files that changed since validation are labelled.
 * - Limits are deterministic; truncation is visible to the reviewer and recorded.
 */

export interface ReviewPacketLimits {
  readonly maxFiles: number;
  readonly maxBytes: number;
  readonly maxFileBytes: number;
}

export const DEFAULT_REVIEW_LIMITS: ReviewPacketLimits = { maxFiles: 50, maxBytes: 100_000, maxFileBytes: 8_000 };

export interface ReviewPacket {
  readonly text: string;
  readonly summary: ContextSummary;
  /** How each changed path was presented. */
  readonly files: readonly { readonly path: string; readonly presentation: 'diff' | 'content' | 'withheld' | 'deleted' | 'omitted' }[];
}

export interface ReviewPacketInput {
  readonly git: GitClient;
  readonly state: ProjectState;
  readonly task: TaskRecord;
  readonly attempt: TaskAttempt;
  readonly profile: ValidationProfile;
  readonly limits?: ReviewPacketLimits;
}

export async function buildReviewPacket(input: ReviewPacketInput): Promise<ReviewPacket> {
  const limits = input.limits ?? DEFAULT_REVIEW_LIMITS;
  const { task, attempt } = input;
  const run = input.state.workerRuns.find((candidate) => candidate.id === attempt.runId);
  const changes = attempt.changes;
  const validation = attempt.validation;

  const blocks: string[] = [
    dataBlock('task', [`title: ${task.title}`, 'instruction:', task.instruction, ...(task.context === null ? [] : ['context:', task.context])].join('\n')),
    dataBlock(
      'deterministic-validation',
      validation === null
        ? 'no validation record'
        : [`overall: ${validation.status}`, ...validation.checks.map((check) => `- ${check.id} (${check.required ? 'required' : 'optional'}): ${check.status}`)].join('\n'),
    ),
    dataBlock(
      'validation-profile',
      input.profile.checks.length === 0 ? 'none configured' : input.profile.checks.map((check) => `- ${check.id} (${check.required ? 'required' : 'optional'})`).join('\n'),
    ),
    dataBlock('worker-claim', `(the implementing worker's own summary — a claim, not evidence)\n${run?.summary ?? '(none)'}`),
  ];

  const previous = input.state.taskReviews.filter((review) => review.taskId === task.id).at(-1);
  if (previous !== undefined) {
    blocks.push(dataBlock('previous-review', `attempt ${previous.attempt}: ${previous.status}${previous.summary === null ? '' : ` — ${previous.summary}`}`));
  }

  const files: ReviewPacket['files'][number][] = [];
  let bytes = 0;
  let truncated = false;
  const sorted = [...(changes?.files ?? [])].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const listing: string[] = [];
  for (const file of sorted) {
    listing.push(`${file.change} ${file.path}${file.attribution === 'mixed' ? ' [MIXED: had uncommitted changes before the task]' : ''}`);
  }
  blocks.push(dataBlock('changed-files', listing.length === 0 ? '(no changes recorded)' : listing.join('\n')));

  for (const file of sorted) {
    if (files.length >= limits.maxFiles || bytes >= limits.maxBytes) {
      files.push({ path: file.path, presentation: 'omitted' });
      truncated = true;
      continue;
    }
    const presented = await presentFile(input.git, changes?.baseline.head ?? null, file, Math.min(limits.maxFileBytes, limits.maxBytes - bytes));
    files.push({ path: file.path, presentation: presented.presentation });
    bytes += Buffer.byteLength(presented.body);
    truncated ||= presented.truncated;
    blocks.push(dataBlock('change', presented.body, { path: file.path, attribution: file.attribution, kind: file.change }));
  }
  if (changes?.truncated === true || changes?.baseline.truncated === true) {
    truncated = true;
  }
  blocks.unshift(
    dataBlock(
      'review-notes',
      [
        `changed files: ${sorted.length}; shown with content: ${files.filter((f) => f.presentation === 'diff' || f.presentation === 'content').length}`,
        truncated ? 'the evidence is TRUNCATED; do not assume unseen code is correct or incorrect' : 'the evidence is complete within the limits',
      ].join('\n'),
    ),
  );

  return {
    text: blocks.join('\n\n'),
    summary: { files: files.filter((f) => f.presentation === 'diff' || f.presentation === 'content').length, bytes, truncated },
    files,
  };
}

async function presentFile(
  git: GitClient,
  baseCommit: string | null,
  file: FileChange,
  budget: number,
): Promise<{ readonly body: string; readonly presentation: ReviewPacket['files'][number]['presentation']; readonly truncated: boolean }> {
  const verdict = classifyPath(file.path);
  if (verdict === 'sensitive' || verdict === 'protected' || verdict === 'binary') {
    return { body: `(content withheld: ${verdict} path)`, presentation: 'withheld', truncated: false };
  }
  const drifted = (await fingerprintPath(git.root, file.path)) !== file.fingerprint;
  const labels = [
    ...(file.attribution === 'mixed' ? ['MIXED FILE: this diff includes changes that were already present before the task; not all of it is the task\'s.'] : []),
    ...(drifted ? ['NOTE: this file changed after validation; the content below is its current state.'] : []),
  ];
  if (file.change === 'deleted') {
    return { body: [...labels, '(file deleted by the task)'].join('\n'), presentation: 'deleted', truncated: false };
  }
  if (file.change === 'added' || baseCommit === null) {
    const content = await readPrefix(join(git.root, ...file.path.split('/')), budget);
    if (content === null) {
      return { body: '(content unavailable)', presentation: 'withheld', truncated: false };
    }
    return {
      body: [...labels, '(new file)', content.text, ...(content.truncated ? ['… (truncated)'] : [])].join('\n'),
      presentation: 'content',
      truncated: content.truncated,
    };
  }
  const diff = await git.diffPath(baseCommit, file.path, budget);
  return {
    body: [...labels, diff.text.trimEnd(), ...(diff.truncated ? ['… (diff truncated)'] : [])].join('\n'),
    presentation: 'diff',
    truncated: diff.truncated,
  };
}

async function readPrefix(absolute: string, budget: number): Promise<{ readonly text: string; readonly truncated: boolean } | null> {
  try {
    const info = await lstat(absolute);
    if (!info.isFile()) {
      return null;
    }
    const handle = await open(absolute, 'r');
    try {
      const buffer = Buffer.alloc(Math.max(0, budget));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const data = buffer.subarray(0, bytesRead);
      if (looksBinary(data)) {
        return null;
      }
      return { text: new TextDecoder().decode(data).replace(/�$/, ''), truncated: info.size > budget };
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}
