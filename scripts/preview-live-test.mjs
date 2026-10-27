import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// A dedicated, disposable file prevents browser tests from modifying a user's model.
const fixture = fileURLToPath(new URL('../.cache/live-sync/linked.puml', import.meta.url));
const initialSource = `' Keep the file header.
@startuml
title Linked class
class "Account" as A {
  +id: UUID
}
class "Ledger" as B
A --> B : records
@enduml

' Keep the diagram separator.
@startuml
title Linked state
state "Draft" as Draft
state "Done" as Done
Draft --> Done
@enduml
' Keep the file trailer.
`;
await mkdir(dirname(fixture), { recursive: true });
await writeFile(fixture, initialSource, 'utf8');
process.env.PORT = '4174';
process.argv = [process.argv[0], fileURLToPath(new URL('./preview.mjs', import.meta.url)), '--model', fixture];
await import('./preview.mjs');
