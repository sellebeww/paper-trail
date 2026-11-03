// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { CanonicalizationError, canonicalize } from './jcs.js';

describe('canonicalize (RFC 8785)', () => {
  it('matches the RFC 8785 §3.2.2 example', () => {
    const input = {
      numbers: [333333333.33333329, 1e30, 4.5, 2e-3, 0.000000000000000000000000001],
      // The RFC sample string, spelled as code points to avoid escaping mistakes:
      // euro, dollar, U+000F, LF, A, apostrophe, B, quote, backslash, backslash, quote, slash.
      string: String.fromCodePoint(
        0x20ac,
        0x24,
        0x0f,
        0x0a,
        0x41,
        0x27,
        0x42,
        0x22,
        0x5c,
        0x5c,
        0x22,
        0x2f,
      ),
      literals: [null, true, false],
    };
    expect(canonicalize(input)).toBe(
      String.raw`{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\u000f\nA'B\"\\\\\"/"}`,
    );
  });

  it('sorts keys by UTF-16 code units (RFC 8785 §3.2.3 example)', () => {
    const input = {
      '€': 'Euro Sign',
      '\r': 'Carriage Return',
      דּ: 'Hebrew Letter Dalet With Dagesh',
      '1': 'One',
      '😀': 'Emoji: Grinning Face',
      '\u0080': 'Control',
      ö: 'Latin Small Letter O With Diaeresis',
    };
    const keys = Object.keys(JSON.parse(canonicalize(input)) as object);
    // JSON.parse reorders integer-like keys, so compare the serialized order directly instead.
    expect(keys).toHaveLength(7);
    const order = ['\r', '1', '\u0080', 'ö', '€', '😀', 'דּ'];
    const serialized = canonicalize(input);
    const positions = order.map((k) => serialized.indexOf(JSON.stringify(k) + ':'));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it.each([
    [0, '0'],
    [-0, '0'],
    [1, '1'],
    [-1, '-1'],
    [1e21, '1e+21'],
    [1e20, '100000000000000000000'],
    [1e-7, '1e-7'],
    [0.000001, '0.000001'],
    [9007199254740991, '9007199254740991'],
    [5e-324, '5e-324'],
    [1.7976931348623157e308, '1.7976931348623157e+308'],
  ])('serializes number %s as %s (ES6 Number-to-String)', (n, expected) => {
    expect(canonicalize(n)).toBe(expected);
  });

  it('sorts nested objects and keeps array order', () => {
    expect(canonicalize({ b: [3, { z: 1, a: 2 }], a: { y: true, x: false } })).toBe(
      '{"a":{"x":false,"y":true},"b":[3,{"a":2,"z":1}]}',
    );
  });

  it('keeps non-ASCII characters literal and escapes control characters', () => {
    expect(canonicalize('é😀\u0007\u001f\u007f')).toBe('"é😀\\u0007\\u001f\u007f"');
  });

  it('produces the same output regardless of key insertion order', () => {
    expect(canonicalize({ a: 1, b: { c: 'x', d: 'y' } })).toBe(
      canonicalize({ b: { d: 'y', c: 'x' }, a: 1 }),
    );
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['undefined', undefined],
    ['undefined member', { a: undefined }],
    ['function', () => 1],
    ['Date', new Date(0)],
    ['Map', new Map()],
    ['bigint', 1n],
    ['lone high surrogate', '\ud83d'],
    ['lone surrogate in key', { '\udc00': 1 }],
    ['sparse array', [1, , 3]],
  ])('rejects %s', (_label, value) => {
    expect(() => canonicalize(value)).toThrow(CanonicalizationError);
  });
});
