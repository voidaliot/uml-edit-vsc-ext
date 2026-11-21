import { useState, type KeyboardEvent } from 'react';
import { Check, X } from 'lucide-react';
import type { DiagramElement } from '../shared/protocol';
import { propertiesError, type ElementProperties } from '../core/properties';
import { isMac, keyLabel, shortcuts } from './shortcuts';
import './panels.css';

/** Palette kinds as people read them; SDL steps are stored as `sdl-input` and shown as "input". */
export const paletteLabel = (kind: string) => kind.replace(/^sdl-/, '');

export function ShortcutsPopover({ onClose }: { onClose: () => void }) {
  return <section className="shortcuts-popover nowheel" role="dialog" aria-label="Keyboard shortcuts">
    <div className="form-heading"><span>Keyboard shortcuts</span><button className="tool-button" title="Close keyboard shortcuts" aria-label="Close keyboard shortcuts" autoFocus onClick={onClose}><X size={15} /></button></div>
    <dl>{shortcuts.map(shortcut => <div key={shortcut.action}><dt>{shortcut.keys.map(keys => <kbd key={keys}>{keyLabel(keys)}</kbd>)}</dt><dd>{shortcut.action}</dd></div>)}</dl>
    {!isMac && <p>On macOS, use ⌘ in place of Ctrl.</p>}
  </section>;
}

const hex = (color: string) => /^#?[\da-f]{6}$/i.test(color.trim()) ? `#${color.trim().replace(/^#/, '')}` : /^#?[\da-f]{3}$/i.test(color.trim()) ? `#${color.trim().replace(/^#/, '').replace(/./g, digit => digit + digit)}` : '#ffffff';

/** Stereotype and background colour of one element, written back into its declaration line. */
export function PropertiesForm({ element, onApply, onCancel }: { element: DiagramElement; onApply: (properties: ElementProperties) => void; onCancel: () => void }) {
  const [stereotype, setStereotype] = useState(typeof element.meta?.stereotype === 'string' ? element.meta.stereotype : '');
  const [color, setColor] = useState(typeof element.meta?.color === 'string' ? element.meta.color : '');
  const problem = propertiesError({ stereotype, color });
  const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') onCancel(); };
  return <div className="floating-form properties-form nowheel" role="dialog" aria-label="Element properties">
    <div className="form-heading"><span>Properties of {element.name || element.id}</span><button className="tool-button" title="Cancel editing properties" aria-label="Cancel editing properties" onClick={onCancel}><X size={15} /></button></div>
    <form onSubmit={event => { event.preventDefault(); if (!problem) onApply({ stereotype, color }); }}>
      <label>Stereotype<input autoFocus aria-label="Stereotype" placeholder="e.g. entity, service" value={stereotype} onChange={event => setStereotype(event.target.value)} onKeyDown={escape} /></label>
      <label>Background colour<span className="color-field"><input aria-label="Background colour" placeholder="#RRGGBB or a name such as LightBlue" value={color} onChange={event => setColor(event.target.value)} onKeyDown={escape} /><input type="color" aria-label="Pick background colour" value={hex(color)} onChange={event => setColor(event.target.value.toUpperCase())} /></span></label>
      {problem && <p className="form-problem" role="status">{problem}</p>}
      <div className="form-actions"><button type="button" onClick={onCancel}>Cancel</button><button className="primary" type="submit" disabled={Boolean(problem)}><Check size={14} /> Apply</button></div>
    </form>
  </div>;
}
