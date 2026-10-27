# Native editing reference

For installation, screenshots, and a quick start, see the [README](../README.md).

Native, editable UML diagrams built with React Flow and synchronized with PlantUML text files. The extension is independently implemented under MIT. It uses no PlantUML renderer, Java runtime, generated diagram images, or remote rendering service.

**Status: 0.3.5 preview. All 33 diagram families in the gallery have native editors.** Each family supports the constructs described below; this is not complete compatibility with every PlantUML language feature. Unsupported constructs keep their source and display a diagnostic.

## Use in VS Code

1. Install the VSIX with **Extensions → Install from VSIX…**.
2. Open a `.aliotuml`, `.puml`, `.plantuml`, `.pu`, or `.iuml` file, or run **Aliot UML: New Diagram**.
3. Double-click a name or member compartment to edit it. Right-click the canvas to create elements. Drag handles to connect supported elements.
4. Use the source editor to edit PlantUML inside the canvas. For plain PlantUML files, **Source file** also opens the text document alongside the diagram. Text edits update the diagram immediately; diagram edits use VS Code undo, redo, and dirty-state handling.
5. Use **Save Aliot diagram** to save the source and placements together as `.aliotuml`. Once opened, Ctrl/Cmd+S saves that document normally. Use **Export PlantUML** for a plain `.puml` copy.

The single toolbar contains open/save/export, diagram selection and creation, Select/Hand tools, an icon-only **Re-layout** button, undo/redo, zoom, fit, outline, minimap, and source actions. Use **Re-layout** after changes to recalculate placement and fit the current diagram. Hover an icon for its name and shortcut. Its source draft is applied with Ctrl+Enter or Apply; conflicting external edits preserve the draft. Naming and creation forms stay inside the diagram and never use VS Code's input box.

## Portable Aliot documents

An `.aliotuml` file is readable, versioned JSON containing the original PlantUML source plus manual positions and saved viewports for its diagrams. Copy or commit this one file to carry the layout between machines. It needs no sidecar or workspace cache. The format specification is in `docs/aliot-file-format.md`, with an example in `examples/portable.aliotuml`.

Moving an element in an Aliot document changes its saved layout and participates in VS Code undo/redo. Source edits retain placements. Pan, zoom, and fit keep the current view in memory without marking a file dirty; the viewport is saved with the next placement change or **Save Aliot diagram**. **Re-layout** clears manual positions. Invalid JSON or unsupported format versions report an error without overwriting the file.

Plain `.puml` files continue to be edited as ordinary PlantUML, with placement kept in the current VS Code workspace. Save as `.aliotuml` when placement must travel with the document. **Export PlantUML** writes only the embedded source; PlantUML does not encode these manual canvas positions. Saving a portable copy does not create a second automatically synchronized source file.

In the browser preview, **Save Aliot diagram** downloads a portable file and **Open Aliot diagram** loads one, including its positions. Opening a local file leaves any live preview connection and edits an independent browser document. Export and save download snapshots; use the extension or `--model` preview for direct disk editing.

## Native diagram families

| Family | Native rendering and editing | Scope notes |
| --- | --- | --- |
| Class | Classes, interfaces, enums, members, generic labels, stereotypes, nested packages/namespaces, relationships | Custom preprocessing and full style semantics are outside the native subset |
| Object | Instances, value compartments, aliases, links, nested groups | Map-specific syntax is not implemented |
| Sequence | Participants, ordered/self/return messages, combined fragments, notes, dividers, delays, activations, destruction, numbering | Participant boxes and advanced activation/creation directives are not fully projected |
| Use case | Actors, use cases, relationships, nested system boundaries | Uses native theme and layout |
| Component | Components, interfaces, databases, dependencies, nested boundaries | Dedicated port notation is not implemented |
| Deployment | Nodes, artifacts, clouds, storage, stacks, agents, folders, other deployment shapes, nested structures | Custom sprites are not evaluated |
| State | States, descriptions, initial/final symbols, transitions, composite and concurrent regions | Advanced history and entry/exit pseudostates are outside the subset |
| Activity | Modern actions, decisions, loops, switch, fork/join, partitions, swimlanes; legacy arrows, actions and synchronization bars | Modern control connections derive from source structure; ambiguous legacy rewrites are rejected |
| Entity relationship | Entities, fields, keys, crow-foot connections, groups | Chen has its own editor below |
| Mind map, WBS | Hierarchy nodes, parent/child creation, rename, move, removal | Single-line nodes; arbitrary cross-links and multiline nodes are outside the subset |
| SDL | Input/output signals, procedures, tasks, save/load, continuous actions, decisions and control flow | Shares structured activity editing |
| Timing | Robust, concise, binary, analog, clock and rectangle signals, waveforms, states, constraints and messages | Edit events in the element's compartment; lanes move vertically |
| Gantt | Dated task bars, milestones, progress, resources, dependencies and closed weekdays | Drag changes task dates; advanced holiday/resource calendars and print styles remain source annotations |
| Chronology | Dated events and timeline | Drag changes event dates; names and timestamps edit in place |
| JSON, YAML | Nested objects, arrays, keys and values; YAML aliases and block/flow values | Structural edits preserve comments and surrounding source where applicable |
| Salt | Native wireframe controls, grids, labels, fields, buttons, choices and separators | Supported Salt layout constructs use native controls |
| EBNF, Regex | Native railroad paths, alternatives, sequences and repetition | Expressions edit in place; unsupported grammar constructs report diagnostics |
| Math, LaTeX | Editable formulas rendered as MathML using KaTeX | KaTeX's supported math language; no external TeX engine |
| Chart | Native axes, series, plots and value editing | Supported numeric series; custom plotting features remain source annotations or diagnostics |
| Files | Directory/file hierarchy and notes | Relationships follow the file tree |
| C4 | People, systems, containers, components, databases, boundaries and relationships | Known C4 macros interpreted locally; external libraries are not executed |
| ArchiMate | Architecture elements, categories and relationships | Known macros and native symbols; custom libraries are not executed |
| Network | Networks, device nodes, groups, addresses and bus connections | Connections derive from network membership |
| Chen ER | Entities, relationship diamonds, attribute ellipses, keys and cardinalities | Native source edits and relationship creation |
| DOT | Directed/undirected graphs, nodes, edges, attributes and clusters | Native layout; no Graphviz engine |
| Ditaa | ASCII boxes, labels and connectors projected as editable native shapes | Source geometry determines connections; no Ditaa renderer |
| Board | Board columns, nested cards and hierarchy | Structure derives from source indentation |
| Git | Commits, branches and history | History links derive from source order and branching |
| JCCKit | Numeric data series, chart axes and plots | Native chart rendering; no JCCKit renderer |

The file `examples/all-native.puml` contains all **33** original starter diagrams. Use **Current diagram** in the toolbar to switch types. **New diagram** opens the full gallery. Existing files with several diagram blocks use the same selector.

Basic formatted labels and selected stock icon names render natively. Simple local procedures with literal arguments can project declarations and edit their invocation parameters. Arbitrary preprocessor evaluation, loops/conditions inside procedures, custom sprites, external includes and remote resources are not executed. Known C4/ArchiMate includes select local native notation. Source styles are preserved, but full PlantUML styling is not reproduced. Engine utilities such as `listopeniconic`, `listsprite` and `stdlib` remain source-only.

## Navigation and placement

| Action | Gesture |
| --- | --- |
| Rename | Double-click the name, or select and press F2 |
| Edit members or diagram-specific properties | Double-click the compartment or shape content |
| Add element | Right-click empty canvas, or use the outline palette |
| Add child | Right-click a container, tree node or data collection |
| Connect elements | Drag between connection handles |
| Edit relationship | Double-click connector or label |
| Move | Drag an element; sequence participants move horizontally |
| Reorder a sequence message | Drag its line or label vertically, or use Up/Down on its focused label |
| Move / resize a sequence divider | Drag its label; select it and drag the left/right resize handle |
| Select-mode pan | Wheel, Shift+wheel horizontally, or middle-button drag |
| Select-mode zoom | Ctrl/Cmd+wheel |
| Hand tool | H; drag pans, wheel zooms |
| Temporary Hand / Select / Fit | Hold Space / V / F |

Connections in structured activities, trees, networks and other derived diagrams follow source structure. The editor disables arbitrary connections for these families. Containers move with their children. Gantt and chronology dragging changes source dates. Other manual positions are saved inside `.aliotuml` documents, or in VS Code workspace storage when editing plain PlantUML.

Sequence connections use row-specific lifeline handles and insert source at the chosen row. Message and divider vertical drags reorder source events, retaining directly attached activation directives. Else dividers remain inside their fragment. Divider horizontal positions and widths use the saved layout; native undo/redo for these presentation edits is available in portable `.aliotuml` documents.

Activity layout follows the control flow: centered action chains, balanced branches and merges, parallel fork lanes and outer loop paths. Node dimensions follow their labels. Pan, zoom and fit preserve automatic layout; only deliberate placement and dragging create manual overrides. **Re-layout** clears those overrides and arranges the current source again, including files positioned with an older extension version.

Graph layouts follow source directions, inheritance and relationships inside nested groups. Mind maps honor left/right branches, WBS uses compact branch stacks, and sequence columns adapt to participant names and messages. JSON/YAML objects and arrays use editable tables; Gantt schedules use compact rows on a shared calendar grid.

Ordinary connectors use straight lines by default. Set `skinparam linetype ortho` for sharp right-angle routes, `polyline` for straight segments, or `spline`/`splines` for curves. Activity branches, loops and schedule dependencies retain their structured tracks, with sharp corners unless curves are requested; sequence messages stay horizontal. Inline dashed, dotted, plain and bold arrow settings are applied. Only directives in the current source are interpreted; included files and arbitrary preprocessing are not evaluated. Existing manual placements remain until **Re-layout** is used.

## Development and previews

```sh
npm ci
npm run check
npm run preview
```

Press F5 to launch the extension development host. The default browser preview at `http://127.0.0.1:4173` displays the 33-diagram showcase and keeps edits in memory. Use `?example=sequence` to show a single template, or `?empty=1` for the gallery.

For an actual file-backed browser preview:

```sh
npm run preview -- --model examples/all-native.puml
# Or edit source and placements directly in a portable document:
npm run preview -- --model examples/portable.aliotuml
```

With `--model`, external file changes update the canvas, and diagram edits are written to the specified file. It preserves unrelated blocks, rejects stale edits, and appends new diagrams. Its undo history is cleared when an external editor changes the file. The VS Code extension instead uses native text-document undo and saves only through VS Code.

```sh
npx playwright install chromium
npm run test:web
npm run test:native
npm run test:corpus
npm run test:corpus -- --examples /path/to/plantuml-examples/doc
node scripts/compare-layouts.mjs --examples /path/to/plantuml-examples/doc --phase updated
npm run package
```

Corpus checks report native syntax coverage; they do not invoke an external renderer. The supplied examples currently contain 37 diagram-bearing files that parse natively, three engine utility listings and one shared style file. The report lists each input and its diagnostics. Browser tests create, rename, move, add and remove elements for every starter family, with separate real-file synchronization tests. These checks do not establish exhaustive PlantUML grammar compatibility.

The visual comparison command builds a local gallery from the example repository's reference PNGs and actual native editor screenshots. The file-by-file review and remaining visual differences are in `docs/plantuml-layout-comparison.md`; the generated gallery is `.cache/layout-comparison/index.html`.

See `CONTRIBUTING.md` for architecture and `THIRD_PARTY_NOTICES.md` for dependency licensing. No SWAML source or private Aliot packages are used. Desktop and remote VS Code hosts are supported; a browser extension bundle for vscode.dev is not yet provided.
