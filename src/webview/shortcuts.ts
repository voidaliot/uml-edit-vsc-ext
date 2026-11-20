/** Every canvas shortcut, in one place: the in-editor reference renders it and the README table mirrors it. */
export interface Shortcut { keys: string[]; action: string }

/** `Mod` reads as Ctrl, or ⌘ on macOS. */
export const shortcuts: readonly Shortcut[] = [
  { keys: ['V'], action: 'Select tool' },
  { keys: ['H'], action: 'Hand tool (or hold Space)' },
  { keys: ['F'], action: 'Fit the diagram in the window' },
  { keys: ['Mod+A'], action: 'Select all' },
  { keys: ['Mod+C'], action: 'Copy selected elements' },
  { keys: ['Mod+X'], action: 'Cut selected elements' },
  { keys: ['Mod+V'], action: 'Paste' },
  { keys: ['Mod+D'], action: 'Duplicate selected elements' },
  { keys: ['Delete', 'Backspace'], action: 'Delete selection' },
  { keys: ['F2'], action: 'Rename element or edit relationship' },
  { keys: ['Arrow keys'], action: 'Move selected elements' },
  { keys: ['Mod+Z'], action: 'Undo' },
  { keys: ['Mod+Shift+Z', 'Mod+Y'], action: 'Redo' },
  { keys: ['Mod+F'], action: 'Find an element in the outline' },
  { keys: ['Mod+Wheel'], action: 'Zoom' },
  { keys: ['Mod+Enter'], action: 'Apply the source editor' },
  { keys: ['Escape'], action: 'Close menus and clear the selection' },
  { keys: ['?'], action: 'Show these shortcuts' },
];

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const keyLabel = (keys: string) => isMac ? keys.replace(/Mod\+/g, '⌘').replace(/Shift\+/g, '⇧') : keys.replace(/Mod\+/g, 'Ctrl+');
