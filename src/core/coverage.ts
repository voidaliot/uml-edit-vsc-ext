import type { DiagramKind } from '../shared/protocol';
import { nativeFamilies } from './families/registry';

/** Families with a native React Flow implementation. Each supports a documented syntax subset. */
export const nativeDiagramKinds = ['class', 'object', 'sequence', 'usecase', 'component', 'deployment', 'state', 'activity', 'entity', 'mindmap', 'wbs', 'sdl', ...nativeFamilies.flatMap(family => family.kinds).filter(kind => kind !== 'wireframe')] as const satisfies readonly DiagramKind[];
export type NativeDiagramKind = typeof nativeDiagramKinds[number];

export function supportsNativeKind(kind: DiagramKind): boolean {
  return (nativeDiagramKinds as readonly DiagramKind[]).includes(kind === 'wireframe' ? 'salt' : kind);
}

export interface NativeCoverage {
  kind: NativeDiagramKind;
  supported: string;
  limitations: string;
}

/** Product-facing scope, deliberately narrower than recognizing an @start marker. */
const umlCoverage: readonly NativeCoverage[] = [
  { kind: 'class', supported: 'Classes, interfaces, enums, attributes, operations, aliases, generic labels, stereotypes, nested packages/namespaces, and relationships.', limitations: 'Custom preprocessing and full PlantUML style semantics are not implemented.' },
  { kind: 'object', supported: 'Objects, value compartments, aliases, nested groups, and links.', limitations: 'Map-specific notation and custom preprocessing are not implemented.' },
  { kind: 'sequence', supported: 'Participants, ordered/return/self messages, combined fragments, notes, dividers, delays, activations, destruction, and numbering.', limitations: 'Participant boxes and advanced activation/creation directives are not fully projected.' },
  { kind: 'usecase', supported: 'Actors, use cases, aliases, nested system boundaries, and relationships.', limitations: 'Uses native theme/layout; custom preprocessing and full style semantics are not implemented.' },
  { kind: 'component', supported: 'Components, interfaces, databases, nested boundaries, and dependencies.', limitations: 'Dedicated port notation and custom preprocessing are not implemented.' },
  { kind: 'deployment', supported: 'Nested nodes, artifacts, databases, clouds, storage, stacks, agents, folders, deployment shapes, and connections.', limitations: 'Custom sprites and external libraries are not executed.' },
  { kind: 'state', supported: 'States, descriptions, initial/final symbols, transitions, composite states, and concurrent regions.', limitations: 'Advanced history and entry/exit pseudostates are outside the native subset.' },
  { kind: 'activity', supported: 'Modern and legacy actions, decisions, loops, switch, forks/joins, partitions, swimlanes, and synchronization bars.', limitations: 'Modern control connections follow source structure. Ambiguous legacy rewrites require source editing.' },
  { kind: 'entity', supported: 'Entities, groups, member compartments, keys, and crow-foot relationships.', limitations: 'Chen notation has a separate native editor; custom preprocessing and full style semantics are not implemented.' },
  { kind: 'mindmap', supported: 'Single-line hierarchy nodes using *, +, or - depth markers.', limitations: 'Multiline nodes, colors, sprites, and custom styles are not supported; connections follow source hierarchy.' },
  { kind: 'wbs', supported: 'Single-line tasks and hierarchy relationships.', limitations: 'Multiline nodes, colors, cross-links, and custom styles are not supported; connections follow source hierarchy.' },
  { kind: 'sdl', supported: 'Input/output signals, procedures, tasks, save/load, continuous actions, decisions, and structured activity control flow.', limitations: 'Connections follow source structure; full styling and preprocessing are not implemented.' },
];

export const nativeCoverage: readonly NativeCoverage[] = nativeDiagramKinds.map(kind => {
  const template = nativeFamilies.flatMap(family => family.templates).find(template => template.kind === kind);
  return umlCoverage.find(entry => entry.kind === kind) ?? { kind, supported: template?.description ?? 'SDL process steps, signals, and control flow.', limitations: 'Custom preprocessing and external includes are not evaluated. Invalid or unrecognized constructs retain their source and report a diagnostic.' };
});
