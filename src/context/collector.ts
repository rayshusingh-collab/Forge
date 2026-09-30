import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';

import { dataBlock } from '../ai/envelope.ts';
import type { GitClient } from '../git/index.ts';
import type { ContextSummary } from '../state/index.ts';
import { classifyPath, listableInTree, looksBinary } from './policy.ts';

/**
 * Deterministic, bounded project context for AI roles.
 *
 * Files come from Git (`ls-files --cached --others --exclude-standard`), so
 * ignored files — typically `.env`, build output, dependencies — are never
 * enumerated or read. On top of that, `policy.ts` withholds secret-like and
 * protected paths, generated files, and binaries. Selection is ordered
 * (manifests first, then shallow-to-deep, then by path) and capped; every
 * omission and truncation is counted and reported.
 */

export interface ContextLimits {
  readonly maxTreeEntries: number;
  readonly maxFiles: number;
  readonly maxBytes: number;
  readonly maxFileBytes: number;
}

export const DEFAULT_CONTEXT_LIMITS: ContextLimits = {
  maxTreeEntries: 400,
  maxFiles: 40,
  maxBytes: 150_000,
  maxFileBytes: 12_000,
};

export interface ContextFile {
  readonly path: string;
  readonly content: string;
  /** Bytes included (after truncation). */
  readonly bytes: number;
  readonly truncated: boolean;
}

export interface ProjectContext {
  /** Listable paths, in order; secret-like and protected paths are omitted. */
  readonly tree: readonly string[];
  readonly treeTruncated: boolean;
  readonly files: readonly ContextFile[];
  readonly omitted: {
    readonly sensitive: number;
    readonly protected: number;
    readonly generated: number;
    readonly binary: number;
    /** Allowed files not included because a limit was reached. */
    readonly overLimit: number;
  };
  readonly bytes: number;
  readonly truncated: boolean;
}

/** Well-known manifests come first because they describe the project. */
const MANIFESTS = [
  'readme.md',
  'readme',
  'package.json',
  'tsconfig.json',
  'pyproject.toml',
  'setup.py',
  'requirements.txt',
  'cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'makefile',
  'dockerfile',
  'deno.json',
];

export async function collectProjectContext(git: GitClient, limits: ContextLimits = DEFAULT_CONTEXT_LIMITS): Promise<ProjectContext> {
  const listed = await git.listFiles();
  const omitted = { sensitive: 0, protected: 0, generated: 0, binary: 0, overLimit: 0 };
  const tree: string[] = [];
  const candidates: string[] = [];

  for (const path of listed) {
    const verdict = classifyPath(path);
    if (verdict === 'sensitive' || verdict === 'protected') {
      omitted[verdict]++;
      continue;
    }
    if (listableInTree(verdict)) {
      tree.push(path);
    }
    if (verdict === 'allowed') {
      candidates.push(path);
    } else {
      omitted[verdict === 'generated' ? 'generated' : 'binary']++;
    }
  }

  const ordered = [...candidates].sort(compareForContext);
  const files: ContextFile[] = [];
  let bytes = 0;
  for (const path of ordered) {
    if (files.length >= limits.maxFiles || bytes >= limits.maxBytes) {
      omitted.overLimit++;
      continue;
    }
    const budget = Math.min(limits.maxFileBytes, limits.maxBytes - bytes);
    const read = await readTextPrefix(join(git.root, ...path.split('/')), budget);
    if (read === 'skip') {
      continue; // Not a regular file (e.g. a link) or unreadable: never followed.
    }
    if (read === 'binary') {
      omitted.binary++;
      continue;
    }
    files.push({ path, content: read.text, bytes: read.bytes, truncated: read.truncated });
    bytes += read.bytes;
  }

  const treeTruncated = tree.length > limits.maxTreeEntries;
  return {
    tree: tree.slice(0, limits.maxTreeEntries),
    treeTruncated,
    files,
    omitted,
    bytes,
    truncated: treeTruncated || omitted.overLimit > 0 || files.some((file) => file.truncated),
  };
}

export function summarizeContext(context: ProjectContext): ContextSummary {
  return { files: context.files.length, bytes: context.bytes, truncated: context.truncated };
}

/** Renders the context as fenced DATA blocks. */
export function renderContext(context: ProjectContext): string {
  const notes = [
    `files shown: ${context.files.length}; bytes: ${context.bytes}`,
    `withheld: ${context.omitted.sensitive} secret-like, ${context.omitted.protected} protected, ${context.omitted.generated} generated, ${context.omitted.binary} binary, ${context.omitted.overLimit} over the size limit`,
    context.truncated ? 'the context is TRUNCATED; the project contains more than is shown' : 'the context is complete within the limits',
  ].join('\n');
  const blocks = [
    dataBlock('context-notes', notes),
    dataBlock('project-tree', `${context.tree.join('\n')}${context.treeTruncated ? '\n… (tree truncated)' : ''}`),
    ...context.files.map((file) =>
      dataBlock('file', `${file.content}${file.truncated ? '\n… (file truncated)' : ''}`, { path: file.path }),
    ),
  ];
  return blocks.join('\n\n');
}

function compareForContext(a: string, b: string): number {
  const rank = (path: string): number => {
    const index = MANIFESTS.indexOf(path.toLowerCase());
    return index === -1 ? MANIFESTS.length : index;
  };
  const depth = (path: string): number => path.split('/').length;
  return rank(a) - rank(b) || depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0);
}

async function readTextPrefix(
  absolute: string,
  budget: number,
): Promise<{ text: string; bytes: number; truncated: boolean } | 'binary' | 'skip'> {
  try {
    const info = await lstat(absolute);
    if (!info.isFile()) {
      return 'skip';
    }
    const handle = await open(absolute, 'r');
    try {
      const buffer = Buffer.alloc(Math.max(0, budget) + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const data = buffer.subarray(0, Math.min(bytesRead, budget));
      if (looksBinary(data)) {
        return 'binary';
      }
      // Never cut a multi-byte character in half.
      const text = new TextDecoder('utf-8', { fatal: false }).decode(data).replace(/�$/, '');
      return { text, bytes: Buffer.byteLength(text), truncated: bytesRead > budget || info.size > budget };
    } finally {
      await handle.close();
    }
  } catch {
    return 'skip';
  }
}
