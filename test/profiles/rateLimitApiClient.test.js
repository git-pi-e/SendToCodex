'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeUsageApiPayload } = require('../../src/profiles/rateLimitApiClient');

test('classifies a lone seven-day Usage API window as the weekly-only mode', () => {
  const originalNow = Date.now;
  Date.now = () => Date.parse('2026-07-12T20:00:00.000Z');
  try {
    const data = normalizeUsageApiPayload({
      plan_type: 'plus',
      rate_limit: {
        primary_window: {
          used_percent: 1,
          limit_window_seconds: 7 * 24 * 60 * 60,
          reset_at: Date.parse('2026-07-19T20:00:00.000Z') / 1000
        },
        secondary_window: null
      }
    });

    assert.equal(data.primary, null);
    assert.equal(data.secondary.windowMinutes, 10_080);
    assert.equal(data.secondary.usedPercent, 1);
  } finally {
    Date.now = originalNow;
  }
});

test('keeps the documented five-hour and weekly Usage API windows', () => {
  const data = normalizeUsageApiPayload({
    plan_type: 'plus',
    rate_limit: {
      primary_window: {
        used_percent: 10,
        limit_window_seconds: 5 * 60 * 60,
        reset_at: Date.now() / 1000 + 60
      },
      secondary_window: {
        used_percent: 20,
        limit_window_seconds: 7 * 24 * 60 * 60,
        reset_at: Date.now() / 1000 + 60
      }
    }
  });

  assert.equal(data.primary.windowMinutes, 300);
  assert.equal(data.secondary.windowMinutes, 10_080);
});
