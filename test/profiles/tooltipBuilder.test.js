'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMockVscode, installMockVscode } = require('../helpers/mockVscode');

const USAGE_API_SOURCE = 'https://chatgpt.com/backend-api/wham/usage';

test('profile tooltip keeps weekly limit and reset countdown inside the limits table cell', () => {
  class MarkdownString {
    constructor() {
      this.value = '';
    }

    appendMarkdown(text) {
      this.value += text;
      return this;
    }
  }

  const mock = createMockVscode({
    overrides: {
      MarkdownString,
      workspace: {
        getConfiguration: () => ({
          get: (_key, fallback) => fallback
        })
      }
    }
  });
  const restore = installMockVscode(mock.vscode);
  try {
    delete require.cache[require.resolve('../../src/profiles/tooltipBuilder')];
    const { createProfileTooltip } = require('../../src/profiles/tooltipBuilder');
    const now = Date.now();
    const tooltip = createProfileTooltip(
      { id: 'profile-1' },
      [
        {
          id: 'profile-1',
          name: 'Profile 1',
          planType: 'plus',
          rateLimitState: {
            observedAt: now,
            sourceFile: USAGE_API_SOURCE,
            primary: {
              usedPercent: 40,
              resetAt: now + 60 * 60 * 1000,
              windowMinutes: 300
            },
            secondary: {
              usedPercent: 25,
              resetAt: now + 24 * 60 * 60 * 1000,
              windowMinutes: 10_080
            }
          }
        }
      ],
      new Map([
        [
          'profile-1',
          [
            {
              windowId: 'other-window',
              profileId: 'profile-1',
              workspaceLabel: 'Other Workspace',
              updatedAt: now
            }
          ]
        ]
      ])
    );

    assert.match(tooltip.value, /5H 60% 1h<br>W 75% 1d/);
    assert.doesNotMatch(tooltip.value, /\\\| W/);
    assert.match(tooltip.value, /1 other window: Other Workspace/);
  } finally {
    restore();
  }
});
