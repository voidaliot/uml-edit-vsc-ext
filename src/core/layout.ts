import type { DiagramBlock, Point } from '../shared/protocol';
import { familyFor } from './families/registry';
import { layoutActivity } from './activity-layout';
import { layoutGraph } from './graph-layout';
import { layoutTree } from './tree-layout';
import { layoutSequence } from './sequence-layout';

/** Deterministic initial positions. User positions are maintained separately by the host. */
export function layoutDiagram(block: DiagramBlock): Record<string, Point> {
  if (block.kind === 'activity' || block.kind === 'sdl') return layoutActivity(block);
  if (['c4', 'archimate', 'dot'].includes(block.kind)) return layoutGraph(block);
  if (block.kind === 'mindmap' || block.kind === 'wbs') return layoutTree(block);
  const familyLayout = familyFor(block.kind)?.layout?.(block);
  if (familyLayout) return familyLayout;
  if (block.kind === 'sequence') return layoutSequence(block);
  return layoutGraph(block);
}
