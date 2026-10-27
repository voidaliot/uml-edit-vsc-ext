import type { DiagramBlock, DiagramEdit, DiagramKind, DiagramTemplate, Point } from '../../shared/protocol';

/** A native syntax adapter projects source and applies targeted text edits. */
export interface NativeFamily {
  kinds: readonly DiagramKind[];
  templates: DiagramTemplate[];
  parse(block: DiagramBlock, absoluteSourceLines: string[]): void;
  edit(source: string, block: DiagramBlock, edit: DiagramEdit): string | undefined;
  layout?(block: DiagramBlock): Record<string, Point> | undefined;
}
