import { describe, expect, it } from 'vitest';
import { parseDocument } from '../src/core/parser';
import { connectorStroke, routeConnector } from '../src/webview/routing';

const parse = (body: string) => parseDocument(`@startuml\n${body}\n@enduml`).diagrams[0];
const geometry = { sourceX: 10, sourceY: 40, targetX: 120, targetY: 180, sourcePosition: 'bottom' as const, targetPosition: 'top' as const };

describe('source connector settings', () => {
  it('defaults to straight connectors without adding or changing source', () => {
    const block = parse('class A\nclass B\nA --> B');
    expect(block.meta?.lineType).toBe('straight');
    expect(block.source).not.toContain('linetype');
    expect(routeConnector(geometry).path).toBe('M 10 40 L 120 180');
  });
  it.each(['ortho', 'polyline', 'spline', 'splines'])('applies skinparam linetype %s', setting => {
    const block = parse(`skinparam linetype ${setting}\nclass A\nclass B\nA --> B`);
    expect(block.graphical).toBe(true);
    expect(block.warnings).toEqual([]);
    expect(block.meta?.lineType).toBe(setting === 'splines' ? 'spline' : setting);
  });
  it('reads the last explicit setting and ignores comments, members, and notes', () => {
    const block = parse("skinparam linetype ortho\nskinparam LINETYPE polyline ' comment\n' skinparam linetype spline\n/'\nskinparam linetype spline\n'/\nclass A {\nskinparam linetype spline\n}\nnote right of A\nskinparam linetype spline\nend note");
    expect(block.meta?.lineType).toBe('polyline');
  });
  it('reads a root skinparam block and ignores uncalled procedure directives', () => {
    const block = parse('skinparam {\nlinetype ortho\n}\n!procedure $unused()\nskinparam linetype spline\n!endprocedure\nclass A');
    expect(block.meta?.lineType).toBe('ortho');
  });
  it('applies settings after the C4 family builds its metadata', () => {
    const block = parse('!include <C4/C4_Container>\nskinparam linetype ortho\nPerson(user, "Reader")\nSystem(system, "Catalog")\nRel(user, system, "Uses")');
    expect(block.kind).toBe('c4');
    expect(block.meta?.lineType).toBe('ortho');
  });
  it('reads DOT routing settings', () => {
    const block = parseDocument('@startdot\ndigraph Demo {\ngraph [splines=ortho, ranksep=1];\na -> b;\n}\n@enddot').diagrams[0];
    expect(block.meta?.lineType).toBe('ortho');
  });
  it('uses sharp axis-aligned segments for ortho and a curve only for explicit splines', () => {
    const orthogonal = routeConnector(geometry, 'ortho').path;
    expect(orthogonal).not.toMatch(/[CQ]/);
    expect(routeConnector(geometry, 'polyline').path).not.toMatch(/[CQ]/);
    expect(routeConnector(geometry, 'spline').path).toContain('C');
  });
  it('retains structured branches and outer loop tracks without rounded defaults', () => {
    const branch = routeConnector({ ...geometry, sourcePosition: 'left' }, 'straight', { kind: 'branch' });
    expect(branch.path).not.toMatch(/[CQ]/);
    const loop = routeConnector({ ...geometry, sourcePosition: 'left', targetPosition: 'left' }, 'ortho', { kind: 'loop', side: 'left', laneX: -30 });
    expect(loop.path).toContain('-30');
    expect(loop.path).not.toMatch(/[CQ]/);
  });
  it('keeps self loops visible for all routing modes', () => {
    for (const style of ['straight', 'ortho', 'polyline', 'spline'] as const) {
      const route = routeConnector({ ...geometry, targetX: 4, targetY: 20 }, style, undefined, true);
      expect(route.path).not.toContain('NaN');
      expect(route.path).toContain('58');
    }
  });
  it('honors relation-level dashed, dotted, bold, and plain settings', () => {
    expect(connectorStroke('-[dashed]->')).toMatchObject({ strokeDasharray: '5 4' });
    expect(connectorStroke('-[dotted,bold]->')).toEqual({ strokeDasharray: '1 4', bold: true });
    expect(connectorStroke('.[plain].>')).toMatchObject({ strokeDasharray: undefined });
    expect(connectorStroke('-->')).toMatchObject({ strokeDasharray: undefined });
    expect(connectorStroke('-->', true)).toMatchObject({ strokeDasharray: '5 4' });
  });
});
