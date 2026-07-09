'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMockVscode, installMockVscode } = require('../helpers/mockVscode');

function loadQuickPickSettings(values = {}) {
  const mock = createMockVscode({
    overrides: {
      workspace: {
        getConfiguration: () => ({
          get: (key, fallback) => Object.prototype.hasOwnProperty.call(values, key)
            ? values[key]
            : fallback
        })
      }
    }
  });
  const restore = installMockVscode(mock.vscode);
  try {
    delete require.cache[require.resolve('../../src/profiles/quickPickSettings')];
    return require('../../src/profiles/quickPickSettings');
  } finally {
    restore();
  }
}

function createItem(overrides) {
  return {
    profileDisplayName: overrides.name,
    planText: overrides.planText || 'PLUS',
    profileGroup: overrides.profileGroup || 'Work',
    quickPickSortIndex: overrides.quickPickSortIndex || 0,
    weeklyRemainingPercent: overrides.weeklyRemainingPercent,
    weeklyResetAt: overrides.weeklyResetAt,
    primaryResetAt: overrides.primaryResetAt || null,
    nextResetAt: overrides.nextResetAt || null,
    observedAt: overrides.observedAt || null,
    primaryRemainingPercent: overrides.primaryRemainingPercent ?? 50,
    lowestRemainingPercent: overrides.lowestRemainingPercent ?? 50
  };
}

test('secondary profile sort applies only when the primary sort value is equal', () => {
  const { sortProfileQuickPickItems } = loadQuickPickSettings();
  const now = Date.parse('2026-07-08T10:00:00.000Z');
  const items = [
    createItem({
      name: 'Pro early weekly reset',
      planText: 'PRO',
      weeklyRemainingPercent: 60,
      weeklyResetAt: now + 5 * 60 * 1000
    }),
    createItem({
      name: 'Free later weekly reset',
      planText: 'FREE',
      weeklyRemainingPercent: 60,
      weeklyResetAt: now + 60 * 60 * 1000
    })
  ];

  const sorted = sortProfileQuickPickItems(items, 'plan', 'weeklyResetSoon');

  assert.deepEqual(
    sorted.map((item) => item.profileDisplayName),
    ['Free later weekly reset', 'Pro early weekly reset']
  );
});

test('weekly reset secondary sort ignores accounts with zero weekly remaining', () => {
  const { sortProfileQuickPickItems } = loadQuickPickSettings();
  const now = Date.parse('2026-07-08T10:00:00.000Z');
  const items = [
    createItem({
      name: 'A zero weekly remaining',
      planText: 'PLUS',
      weeklyRemainingPercent: 0,
      weeklyResetAt: now + 60 * 1000
    }),
    createItem({
      name: 'C nonzero later weekly reset',
      planText: 'PLUS',
      weeklyRemainingPercent: 50,
      weeklyResetAt: now + 60 * 60 * 1000
    }),
    createItem({
      name: 'B nonzero earlier weekly reset',
      planText: 'PLUS',
      weeklyRemainingPercent: 50,
      weeklyResetAt: now + 5 * 60 * 1000
    })
  ];

  const sorted = sortProfileQuickPickItems(items, 'plan', 'weeklyResetSoon');

  assert.deepEqual(
    sorted.map((item) => item.profileDisplayName),
    [
      'B nonzero earlier weekly reset',
      'C nonzero later weekly reset',
      'A zero weekly remaining'
    ]
  );
});

test('account switcher settings default to weekly reset as the secondary sort', () => {
  const { getProfileQuickPickSettings } = loadQuickPickSettings();

  assert.equal(getProfileQuickPickSettings().secondaryProfileSort, 'weeklyResetSoon');
});

test('account switcher settings default weekly zero threshold to one percent', () => {
  const {
    formatLowRemainingPercentThreshold,
    getProfileQuickPickSettings
  } = loadQuickPickSettings();
  const settings = getProfileQuickPickSettings();

  assert.equal(settings.lowWeeklyRemainingZeroThreshold, 1);
  assert.equal(formatLowRemainingPercentThreshold(settings.lowWeeklyRemainingZeroThreshold), '1');
});

test('account switcher settings read custom weekly zero threshold', () => {
  const {
    formatLowRemainingPercentThreshold,
    getProfileQuickPickSettings
  } = loadQuickPickSettings({
    'profileQuickPick.lowWeeklyRemainingZeroThreshold': 2.5
  });
  const settings = getProfileQuickPickSettings();

  assert.equal(settings.lowWeeklyRemainingZeroThreshold, 2.5);
  assert.equal(formatLowRemainingPercentThreshold(settings.lowWeeklyRemainingZeroThreshold), '2.5');
});
