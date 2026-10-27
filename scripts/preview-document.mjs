import { watchFile, unwatchFile } from 'node:fs';
import { readFile, writeFile, rename, rm, realpath, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { loadModule } from './runtime.mjs';

/** Only the explicitly selected file and its layout file are accessible; messages cannot supply paths. */
export async function openPreviewDocument(path, broadcast = () => {}) {
  path = await realpath(path);
  const { applyDiagramEdit } = await loadModule('src/core/edits.ts', 'preview-edits');
  const { validWebviewMessage, requireDocumentVersion, mergeLayoutPositions } = await loadModule('src/host/messages.ts', 'preview-messages');
  const { nativeTemplates } = await loadModule('src/core/templates.ts', 'preview-templates');
  const { layoutFileName, parseLayoutFile, serializeLayoutFile, validateSource } = await loadModule('src/core/layout-file.ts', 'preview-layout');
  const layoutPath = layoutFileName(path);
  const readOptional = async file => { try { return await readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
  let source = await readFile(path, 'utf8');
  validateSource(source);
  let layoutText = await readOptional(layoutPath);
  let positions = layoutText === null ? {} : parseLayoutFile(layoutText);
  const viewports = {};
  let version = 1;
  let revision = 1;
  // Source and placement share one history; each entry restores both files.
  const undo = [], redo = [];
  let queue = Promise.resolve();
  const layouts = () => {
    const result = Object.create(null);
    for (const [id, layout] of Object.entries(positions)) result[id] = { positions: layout.positions };
    for (const [id, viewport] of Object.entries(viewports)) result[id] = { positions: result[id]?.positions ?? {}, viewport };
    return result;
  };
  const snapshot = () => ({ type: 'document', source, version, revision, layouts: layouts(), fileName: basename(path), trusted: true });
  const serialize = operation => {
    const next = queue.catch(() => {}).then(operation);
    queue = next;
    return next;
  };
  async function refresh() {
    const [diskSource, diskLayout] = await Promise.all([readFile(path, 'utf8'), readOptional(layoutPath)]);
    if (diskSource === source && diskLayout === layoutText) return;
    // Decode before changing any live state: a malformed external layout file must never
    // become an empty layout that the next drag could overwrite.
    validateSource(diskSource);
    const nextPositions = diskLayout === null ? {} : parseLayoutFile(diskLayout);
    if (diskSource !== source) version++;
    source = diskSource; layoutText = diskLayout; positions = nextPositions; revision++;
    undo.length = 0; redo.length = 0;
    broadcast(snapshot());
  }
  async function writeAtomic(file, next, current) {
    if (next === current) return;
    if (next === null) { await rm(file, { force: true }); return; }
    const temporary = `${file}.aliot-${randomBytes(6).toString('hex')}.tmp`;
    try {
      const mode = await stat(file).then(info => info.mode, () => undefined);
      await writeFile(temporary, next, { flag: 'wx', mode });
      for (let attempt = 0; ; attempt++) {
        try { await rename(temporary, file); break; }
        catch (error) {
          // Windows readers/indexers can briefly hold a handle without delete
          // sharing. Keep the atomic replacement and never truncate/remove the
          // original as a fallback.
          if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 5) throw error;
          await delay(25 * 2 ** attempt);
        }
      }
    } finally { await rm(temporary, { force: true }); }
  }
  async function replace(nextSource, nextLayoutText) {
    validateSource(nextSource);
    const nextPositions = nextLayoutText === null ? {} : parseLayoutFile(nextLayoutText);
    const previous = { source, layoutText };
    await refresh();
    if (source !== previous.source || layoutText !== previous.layoutText) throw new Error('The file changed externally. Your draft is preserved; review the current source before applying it again.');
    await writeAtomic(path, nextSource, source);
    await writeAtomic(layoutPath, nextLayoutText, layoutText);
    if (nextSource !== source) version++;
    source = nextSource; layoutText = nextLayoutText; positions = nextPositions; revision++;
  }
  async function change(nextSource, nextLayoutText) {
    if (nextSource === source && nextLayoutText === layoutText) return;
    const before = { source, layoutText };
    await replace(nextSource, nextLayoutText);
    undo.push(before); redo.length = 0;
  }
  async function travel(from, to) {
    if (!from.length) return;
    const current = { source, layoutText }, target = from.at(-1);
    await replace(target.source, target.layoutText);
    from.pop(); to.push(current);
  }
  const changed = () => { void serialize(refresh).catch(error => broadcast({ type: 'error', message: `Cannot read the linked file: ${error.message}` })); };
  watchFile(path, { interval: 150, persistent: false }, changed);
  watchFile(layoutPath, { interval: 150, persistent: false }, changed);
  return {
    snapshot: () => serialize(async () => { await refresh(); return snapshot(); }),
    receive: message => serialize(async () => {
      if (!validWebviewMessage(message)) throw new Error('Invalid editor request.');
      await refresh();
      switch (message.type) {
        case 'edit':
          requireDocumentVersion(version, message.version);
          await change(applyDiagramEdit(source, message.diagramId, message.edit), layoutText);
          break;
        case 'layout': {
          if (message.version !== undefined) requireDocumentVersion(version, message.version);
          const layout = mergeLayoutPositions(positions[message.diagramId] ?? { positions: {} }, message.layout, message.basePositions);
          if (layout.viewport) viewports[message.diagramId] = layout.viewport; else delete viewports[message.diagramId];
          const next = { ...positions, [message.diagramId]: { positions: layout.positions } };
          await change(source, serializeLayoutFile(next) ?? null);
          revision++;
          break;
        }
        case 'create': {
          const template = nativeTemplates.find(item => item.kind === message.kind);
          if (!template) throw new Error('This diagram type does not yet have a native editor.');
          const eol = source.includes('\r\n') ? '\r\n' : '\n';
          await change((source.trim() ? source.trimEnd() + eol + eol : '') + template.source.replace(/\r?\n/g, eol), layoutText);
          break;
        }
        case 'undo': await travel(undo, redo); break;
        case 'redo': await travel(redo, undo); break;
        case 'ready':
        case 'openSource': break;
      }
      const result = snapshot(); broadcast(result); return result;
    }),
    close: () => { unwatchFile(path, changed); unwatchFile(layoutPath, changed); },
  };
}
