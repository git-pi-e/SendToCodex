'use strict';

const vscode = require('vscode');
const { areProfileFeaturesEnabled } = require('./featureFlags');
const { getUsageApiRateLimitData } = require('./rateLimitApiClient');
const { getRateLimitData } = require('./rateLimitParser');
const {
  getProfileRateStatus,
  getWindowRemainingPercent,
  isProfileWeeklyTokensLow,
  sortProfilesForDisplay
} = require('./profileStatus');
const { displayProfileName } = require('./privacy');

class RateLimitMonitor {
  constructor(profileManager, logger) {
    this.profileManager = profileManager;
    this.logger = logger;
    this.refreshTimer = undefined;
    this.isWindowFocused = true;
    this.lastError = null;
    this.lastObservation = null;
    this.lastRefreshResult = null;
    this.lastActiveProfileId = null;
    this.lastLowUsagePromptKey = null;
    this.sessionFileByProfileId = new Map();
    this.latestRefreshId = 0;
    this.onDidChangeEmitter = new vscode.EventEmitter();
    this.onDidChange = this.onDidChangeEmitter.event;
    this.disposables = [];
  }

  activate() {
    this.disposables.push(
      vscode.window.onDidChangeWindowState((event) => {
        this.setWindowFocused(event.focused);
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          !event.affectsConfiguration('codexRatelimit') &&
          !event.affectsConfiguration('codexSwitch.enabled') &&
          !event.affectsConfiguration('codexSwitch.lowUsageProfileSwitchBehavior') &&
          !event.affectsConfiguration('codexSwitch.lowUsageSwitchThreshold') &&
          !event.affectsConfiguration('codexSwitch.lowUsageSwitchFreshnessMinutes')
        ) {
          return;
        }

        if (event.affectsConfiguration('codexSwitch.enabled')) {
          if (areProfileFeaturesEnabled()) {
            this.startRefreshTimer();
            void this.refresh(true);
          } else {
            this.stopRefreshTimer();
            this.lastError = null;
            this.lastObservation = null;
            this.lastRefreshResult = {
              timestamp: Date.now(),
              source: 'profileFeatures',
              outcome: 'disabled'
            };
            this.lastActiveProfileId = null;
            this.onDidChangeEmitter.fire();
          }
          return;
        }

        if (event.affectsConfiguration('codexRatelimit.refreshInterval')) {
          this.startRefreshTimer();
          return;
        }

        void this.refresh(true);
      })
    );

    this.startRefreshTimer();
  }

  dispose() {
    this.stopRefreshTimer();
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
    this.onDidChangeEmitter.dispose();
  }

  getRefreshIntervalMs() {
    const intervalSeconds = Math.max(
      vscode.workspace.getConfiguration('codexRatelimit').get('refreshInterval', 10),
      5
    );
    return intervalSeconds * 1000;
  }

  getSessionPath() {
    return vscode.workspace.getConfiguration('codexRatelimit').get('sessionPath', '');
  }

  shouldUseUsageApi() {
    return vscode.workspace.getConfiguration('codexRatelimit').get('preferUsageApi', true);
  }

  getWorkspaceCwd() {
    const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    return folder ? folder.uri.fsPath : null;
  }

  normalizePlanType(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return normalized && normalized !== 'unknown' ? normalized : null;
  }

  shouldAcceptObservationForProfile(profile, observation) {
    if (!profile || !observation) {
      return false;
    }

    const profilePlanType = this.normalizePlanType(profile.planType);
    const observedPlanType = this.normalizePlanType(observation.planType);
    if (profilePlanType && observedPlanType && profilePlanType !== observedPlanType) {
      return false;
    }

    return true;
  }

  setWindowFocused(focused) {
    this.isWindowFocused = focused;
    if (focused) {
      this.startRefreshTimer();
      return;
    }
    this.stopRefreshTimer();
  }

  startRefreshTimer() {
    this.stopRefreshTimer();

    if (!this.isWindowFocused || !areProfileFeaturesEnabled()) {
      return;
    }

    void this.refresh(true);
    this.refreshTimer = setInterval(() => {
      if (this.isWindowFocused) {
        void this.refresh(false);
      }
    }, this.getRefreshIntervalMs());
  }

  stopRefreshTimer() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  getLastError() {
    return this.lastError;
  }

  getLastObservation() {
    return this.lastObservation;
  }

  getLastRefreshResult() {
    return this.lastRefreshResult;
  }

  setRefreshResult(result) {
    this.lastRefreshResult = {
      timestamp: Date.now(),
      ...result
    };
  }

  getLowUsageSwitchBehavior() {
    const behavior = vscode.workspace
      .getConfiguration('codexSwitch')
      .get('lowUsageProfileSwitchBehavior', 'ask');
    return behavior === 'auto' || behavior === 'off' ? behavior : 'ask';
  }

  getLowUsageSwitchThreshold() {
    const threshold = Number(
      vscode.workspace.getConfiguration('codexSwitch').get('lowUsageSwitchThreshold', 5)
    );
    if (!Number.isFinite(threshold)) {
      return 5;
    }
    return Math.max(0, Math.min(100, Math.round(threshold)));
  }

  getLowUsageSwitchFreshnessMs() {
    const minutes = Number(
      vscode.workspace
        .getConfiguration('codexSwitch')
        .get('lowUsageSwitchFreshnessMinutes', 60)
    );
    const normalizedMinutes = Number.isFinite(minutes) ? Math.max(1, minutes) : 60;
    return normalizedMinutes * 60 * 1000;
  }

  getKnownRemainingPercents(profile, now) {
    const status = getProfileRateStatus(profile, now);
    return [status.primary, status.secondary]
      .map((windowState) => getWindowRemainingPercent(windowState, now))
      .filter((value) => value >= 0);
  }

  isProfileLowOnUsage(profile, now, threshold) {
    const remainingPercents = this.getKnownRemainingPercents(profile, now);
    return remainingPercents.some((value) => value <= threshold);
  }

  isUsableSwitchCandidate(profile, now, threshold, freshnessMs) {
    if (!profile || !profile.rateLimitState || !profile.rateLimitState.observedAt) {
      return false;
    }

    if (now - Number(profile.rateLimitState.observedAt) > freshnessMs) {
      return false;
    }

    if (isProfileWeeklyTokensLow(profile, now)) {
      return false;
    }

    const remainingPercents = this.getKnownRemainingPercents(profile, now);
    return remainingPercents.length > 0 && remainingPercents.every((value) => value > threshold);
  }

  async maybeSuggestLowUsageSwitch(activeProfileId) {
    const behavior = this.getLowUsageSwitchBehavior();
    if (behavior === 'off' || !activeProfileId) {
      return;
    }

    try {
      const now = Date.now();
      const threshold = this.getLowUsageSwitchThreshold();
      const freshnessMs = this.getLowUsageSwitchFreshnessMs();
      const profiles = await this.profileManager.listProfiles();
      const activeProfile = profiles.find((profile) => profile.id === activeProfileId);
      if (!activeProfile || !this.isProfileLowOnUsage(activeProfile, now, threshold)) {
        return;
      }

      const candidates = sortProfilesForDisplay(
        profiles.filter((profile) => {
          return profile.id !== activeProfileId &&
            this.isUsableSwitchCandidate(profile, now, threshold, freshnessMs);
        }),
        undefined,
        now
      );
      const candidate = candidates[0];
      if (!candidate) {
        return;
      }

      const promptKey = `${behavior}:${activeProfileId}:${candidate.id}:${Math.floor(now / 3600000)}`;
      if (this.lastLowUsagePromptKey === promptKey) {
        return;
      }
      this.lastLowUsagePromptKey = promptKey;

      const switchLabel = `Switch to ${displayProfileName(candidate)}`;
      if (behavior === 'auto') {
        void vscode.window.showInformationMessage(
          `Codex profile "${displayProfileName(activeProfile)}" is low on usage. Switching to "${displayProfileName(candidate)}".`
        );
        await vscode.commands.executeCommand('codex-switch.profile.activate', candidate.id);
        return;
      }

      const selection = await vscode.window.showInformationMessage(
        `Codex profile "${displayProfileName(activeProfile)}" is at or below ${threshold}% remaining. A fresher profile is available.`,
        switchLabel
      );
      if (selection === switchLabel) {
        await vscode.commands.executeCommand('codex-switch.profile.activate', candidate.id);
      }
    } catch (error) {
      if (this.logger) {
        this.logger.warn('Failed to suggest a Codex profile switch for low usage.', {
          activeProfileId,
          error: error && error.message ? error.message : String(error)
        });
      }
    }
  }

  async refresh(force) {
    const refreshId = ++this.latestRefreshId;

    try {
      if (!areProfileFeaturesEnabled()) {
        this.lastActiveProfileId = null;
        this.lastError = null;
        this.lastObservation = null;
        this.setRefreshResult({
          source: 'profileFeatures',
          outcome: 'disabled',
          force: Boolean(force)
        });
        this.onDidChangeEmitter.fire();
        return;
      }

      await this.profileManager.clearExpiredCooldowns();
      const activeProfileId = await this.profileManager.getActiveProfileId();
      if (refreshId !== this.latestRefreshId) {
        return;
      }

      if (!activeProfileId) {
        this.lastActiveProfileId = null;
        this.lastError = null;
        this.lastObservation = null;
        this.setRefreshResult({
          source: 'profileStore',
          outcome: 'no-active-profile',
          force: Boolean(force)
        });
        this.onDidChangeEmitter.fire();
        return;
      }

      const activeProfile = await this.profileManager.getProfile(activeProfileId);
      if (refreshId !== this.latestRefreshId) {
        return;
      }

      if (!activeProfile) {
        this.lastActiveProfileId = null;
        this.lastError = 'Active profile could not be loaded';
        this.lastObservation = null;
        this.setRefreshResult({
          source: 'profileStore',
          outcome: 'error',
          profileId: activeProfileId,
          error: this.lastError,
          force: Boolean(force)
        });
        this.onDidChangeEmitter.fire();
        return;
      }

      if (this.lastActiveProfileId !== activeProfileId) {
        this.lastActiveProfileId = activeProfileId;
        this.lastObservation = null;
        const sourceFile =
          activeProfile.rateLimitState && activeProfile.rateLimitState.sourceFile
            ? activeProfile.rateLimitState.sourceFile
            : null;
        if (sourceFile) {
          this.sessionFileByProfileId.set(activeProfileId, sourceFile);
        }
      }

      let usageApiError = null;
      let recordedUsageApi = false;
      if (this.shouldUseUsageApi()) {
        const authData = await this.profileManager.loadAuthData(activeProfileId);
        if (refreshId !== this.latestRefreshId) {
          return;
        }

        if (authData) {
          const usageApiResult = await getUsageApiRateLimitData(authData, this.logger);
          if (refreshId !== this.latestRefreshId) {
            return;
          }

          if (
            usageApiResult.found &&
            usageApiResult.data &&
            this.shouldAcceptObservationForProfile(activeProfile, usageApiResult.data)
          ) {
            this.lastError = null;
            this.lastObservation = usageApiResult.data;
            await this.profileManager.recordRateLimitObservation(
              activeProfileId,
              usageApiResult.data
            );
            recordedUsageApi = true;
            this.setRefreshResult({
              source: 'usageApi',
              outcome: 'fresh',
              profileId: activeProfileId,
              sourceFile: usageApiResult.data.filePath || 'usage-api',
              force: Boolean(force)
            });
          }

          usageApiError =
            recordedUsageApi
              ? null
              : usageApiResult.error || 'Waiting for usage API data for the active profile';
        }
      }

      const activeSinceMs = await this.profileManager.getActiveProfileActivatedAt();
      const preferredFile =
        this.sessionFileByProfileId.get(activeProfileId) ||
        (activeProfile.rateLimitState && activeProfile.rateLimitState.sourceFile) ||
        null;
      const result = await getRateLimitData(this.getSessionPath(), this.logger, {
        preferredFile,
        activeSinceMs,
        workspaceCwd: this.getWorkspaceCwd(),
        expectedPlanType: activeProfile.planType
      });
      if (refreshId !== this.latestRefreshId) {
        return;
      }

      if (!result.found || !result.data) {
        if (recordedUsageApi) {
          this.lastError = null;
          this.onDidChangeEmitter.fire();
          void this.maybeSuggestLowUsageSwitch(activeProfileId);
          return;
        }

        this.lastError = usageApiError || result.error || 'No rate limit data found';
        this.lastObservation = null;
        this.setRefreshResult({
          source: 'localSessions',
          outcome: 'error',
          profileId: activeProfileId,
          error: this.lastError,
          usageApiError,
          force: Boolean(force)
        });
        this.onDidChangeEmitter.fire();
        return;
      }

      if (
        activeSinceMs &&
        result.data.recordTimestampMs &&
        result.data.recordTimestampMs + 2000 < activeSinceMs
      ) {
        if (recordedUsageApi) {
          this.lastError = null;
          this.onDidChangeEmitter.fire();
          void this.maybeSuggestLowUsageSwitch(activeProfileId);
          return;
        }

        this.lastError = 'Waiting for session data for the active profile';
        this.lastObservation = result.data;
        this.setRefreshResult({
          source: 'localSessions',
          outcome: 'stale',
          profileId: activeProfileId,
          sourceFile: result.data.filePath,
          error: this.lastError,
          force: Boolean(force)
        });
        this.onDidChangeEmitter.fire();
        return;
      }

      if (!this.shouldAcceptObservationForProfile(activeProfile, result.data)) {
        if (recordedUsageApi) {
          this.lastError = null;
          this.onDidChangeEmitter.fire();
          void this.maybeSuggestLowUsageSwitch(activeProfileId);
          return;
        }

        this.lastError = 'Waiting for rate-limit data for the active profile';
        this.lastObservation = null;
        this.setRefreshResult({
          source: 'localSessions',
          outcome: 'profile-mismatch',
          profileId: activeProfileId,
          sourceFile: result.data.filePath,
          error: this.lastError,
          force: Boolean(force)
        });
        this.onDidChangeEmitter.fire();
        return;
      }

      if (refreshId !== this.latestRefreshId) {
        return;
      }

      this.lastError = null;
      this.lastObservation = result.data;
      this.sessionFileByProfileId.set(activeProfileId, result.data.filePath);
      await this.profileManager.recordRateLimitObservation(activeProfileId, result.data);
      this.setRefreshResult({
        source: 'localSessions',
        outcome: 'fresh',
        profileId: activeProfileId,
        sourceFile: result.data.filePath,
        usageApiError,
        force: Boolean(force)
      });
      this.onDidChangeEmitter.fire();
      void this.maybeSuggestLowUsageSwitch(activeProfileId);
    } catch (error) {
      this.lastError = error && error.message ? error.message : String(error);
      this.setRefreshResult({
        source: 'monitor',
        outcome: 'error',
        error: this.lastError,
        force: Boolean(force)
      });
      this.onDidChangeEmitter.fire();
      if (this.logger) {
        this.logger.error('Failed to refresh Codex rate-limit data.', {
          error: this.lastError,
          force: Boolean(force)
        });
      }
    }
  }
}

module.exports = {
  RateLimitMonitor
};
