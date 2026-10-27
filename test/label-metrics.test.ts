import { describe, expect, it } from 'vitest';
import { measureLabel } from '../src/core/label-metrics';

describe('safe rich-label measurement', () => {
  it('uses each line’s font size when reserving multiline label height', () => {
    const normal = measureLabel('First\nSecond', 300);
    const large = measureLabel('First\n<size:20>Second</size>', 300);
    expect(normal.height).toBeCloseTo(12 * 1.4 * 2);
    expect(large.height).toBeCloseTo(12 * 1.4 + 20 * 1.4);
    expect(large.width).toBeGreaterThan(normal.width);
  });

  it('counts inline icon glyphs and their stylesheet margins without counting tag text', () => {
    expect(measureLabel('<&heart>', 200).width).toBe(14 + 2 + 2);
    expect(measureLabel('<$cloud><&heart>', 200).width).toBe(36);
    expect(measureLabel('<&heart><$cloud>', 20).height).toBeCloseTo(2 * 12 * 1.4);
    expect(measureLabel('<size:32><&heart></size>', 200).width).toBe(18);
  });

  it('wraps long labels within the requested content width including enlarged spans', () => {
    const short = measureLabel('The label needs several separate words to wrap safely', 100);
    const wide = measureLabel('The label needs several separate words to wrap safely', 1000);
    const large = measureLabel('<size:20>The label needs several separate words to wrap safely</size>', 100);
    expect(short.width).toBe(100);
    expect(short.height).toBeGreaterThan(wide.height * 2);
    expect(large.width).toBe(100);
    expect(large.height).toBeGreaterThan(short.height);
    expect(measureLabel('X'.repeat(100), 70).height).toBeGreaterThan(10 * 12 * 1.4);
  });

  it('ignores supported formatting tag text and resets size after its closing tag', () => {
    const plain = measureLabel('Text', 300);
    expect(measureLabel('<i><u><color:red>Text</color></u></i>', 300)).toEqual(plain);
    expect(measureLabel('<b>Text</b>', 300).width).toBeLessThan(plain.width * 1.1);
    expect(measureLabel('<size:20>A</size>B', 300).width).toBeCloseTo(measureLabel('A', 300, 20).width + measureLabel('B', 300).width, 1);
    expect(measureLabel('<size:200>A</size>', 300)).toEqual(measureLabel('<size:32>A</size>', 300));
  });

  it('decodes Unicode markup including nonbreaking spaces and astral characters', () => {
    expect(measureLabel('A<U+00A0>B', 300)).toEqual(measureLabel('A\u00a0B', 300));
    expect(measureLabel('A<U+00A0>B', 300).width).toBe(measureLabel('A B', 300).width);
    expect(measureLabel('<U+1F331>', 300)).toEqual(measureLabel('🌱', 300));
    expect(measureLabel('<U+110000>', 300).width).toBe(0);
  });

  it('preserves explicit empty lines and decodes literal PlantUML line breaks', () => {
    expect(measureLabel('A\\n\\nB', 300)).toEqual(measureLabel('A\n\nB', 300));
    expect(measureLabel('A\n\nB', 300).height).toBeCloseTo(3 * 12 * 1.4);
    expect(measureLabel('A\n', 300).height).toBeCloseTo(2 * 12 * 1.4);
    expect(measureLabel('A\r\nB', 300)).toEqual(measureLabel('A\nB', 300));
  });

  it('treats unsupported HTML-like content as visible literal text', () => {
    expect(measureLabel('<script>Text</script>', 300).width).toBeGreaterThan(measureLabel('Text', 300).width * 2);
    expect(measureLabel('<size:evil>Text</size>', 300).width).toBeGreaterThan(measureLabel('Text', 300).width);
    expect(measureLabel('', 300)).toEqual({ width: 0, height: 16.8 });
  });
});
