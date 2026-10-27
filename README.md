# Aliot UML Editor

**Edit UML visually. Keep your PlantUML source.**

Create and edit diagrams directly in VS Code: rename a class, connect components, rearrange a workflow, or change the source. Aliot UML Editor keeps the canvas and supported PlantUML syntax in sync, with editable shapes instead of a rendered image.

**33 diagram families · Visual and source editing · Plain PlantUML files · Runs locally · MIT licensed**

![Class diagram with editable members, an element outline, and synchronized PlantUML source in Aliot UML Editor.](media/screenshots/visual-and-source.png)

*The actual editor, shown in its standalone preview with the bundled Order model example.*

## Why Aliot UML Editor?

- **Work directly on the diagram.** Double-click names and members, add elements from the canvas menu, and drag between connection handles for supported relationships.
- **Keep readable source.** Edit `.puml` files or use the source panel inside the canvas. Source edits update the diagram; visual edits update the corresponding source.
- **Start from a template.** Choose from 33 diagram families in a searchable gallery, then switch between multiple diagram blocks in the same file.
- **Your PlantUML stays plain PlantUML.** Manual positions go to a small layout file next to the diagram, so other tools and teammates without the extension see exactly the source you wrote.
- **Use familiar editor controls.** One undo/redo history for moves and edits, native VS Code save and unsaved-change handling, plus outline navigation, a minimap, zoom, fit, and **Re-layout**.
- **Render locally.** No Java, Graphviz installation, PlantUML server, or remote rendering service is required.

## Get started

Requires **VS Code 1.104.0 or later** on a desktop or remote extension host.

1. Install **Aliot UML Editor** from the Extensions view, or run `ext install voidaliot.aliot-uml-editor` from Quick Open (**Ctrl+P** / **Cmd+P**). For a downloaded `.vsix`, use **Extensions: Install from VSIX…** from the Command Palette.
2. Run **Aliot UML: New Diagram** and choose a template, or open an existing `.puml`, `.plantuml`, `.pu`, or `.iuml` file.
3. Double-click a label or compartment to edit it. Right-click empty canvas to add an element. Drag connection handles to create supported relationships.
4. Save with **Ctrl+S** / **Cmd+S**. Manual positions are saved automatically in the layout file.

If a file opens as text, right-click its editor tab and choose **Reopen Editor With… → Aliot UML Editor**, or run **Aliot UML: Open Diagram**.

![Searchable diagram gallery with starter templates for class, sequence, activity, architecture, and other diagram families.](media/screenshots/diagram-gallery.png)

*Pick a starter and make it your own. The gallery includes 33 native diagram types.*

## From architecture to workflows

Model a checkout conversation, sketch a service boundary, explore a data structure, or map a release plan. Each family has its own native notation and editing tools.

| Area | Diagram families |
| --- | --- |
| UML and data modeling | Class, object, sequence, use case, component, deployment, state, activity, entity relationship, Chen ER |
| Architecture and infrastructure | C4, ArchiMate, network, DOT |
| Planning and organization | Mind map, work breakdown structure, Gantt, chronology, board, Git history |
| Data and interfaces | JSON, YAML, Salt wireframes, files |
| Signals, languages, and formulas | Timing, SDL, EBNF, regex, math, LaTeX |
| Charts and ASCII diagrams | Chart, JCCKit, Ditaa |

![Checkout sequence diagram showing the customer, storefront, order service, inventory, and their messages.](media/screenshots/sequence.png)

*Sequence diagrams keep participants, messages, and lifelines on the canvas.*

![Fulfilment activity diagram with a stock decision, two branches, a merge, and a final notification.](media/screenshots/activity.png)

*Activity diagrams arrange actions, decisions, and merges around the control flow.*

## Visual editing and source, together

Open **Edit PlantUML source in canvas** from the toolbar to work on the current diagram's text. Apply a source draft with **Apply** or **Ctrl+Enter** / **Cmd+Enter**. For plain PlantUML files, **Source file** opens the text document alongside the diagram.

Try this in a new `order.puml` file:

```plantuml
@startuml
class Order {
  +number: String
  +submit()
}
class "Line item" as LineItem {
  +quantity: Integer
}
Order "1" *-- "many" LineItem : contains
@enduml
```

Double-click **Order** to rename it, edit its members, or move the shapes. Use **Re-layout** to clear manual placements and arrange the current diagram again.

## Where your layout is saved

| File | What it stores |
| --- | --- |
| `order.puml` | Your PlantUML source, exactly as written. Moving shapes never changes it. |
| `order.puml.layout.json` | Manual positions and sizes, one element per line. Created only once you move something; removed again by **Re-layout**. |

Commit the layout file to share your arrangement, or ignore it and let everyone use the automatic layout. Renaming, moving or deleting a diagram in VS Code does the same to its layout file; outside VS Code, move both together. Pan and zoom stay in your workspace and are not shared. See the [layout file format](docs/layout-file-format.md).

## Canvas shortcuts

| Action | Gesture |
| --- | --- |
| Rename | Double-click a name, or select and press **F2** |
| Edit members or properties | Double-click the compartment or shape content |
| Add an element or child | Right-click the canvas or a supported container |
| Edit a relationship | Double-click its connector or label |
| Reorder a sequence message | Drag its line or label up/down; focused labels also accept **↑** / **↓** |
| Move or resize a sequence divider | Drag its label; select it and drag the left/right resize handle |
| Select / Hand tool | **V** / **H** |
| Temporary Hand tool | Hold **Space** |
| Pan in Select mode | Mouse wheel; **Shift+wheel** horizontally; middle-button drag |
| Zoom in Select mode | **Ctrl+wheel** / **Cmd+wheel** |
| Fit diagram | **F** |

Connections in structured activities, trees, and networks follow their source structure. Gantt tasks and chronology events change their dates when dragged.

Sequence lifelines offer connection points at the message rows. Drag between lifelines at the desired row to insert a message there. Moving messages or dividers between rows updates their source order; divider widths and horizontal placement are saved with the layout.

## PlantUML compatibility

**Preview release.** Aliot UML Editor implements a native subset of PlantUML; support for a diagram family does not mean complete language compatibility or identical rendering to PlantUML. Unsupported constructs retain their source and produce diagnostics.

Common labels, relationships, nested groups, and selected styles are supported. Full styling, arbitrary preprocessing, custom sprites, and external includes are not evaluated. Known C4 and ArchiMate macros are interpreted locally. Diagram layout and appearance use the native editor.

Desktop and remote VS Code hosts are supported. A browser extension bundle for **vscode.dev** is not currently provided. Image and PDF export are not currently offered.

See the [native editing reference](docs/native-editing.md) for the scope of each family and the [layout file format](docs/layout-file-format.md) for saved positions. The [bundled examples](examples/all-native.puml) include all 33 starter diagrams.

## Feedback and contributing

Found a diagram that does not round-trip, or a construct you would like supported? [Open an issue](https://github.com/voidaliot/uml-edit-vsc-ext/issues) with a minimal `.puml` sample. See [Contributing](CONTRIBUTING.md) for the architecture, development setup, and test commands, and the [Changelog](CHANGELOG.md) for release notes.

## License

[MIT](LICENSE) — free to use, modify, and distribute, including commercially, under the license terms. Copyright © 2026 Aliot UML Editor contributors.

Bundled dependencies retain their own licenses. See [Third-party notices](THIRD_PARTY_NOTICES.md) and [Third-party license texts](THIRD_PARTY_LICENSES.txt).
