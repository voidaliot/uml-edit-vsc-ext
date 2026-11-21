import type { ExportFormat } from '../shared/protocol';
import { MAX_EXPORT_CHARS } from '../host/messages';
import type { Box } from './arrange';

export type ExportBackground = 'theme' | 'transparent' | 'light';
export const EXPORT_MARGIN = 24;
/** Chromium refuses canvases beyond 16384px a side or 268M pixels; stay well inside both, and inside webview memory. */
export const MAX_EXPORT_SIDE = 16384;
export const MAX_EXPORT_PIXELS = 64 * 1024 * 1024;
const XHTML = 'http://www.w3.org/1999/xhtml';

/**
 * VS Code Light Modern colours for every theme variable the canvas reads. The editor's own
 * palette stays the default; this one keeps a dark-theme export legible on a white page.
 */
export const LIGHT_PALETTE: Readonly<Record<string, string>> = {
  '--vscode-editor-background': '#ffffff', '--vscode-editor-foreground': '#1f1f1f', '--vscode-descriptionForeground': '#616161',
  '--vscode-sideBar-background': '#f8f8f8', '--vscode-editorWidget-background': '#f8f8f8', '--vscode-input-background': '#ffffff',
  '--vscode-panel-border': '#e5e5e5', '--vscode-list-hoverBackground': '#f2f2f2', '--vscode-list-activeSelectionBackground': '#e8e8e8',
  '--vscode-list-activeSelectionForeground': '#1f1f1f', '--vscode-focusBorder': '#005fb8', '--vscode-button-background': '#005fb8',
  '--vscode-button-foreground': '#ffffff', '--vscode-button-secondaryBackground': '#e5e5e5', '--vscode-editor-selectionBackground': '#add6ff',
  '--vscode-charts-blue': '#1a85ff', '--vscode-charts-green': '#388a34', '--vscode-charts-orange': '#d18616', '--vscode-charts-purple': '#652d90',
  '--vscode-charts-red': '#e51400', '--vscode-charts-yellow': '#bf8803', '--vscode-errorForeground': '#e51400',
  '--vscode-inputValidation-errorBackground': '#f2dede', '--vscode-inputValidation-errorBorder': '#be1100',
};

/** The area to export in flow coordinates: everything drawn, plus a margin, on whole pixels. */
export function exportFrame(boxes: readonly Box[], margin = EXPORT_MARGIN): Box {
  const drawn = boxes.filter(box => [box.x, box.y, box.width, box.height].every(Number.isFinite) && (box.width > 0 || box.height > 0));
  if (!drawn.length) throw new Error('This diagram has nothing to export yet.');
  const left = Math.floor(Math.min(...drawn.map(box => box.x)) - margin), top = Math.floor(Math.min(...drawn.map(box => box.y)) - margin);
  const right = Math.ceil(Math.max(...drawn.map(box => box.x + box.width)) + margin), bottom = Math.ceil(Math.max(...drawn.map(box => box.y + box.height)) + margin);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** PNGs are drawn at 2× for sharp text; a diagram too large for that falls back to 1×, then fails plainly. */
export function rasterScale(width: number, height: number): number {
  for (const scale of [2, 1]) {
    const w = Math.ceil(width * scale), h = Math.ceil(height * scale);
    if (w <= MAX_EXPORT_SIDE && h <= MAX_EXPORT_SIDE && w * h <= MAX_EXPORT_PIXELS) return scale;
  }
  throw new Error(`This diagram is too large for a PNG (${Math.ceil(width)} × ${Math.ceil(height)} px; the limit is ${MAX_EXPORT_SIDE} px a side and ${Math.round(MAX_EXPORT_PIXELS / 1e6)} megapixels). Export it as SVG instead.`);
}

/** `orders.puml` → `orders.svg`; a file with several diagrams adds the diagram's title or number. */
export function exportFileName(fileName: string, format: ExportFormat, diagram?: { index: number; title?: string; count: number }): string {
  const clean = (value: string) => value.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/\s+/g, ' ').trim().replace(/^[.\s-]+|[.\s-]+$/g, '');
  const base = clean(fileName.replace(/^.*[\\/]/, '').replace(/\.(?:puml|plantuml|pu|iuml)$/i, '')) || 'diagram';
  const part = diagram && diagram.count > 1 ? (diagram.title ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || String(diagram.index + 1) : '';
  return `${`${base}${part ? `-${part}` : ''}`.slice(0, 150)}.${format}`;
}

/**
 * Editor chrome: connection handles, resize grips, selection rectangles, the grips that reshape or
 * re-attach a selected relationship, drag guides, and the "attributes" and "operations" hints, which
 * only invite editing; an empty compartment itself is UML and stays.
 */
const CHROME = '.react-flow__handle, .react-flow__resize-control, .react-flow__edge-interaction, .react-flow__edgeupdater, .react-flow__viewport-portal, .react-flow__nodesselection, .react-flow__selection, .edge-grip, .bend-grip, .drag-overlay, .drop-hint, .member-placeholder';
const DYNAMIC = /:(?:hover|active|focus|focus-visible|focus-within)\b/;

/** The stylesheet rules that can apply to the exported tree; the editor's own rules are left out. */
function exportStyles(tree: Element): string {
  const rules: string[] = [];
  const visit = (list: CSSRuleList) => {
    for (const rule of Array.from(list)) {
      if (rule instanceof CSSStyleRule) {
        const selectors = rule.selectorText.split(/,(?![^(]*\))/);
        const used = selectors.some(selector => {
          if (/:root\b/.test(selector)) return true;
          if (DYNAMIC.test(selector)) return false;
          try { return !!tree.querySelector(selector.replace(/::?(?:before|after|placeholder|marker|selection)\b/g, '').trim() || '*'); }
          catch { return true; }
        });
        // The page's root variables and type settings belong to the export's own root.
        if (used) rules.push(rule.cssText.replace(/:root\b/g, '.aliot-export'));
      } else if (rule instanceof CSSKeyframesRule) rules.push(rule.cssText);
      else if (rule instanceof CSSSupportsRule) visit(rule.cssRules);
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    try { visit(sheet.cssRules); } catch { /* A sheet the page cannot read cannot style the canvas either. */ }
  }
  return rules.join('\n');
}

/** The rectangles of everything drawn in the viewport, in flow coordinates. */
function drawnBoxes(viewport: HTMLElement, zoom: number): Box[] {
  const origin = viewport.getBoundingClientRect(), boxes: Box[] = [];
  for (const path of Array.from(viewport.querySelectorAll<SVGGraphicsElement>('.react-flow__edge-path'))) {
    const box = path.getBBox();
    boxes.push({ x: box.x - 2, y: box.y - 2, width: box.width + 4, height: box.height + 4 });
  }
  for (const element of Array.from(viewport.querySelectorAll('.react-flow__node, .react-flow__node *, .react-flow__edgelabel-renderer *'))) {
    // An inline SVG drawing is measured once, by its own box.
    if (element.closest(CHROME) || element instanceof SVGElement && !(element instanceof SVGSVGElement)) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width || rect.height) boxes.push({ x: (rect.left - origin.left) / zoom, y: (rect.top - origin.top) / zoom, width: rect.width / zoom, height: rect.height / zoom });
  }
  return boxes;
}

/**
 * The whole diagram as a standalone SVG. The canvas is HTML positioned by React Flow, so the SVG holds
 * a copy of that HTML in a foreignObject with the stylesheet it needs; nothing outside the file is referenced.
 */
export function renderSvg(flowElement: HTMLElement, background: ExportBackground): { svg: string; width: number; height: number } {
  const viewport = flowElement.querySelector<HTMLElement>('.react-flow__viewport');
  if (!viewport) throw new Error('This diagram has nothing to export yet.');
  const zoom = new DOMMatrixReadOnly(getComputedStyle(viewport).transform).a || 1;
  const frame = exportFrame(drawnBoxes(viewport, zoom));
  const prefix = `aliot-${Math.random().toString(36).slice(2, 8)}-`;

  const copy = viewport.cloneNode(true) as HTMLElement;
  // Nodes keep their measured size so connectors still meet their borders when a fallback font is wider.
  const originals = viewport.querySelectorAll<HTMLElement>('.react-flow__node'), copies = copy.querySelectorAll<HTMLElement>('.react-flow__node');
  originals.forEach((node, index) => { copies[index].style.width = `${node.offsetWidth}px`; copies[index].style.height = `${node.offsetHeight}px`; });
  copy.querySelectorAll(CHROME).forEach(element => element.remove());
  // An unlabelled connector keeps a click target, and "+ label" while selected; a message number is content.
  copy.querySelectorAll('.edge-label.empty-label').forEach(label => { if (!label.querySelector('b')) label.remove(); });
  copy.querySelectorAll<SVGPathElement>('.react-flow__edge.selected .react-flow__edge-path').forEach(path => { path.style.stroke = 'var(--diagram-line)'; });
  for (const element of [copy, ...Array.from(copy.querySelectorAll('*'))]) {
    element.classList.remove('selected', 'is-selected', 'selectable', 'draggable', 'connectable', 'dragging');
    for (const name of ['id', 'tabindex', 'aria-describedby', 'data-testid']) element.removeAttribute(name);
    for (const name of ['marker-start', 'marker-end', 'marker-mid']) {
      const value = element.getAttribute(name);
      if (value) element.setAttribute(name, value.replace(/url\(#/, `url(#${prefix}`));
    }
  }
  copy.style.transform = `translate(${-frame.x}px, ${-frame.y}px) scale(1)`;

  const markers = flowElement.querySelector('.marker-definitions')?.cloneNode(true) as SVGSVGElement | undefined;
  markers?.querySelectorAll('marker').forEach(marker => { marker.id = prefix + marker.id; });

  // The element chain from React Flow's root keeps every selector that names an ancestor working.
  const root = document.createElementNS(XHTML, 'div') as HTMLDivElement;
  root.className = 'aliot-export';
  let parent: HTMLElement = root;
  for (const original of [flowElement, flowElement.querySelector<HTMLElement>('.react-flow__renderer'), flowElement.querySelector<HTMLElement>('.react-flow__pane')]) {
    if (!original) continue;
    const shell = original.cloneNode(false) as HTMLElement;
    shell.removeAttribute('style'); shell.removeAttribute('id');
    Object.assign(shell.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', overflow: 'visible' });
    if (original === flowElement) { shell.style.background = 'transparent'; if (markers) shell.append(markers); }
    parent.append(shell); parent = shell;
  }
  parent.append(copy);

  const style = document.createElementNS(XHTML, 'style');
  style.textContent = exportStyles(root);
  const computed = getComputedStyle(flowElement), variables: Record<string, string> = {};
  // Theme colours and fonts are fixed at their current values; derived colours follow from them in the stylesheet.
  for (const name of new Set(style.textContent.match(/--vscode-[\w-]+/g))) {
    const value = computed.getPropertyValue(name).trim();
    if (value) variables[name] = value;
  }
  if (background === 'light') Object.assign(variables, LIGHT_PALETTE);
  root.setAttribute('style', `${Object.entries(variables).map(([name, value]) => `${name}: ${value}`).join('; ')}; position: relative; overflow: hidden; width: ${frame.width}px; height: ${frame.height}px; background: ${background === 'transparent' ? 'transparent' : 'var(--canvas)'}`);
  root.prepend(style);

  const body = new XMLSerializer().serializeToString(root);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${frame.width}" height="${frame.height}" viewBox="0 0 ${frame.width} ${frame.height}"><foreignObject x="0" y="0" width="${frame.width}" height="${frame.height}">${body}</foreignObject></svg>`;
  if (svg.length > MAX_EXPORT_CHARS) throw new Error('This diagram is too large to export as an image.');
  return { svg, width: frame.width, height: frame.height };
}

/** Draws the SVG on a canvas. It references nothing outside itself, so the canvas stays readable. */
export async function rasterize(svg: string, width: number, height: number): Promise<Blob> {
  const scale = rasterScale(width, height);
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  try { await image.decode(); } catch { throw new Error('The diagram could not be drawn as an image.'); }
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(width * scale); canvas.height = Math.ceil(height * scale);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This diagram is too large for a PNG. Export it as SVG instead.');
  context.scale(scale, scale);
  context.drawImage(image, 0, 0, width, height);
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
  // A canvas the browser could not allocate produces no image rather than an error.
  if (!blob || Math.ceil(blob.size / 3) * 4 > MAX_EXPORT_CHARS) throw new Error('This diagram is too large for a PNG. Export it as SVG instead.');
  return blob;
}

export async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}
