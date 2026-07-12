'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMockVscode, installMockVscode } = require('../helpers/mockVscode');

const mock = createMockVscode({
  overrides: {
    workspace: {
      getConfiguration: () => ({
        get: () => false
      })
    }
  }
});
const restoreVscode = installMockVscode(mock.vscode);
const {
  APP_SERVER_RATE_LIMIT_SOURCE,
  normalizeAppServerRateLimitPayload
} = require('../../src/profiles/codexAppServerRateLimitClient');
restoreVscode();

test('normalizes Codex app-server rate-limit response', () => {
  const originalNow = Date.now;
  Date.now = () => Date.parse('2026-05-20T10:00:00.000Z');
  try {
    const data = normalizeAppServerRateLimitPayload({
      rateLimits: {
        limitId: 'codex',
        primary: {
          usedPercent: 9,
          windowDurationMins: 300,
          resetsAt: Date.parse('2026-05-20T12:00:00.000Z') / 1000
        },
        secondary: {
          usedPercent: 1,
          windowDurationMins: 10080,
          resetsAt: Date.parse('2026-05-23T10:00:00.000Z') / 1000
        },
        planType: 'plus'
      }
    });

    assert.equal(data.filePath, APP_SERVER_RATE_LIMIT_SOURCE);
    assert.equal(data.planType, 'plus');
    assert.equal(data.primary.usedPercent, 9);
    assert.equal(data.primary.windowMinutes, 300);
    assert.equal(data.primary.resetAt, Date.parse('2026-05-20T12:00:00.000Z'));
    assert.equal(data.secondary.usedPercent, 1);
    assert.equal(data.secondary.windowMinutes, 10080);
    assert.equal(data.secondary.resetAt, Date.parse('2026-05-23T10:00:00.000Z'));
  } finally {
    Date.now = originalNow;
  }
});

test('classifies a lone seven-day app-server window as the weekly-only mode', () => {
  const data = normalizeAppServerRateLimitPayload({
    rateLimits: {
      planType: 'plus',
      primary: {
        usedPercent: 1,
        windowDurationMins: 10_080,
        resetsAt: Date.now() / 1000 + 60
      },
      secondary: null
    }
  });

  assert.equal(data.primary, null);
  assert.equal(data.secondary.windowMinutes, 10_080);
  assert.equal(data.secondary.usedPercent, 1);
});

test('prefers codex entry from multi-limit app-server response', () => {
  const originalNow = Date.now;
  Date.now = () => Date.parse('2026-05-20T10:00:00.000Z');
  try {
    const data = normalizeAppServerRateLimitPayload({
      rateLimits: {
        limitId: 'other',
        primary: {
          usedPercent: 90,
          windowDurationMins: 300,
          resetsAt: Date.parse('2026-05-20T11:00:00.000Z') / 1000
        },
        secondary: null,
        planType: 'free'
      },
      rateLimitsByLimitId: {
        codex: {
          limitId: 'codex',
          primary: {
            usedPercent: 15,
            windowDurationMins: 300,
            resetsAt: Date.parse('2026-05-20T12:00:00.000Z') / 1000
          },
          secondary: null,
          planType: 'plus'
        }
      }
    });

    assert.equal(data.planType, 'plus');
    assert.equal(data.primary.usedPercent, 15);
    assert.equal(data.primary.resetAt, Date.parse('2026-05-20T12:00:00.000Z'));
  } finally {
    Date.now = originalNow;
  }
});
