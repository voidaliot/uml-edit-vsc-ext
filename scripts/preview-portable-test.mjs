import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// This disposable document is isolated from the user's selected model.
const fixture = fileURLToPath(new URL('../.cache/live-sync/linked.aliotuml', import.meta.url));
const source = `' Portable integration fixture.
@startuml
class "Account" as A {
  +id: UUID
}
class "Ledger" as B
A --> B : records
@enduml
`;
const envelope = {
  format: 'aliot-uml', version: 1, source,
  layouts: { 'diagram-1': { positions: { A: { x: 160, y: 120 }, B: { x: 480, y: 120 } }, viewport: { x: 80, y: 80, zoom: 1 } } },
  metadata: { owner: 'Portable browser integration fixture', preserve: true },
};
await mkdir(dirname(fixture), { recursive: true });
await writeFile(fixture, JSON.stringify(envelope, null, 2) + '\n', 'utf8');
process.env.PORT = '4175';
process.argv = [process.argv[0], fileURLToPath(new URL('./preview.mjs', import.meta.url)), '--model', fixture];
await import('./preview.mjs');
