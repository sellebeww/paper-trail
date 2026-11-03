// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
// Automated accessibility check (axe-core, WCAG 2.x A and AA rules) for the screen a page is currently showing.
// It finds the mechanical problems (contrast, names, labels, landmarks, ARIA misuse); it is not a substitute for
// trying the screens with a screen reader and a keyboard.
import { createRequire } from 'node:module';
import type { Page } from 'playwright-core';
import { expect } from 'vitest';

const axeSource = createRequire(import.meta.url).resolve('axe-core/axe.min.js');

type Violation = { id: string; impact: string | null; help: string; nodes: { target: unknown }[] };
declare const axe: {
  run: (
    context: Document,
    options: { runOnly: { type: 'tag'; values: string[] } },
  ) => Promise<{ violations: Violation[] }>;
};

export const expectAccessible = async (page: Page, screen: string) => {
  await page.addScriptTag({ path: axeSource });
  const { violations } = await page.evaluate(() =>
    axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
    }),
  );
  const summary = violations.map(
    (v) =>
      `${v.impact} ${v.id}: ${v.help} -> ${v.nodes.map((n) => JSON.stringify(n.target)).join(' ')}`,
  );
  expect(summary, `accessibility violations on "${screen}"`).toEqual([]);
};
