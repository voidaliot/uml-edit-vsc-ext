# Aliot UML document format, version 1

The `.aliotuml` extension identifies a UTF-8 JSON document. It carries PlantUML source and its presentation state in one portable, text-diffable file. There is no binary content or renderer output.

```json
{
  "format": "aliot-uml",
  "version": 1,
  "source": "@startuml\nclass Customer\nclass Order\nCustomer --> Order\n@enduml\n",
  "layouts": {
    "diagram-1": {
      "positions": {
        "Customer": { "x": 80, "y": 80 },
        "Order": { "x": 400, "y": 180 }
      },
      "viewport": { "x": 0, "y": 0, "zoom": 1 }
    }
  }
}
```

All four top-level fields are required. The editor ships `schemas/aliot-uml.schema.json` and registers it with VS Code for `.aliotuml` files opened as JSON.

- `format` is exactly `aliot-uml`; `version` is currently `1`.
- `source` holds the full PlantUML text, including multiple diagram blocks, comments and source line endings. Export writes this string as plain `.puml` text.
- `layouts` maps parsed diagram identities (`diagram-1`, `diagram-2`, etc., in source order) to presentation state. Reordering blocks by hand also requires moving their layout entries.
- `positions` maps native element identities to absolute canvas coordinates. Explicit PlantUML aliases provide stable identities for declarations. Syntax-derived elements may use generated identities. These are manual overrides: omitted elements use the native automatic layout.
- A position can also contain optional positive `width` and `height` values, each at most 10,000,000, for resizable elements. Sequence dividers currently use these fields. Source order controls their vertical row; the saved layout controls horizontal placement and span. Sequence event identities are derived from content and occurrence so unrelated insertions and reordering retain geometry.
- `viewport` is optional and contains canvas translation `x`/`y` and zoom. It is written with deliberate placement changes or explicit Save Aliot. Navigation alone does not dirty an open document.

Changes to source replace only the JSON source token. Geometry edits update the affected positions and viewport. Unrelated JSON formatting and unknown metadata are retained when updating existing files. New documents use a two-space indented envelope. Removing a position removes metadata attached to that position; arbitrary additional fields are data, never executable instructions.

Invalid JSON, duplicate property names, unsupported versions, and invalid geometry are rejected before a write. Comments and trailing commas are not allowed. Source is limited to 2 MiB UTF-8; the whole envelope to 32 MiB, with at most 10,000 layouts and 20,000 positions per layout. Coordinates must be finite and between −10,000,000 and 10,000,000; zoom must be between 0.05 and 10. Nesting is limited to 128 levels. Diagram dictionary keys `__proto__`, `constructor`, and `prototype` are reserved; element aliases with these spellings remain ordinary data.

Saving as Aliot creates a self-contained document. It does not keep an exported `.puml` file linked as a second writable copy. Existing plain PlantUML files remain fully supported, with workspace-local presentation state until converted using Save Aliot.
