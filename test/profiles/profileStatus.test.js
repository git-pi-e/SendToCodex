'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  formatCompactRateSummary,
  getProfileRateStatus,
  getWindowRemainingPercent
} = require('../../src/profiles/profileStatus');

const USAGE_API_SOURCE = 'https://chatgpt.com/backend-api/wham/usage';

function createProfile(rateLimitState) {
  return {
    id: 'profile-1',
    name: 'Profile 1',
    planType: 'plus',
    rateLimitState
  };
}

const ACTIVE_PROFILE_OPTIONS = { activeProfileId: 'profile-1' };
const INACTIVE_PROFILE_OPTIONS = { activeProfileId: 'other-profile' };

test('rate-limit display uses fresh Usage API observations', () => {
  const now = Date.parse('2026-05-20T10:00:00.000Z');
  const status = getProfileRateStatus(
    createProfile({
      observedAt: now - 10_000,
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
    }),
    now,
    ACTIVE_PROFILE_OPTIONS
  );

  assert.equal(status.hasFreshUsageApiData, true);
  assert.equal(status.isEstimatedRateLimitData, false);
  assert.equal(getWindowRemainingPercent(status.primary, now), 60);
  assert.equal(getWindowRemainingPercent(status.secondary, now), 75);
  assert.equal(
    formatCompactRateSummary(status, now, {
      includePrimaryCountdown: false,
      includeSecondaryCountdown: false,
      percentageMode: 'remaining'
    }),
    '5H 60% | W 75%'
  );
});

test('nearly full remaining limits display as 100 percent', () => {
  const now = Date.parse('2026-05-20T10:00:00.000Z');
  const status = getProfileRateStatus(
    createProfile({
      observedAt: now - 10_000,
      sourceFile: USAGE_API_SOURCE,
      primary: {
        usedPercent: 0.6,
        resetAt: now + 60 * 60 * 1000,
        windowMinutes: 300
      },
      secondary: {
        usedPercent: 0.9,
        resetAt: now + 24 * 60 * 60 * 1000,
        windowMinutes: 10_080
      }
    }),
    now,
    ACTIVE_PROFILE_OPTIONS
  );

  assert.equal(getWindowRemainingPercent(status.primary, now), 100);
  assert.equal(getWindowRemainingPercent(status.secondary, now), 100);
  assert.equal(
    formatCompactRateSummary(status, now, {
      includePrimaryCountdown: false,
      includeSecondaryCountdown: false,
      percentageMode: 'remaining'
    }),
    '5H 100% | W 100%'
  );
});

test('active profile display ignores local session estimates', () => {
  const now = Date.parse('2026-05-20T10:00:00.000Z');
  const status = getProfileRateStatus(
    createProfile({
      observedAt: now - 10_000,
      sourceFile: 'C:/Users/example/.codex/sessions/rollout.jsonl',
      primary: {
        usedPercent: 99,
        resetAt: now + 60 * 60 * 1000,
        windowMinutes: 300
      },
      secondary: {
        usedPercent: 99,
        resetAt: now + 24 * 60 * 60 * 1000,
        windowMinutes: 10_080
      }
    }),
    now,
    ACTIVE_PROFILE_OPTIONS
  );

  assert.equal(status.hasFreshUsageApiData, false);
  assert.equal(status.isEstimatedRateLimitData, false);
  assert.equal(status.primary, null);
  assert.equal(status.secondary, null);
  assert.equal(
    formatCompactRateSummary(status, now, {
      includePrimaryCountdown: false,
      includeSecondaryCountdown: false,
      percentageMode: 'remaining'
    }),
    '5H n/a | W n/a'
  );
});

test('inactive profile display uses local session estimates', () => {
  const now = Date.parse('2026-05-20T10:00:00.000Z');
  const status = getProfileRateStatus(
    createProfile({
      observedAt: now - 10_000,
      sourceFile: 'C:/Users/example/.codex/sessions/rollout.jsonl',
      primary: {
        usedPercent: 70,
        resetAt: now + 60 * 60 * 1000,
        windowMinutes: 300
      },
      secondary: {
        usedPercent: 20,
        resetAt: now + 24 * 60 * 60 * 1000,
        windowMinutes: 10_080
      }
    }),
    now,
    INACTIVE_PROFILE_OPTIONS
  );

  assert.equal(status.hasFreshUsageApiData, false);
  assert.equal(status.isEstimatedRateLimitData, true);
  assert.equal(status.sourceType, 'localSessions');
  assert.equal(getWindowRemainingPercent(status.primary, now), 30);
  assert.equal(getWindowRemainingPercent(status.secondary, now), 80);
});

test('active profile display ignores stale Usage API observations', () => {
  const now = Date.parse('2026-05-20T10:00:00.000Z');
  const status = getProfileRateStatus(
    createProfile({
      observedAt: now - 61 * 60 * 1000,
      sourceFile: USAGE_API_SOURCE,
      primary: {
        usedPercent: 10,
        resetAt: now + 60 * 60 * 1000,
        windowMinutes: 300
      },
      secondary: {
        usedPercent: 10,
        resetAt: now + 24 * 60 * 60 * 1000,
        windowMinutes: 10_080
      }
    }),
    now,
    ACTIVE_PROFILE_OPTIONS
  );

  assert.equal(status.hasFreshUsageApiData, false);
  assert.equal(status.isEstimatedRateLimitData, false);
  assert.equal(status.primary, null);
  assert.equal(status.secondary, null);
});

test('inactive profile display keeps stale Usage API observations as estimates', () => {
  const now = Date.parse('2026-05-20T10:00:00.000Z');
  const status = getProfileRateStatus(
    createProfile({
      observedAt: now - 61 * 60 * 1000,
      sourceFile: USAGE_API_SOURCE,
      primary: {
        usedPercent: 10,
        resetAt: now + 60 * 60 * 1000,
        windowMinutes: 300
      },
      secondary: {
        usedPercent: 10,
        resetAt: now + 24 * 60 * 60 * 1000,
        windowMinutes: 10_080
      }
    }),
    now,
    INACTIVE_PROFILE_OPTIONS
  );

  assert.equal(status.hasFreshUsageApiData, false);
  assert.equal(status.isEstimatedRateLimitData, true);
  assert.equal(status.sourceType, 'usageApi');
  assert.equal(getWindowRemainingPercent(status.primary, now), 90);
  assert.equal(getWindowRemainingPercent(status.secondary, now), 90);
});

test('weekly zero remaining forces primary remaining to zero', () => {
  const now = Date.parse('2026-05-20T10:00:00.000Z');
  const status = getProfileRateStatus(
    createProfile({
      observedAt: now - 10_000,
      sourceFile: USAGE_API_SOURCE,
      primary: {
        usedPercent: 5,
        resetAt: now + 60 * 60 * 1000,
        windowMinutes: 300
      },
      secondary: {
        usedPercent: 100,
        resetAt: now + 24 * 60 * 60 * 1000,
        windowMinutes: 10_080
      }
    }),
    now,
    ACTIVE_PROFILE_OPTIONS
  );

  assert.equal(getWindowRemainingPercent(status.secondary, now), 0);
  assert.equal(getWindowRemainingPercent(status.primary, now), 0);
});
