# Layout file format, version 1

Manual placements are stored next to the diagram in a UTF-8 JSON file named after the full PlantUML file name: `order.puml` → `order.puml.layout.json`. The PlantUML file itself is never changed by placement.

```json
{
  "version": 1,
  "diagrams": {
    "diagram-1": {
      "positions": {
        "Order": { "x": 80, "y": 80 },
        "LineItem": { "x": 420, "y": 80 },
        "Product": { "x": 420, "y": 320 }
      }
    }
  }
}
```

The editor ships `schemas/layout.schema.json` and registers it with VS Code for `*.puml.layout.json`, `*.plantuml.layout.json`, `*.pu.layout.json`, and `*.iuml.layout.json`.

- `version` is currently `1`.
- `diagrams` maps parsed diagram identities (`diagram-1`, `diagram-2`, etc., in source order) to their placements. Reordering diagram blocks by hand also requires moving their entries.
- `positions` maps native element identities to absolute canvas coordinates. Explicit PlantUML aliases provide stable identities for declarations; syntax-derived elements may use generated identities. Entries are overrides: elements without one use the automatic layout, and entries for elements that no longer exist are ignored.
- A position can also contain optional positive `width` and `height` values for resizable elements. Sequence dividers use these fields: source order controls their vertical row; the layout controls horizontal placement and span. Sequence event identities are derived from content and occurrence, so unrelated insertions and reordering keep their geometry.

The viewport (pan and zoom) is not part of the file; it is personal view state kept in the VS Code workspace.

The editor writes one element per line so diffs stay readable, creates the file only when something is placed manually, and deletes it when **Re-layout** clears every placement. Unknown fields are ignored when reading and are not kept when the editor rewrites the file.

Invalid JSON, unsupported versions, and invalid geometry are reported; the file is left untouched until the next manual placement replaces it. The file is limited to 32 MiB, with at most 10,000 diagrams and 20,000 positions per diagram. Coordinates must be finite and between −10,000,000 and 10,000,000. Diagram keys `__proto__`, `constructor`, and `prototype` are reserved; element aliases with these spellings remain ordinary data.
