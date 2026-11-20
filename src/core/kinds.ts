import type { DiagramKind } from '../shared/protocol';

/**
 * Families written as self-contained declarations and relationships, with containment as source
 * nesting. Copying, properties and moving between containers all patch declaration lines, so they
 * share this one list.
 */
export const declarationKinds: ReadonlySet<DiagramKind> = new Set<DiagramKind>(['class', 'object', 'usecase', 'component', 'deployment', 'state', 'entity']);

/** A state machine's initial and final symbols: they exist only as the `[*]` end of a transition. */
export const pseudoKinds: ReadonlySet<string> = new Set(['start', 'end']);
