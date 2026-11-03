// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0

export class CanonicalizationError extends Error {
  override name = 'CanonicalizationError';
}

// In unicode mode a valid surrogate pair is one code point, so this only matches lone surrogates.
const LONE_SURROGATE = /\p{Cs}/u;

const serializeString = (value: string): string => {
  if (LONE_SURROGATE.test(value))
    throw new CanonicalizationError('String contains a lone surrogate');
  // JSON.stringify escapes exactly what RFC 8785 §3.2.2.2 requires: quote, backslash, and
  // U+0000–U+001F (as \b \t \n \f \r or lowercase \u00xx); everything else is emitted as-is.
  return JSON.stringify(value);
};

/**
 * JSON Canonicalization Scheme, RFC 8785.
 * Accepts only JSON data (plain objects, arrays, strings, finite numbers, booleans, null) and throws
 * on anything that JSON.stringify would silently drop or coerce (undefined, functions, Dates, Maps…).
 */
export const canonicalize = (value: unknown): string => {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new CanonicalizationError('Number is not finite');
      // RFC 8785 §3.2.2.3 mandates the ECMAScript Number-to-String algorithm, which is what JS uses.
      return JSON.stringify(value);
    case 'string':
      return serializeString(value);
    case 'object': {
      if (Array.isArray(value)) return `[${Array.from(value, canonicalize).join(',')}]`;
      const proto = Object.getPrototypeOf(value) as unknown;
      if (proto !== Object.prototype && proto !== null) {
        throw new CanonicalizationError('Only plain objects can be canonicalized');
      }
      const record = value as Record<string, unknown>;
      // Default sort compares UTF-16 code units, which is the order RFC 8785 §3.2.3 requires.
      const members = Object.keys(record)
        .sort()
        .map((key) => `${serializeString(key)}:${canonicalize(record[key])}`);
      return `{${members.join(',')}}`;
    }
    default:
      throw new CanonicalizationError(`Unsupported value of type ${typeof value}`);
  }
};
