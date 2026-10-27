import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { parseDocument } from '../../src/core/parser';
import { geometry, crossesBox, crossesLine, collinearOverlap } from './graph-geometry';

// Original regression models; the optional external corpus is read in place.
const platform = `@startuml
!include <C4/C4_Container>
Person(reader, "Reader", "Reviews documents and shares feedback with the team")
System_Boundary(platform, "Publishing platform") {
  Container(site, "Website", "Web server", "Delivers the document viewer")
  Container(viewer, "Viewer", "Browser", "Displays documents and annotations")
  Container(tablet, "Tablet client", "Mobile", "Reviews and annotates documents while travelling")
  ContainerDb(store, "Document store", "SQL", "Stores documents, permissions and review history")
  Container(api, "Review API", "Service", "Handles document access and review updates")
}
System_Ext(notifier, "Notification service", "Delivers review notifications")
System_Ext(archive, "Archive service", "Retains completed reviews")
Rel(reader, site, "Visits")
Rel(reader, viewer, "Reviews")
Rel(reader, tablet, "Reviews")
Rel_Neighbor(site, viewer, "Serves")
Rel(viewer, api, "Updates")
Rel(tablet, api, "Updates")
Rel_Back_Neighbor(store, api, "Persists")
Rel_Back(reader, notifier, "Notifies")
Rel_Back(notifier, api, "Dispatches")
Rel_Neighbor(api, archive, "Archives")
@enduml`;

const nested = `@startuml
!include <C4/C4_Container>
skinparam linetype ortho
Person(reviewer, "Reviewer")
System_Boundary(workflow, "Review workflow") {
  package stages {
    package first {
      Container(draft, "Draft", "", "Prepare the document")
      Container(help, "Guidance", "", "Provide writing guidance")
      Rel_Right(draft, help, "Consults")
    }
    package second {
      Container(review, "Review", "", "Check the document")
      Container(checklist, "Checklist", "", "Provide review criteria")
      Rel_Right(review, checklist, "Checks")
    }
    Rel_Down(draft, review, "")
  }
}
Rel_Down(reviewer, draft, "Writes")
@enduml`;

async function show(page: Page, source: string) {
  const block = parseDocument(source).diagrams[0];
  await page.addInitScript(value => Object.defineProperty(window, '__ALIOT_INITIAL_SOURCE__', { value }), source);
  await page.goto('/');
  await expect(page.locator('.uml-node')).toHaveCount(block.elements.length);
  await expect(page.locator('.react-flow__edge-path')).toHaveCount(block.relations.length);
  await page.getByRole('button', { name: 'Fit diagram (F)', exact: true }).click();
  // Wait for fit and measured handle positions before testing screen geometry.
  await page.waitForTimeout(300);
}

async function expectClear(page: Page, source: string) {
  const scene = await geometry(page, source);
  const containers = new Set(parseDocument(source).diagrams[0].elements.filter(element => element.meta?.container).map(element => element.id));
  const passages: string[] = [], overlaps: string[] = [], crossings: string[] = [];
  for (const link of scene.links) {
    expect(link.path, 'Default connectors are single straight segments').toMatch(/^M\s*[-\d.e+]+\s+[-\d.e+]+\s+L\s+[-\d.e+]+\s+[-\d.e+]+$/i);
    const [a, b] = [link.points[0], link.points.at(-1)!];
    for (const box of scene.nodes) if (!containers.has(box.id) && ![link.source, link.target].includes(box.id) && crossesBox(a, b, box)) passages.push(`${link.source} -> ${link.target} passes through ${box.id}`);
  }
  for (let a = 0; a < scene.links.length; a++) for (let b = a + 1; b < scene.links.length; b++) {
    const p = scene.links[a], q = scene.links[b];
    const [p0, p1, q0, q1] = [p.points[0], p.points.at(-1)!, q.points[0], q.points.at(-1)!];
    if (collinearOverlap(p0, p1, q0, q1) > 1.5) overlaps.push(`${p.source} -> ${p.target} / ${q.source} -> ${q.target}`);
    if (crossesLine(p0, p1, q0, q1)) crossings.push(`${p.source} -> ${p.target} / ${q.source} -> ${q.target}`);
  }
  expect(passages, 'Long relationships avoid unrelated nodes').toEqual([]);
  expect(overlaps, 'Distinct relationships do not share line segments').toEqual([]);
  expect(crossings, 'Relationships remain separate outside their endpoints').toEqual([]);
}

test('compound C4 links have clear straight sightlines, including after Re-layout', async ({ page }) => {
  await show(page, platform);
  await expectClear(page, platform);
  await page.getByRole('button', { name: 'Re-layout diagram', exact: true }).click();
  await page.waitForTimeout(300);
  await expectClear(page, platform);
});

test('nested boundaries align external links to the connected child rather than the group center', async ({ page }) => {
  await show(page, nested);
  const scene = await geometry(page, nested);
  for (const [source, target] of [['reviewer', 'draft'], ['draft', 'review']]) {
    const link = scene.links.find(link => link.source === source && link.target === target)!;
    const xs = link.points.map(point => point.x);
    expect(Math.max(...xs) - Math.min(...xs), `${source} -> ${target} stays vertical`).toBeLessThan(1);
  }
});

const corpus = resolve(process.env.PLANTUML_EXAMPLES ?? '../plantuml-examples/doc');
const reference = resolve(corpus, 'c4-model/c4-model-container-diagram/c4-model-container-diagram.plantuml');
test('reported C4 container example has no node passages, overlapping lines or line crossings', async ({ page }) => {
  test.skip(!existsSync(reference), 'Set PLANTUML_EXAMPLES to the optional example checkout.');
  const source = readFileSync(reference, 'utf8');
  await show(page, source);
  await expectClear(page, source);
});
