# Contributing

Aliot UML Editor is an independent MIT-licensed implementation. Do not import proprietary internals, copy source from other Aliot extensions, or add examples with incompatible licensing.

## Development setup

```sh
npm ci
npm run check
npm run preview
```

Press **F5** to launch an Extension Development Host, or open the standalone preview at `http://127.0.0.1:4173`. To edit a real file in the browser preview, run `npm run preview -- --model examples/order-model.puml`.

## Code map

- `src/core/`: conservative PlantUML projection, source-span edits, layout, original templates. This layer has no VS Code or React dependency.
- `src/core/layout-file.ts`: the `<diagram>.layout.json` codec for manual placements. `schemas/layout.schema.json` and `docs/layout-file-format.md` describe its public format.
- `src/core/families/`: data, architecture and time adapters sharing the `NativeFamily` parse/edit/layout contract; `activities.ts`, `legacy-activity.ts`, `sequence.ts` and `procedures.ts` handle richer UML constructs.
- `src/shared/`: typed host/webview protocol and diagram data structures.
- `src/host/`: message validation and source-version checks.
- `src/extension.ts`: custom text editor provider, native document edits, layout files, the shared undo/redo history and commands.
- `src/webview/`: React Flow canvas, UML shapes and markers, inline forms, source editor and template gallery.
- `test/`: core and host regression tests; `test/web/`: browser interaction tests; `test/native/`: extension host smoke tests.

Keep `.puml` source authoritative. Prefer narrow text-span edits and retain comments, aliases, directives, EOLs, and unrelated blocks. Reject ambiguous edits. Unsupported syntax must be identified explicitly with its source retained. Do not introduce a PlantUML/Java renderer, generated diagram images, or a remote rendering fallback. Changes to versioned edit handling need conflict tests.

Placement never changes the PlantUML file; it lives in the companion layout file, which is written only when something is placed manually and removed when nothing is. Keep source-edit versions stable across geometry-only changes, and merge position changes against their supplied baseline so independent split-view drags survive. Source and placement share one history: placement steps are recorded with the source text they were made on, and source steps are VS Code's native undo stack. Changes to that history need native host tests (`npm run test:native`).

Add native support by extending `src/core/coverage.ts`, detection/projection, source-edit rules, a diagram-specific palette, shape/layout behavior, and round-trip tests together. New families register through `families/registry.ts`; the gallery and example checks use their templates. Recognition alone is not support: verify real diagrams, creation, editing, and source synchronization in the browser. Keep scope and limitations explicit.

Run `npm run check` and `npm run test:web` before contributing. For parser/template changes run `npm run test:corpus`. The corpus command reports native coverage of external inputs without copying them or executing their contents. Unsupported input is reported as a coverage gap, never counted as rendered.

The extension is published as `voidaliot.aliot-uml-editor` from https://github.com/voidaliot/uml-edit-vsc-ext. `npm run package` builds the VSIX only; merging a new version to `main` publishes it through the Release workflow.

## Releases

Every push to `main` runs the Release workflow (`.github/workflows/release.yml`), which first runs the full CI. When the `version` in `package.json` has no `v<version>` tag yet, it packages one VSIX, publishes it to Visual Studio Marketplace and Open VSX, then tags the commit and creates a GitHub release with that same VSIX and the matching `CHANGELOG.md` section as notes. Repository secrets `VSCE_PAT` and `OVSX_PAT` must be configured. Missing credentials or release notes fail before publication. To release, bump the version, add its changelog section, and merge to `main`; a merge without a version bump only runs CI. Rerun a failed Release workflow to resume partial publication: both registries skip an already published version, and an existing tag on the same commit permits recovery if creating the GitHub release failed. Manual dispatch publishes only from `main`.

## README screenshots

Run `node scripts/capture-readme.mjs` to refresh the four PNGs in `media/screenshots/`. Install Chromium with `npx playwright install chromium` if needed. The command starts and stops its own local preview on port 4187, uses the original bundled examples, and captures the actual editor without changing their files. Browser page errors fail the capture.

The README uses relative image and documentation links. `vsce` rewrites them against the `repository` URL in `package.json` (the `main` branch on GitHub), so commit and push refreshed screenshots and docs before publishing, or the Marketplace listing will show the previous versions.

## Packaging dependencies

The packaging CLI's Azure authentication chain is constrained to `@azure/identity` 4.13.0 and `uuid` 11.1.1 to avoid the audited MSAL 5–7.0 authorization advisory and the old UUID buffer bounds advisory. Its `minimatch` dependency is constrained to 11.0.1 to address glob amplification (GHSA-g3hv-75wg-m249). These are development-only dependencies and are excluded from the VSIX. Revisit these pins when the upstream packaging dependencies adopt patched compatible releases. Local packaging is tested; registry credentials are exercised only by the Release workflow.
