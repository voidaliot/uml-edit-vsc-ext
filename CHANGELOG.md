# Changelog

## 0.7.0 — 2026-11-20

- **Copy, cut, paste and duplicate** elements on the canvas (Ctrl/Cmd+C, X, V, D, or the context menu) in class, object, use case, component, deployment, state and entity diagrams. Each paste is one undoable source edit that keeps display names and gives copies fresh aliases (`Order` → `Order2`). Copies of hand-placed elements appear beside their originals, selected. Pasting works between diagrams of the same type in one file.
- **Connect faster.** Drag a connection from an element onto empty canvas to add a new, already connected element there; in sequence diagrams this adds a participant and a message at that row. Releasing a connection on an element's body now connects to it. Re-attach either end of a selected relationship by dragging its end grip to another element: only that endpoint changes in the source.
- **Shape relationships** in the freely arranged diagrams with manual bend points: drag the grip in the middle of a selected relationship to add a bend, drag a bend to move it, double-click to remove it. Bends are stored in the layout file under an optional `bends` list, share the undo history with placements, move along when both ends are dragged together, and are cleared by **Re-layout**. Layout files without bends are written exactly as before.
- **Snap while dragging.** Dragged elements snap to the edges and centres of the others, with guide lines; hold Alt to place freely once, or switch snapping off in the toolbar.
- **Move elements between packages.** Drop an element on another package, node or composite state, or drag it clear of its container to take it to the top level; **Move to…** in the context menu does the same without dragging. The declaration moves in the PlantUML source with its body and comments. A move is refused when it would put the declaration below a line that already names the element, because PlantUML would then keep it where that line stands. States in concurrent regions and namespaces stay source-only.
- **Export** the current diagram as SVG or PNG from the toolbar or the **Export Diagram as SVG…** / **PNG…** commands: the whole diagram at natural size, on the theme background, a light background or transparent, without selection or editing handles. PNGs are drawn at 2×. The SVG is self-contained and opens in web browsers; use PNG for tools that cannot display HTML inside SVG. The editor's Content-Security-Policy now allows `data:` images, which drawing the PNG requires.
- **One undo per action.** A placement that completes a source edit — an element added at a point, a paste beside hand-placed originals, a move into a package — is undone and redone together with that edit.
- **Find and reference.** A search box at the top of the outline finds elements by name, kind or alias (Ctrl/Cmd+F), and a keyboard shortcut reference opens from the toolbar or with `?`.
- **Properties…** in the context menu sets or clears an element's stereotype and background colour. SDL palette buttons show readable labels such as "input".
- **Start from nothing.** The gallery offers **Blank** beside **Example**, and an empty `@startuml` block asks which diagram it is going to be instead of assuming a class diagram. The chosen type stays while the source does not contradict it, so a use case diagram that begins with an actor, or a component diagram that begins with a database, no longer turns into a sequence diagram. The type remains correctable under **Diagram type** until the source settles it.
- New elements get readable source: `class Invoice` and `class "Line item" as LineItem` instead of `class "Invoice" as class_1`. Activity diagrams can add their start and stop, and state machines their initial and final symbols, from the palette or a state's context menu.
- **Delete what is selected.** Delete, the toolbar button and the context menu remove the whole selection as one undoable step. Select with a marquee, Shift/Ctrl-click or Ctrl+A. Activity decisions, loops and forks are removed with their branches, start and stop symbols can be deleted, and deleting a sequence frame keeps its messages.
- **Arrange.** Elements added from the palette are laid out with the diagram instead of stacking on one spot. Dragging a marquee selection by its box is saved, packages and other containers stay drawn around their contents wherever those are dragged, and a selection can be aligned or distributed from the toolbar. An element ranked by the automatic layout never lands on one placed by hand.
- **Layout.** Graph diagrams route a relationship that spans several ranks beside the boxes in between, not through them, including relationships that cross a package boundary. Cycles are broken at their feedback edge, a lone source sits next to what it points at, relationships from outside a container decide which of its children face that side, and independent groups wrap instead of forming one row. Parallel and opposite relationships keep their labels apart, and labelled relationships get room between rows.
- Dense graph diagrams have far fewer crossing relationships: every rank is ordered by a dedicated crossing-reduction pass before positions are assigned, and a relationship to a box far along the next rank steps clear of its own neighbours before it crosses over.
- Relationship types offered when connecting follow the diagram: messages and replies in sequence diagrams, transitions in state machines, cardinalities in entity diagrams.
- Sequence frames and notes in the last rows no longer overlap the participant footers or the next message's label.

## 0.6.0 — 2026-11-08

- Releases now publish the same tested VSIX to Visual Studio Marketplace, Open VSX and GitHub automatically when a new version reaches `main`. Failed publishing runs can be retried without duplicating registry versions.
- Failed layout-file writes and deletions retain the last saved placement and undo/redo history. Identical moves and history operations can be retried after the filesystem recovers, and the canvas restores the saved placement on failure.
- Companion layout files move only after their PlantUML file has been renamed successfully, so failed or canceled renames retain the original layout.
- Reopening the source editor after switching diagrams preserves an unsaved draft and its original target. Moving selected nested containers moves their descendants exactly once, and keyboard placement is saved without freezing untouched elements.
- Architecture insertions preserve uppercase diagram terminators and comments containing marker-like text. Editing C4 and ArchiMate boundary details is rejected to protect child declarations.
- Unterminated UML, sequence and activity notes are reported without exposing the diagram terminator to visual edits. Empty inline activity notes retain subsequent actions, and deleting a UML group also removes external member references to its descendants.
- Native VS Code persistence regressions run in CI. Patched the packaging tools' glob dependency; the dependency audit reports no vulnerabilities.

## 0.5.0 — 2026-10-27

- PlantUML files stay plain PlantUML. Manual positions and sizes are saved automatically to a companion layout file, `<diagram>.puml.layout.json`, written one element per line, created only when something is placed manually and removed by **Re-layout**. Pan and zoom stay in the VS Code workspace.
- Moves, resizes and source edits share one undo/redo history in the diagram, including edits typed in a text editor beside it. Undo from a text editor or the Edit menu keeps that history consistent.
- Renaming, moving or deleting a diagram in VS Code does the same to its layout file. External changes to the layout file reload live; invalid files are reported and left untouched.
- Removed the `.aliotuml` format and the **Save Aliot diagram**, **Open Aliot diagram** and **Export PlantUML** commands. The browser preview offers **Open PlantUML file** and **Download PlantUML**.
- First Marketplace release as `voidaliot.aliot-uml-editor`, marked as a preview. The package declares its public GitHub repository, issue tracker and homepage, so README images and documentation links resolve on the Marketplace listing.
- Canvas placement no longer adjusts stored layout points in place when an element's horizontal position is locked to its automatic layout.
- Multiline labels in SDL activity shapes no longer overflow their shape with wider fonts, such as the default Linux sans-serif.
- Releases are tagged and built automatically: merging a new version to `main` publishes a GitHub release with the VSIX attached.

## 0.4.0 — 2026-10-27

- Packages the current editor improvements as version 0.4.0, including sequence message reordering, movable and resizable dividers, row-aligned lifeline connections, and portable divider geometry.
- Includes the toolbar simplification and C4 connector layout fixes from the preceding preview releases.

## 0.3.5 — 2026-10-27

- Sequence messages can be dragged vertically by their line or label to reorder the PlantUML source. Focused labels also accept Up/Down arrows. Implicit participant declarations are made explicit when needed to retain column order.
- Sequence dividers can move horizontally and between message rows. Select a divider to resize its span using the left or right handle.
- Lifelines expose connection points at actual message rows, plus self-call returns and a final insertion point. New connections insert at the selected row; message endpoints sit exactly on the lifelines.
- Divider sizes persist with portable layouts and workspace placement. Portable size changes participate in native VS Code undo/redo and synchronize across split views without invalidating source drafts.
- Sequence events use content identities so reordering and unrelated source insertions retain divider geometry. Added source-edit, browser interaction, portable round-trip and native size-persistence regressions.

## 0.3.4 — 2026-10-27

- Removed the grid toggle, changed the minimap button to a map icon, and made Re-layout an icon-only button with its existing tooltip and accessible name.
- Nested graph boundaries align relationships to their connected children, keeping vertical C4 step chains straight instead of adding unnecessary elbows.
- C4 neighbor relations use adjacent columns. Compound layouts move whole subtrees to clear long straight relationships while retaining rank and directional constraints.
- Graph attachment points follow direct sightlines and keep close connections separate, avoiding the node passages and crossed lines in the reported C4 container example.
- Added browser geometry regressions for compound C4 layouts and refreshed the Marketplace screenshots.

## 0.3.3 — 2026-10-26

- Added a labeled **Re-layout** toolbar button to recalculate diagram placement after edits and clear manual placement overrides.
- Re-layout fits the measured current diagram without leaving a delayed request that could affect a newly selected diagram.
- Removed inherited webview padding so the editor and canvas fill the frame without unused strips on either side.

## 0.3.2 — 2026-10-26

- The marketplace badge now uses a flat white plant symbol on the existing yellow accent.
- Mixed-direction graphs keep pipeline chains together and balance their surrounding branches, honoring hidden ordering links without stretching individual connections.
- Area diagrams center the cloud and database over and under the pipeline, align actors above use cases, and place control pairs below their targets.
- Separate outline attachment points keep converging straight connectors clear of neighboring nodes and each other. Attachment points refresh after manual moves and Auto layout.
- Standalone controls and interfaces use their UML symbols. Formatted label sizes contribute to node dimensions and connector spacing.
- Area layout regressions check node overlaps, connector crossings and all supported source line types.

## 0.3.1 — 2026-10-26

- Graph layouts follow PlantUML directions, inheritance, hidden ordering links and nested group relationships. Symbol galleries use compact rows and columns.
- Straight connectors are the default; source `skinparam linetype ortho`, `polyline`, and `spline`/`splines` select routing. Orthogonal paths have sharp corners; relation-level dashed, dotted, plain and bold styles are honored.
- Mind maps preserve left/right branches, WBS uses compact branch stacks, and sequence participants use label-aware spacing with repeated footer symbols.
- JSON/YAML properties form editable key/value tables. Gantt uses compact task rows, a shared calendar grid and resource workloads; timing annotations sit above waveforms.
- Procedure diagrams display their expanded labels without duplicated invocation parameters. Title-only diagrams render their text and stock symbols.
- Initial fit waits for measured shapes and no longer schedules a delayed pan during inline editing.
- Marketplace icon uses the Aliot star, a flat plant sprout badge for PlantUML and the existing warm yellow accent.
- Added a reproducible comparison gallery for all 41 files in the PlantUML example corpus, alongside layout and browser editing regressions.

## 0.3.0 — 2026-10-26

- Portable `.aliotuml` documents store PlantUML source, manual element positions and saved viewports in versioned JSON with an included schema.
- Save/open Aliot documents and export plain PlantUML from the single toolbar. Browser previews can download and reopen portable snapshots.
- Native VS Code saving, dirty state and undo/redo cover placement edits; source edits retain layouts and unknown document metadata.
- Layout-only updates do not invalidate source drafts. Pan and zoom alone do not dirty portable files.
- All canvas controls share one toolbar; React Flow attribution and passive branding/status labels are hidden.

## 0.2.1 — 2026-10-26

- Compact activity layouts with centered trunks, balanced branches, merges, forks and loop tracks; text-sized shapes and smaller UML arrows.
- Orthogonal activity connectors and center-based connection-side selection for differently sized shapes.
- One interactive toolbar replaces the two headers, floating toolbars and passive branding/status labels.
- Pan, zoom and fit no longer freeze automatic positions. Deliberate drags remain persistent, while Auto layout clears manual overrides.

## 0.2.0 — 2026-10-26

- Native editors and original starter templates for 33 diagram families, including all UML families and PlantUML's data, architecture, timing, planning, grammar, chart and text-based formats.
- Native waveforms, task bars, timelines, railroad paths, MathML formulas, wireframes, network buses, Chen notation and chart plots.
- Nested UML containers, concurrent states, sequence fragments and activations, modern activity loops/forks/swimlanes, legacy activities and SDL.
- In-place names, members, values and properties; context-menu child creation; semantic date editing by dragging Gantt tasks and chronology events.
- Source-aware edits for JSON/YAML, diagram-specific syntax and safe literal procedure arguments, with comments and adjacent blocks retained.
- Browser creation/editing checks for every family, native VS Code synchronization checks and external example corpus reporting.
- Full style/preprocessor parity is not claimed; unsupported constructs produce diagnostics and retain their source.

## 0.1.0 — 2026-10-26

- Independent React Flow custom editor for PlantUML files.
- In-canvas name/member/relationship edits, context-menu creation, placement, outline, and Select/Hand navigation.
- Conservative graphical projections for common UML, activity, sequence, and tree diagrams.
- Original native templates and a multi-diagram showcase for 11 diagram families; other families are explicitly marked not implemented.
- Native React Flow only: no PlantUML/Java renderer, generated diagram images, renderer setup, or image fallback.
- Live text-document synchronization, in-canvas source editing, and optional file-backed development preview.
- Native VS Code text-document saving and undo, stale-edit rejection, multi-diagram selection, and local presentation storage.
