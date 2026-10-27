import { watchFile, unwatchFile } from 'node:fs';
import { readFile, writeFile, rename, rm, realpath, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { loadModule } from './runtime.mjs';

/** Only the explicitly selected file is accessible; messages cannot supply paths. */
export async function openPreviewDocument(path, broadcast = () => {}) {
  path = await realpath(path);
  const { applyDiagramEdit } = await loadModule('src/core/edits.ts', 'preview-edits');
  const { validWebviewMessage, requireDocumentVersion, mergeLayoutPositions } = await loadModule('src/host/messages.ts', 'preview-messages');
  const { nativeTemplates } = await loadModule('src/core/templates.ts', 'preview-templates');
  const { readEditorDocument, writeEditorSource, writeEditorLayout } = await loadModule('src/core/aliot-document.ts', 'preview-aliot');
  let raw = await readFile(path, 'utf8');
  let { source, layouts, format } = readEditorDocument(raw, path);
  let version = 1;
  let revision = 1;
  const undo = [], redo = [];
  let queue = Promise.resolve();
  const snapshot = () => ({ type: 'document', source, version, revision, layouts, format, ...(format === 'aliot' ? { aliotDocument: raw } : {}), fileName: basename(path), trusted: true });
  const serialize = operation => {
    const next = queue.catch(() => {}).then(operation);
    queue = next;
    return next;
  };
  function accept(next, preserveViews = false) {
    // Decode before changing any live state: malformed external JSON must never
    // become a blank diagram that the next graphical edit could overwrite.
    const decoded = readEditorDocument(next, path);
    if (source !== decoded.source) version++;
    raw = next; source = decoded.source; revision++;
    if (format === 'aliot') {
      if (preserveViews) for (const [id, layout] of Object.entries(layouts)) {
        if (layout.viewport) decoded.layouts[id] = { positions: {}, ...decoded.layouts[id], viewport: layout.viewport };
      }
      layouts = decoded.layouts;
    }
  }
  const samePositions = (a = {}, b = {}) => Object.keys(a).length === Object.keys(b).length &&
    Object.entries(a).every(([id, point]) => Object.hasOwn(b, id) && ['x', 'y', 'width', 'height'].every(field => point[field] === b[id][field]));
  async function refresh() {
    const disk = await readFile(path, 'utf8');
    if (disk !== raw) {
      accept(disk);
      undo.length = 0; redo.length = 0;
      broadcast(snapshot());
    }
  }
  async function replace(next, preserveViews = false) {
    if (next === raw) return;
    readEditorDocument(next, path);
    const previous = raw;
    const temporary = `${path}.aliot-${randomBytes(6).toString('hex')}.tmp`;
    try {
      const { mode } = await stat(path);
      await writeFile(temporary, next, { flag: 'wx', mode });
      for (let attempt = 0; ; attempt++) {
        await refresh();
        if (raw !== previous) throw new Error('The file changed externally. Your draft is preserved; review the current source before applying it again.');
        try { await rename(temporary, path); break; }
        catch (error) {
          // Windows readers/indexers can briefly hold a handle without delete
          // sharing. Keep the atomic replacement and never truncate/remove the
          // original as a fallback. Recheck external edits after each wait.
          if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 5) throw error;
          await delay(25 * 2 ** attempt);
        }
      }
      accept(next, preserveViews);
    } finally { await rm(temporary, { force: true }); }
  }
  const changed = () => { void serialize(refresh).catch(error => broadcast({ type: 'error', message: `Cannot read the linked file: ${error.message}` })); };
  watchFile(path, { interval: 150, persistent: false }, changed);
  return {
    snapshot: () => serialize(async () => { await refresh(); return snapshot(); }),
    receive: message => serialize(async () => {
      if (!validWebviewMessage(message)) throw new Error('Invalid editor request.');
      await refresh();
      switch (message.type) {
        case 'edit': {
          requireDocumentVersion(version, message.version);
          const before = raw;
          const next = writeEditorSource(raw, path, applyDiagramEdit(source, message.diagramId, message.edit));
          await replace(next, true);
          if (next !== before) { undo.push(before); redo.length = 0; }
          break;
        }
        case 'layout': {
          if (message.version !== undefined) requireDocumentVersion(version, message.version);
          const layout = mergeLayoutPositions(layouts[message.diagramId] ?? { positions: {} }, message.layout, message.basePositions);
          if (format === 'aliot' && !samePositions(layouts[message.diagramId]?.positions, layout.positions)) {
            const before = raw;
            const next = writeEditorLayout(raw, path, message.diagramId, layout);
            await replace(next, true);
            if (next !== before) { undo.push(before); redo.length = 0; }
          }
          layouts = { ...layouts, [message.diagramId]: layout };
          revision++;
          break;
        }
        case 'create': {
          const template = nativeTemplates.find(item => item.kind === message.kind);
          if (!template) throw new Error('This diagram type does not yet have a native editor.');
          const before = raw;
          const eol = source.includes('\r\n') ? '\r\n' : '\n';
          const next = (source.trim() ? source.trimEnd() + eol + eol : '') + template.source.replace(/\r?\n/g, eol);
          await replace(writeEditorSource(raw, path, next), true);
          undo.push(before); redo.length = 0;
          break;
        }
        case 'undo': if (undo.length) { const before = raw; await replace(undo.at(-1)); undo.pop(); redo.push(before); } break;
        case 'redo': if (redo.length) { const before = raw; await replace(redo.at(-1)); redo.pop(); undo.push(before); } break;
        case 'ready':
        case 'openSource': break;
        case 'saveAliot':
        case 'openAliot':
        case 'exportPlantUml': throw new Error('Use the browser toolbar to open or download a document.');
      }
      const result = snapshot(); broadcast(result); return result;
    }),
    close: () => unwatchFile(path, changed),
  };
}
