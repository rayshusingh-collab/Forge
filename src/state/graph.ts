/**
 * Deterministic task dependency graph checks. Pure functions over task IDs:
 * traversal follows the order tasks and dependencies are listed in, so the
 * same state always yields the same answer.
 */

export interface DependencyNode {
  readonly id: string;
  readonly dependsOn: readonly string[];
}

export type DependencyProblem =
  | { readonly kind: 'self'; readonly taskId: string }
  | { readonly kind: 'duplicate'; readonly taskId: string; readonly dependencyId: string }
  | { readonly kind: 'missing'; readonly taskId: string; readonly dependencyId: string }
  | { readonly kind: 'cycle'; readonly cycle: readonly string[] };

/** Returns the first problem found, or null when the graph is a valid DAG. */
export function findDependencyProblem(nodes: readonly DependencyNode[]): DependencyProblem | null {
  const ids = new Set(nodes.map((node) => node.id));
  for (const node of nodes) {
    const seen = new Set<string>();
    for (const dependencyId of node.dependsOn) {
      if (dependencyId === node.id) {
        return { kind: 'self', taskId: node.id };
      }
      if (seen.has(dependencyId)) {
        return { kind: 'duplicate', taskId: node.id, dependencyId };
      }
      seen.add(dependencyId);
      if (!ids.has(dependencyId)) {
        return { kind: 'missing', taskId: node.id, dependencyId };
      }
    }
  }
  const cycle = findCycle(nodes);
  return cycle === null ? null : { kind: 'cycle', cycle };
}

/**
 * Finds a dependency cycle, returned as the IDs along it with the first ID
 * repeated at the end (e.g. `[a, b, c, a]`), or null if there is none.
 * Unknown dependency IDs are ignored here (see `findDependencyProblem`).
 */
export function findCycle(nodes: readonly DependencyNode[]): string[] | null {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const state = new Map<string, 'visiting' | 'done'>();
  const path: string[] = [];

  const visit = (id: string): string[] | null => {
    const mark = state.get(id);
    if (mark === 'done') {
      return null;
    }
    if (mark === 'visiting') {
      return [...path.slice(path.indexOf(id)), id];
    }
    state.set(id, 'visiting');
    path.push(id);
    for (const dependencyId of byId.get(id)?.dependsOn ?? []) {
      if (byId.has(dependencyId)) {
        const cycle = visit(dependencyId);
        if (cycle !== null) {
          return cycle;
        }
      }
    }
    path.pop();
    state.set(id, 'done');
    return null;
  };

  for (const node of nodes) {
    const cycle = visit(node.id);
    if (cycle !== null) {
      return cycle;
    }
  }
  return null;
}

export function describeDependencyProblem(problem: DependencyProblem): string {
  switch (problem.kind) {
    case 'self':
      return `task "${problem.taskId}" depends on itself`;
    case 'duplicate':
      return `task "${problem.taskId}" lists dependency "${problem.dependencyId}" more than once`;
    case 'missing':
      return `task "${problem.taskId}" depends on unknown task "${problem.dependencyId}"`;
    case 'cycle':
      return `dependency cycle: ${problem.cycle.join(' -> ')}`;
  }
}
