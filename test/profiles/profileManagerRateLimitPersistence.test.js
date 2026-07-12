'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMockVscode, installMockVscode } = require('../helpers/mockVscode');

function loadProfileManager(storageDirectory) {
  const mock = createMockVscode({
    overrides: {
      EventEmitter: class EventEmitter {
        constructor() {
          this.event = () => ({ dispose() {} });
        }

        fire() {}

        dispose() {}
      },
      env: { remoteName: undefined },
      workspace: {
        getConfiguration: () => ({
          get: (key, fallback) => fallback
        })
      }
    }
  });
  const restore = installMockVscode(mock.vscode);
  delete require.cache[require.resolve('../../src/profiles/profileManager')];
  const { ProfileManager } = require('../../src/profiles/profileManager');
  restore();

  return new ProfileManager(
    {
      globalStorageUri: { fsPath: storageDirectory }
    },
    null
  );
}

function createProfile(id) {
  return {
    id,
    name: id,
    email: `${id}@example.com`,
    planType: 'plus',
    createdAt: '2026-07-11T10:00:00.000Z',
    updatedAt: '2026-07-11T10:00:00.000Z'
  };
}

function createObservation(timestamp, usedPercent) {
  return {
    recordTimestampMs: timestamp,
    filePath: 'https://chatgpt.com/backend-api/wham/usage',
    planType: 'plus',
    primary: {
      usedPercent,
      resetAt: timestamp + 60 * 60 * 1000,
      windowMinutes: 300
    },
    secondary: {
      usedPercent: usedPercent + 1,
      resetAt: timestamp + 24 * 60 * 60 * 1000,
      windowMinutes: 10_080
    }
  };
}

test('rate-limit updates for different profiles preserve each other', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-profile-limits-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const profilesPath = path.join(directory, 'profiles.json');
  fs.writeFileSync(
    profilesPath,
    JSON.stringify({ version: 2, profiles: [createProfile('profile-a'), createProfile('profile-b')] })
  );
  const firstManager = loadProfileManager(directory);
  const secondManager = loadProfileManager(directory);
  const timestamp = Date.now();

  await Promise.all([
    firstManager.recordRateLimitObservation('profile-a', createObservation(timestamp, 10)),
    secondManager.recordRateLimitObservation('profile-b', createObservation(timestamp + 1, 70))
  ]);

  const stored = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
  const first = stored.profiles.find((profile) => profile.id === 'profile-a');
  const second = stored.profiles.find((profile) => profile.id === 'profile-b');
  assert.equal(first.rateLimitState.primary.usedPercent, 10);
  assert.equal(second.rateLimitState.primary.usedPercent, 70);
});

test('an older completed request cannot replace a newer rate-limit observation', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-profile-order-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const profilesPath = path.join(directory, 'profiles.json');
  fs.writeFileSync(
    profilesPath,
    JSON.stringify({ version: 2, profiles: [createProfile('profile-a')] })
  );
  const manager = loadProfileManager(directory);
  const timestamp = Date.now();

  assert.equal(
    await manager.recordRateLimitObservation('profile-a', createObservation(timestamp, 20)),
    true
  );
  assert.equal(
    await manager.recordRateLimitObservation('profile-a', createObservation(timestamp - 10_000, 90)),
    false
  );

  const stored = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
  assert.equal(stored.profiles[0].rateLimitState.observedAt, timestamp);
  assert.equal(stored.profiles[0].rateLimitState.primary.usedPercent, 20);
});
