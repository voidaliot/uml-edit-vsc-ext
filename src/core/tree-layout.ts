import type { DiagramBlock, DiagramElement, Point } from '../shared/protocol';

interface Size { width: number; height: number }
interface Branch { node: DiagramElement; size: Size; children: Branch[]; span: number }
interface WbsBranch { node: DiagramElement; size: Size; children: WbsBranch[]; left: number; right: number; height: number; offsets: Point[]; stacked: boolean }

const siblingGap = 20;
const levelGap = 54;
const wbsGap = 32;

/** Keep short hierarchy labels compact while reserving enough room for wrapped names. */
function dimensions(node: DiagramElement): Size {
  const textLines = node.name.split(/\n|\\n/);
  const columns = Math.max(1, ...textLines.map(line => Array.from(line).length));
  const width = Math.max(36, Math.min(340, Math.ceil(columns * 7.3 + 28)));
  const lines = textLines.reduce((sum, line) => sum + Math.max(1, Math.ceil(Array.from(line).length * 7.3 / (width - 28))), 0);
  const height = 44 + (lines - 1) * 17;
  node.meta = { ...node.meta, width, height, treeLayout: true };
  return { width, height };
}

/** Native mind-map sides and WBS branch stacks follow the source hierarchy. */
export function layoutTree(block: DiagramBlock): Record<string, Point> {
  const result: Record<string, Point> = Object.create(null);
  const ids = new Set(block.elements.map(node => node.id));
  const roots = block.elements.filter(node => !node.parentId || !ids.has(node.parentId));
  const children = new Map<string, DiagramElement[]>();
  for (const node of block.elements) if (node.parentId && ids.has(node.parentId)) children.set(node.parentId, [...(children.get(node.parentId) ?? []), node]);
  const sizes = new Map(block.elements.map(node => [node.id, dimensions(node)]));
  let forestY = 70;

  if (block.kind === 'mindmap') {
    const measure = (node: DiagramElement): Branch => {
      const branches = (children.get(node.id) ?? []).map(measure), size = sizes.get(node.id)!;
      return { node, size, children: branches, span: Math.max(size.height, branches.reduce((sum, branch) => sum + branch.span, 0) + Math.max(0, branches.length - 1) * siblingGap) };
    };
    const place = (branch: Branch, x: number, top: number, side: 'left' | 'right') => {
      result[branch.node.id] = { x, y: top + (branch.span - branch.size.height) / 2 };
      let childTop = top + (branch.span - (branch.children.reduce((sum, child) => sum + child.span, 0) + Math.max(0, branch.children.length - 1) * siblingGap)) / 2;
      for (const child of branch.children) {
        place(child, side === 'left' ? x - levelGap - child.size.width : x + branch.size.width + levelGap, childTop, side);
        childTop += child.span + siblingGap;
      }
    };
    for (const root of roots) {
      const branches = (children.get(root.id) ?? []).map(measure);
      const left = branches.filter(branch => branch.node.meta?.treeSide === 'left');
      const right = branches.filter(branch => branch.node.meta?.treeSide !== 'left');
      const span = (group: Branch[]) => group.reduce((sum, child) => sum + child.span, 0) + Math.max(0, group.length - 1) * siblingGap;
      const rootSize = sizes.get(root.id)!, height = Math.max(rootSize.height, span(left), span(right));
      result[root.id] = { x: 0, y: forestY + (height - rootSize.height) / 2 };
      for (const [side, group] of [['left', left], ['right', right]] as const) {
        let top = forestY + (height - span(group)) / 2;
        for (const child of group) {
          place(child, side === 'left' ? -levelGap - child.size.width : rootSize.width + levelGap, top, side);
          top += child.span + siblingGap;
        }
      }
      forestY += height + 54;
    }
  } else {
    const measure = (node: DiagramElement, depth: number): WbsBranch => {
      const branches = (children.get(node.id) ?? []).map(child => measure(child, depth + 1)), size = sizes.get(node.id)!;
      const stacked = depth > 0 && branches.length > 0 && branches.every(child => child.children.length === 0);
      const offsets: Point[] = [];
      let left = -size.width / 2, right = size.width / 2, height = size.height;
      if (stacked) {
        let y = size.height + wbsGap;
        for (const child of branches) {
          const x = 14 - child.left;
          offsets.push({ x, y });
          right = Math.max(right, x + child.right);
          height = y + child.height;
          y += child.height + siblingGap;
        }
      } else if (branches.length) {
        let cursor = 0;
        for (const child of branches) {
          offsets.push({ x: cursor - child.left, y: size.height + wbsGap });
          cursor += child.right - child.left + wbsGap;
        }
        // Balance the parent above its branch roots; each allocated subtree keeps its full envelope.
        const center = (offsets[0].x + offsets.at(-1)!.x) / 2;
        branches.forEach((child, index) => {
          offsets[index].x -= center;
          left = Math.min(left, offsets[index].x + child.left);
          right = Math.max(right, offsets[index].x + child.right);
          height = Math.max(height, offsets[index].y + child.height);
        });
      }
      return { node, size, children: branches, left, right, height, offsets, stacked };
    };
    const place = (branch: WbsBranch, centerX: number, top: number) => {
      result[branch.node.id] = { x: centerX - branch.size.width / 2, y: top };
      branch.children.forEach((child, index) => {
        child.node.meta = { ...child.node.meta, treeStacked: branch.stacked };
        place(child, centerX + branch.offsets[index].x, top + branch.offsets[index].y);
      });
    };
    for (const root of roots) {
      const branch = measure(root, 0);
      place(branch, 0, forestY);
      forestY += branch.height + 54;
    }
  }

  const minX = Math.min(0, ...Object.values(result).map(point => point.x));
  for (const point of Object.values(result)) point.x += 80 - minX;
  for (const relation of block.relations) {
    const target = block.elements.find(node => node.id === relation.target);
    const source = result[relation.source], end = result[relation.target];
    const side = source && end && end.x < source.x ? 'left' : 'right';
    relation.meta = { ...relation.meta, treeLayout: block.kind, sourceHandle: block.kind === 'mindmap' ? side : 'bottom', targetHandle: block.kind === 'mindmap' ? side === 'left' ? 'right' : 'left' : target?.meta?.treeStacked ? 'left' : 'top' };
  }
  return result;
}
