'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMockVscode, installMockVscode } = require('../helpers/mockVscode');

function loadRateLimitMonitor() {
  const mock = createMockVscode({
    overrides: {
      EventEmitter: class EventEmitter {
        constructor() {
          this.event = () => ({ dispose() {} });
        }

        fire() {}

        dispose() {}
      }
    }
  });
  const restore = installMockVscode(mock.vscode);
  delete require.cache[require.resolve('../../src/profiles/rateLimitMonitor')];
  const { RateLimitMonitor } = require('../../src/profiles/rateLimitMonitor');
  restore();
  return RateLimitMonitor;
}

test('Usage API observations can update a stale saved profile plan', () => {
  const RateLimitMonitor = loadRateLimitMonitor();
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
