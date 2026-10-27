# Third-party notices

The extension's original implementation is licensed under MIT. It does not include code, assets, or private packages from SWAML or another Aliot extension. Interaction conventions were inspected as a product reference only.

Primary bundled runtime dependencies:

| Dependency | License | Upstream |
| --- | --- | --- |
| React and React DOM | MIT | https://github.com/facebook/react |
| React Flow (`@xyflow/react`) and `@xyflow/system` | MIT | https://github.com/xyflow/xyflow |
| Lucide React | ISC | https://github.com/lucide-icons/lucide |
| JSONC parser | MIT | https://github.com/microsoft/node-jsonc-parser |
| YAML | ISC | https://github.com/eemeli/yaml |
| KaTeX | MIT | https://github.com/KaTeX/KaTeX |

Build tooling retains legal comments in generated bundles. `THIRD_PARTY_LICENSES.txt` contains the full license texts for bundled npm dependencies and is generated during the build.

## PlantUML text format

The extension implements its own native diagram projection and text edits. It does not bundle, download, invoke, or depend on the PlantUML renderer or a Java runtime.

## Reference examples

The user-provided `plantuml-examples` checkout is inspected and tested in place. Its license is CC BY-NC-SA 4.0, so none of its source files or images are redistributed in this MIT project. Bundled starter templates and examples were written independently.
