# Contributing

Aliot UML Editor is an independent MIT-licensed implementation. Do not import proprietary internals, copy source from other Aliot extensions, or add examples with incompatible licensing.

## Code map

- `src/core/`: conservative PlantUML projection, source-span edits, layout, original templates. This layer has no VS Code or React dependency.
- `src/core/aliot-document.ts`: the portable `.aliotuml` codec. `schemas/aliot-uml.schema.json` and `docs/aliot-file-format.md` describe its public format.
- `src/core/families/`: data, architecture and time adapters sharing the `NativeFamily` parse/edit/layout contract; `activities.ts`, `legacy-activity.ts`, `sequence.ts` and `procedures.ts` handle richer UML constructs.
- `src/shared/`: typed host/webview protocol and diagram data structures.
- `src/host/`: message validation and source-version checks.
- `src/extension.ts`: custom text editor provider, native document edits, layout persistence and commands.
- `src/webview/`: React Flow canvas, UML shapes and markers, inline forms, source editor and template gallery.
- `test/`: core and host regression tests; `test/web/`: browser interaction tests; `test/native/`: extension host smoke tests.

Keep `.puml` source authoritative. Prefer narrow text-span edits and retain comments, aliases, directives, EOLs, and unrelated blocks. Reject ambiguous edits. Unsupported syntax must be identified explicitly with its source retained. Do not introduce a PlantUML/Java renderer, generated diagram images, or a remote rendering fallback. Changes to versioned edit handling need conflict tests.

For `.aliotuml`, the embedded PlantUML string is authoritative for semantics; JSON layout entries store presentation only. Preserve unknown metadata and update the latest envelope through the codec. Keep source-edit versions stable across geometry-only changes, and merge position changes against their supplied baseline so independent split-view drags survive. Native VS Code undo must cover both source and placement edits.

Add native support by extending `src/core/coverage.ts`, detection/projection, source-edit rules, a diagram-specific palette, shape/layout behavior, and round-trip tests together. New families register through `families/registry.ts`; the gallery and example checks use their templates. Recognition alone is not support: verify real diagrams, creation, editing, and source synchronization in the browser. Keep scope and limitations explicit.

Run `npm run check` and `npm run test:web` before contributing. For parser/template changes run `npm run test:corpus`. The corpus command reports native coverage of external inputs without copying them or executing their contents. Unsupported input is reported as a coverage gap, never counted as rendered.

The current package name and publisher are local packaging metadata. Marketplace publishing and a public GitHub repository must be configured by the project owner; the build does not publish anything.

## README screenshots

Run `node scripts/capture-readme.mjs` to refresh the four PNGs in `media/screenshots/`. Install Chromium with `npx playwright install chromium` if needed. The command starts and stops its own local preview on port 4187, uses the original bundled examples, and captures the actual editor without changing their files. Browser page errors fail the capture.

The README uses relative image and documentation links. Before Marketplace packaging or publishing, set the real public `repository` URL in `package.json`, or supply `--baseContentUrl` and `--baseImagesUrl` to `vsce` with the public documentation and image locations. `vsce` uses these to resolve links for the Marketplace listing. Keep the screenshots available at those locations. For local-only VSIX inspection before a public repository exists, `vsce package --no-dependencies --allow-missing-repository --no-rewrite-relative-links` preserves the relative paths; that package does not establish working Marketplace image URLs.

## Packaging dependencies

The packaging CLI's Azure authentication chain is constrained to `@azure/identity` 4.13.0 and `uuid` 11.1.1 to avoid the audited MSAL 5–7.0 authorization advisory and the old UUID buffer bounds advisory. These are development-only dependencies and are excluded from the VSIX. Revisit these pins when the upstream packaging dependency adopts a patched compatible MSAL release. Local packaging is tested; marketplace authentication is not exercised by this repository's tests.
