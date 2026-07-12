'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  formatCompactRateSummary,
  getProfileRateStatus,
  getWindowRemainingPercent
} = require('../../src/profiles/profileStatus');

const USAGE_API_SOURCE = 'https://chatgpt.com/backend-api/wham/usage';
const APP_SERVER_SOURCE = 'codex-app-server://account/rateLimits/read';

function createProfile(rateLimitState, overrides = {}) {
  return {
    id: 'profile-1',
    name: 'Profile 1',
    planType: overrides.planType || 'plus',
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

test('rate-limit display treats Codex app-server observations as fresh exact data', () => {
  const now = Date.parse('2026-05-20T10:00:00.000Z');
  const status = getProfileRateStatus(
    createProfile({
      observedAt: now - 10_000,
      sourceFile: APP_SERVER_SOURCE,
      primary: {
        usedPercent: 35,
        resetAt: now + 2 * 60 * 60 * 1000,
        windowMinutes: 300
      },
      secondary: {
        usedPercent: 20,
        resetAt: now + 3 * 24 * 60 * 60 * 1000,
        windowMinutes: 10_080
      }
    }),
    now,
    ACTIVE_PROFILE_OPTIONS
  );

  assert.equal(status.hasFreshUsageApiData, true);
  assert.equal(status.isEstimatedRateLimitData, false);
  assert.equal(status.sourceType, 'codexAppServer');
  assert.equal(getWindowRemainingPercent(status.primary, now), 65);
  assert.equal(getWindowRemainingPercent(status.secondary, now), 80);
});

test('compact rate summary shows weekly remaining limit and reset countdown', () => {
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

  assert.equal(
    formatCompactRateSummary(status, now, {
      includePrimaryCountdown: true,
      includeSecondaryCountdown: true,
      percentageMode: 'remaining'
    }),
    '5H 60% 1h | W 75% 1d'
  );
});

test('remaining limits do not hide a reported one-percent usage change', () => {
  const now = Date.parse('2026-05-20T10:00:00.000Z');
  const status = getProfileRateStatus(
    createProfile({
      observedAt: now - 10_000,
      sourceFile: USAGE_API_SOURCE,
      primary: {
        usedPercent: 1,
        resetAt: now + 60 * 60 * 1000,
        windowMinutes: 300
      },
      secondary: {
        usedPercent: 1,
        resetAt: now + 24 * 60 * 60 * 1000,
        windowMinutes: 10_080
      }
    }),
    now,
    ACTIVE_PROFILE_OPTIONS
  );

  assert.equal(getWindowRemainingPercent(status.primary, now), 99);
  assert.equal(getWindowRemainingPercent(status.secondary, now), 99);
  assert.equal(
    formatCompactRateSummary(status, now, {
      includePrimaryCountdown: false,
      includeSecondaryCountdown: false,
      percentageMode: 'remaining'
    }),
    '5H 99% | W 99%'
  );
});

test('weekly-only exact data is displayed in the weekly lane', () => {
  const now = Date.parse('2026-07-12T20:00:00.000Z');
  const status = getProfileRateStatus(
    createProfile({
      observedAt: now - 10_000,
      sourceFile: USAGE_API_SOURCE,
      primary: null,
      secondary: {
        usedPercent: 1,
        resetAt: now + 7 * 24 * 60 * 60 * 1000,
        windowMinutes: 10_080
      }
    }),
    now,
    ACTIVE_PROFILE_OPTIONS
  );

  assert.equal(
    formatCompactRateSummary(status, now, {
      includePrimaryCountdown: false,
      includeSecondaryCountdown: true,
      percentageMode: 'remaining'
    }),
    'W 99% 7d'
  );
});

test('free profile display uses primary limit window longer than five hours', () => {
  const now = Date.parse('2026-05-20T10:00:00.000Z');
  const status = getProfileRateStatus(
    createProfile(
      {
        observedAt: now - 10_000,
        sourceFile: USAGE_API_SOURCE,
        primary: {
          usedPercent: 35,
          resetAt: now + 24 * 60 * 60 * 1000,
          windowMinutes: 24 * 60
        },
        secondary: {
          usedPercent: 15,
          resetAt: now + 7 * 24 * 60 * 60 * 1000,
          windowMinutes: 10_080
        }
      },
      { planType: 'free' }
    ),
    now,
    ACTIVE_PROFILE_OPTIONS
  );

  assert.equal(
    formatCompactRateSummary(status, now, {
      includePrimaryCountdown: false,
      includeSecondaryCountdown: false,
      percentageMode: 'remaining'
    }),
    '1D 65% | W 85%'
  );
});

test('free profile display can derive primary limit window from reset time', () => {
  const now = Date.parse('2026-05-20T10:00:00.000Z');
  const status = getProfileRateStatus(
    createProfile(
      {
        observedAt: now - 10_000,
        sourceFile: USAGE_API_SOURCE,
        primary: {
          usedPercent: 45,
          resetAt: now + 9 * 60 * 60 * 1000,
          windowMinutes: 0
        },
        secondary: null
      },
      { planType: 'free' }
    ),
    now,
    ACTIVE_PROFILE_OPTIONS
  );

  assert.equal(
    formatCompactRateSummary(status, now, {
      includePrimaryCountdown: false,
      includeSecondaryCountdown: false,
      percentageMode: 'remaining'
    }),
    '9H 55%'
  );
});

test('free profile display prefers long reset time over generic five hour window', () => {
  const now = Date.parse('2026-05-20T10:00:00.000Z');
  const status = getProfileRateStatus(
    createProfile(
      {
        observedAt: now - 10_000,
        sourceFile: USAGE_API_SOURCE,
        primary: {
          usedPercent: 3,
          resetAt: now + 7 * 24 * 60 * 60 * 1000,
          windowMinutes: 300
        },
        secondary: null
      },
      { planType: 'free' }
    ),
    now,
    ACTIVE_PROFILE_OPTIONS
  );

  assert.equal(
    formatCompactRateSummary(status, now, {
      includePrimaryCountdown: true,
      includeSecondaryCountdown: false,
      percentageMode: 'remaining'
    }),
    '7D 97% 7d'
  );
});

test('free profile display rounds one-minute-short weekly reset label to seven days', () => {
  const now = Date.parse('2026-05-20T10:00:00.000Z');
  const status = getProfileRateStatus(
    createProfile(
      {
        observedAt: now - 10_000,
        sourceFile: USAGE_API_SOURCE,
        primary: {
          usedPercent: 3,
          resetAt: now + (7 * 24 * 60 - 1) * 60 * 1000,
          windowMinutes: 300
        },
        secondary: null
      },
      { planType: 'free' }
    ),
    now,
    ACTIVE_PROFILE_OPTIONS
  );

  assert.equal(
    formatCompactRateSummary(status, now, {
      includePrimaryCountdown: true,
      includeSecondaryCountdown: false,
      percentageMode: 'remaining'
    }),
    '7D 97% 6d 23h'
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

test('weekly remaining above one percent is not displayed as zero by default', () => {
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
        usedPercent: 96,
        resetAt: now + 24 * 60 * 60 * 1000,
        windowMinutes: 10_080
      }
    }),
    now,
    ACTIVE_PROFILE_OPTIONS
  );

  assert.equal(getWindowRemainingPercent(status.secondary, now), 4);
  assert.equal(
    getWindowRemainingPercent(status.secondary, now, { roundLowRemainingToZero: true }),
    4
  );
  assert.match(
    formatCompactRateSummary(status, now, {
      includePrimaryCountdown: true,
      includeSecondaryCountdown: true,
      percentageMode: 'remaining'
    }),
    /W 4%/
  );
  assert.match(
    formatCompactRateSummary(status, now, {
      includePrimaryCountdown: true,
      includeSecondaryCountdown: true,
      percentageMode: 'remaining',
      roundLowWeeklyRemainingToZero: true
    }),
    /W 4%/
  );
  assert.equal(
    getWindowRemainingPercent(status.secondary, now, {
      roundLowRemainingToZero: true,
      lowRemainingPercentThreshold: 5
    }),
    0
  );
  assert.match(
    formatCompactRateSummary(status, now, {
      includePrimaryCountdown: true,
      includeSecondaryCountdown: true,
      percentageMode: 'remaining',
      roundLowWeeklyRemainingToZero: true,
      lowRemainingPercentThreshold: 5
    }),
    /W 0%/
  );
});

test('weekly remaining below one percent can be displayed as zero', () => {
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
        usedPercent: 99.4,
        resetAt: now + 24 * 60 * 60 * 1000,
        windowMinutes: 10_080
      }
    }),
    now,
    ACTIVE_PROFILE_OPTIONS
  );

  assert.equal(getWindowRemainingPercent(status.secondary, now), 1);
  assert.equal(
    getWindowRemainingPercent(status.secondary, now, { roundLowRemainingToZero: true }),
    0
  );
  assert.match(
    formatCompactRateSummary(status, now, {
      includePrimaryCountdown: true,
      includeSecondaryCountdown: true,
      percentageMode: 'remaining'
    }),
    /W 1%/
  );
  assert.match(
    formatCompactRateSummary(status, now, {
      includePrimaryCountdown: true,
      includeSecondaryCountdown: true,
      percentageMode: 'remaining',
      roundLowWeeklyRemainingToZero: true
    }),
    /W 0%/
  );
});
