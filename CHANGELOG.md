# Changelog

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
