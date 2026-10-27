import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// A disposable diagram and layout file, isolated from the user's selected model.
const fixture = fileURLToPath(new URL('../.cache/live-sync/placed.puml', import.meta.url));
const source = `' Layout file integration fixture.
@startuml
class "Account" as A {
  +id: UUID
}
class "Ledger" as B
A --> B : records
@enduml
`;
const layout = `{
  "version": 1,
  "diagrams": {
    "diagram-1": {
      "positions": {
        "A": { "x": 160, "y": 120 },
        "B": { "x": 480, "y": 120 }
      }
    }
  }
}
`;
await mkdir(dirname(fixture), { recursive: true });
await writeFile(fixture, source, 'utf8');
await writeFile(fixture + '.layout.json', layout, 'utf8');
process.env.PORT = '4175';
process.argv = [process.argv[0], fileURLToPath(new URL('./preview.mjs', import.meta.url)), '--model', fixture];
await import('./preview.mjs');
