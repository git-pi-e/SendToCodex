'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMockVscode, installMockVscode } = require('../helpers/mockVscode');

const USAGE_API_SOURCE = 'https://chatgpt.com/backend-api/wham/usage';

function createStateBucket() {
  const values = new Map();
  return {
    values,
    get: (key) => values.get(key),
    update: async (key, value) => {
      if (value === undefined) {
        values.delete(key);
      } else {
        values.set(key, value);
      }
    }
  };
}

function createWorkspaceConfig(initialValues = {}) {
  const values = new Map(Object.entries({
    'codexSwitch.lowUsageProfileSwitchBehavior': 'ask',
    'codexSwitch.lowUsageSwitchThreshold': 5,
    'codexSwitch.lowUsageSwitchFreshnessMinutes': 60,
    ...initialValues
  }));

  return {
    values,
    getConfiguration: (section) => ({
      get: (key, fallback) => {
        const fullKey = `${section}.${key}`;
        return values.has(fullKey) ? values.get(fullKey) : fallback;
      },
      update: async (key, value) => {
        values.set(`${section}.${key}`, value);
      }
    })
  };
}

function createRateLimitProfile(id, primaryRemaining, weeklyRemaining, now) {
  return {
    id,
    name: id,
    planType: 'plus',
    rateLimitState: {
      observedAt: now - 1000,
      sourceFile: USAGE_API_SOURCE,
      primary: {
        usedPercent: 100 - primaryRemaining,
        resetAt: now + 60 * 60 * 1000,
        windowMinutes: 300
      },
      secondary: {
        usedPercent: 100 - weeklyRemaining,
        resetAt: now + 24 * 60 * 60 * 1000,
        windowMinutes: 10080
      }
    }
  };
}

function loadRateLimitMonitor(options = {}) {
  const workspaceConfig = options.workspaceConfig || createWorkspaceConfig();
  const mock = createMockVscode({
    overrides: {
      EventEmitter: class EventEmitter {
        constructor() {
          this.event = () => ({ dispose() {} });
        }

        fire() {}

        dispose() {}
      },
      workspace: {
        getConfiguration: workspaceConfig.getConfiguration
      },
      window: {
        showInformationMessage: async () => undefined,
        showQuickPick: async (items, quickPickOptions) => {
          mock.quickPickCalls.push({ items, options: quickPickOptions });
          return options.quickPickSelection
            ? options.quickPickSelection(items, quickPickOptions)
            : undefined;
        }
      }
    }
  });
  const restore = installMockVscode(mock.vscode);
  delete require.cache[require.resolve('../../src/profiles/rateLimitMonitor')];
  const { RateLimitMonitor } = require('../../src/profiles/rateLimitMonitor');
  restore();
  return { RateLimitMonitor, mock, workspaceConfig };
}

test('Usage API observations can update a stale saved profile plan', () => {
  const { RateLimitMonitor } = loadRateLimitMonitor();
  const monitor = new RateLimitMonitor({}, null);
  const profile = {
    id: 'profile-1',
    planType: 'plus'
  };
  const observation = {
    planType: 'free'
  };

  assert.equal(monitor.shouldAcceptObservationForProfile(profile, observation), false);
  assert.equal(
    monitor.shouldAcceptObservationForProfile(profile, observation, {
      acceptPlanChange: true
    }),
    true
  );
});

test('low-usage switch prompt ignores weekly-only low usage', async () => {
  const now = Date.now();
  const { RateLimitMonitor, mock } = loadRateLimitMonitor();
  const profiles = [
    createRateLimitProfile('active-profile', 80, 0.5, now),
    createRateLimitProfile('candidate-profile', 80, 80, now)
  ];
  const monitor = new RateLimitMonitor({
    context: { globalState: createStateBucket() },
    listProfiles: async () => profiles
  }, null);

  await monitor.maybeSuggestLowUsageSwitch('active-profile');

  assert.equal(mock.quickPickCalls.length, 0);
  assert.deepEqual(mock.commandCalls, []);
});

test('low-usage switch prompt is rate-limited after dismissal', async () => {
  const now = Date.now();
  const { RateLimitMonitor, mock } = loadRateLimitMonitor({
    quickPickSelection: () => []
  });
  const profiles = [
    createRateLimitProfile('active-profile', 4, 80, now),
    createRateLimitProfile('candidate-profile', 80, 80, now)
  ];
  const monitor = new RateLimitMonitor({
    context: { globalState: createStateBucket() },
    listProfiles: async () => profiles
  }, null);

  await monitor.maybeSuggestLowUsageSwitch('active-profile');
  await monitor.maybeSuggestLowUsageSwitch('active-profile');

  assert.equal(mock.quickPickCalls.length, 1);
  assert.deepEqual(mock.commandCalls, []);
});

test('low-usage switch prompt checkbox can disable future prompts', async () => {
  const now = Date.now();
  const workspaceConfig = createWorkspaceConfig();
  const { RateLimitMonitor, mock } = loadRateLimitMonitor({
    workspaceConfig,
    quickPickSelection: (items) => [items.find((item) => item.id === 'disable')]
  });
  const profiles = [
    createRateLimitProfile('active-profile', 4, 80, now),
    createRateLimitProfile('candidate-profile', 80, 80, now)
  ];
  const monitor = new RateLimitMonitor({
    context: { globalState: createStateBucket() },
    listProfiles: async () => profiles
  }, null);

  await monitor.maybeSuggestLowUsageSwitch('active-profile');
  await monitor.maybeSuggestLowUsageSwitch('active-profile');

  assert.equal(mock.quickPickCalls.length, 1);
  assert.equal(
    workspaceConfig.values.get('codexSwitch.lowUsageProfileSwitchBehavior'),
    'off'
  );
  assert.equal(mock.quickPickCalls[0].options.canPickMany, true);
  assert.deepEqual(mock.commandCalls, []);
});
