import { useEffect, useRef, useState, type RefObject } from 'react';
import { Check, ImageDown } from 'lucide-react';
import type { ExportFormat } from '../shared/protocol';
import { saveExport, subscribe } from './bridge';
import { exportFileName, rasterize, renderSvg, type ExportBackground } from './export';

const backgrounds: [ExportBackground, string][] = [['theme', 'Theme background'], ['transparent', 'Transparent'], ['light', 'Light background']];
/** The export commands in VS Code reuse the background last picked in this editor. */
let lastBackground: ExportBackground = 'theme';

export function ExportMenu({ canvas, fileName, diagram, disabled, onError }: { canvas: RefObject<HTMLElement | null>; fileName?: string; diagram?: { index: number; title?: string; count: number }; disabled: boolean; onError: (message: string) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [background, setBackground] = useState(lastBackground);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const run = useRef<(format: ExportFormat) => void>(() => undefined);
  run.current = format => {
    setOpen(false);
    const flowElement = canvas.current?.querySelector<HTMLElement>('.react-flow');
    if (disabled || !flowElement) { onError('Open a diagram with native elements to export it.'); return; }
    setBusy(true);
    void (async () => {
      try {
        const { svg, width, height } = renderSvg(flowElement, lastBackground);
        await saveExport(exportFileName(fileName ?? '', format, diagram), format, format === 'svg' ? svg : await rasterize(svg, width, height));
      } catch (error) { onError(error instanceof Error ? error.message : String(error)); }
      finally { setBusy(false); }
    })();
  };
  useEffect(() => subscribe(message => { if (message.type === 'exportRequest') run.current(message.format); }), []);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node) && !button.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener('pointerdown', close, true);
    return () => window.removeEventListener('pointerdown', close, true);
  }, [open]);
  const rect = open ? button.current?.getBoundingClientRect() : undefined;
  return <>
    <button ref={button} className={`tool-button ${open ? 'active' : ''}`} title="Export image (SVG or PNG)" aria-label="Export image" aria-haspopup="menu" aria-expanded={open} disabled={disabled || busy} onClick={() => setOpen(!open)}><ImageDown size={16} /></button>
    {open && rect && <div ref={menu} className="context-menu export-menu nowheel" role="menu" aria-label="Export image" style={{ position: 'fixed', left: Math.max(8, Math.min(rect.left, window.innerWidth - 238)), top: rect.bottom + 4 }} onKeyDown={event => { if (event.key === 'Escape') { setOpen(false); button.current?.focus(); } }}>
      <div className="context-heading">BACKGROUND</div>
      {backgrounds.map(([value, label]) => <button key={value} role="menuitemradio" aria-checked={background === value} onClick={() => { lastBackground = value; setBackground(value); }}>{background === value ? <Check size={13} /> : <span className="menu-check" />}{label}</button>)}
      <div className="menu-divider" />
      <button role="menuitem" autoFocus onClick={() => run.current('svg')}>Export SVG…</button>
      <button role="menuitem" onClick={() => run.current('png')}>Export PNG…<kbd>2×</kbd></button>
    </div>}
  </>;
}
