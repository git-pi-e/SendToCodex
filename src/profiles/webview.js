'use strict';

const vscode = require('vscode');
const {
  formatAbsoluteTimestamp,
  formatResetText,
  getProfileRateStatus,
  getWindowLabel,
  isProfileWeeklyTokensLow,
  normalizeLowRemainingPercentThreshold,
  sortProfilesForDisplay
} = require('./profileStatus');
const { formatTokenUsage } = require('./rateLimitParser');
const { displayProfileEmail, displayProfileName } = require('./privacy');
const {
  PROFILE_QUICK_PICK_SECTIONS,
  PROFILE_QUICK_PICK_SECONDARY_SORT_OPTIONS,
  PROFILE_QUICK_PICK_SORT_OPTIONS,
  formatLowRemainingPercentThreshold,
  getProfileQuickPickSectionLabel,
  getProfileQuickPickSettings,
  isProfileQuickPickSectionVisible,
  normalizeHiddenSections,
  normalizeSecondaryProfileSort,
  normalizeProfileSort,
  normalizeSectionOrder
} = require('./quickPickSettings');

const UNGROUPED_PROFILE_GROUP = 'Ungrouped';
const CUSTOM_GROUP_VALUE = '__custom_group__';
const DEFAULT_PROFILE_GROUPS = [
  'Personal',
  'Work',
  'Pro',
  'Free',
  'Backup',
  'Test',
  'Broken',
  'Disposable',
  UNGROUPED_PROFILE_GROUP
];

const WEBVIEW_COMMANDS = {
  addCurrent: 'codex-switch.profile.addFromCodexAuthFile',
  addFromFile: 'codex-switch.profile.addFromFile',
  doctor: 'codex-switch.profile.doctor',
  exportProfiles: 'codex-switch.profile.exportSettings',
  importProfiles: 'codex-switch.profile.importSettings',
  login: 'codex-switch.profile.login',
  refreshStats: 'codex-ratelimit.refreshStats',
  restoreBackup: 'codex-switch.profile.restoreAuthBackup',
  restoreStrategy: 'codex-switch.profile.restoreStrategy',
  settings: 'codex-ratelimit.openSettings',
  switchProfile: 'codex-switch.profile.switch'
};

function asNonEmptyString(value) {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();
  return normalized ? normalized : undefined;
}

function normalizeProfileGroup(value) {
  return asNonEmptyString(value) || UNGROUPED_PROFILE_GROUP;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeScriptJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function getErrorMessage(error) {
  return error && error.message ? error.message : String(error);
}

function formatRefreshResult(result) {
  if (!result) {
    return 'n/a';
  }

  const parts = [`${result.source || 'unknown'} / ${result.outcome || 'unknown'}`];
  if (result.sourceFile) {
    parts.push(String(result.sourceFile));
  }
  if (result.error) {
    parts.push(String(result.error));
  }
  if (result.timestamp) {
    parts.push(new Date(result.timestamp).toLocaleString());
  }
  return parts.join(' - ');
}

function hasRequiredStoredTokens(tokens) {
  if (!tokens || typeof tokens !== 'object') {
    return false;
  }

  return ['idToken', 'accessToken', 'refreshToken'].every((key) => {
    return typeof tokens[key] === 'string' && tokens[key].trim();
  });
}

function formatWindowRemaining(windowState, now) {
  if (!windowState) {
    return 'n/a';
  }

  if (!windowState.resetAt || windowState.resetAt <= now) {
    return '100%';
  }

  const remaining = Math.max(0, Math.min(100, 100 - Number(windowState.usedPercent || 0)));
  return `${Math.round(remaining)}%`;
}

function formatWindowCell(windowState, now) {
  if (!windowState) {
    return 'n/a';
  }

  return `${formatWindowRemaining(windowState, now)} - ${formatResetText(
    windowState.resetAt,
    now
  )}`;
}

function getOperationalStatus(profile, status, authState, weeklyTokensLow, activeProfileId) {
  if (authState.hasIssue) {
    return 'Auth required';
  }

  if (profile.id === activeProfileId) {
    return 'Active';
  }

  if (weeklyTokensLow) {
    return 'Weekly low';
  }

  if (status.cooldownActive) {
    return 'Cooling down';
  }

  if (!status.observedAt) {
    return 'No data';
  }

  if (status.isEstimatedRateLimitData) {
    return 'Stale / estimate';
  }

  return 'Ready';
}

function isProblemAccount(viewModel) {
  return Boolean(
    viewModel.authIssue ||
      viewModel.weeklyLow ||
      viewModel.operationalStatus === 'Cooling down' ||
      viewModel.operationalStatus === 'No data' ||
      viewModel.operationalStatus === 'Stale / estimate'
  );
}

function sortUniqueStrings(values) {
  return [...new Set(values.map((value) => normalizeProfileGroup(value)))]
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
}

class RateLimitDetailsPanel {
  static createOrShow(extensionUri, profileManager, rateLimitMonitor) {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : vscode.ViewColumn.One;

    if (RateLimitDetailsPanel.currentPanel) {
      RateLimitDetailsPanel.currentPanel.panel.reveal(column);
      void RateLimitDetailsPanel.currentPanel.update();
      return RateLimitDetailsPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      'codexRateLimitDetails',
      'Codex Accounts',
      column || vscode.ViewColumn.One,
      { enableScripts: true, localResourceRoots: [extensionUri] }
    );

    RateLimitDetailsPanel.currentPanel = new RateLimitDetailsPanel(
      panel,
      profileManager,
      rateLimitMonitor
    );
    return RateLimitDetailsPanel.currentPanel;
  }

  constructor(panel, profileManager, rateLimitMonitor) {
    this.panel = panel;
    this.profileManager = profileManager;
    this.rateLimitMonitor = rateLimitMonitor;
    this.disposables = [];

    this.disposables.push(
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage((message) => {
        void this.handleMessage(message);
      }),
      this.profileManager.onDidChange(() => {
        void this.update();
      }),
      this.rateLimitMonitor.onDidChange(() => {
        void this.update();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration('codexSwitch.profileQuickPick.hiddenSections') ||
          event.affectsConfiguration('codexSwitch.profileQuickPick.sectionOrder') ||
          event.affectsConfiguration('codexSwitch.profileQuickPick.profileSort') ||
          event.affectsConfiguration('codexSwitch.profileQuickPick.secondaryProfileSort') ||
          event.affectsConfiguration('codexSwitch.profileQuickPick.roundLowWeeklyRemainingToZero') ||
          event.affectsConfiguration('codexSwitch.profileQuickPick.lowWeeklyRemainingZeroThreshold')
        ) {
          void this.update();
        }
      })
    );

    void this.update();
  }

  dispose() {
    RateLimitDetailsPanel.currentPanel = undefined;
    while (this.disposables.length > 0) {
      const disposable = this.disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }

  log(level, message, data) {
    if (this.profileManager.logger && typeof this.profileManager.logger[level] === 'function') {
      this.profileManager.logger[level](message, data);
    }
  }

  reportOperationError(operation, error) {
    const message = getErrorMessage(error);
    this.log('error', `Codex Accounts: ${operation} failed.`, { error: message });
    void vscode.window.showErrorMessage(`Codex Accounts: ${operation} failed: ${message}`);
  }

  async handleMessage(message) {
    try {
      await this.dispatchMessage(message);
    } catch (error) {
      this.reportOperationError('webview action', error);
      await this.update();
    }
  }

  async dispatchMessage(message) {
    if (!message || typeof message !== 'object') {
      throw new Error('Received an invalid Codex Accounts webview message.');
    }

    switch (message.command) {
      case 'refresh':
        await this.rateLimitMonitor.refresh(true);
        await this.update();
        return;
      case 'openCommand':
        await this.runWhitelistedCommand(message.action);
        await this.update();
        return;
      case 'activateProfile':
        await this.ensureProfileExists(message.profileId);
        await vscode.commands.executeCommand('codex-switch.profile.activate', message.profileId);
        await this.update();
        return;
      case 'reauthenticateProfile':
        await this.ensureProfileExists(message.profileId);
        await vscode.commands.executeCommand(
          'codex-switch.profile.reauthenticate',
          message.profileId
        );
        await this.update();
        return;
      case 'renameProfile':
        await this.renameProfile(message.profileId);
        return;
      case 'setProfileGroup':
        await this.setProfileGroupForProfiles([message.profileId], message.group);
        return;
      case 'promptProfileGroup':
        await this.promptProfileGroup([message.profileId]);
        return;
      case 'promptSelectedGroup':
        await this.promptProfileGroup(message.profileIds);
        return;
      case 'deleteProfile':
        await this.deleteProfiles([message.profileId]);
        return;
      case 'deleteSelectedProfiles':
        await this.deleteProfiles(message.profileIds);
        return;
      case 'setQuickPickSectionVisibility':
        await this.setQuickPickSectionVisibility(message.sectionId, message.visible);
        return;
      case 'moveQuickPickSection':
        await this.moveQuickPickSection(message.sectionId, message.direction);
        return;
      case 'setQuickPickProfileSort':
        await this.setQuickPickProfileSort(message.sortMode);
        return;
      case 'setQuickPickSecondaryProfileSort':
        await this.setQuickPickSecondaryProfileSort(message.sortMode);
        return;
      case 'setRoundLowWeeklyRemainingToZero':
        await this.setRoundLowWeeklyRemainingToZero(message.enabled);
        return;
      case 'setLowWeeklyRemainingZeroThreshold':
        await this.setLowWeeklyRemainingZeroThreshold(message.threshold);
        return;
      default:
        throw new Error(`Unsupported Codex Accounts webview command: ${message.command}`);
    }
  }

  async updateCodexSwitchConfiguration(key, value) {
    await vscode.workspace
      .getConfiguration('codexSwitch')
      .update(key, value, vscode.ConfigurationTarget.Global);
  }

  async setQuickPickSectionVisibility(sectionId, visible) {
    const knownSectionIds = PROFILE_QUICK_PICK_SECTIONS.map((section) => section.id);
    if (!knownSectionIds.includes(sectionId)) {
      throw new Error(`Unsupported account switcher group: ${sectionId}`);
    }

    const settings = getProfileQuickPickSettings();
    const hiddenSections = new Set(settings.hiddenSections);
    if (visible === true) {
      hiddenSections.delete(sectionId);
    } else {
      hiddenSections.add(sectionId);
    }

    await this.updateCodexSwitchConfiguration(
      'profileQuickPick.hiddenSections',
      normalizeHiddenSections([...hiddenSections])
    );
    await this.update();
  }

  async moveQuickPickSection(sectionId, direction) {
    const settings = getProfileQuickPickSettings();
    const sectionOrder = normalizeSectionOrder(settings.sectionOrder);
    const index = sectionOrder.indexOf(sectionId);
    if (index === -1) {
      throw new Error(`Unsupported account switcher group: ${sectionId}`);
    }

    const delta = direction === 'up' ? -1 : direction === 'down' ? 1 : 0;
    if (!delta) {
      throw new Error(`Unsupported account switcher group move direction: ${direction}`);
    }

    const nextIndex = index + delta;
    if (nextIndex < 0 || nextIndex >= sectionOrder.length) {
      return;
    }

    const nextOrder = [...sectionOrder];
    const [item] = nextOrder.splice(index, 1);
    nextOrder.splice(nextIndex, 0, item);
    await this.updateCodexSwitchConfiguration('profileQuickPick.sectionOrder', nextOrder);
    await this.update();
  }

  async setQuickPickProfileSort(sortMode) {
    const normalized = normalizeProfileSort(sortMode);
    await this.updateCodexSwitchConfiguration('profileQuickPick.profileSort', normalized);
    await this.update();
  }

  async setQuickPickSecondaryProfileSort(sortMode) {
    const normalized = normalizeSecondaryProfileSort(sortMode);
    await this.updateCodexSwitchConfiguration(
      'profileQuickPick.secondaryProfileSort',
      normalized
    );
    await this.update();
  }

  async setRoundLowWeeklyRemainingToZero(enabled) {
    await this.updateCodexSwitchConfiguration(
      'profileQuickPick.roundLowWeeklyRemainingToZero',
      enabled === true
    );
    await this.update();
  }

  async setLowWeeklyRemainingZeroThreshold(threshold) {
    await this.updateCodexSwitchConfiguration(
      'profileQuickPick.lowWeeklyRemainingZeroThreshold',
      normalizeLowRemainingPercentThreshold(threshold)
    );
    await this.update();
  }

  async runWhitelistedCommand(action) {
    const command = WEBVIEW_COMMANDS[action];
    if (!command) {
      throw new Error(`Unsupported Codex Accounts action: ${action}`);
    }

    await vscode.commands.executeCommand(command);
  }

  async ensureProfileExists(profileId) {
    const normalizedProfileId = asNonEmptyString(profileId);
    if (!normalizedProfileId) {
      throw new Error('Profile id is required.');
    }

    const profile = await this.profileManager.getProfile(normalizedProfileId);
    if (!profile) {
      throw new Error('The selected Codex profile no longer exists.');
    }

    return profile;
  }

  async getProfilesByIds(profileIds) {
    const ids = [...new Set((profileIds || []).map(asNonEmptyString).filter(Boolean))];
    if (!ids.length) {
      throw new Error('No Codex profiles were selected.');
    }

    const profiles = await this.profileManager.listProfiles();
    const byId = new Map(profiles.map((profile) => [profile.id, profile]));
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length) {
      throw new Error(`Selected Codex profile no longer exists: ${missing.join(', ')}`);
    }

    return ids.map((id) => byId.get(id));
  }

  async renameProfile(profileId) {
    const profile = await this.ensureProfileExists(profileId);
    const nextName = await vscode.window.showInputBox({
      prompt: 'New profile name',
      value: profile.name || '',
      validateInput: (value) => (asNonEmptyString(value) ? null : 'Profile name is required.')
    });

    if (nextName === undefined) {
      return;
    }

    const normalizedName = asNonEmptyString(nextName);
    if (!normalizedName) {
      throw new Error('Profile name is required.');
    }

    const updated = await this.profileManager.renameProfile(profile.id, normalizedName);
    if (!updated) {
      throw new Error(`Failed to rename profile "${displayProfileName(profile)}".`);
    }

    await this.profileManager.appendProfileActivity('renameProfile', {
      profileId: profile.id,
      oldName: profile.name,
      newName: normalizedName
    });
    void vscode.window.showInformationMessage(
      `Renamed Codex profile "${displayProfileName({ ...profile, name: normalizedName })}".`
    );
    await this.update();
  }

  getProfileGroupChoices(profiles) {
    return sortUniqueStrings([
      ...DEFAULT_PROFILE_GROUPS,
      ...profiles.map((profile) => profile.group)
    ]);
  }

  async promptProfileGroup(profileIds) {
    const selectedProfiles = await this.getProfilesByIds(profileIds);
    const allProfiles = await this.profileManager.listProfiles();
    const groupChoices = this.getProfileGroupChoices(allProfiles);

    const customLabel = 'Custom group...';
    const pick = await vscode.window.showQuickPick(
      [
        ...groupChoices.map((group) => ({
          label: selectedProfiles.every((profile) => normalizeProfileGroup(profile.group) === group)
            ? `$(check) ${group}`
            : group,
          group
        })),
        {
          label: customLabel,
          group: CUSTOM_GROUP_VALUE
        }
      ],
      {
        placeHolder:
          selectedProfiles.length === 1
            ? 'Set account group'
            : `Set group for ${selectedProfiles.length} accounts`
      }
    );

    if (!pick) {
      await this.update();
      return;
    }

    let group = pick.group;
    if (group === CUSTOM_GROUP_VALUE) {
      const value = await vscode.window.showInputBox({
        prompt: 'Group name',
        validateInput: (inputValue) => (asNonEmptyString(inputValue) ? null : 'Group name is required.')
      });
      if (value === undefined) {
        await this.update();
        return;
      }
      group = value;
    }

    await this.setProfileGroupForProfiles(
      selectedProfiles.map((profile) => profile.id),
      group
    );
  }

  async setProfileGroupForProfiles(profileIds, groupName) {
    const group = normalizeProfileGroup(groupName);
    const selectedProfiles = await this.getProfilesByIds(profileIds);

    for (const profile of selectedProfiles) {
      const updated = await this.profileManager.setProfileGroup(profile.id, group);
      if (!updated) {
        throw new Error(`Failed to set group for profile "${displayProfileName(profile)}".`);
      }
      await this.profileManager.appendProfileActivity('setProfileGroup', {
        profileId: profile.id,
        name: profile.name,
        group
      });
    }

    void vscode.window.showInformationMessage(
      selectedProfiles.length === 1
        ? `Moved "${displayProfileName(selectedProfiles[0])}" to group "${group}".`
        : `Moved ${selectedProfiles.length} Codex profiles to group "${group}".`
    );
    await this.update();
  }

  async deleteProfiles(profileIds) {
    const selectedProfiles = await this.getProfilesByIds(profileIds);
    const names = selectedProfiles.map((profile) => displayProfileName(profile));
    const deleteLabel =
      selectedProfiles.length === 1
        ? 'Delete account'
        : `Delete ${selectedProfiles.length} accounts`;
    const confirm = await vscode.window.showWarningMessage(
      `Delete ${selectedProfiles.length} Codex profile(s)? This removes profile metadata and stored tokens. It does not delete the current ~/.codex/auth.json.\n\n${names.join('\n')}`,
      { modal: true },
      deleteLabel
    );

    if (confirm !== deleteLabel) {
      return;
    }

    if (selectedProfiles.length > 1) {
      const expected = `DELETE ${selectedProfiles.length} ACCOUNTS`;
      const typed = await vscode.window.showInputBox({
        prompt: `Type ${expected} to confirm bulk deletion`
      });
      if (typed === undefined) {
        return;
      }
      if (typed !== expected) {
        throw new Error('Bulk deletion confirmation did not match.');
      }
    }

    for (const profile of selectedProfiles) {
      const deleted = await this.profileManager.deleteProfile(profile.id);
      if (!deleted) {
        throw new Error(`Failed to delete profile "${displayProfileName(profile)}".`);
      }
      await this.profileManager.appendProfileActivity('deleteProfile', {
        profileId: profile.id,
        name: profile.name,
        group: profile.group
      });
    }

    void vscode.window.showInformationMessage(
      selectedProfiles.length === 1
        ? `Deleted Codex profile "${names[0]}".`
        : `Deleted ${selectedProfiles.length} Codex profiles.`
    );
    await this.update();
  }

  renderWindow(windowState, fallbackLabel, now) {
    if (!windowState) {
      return '';
    }

    const label = getWindowLabel(windowState, fallbackLabel);
    const status = windowState.resetAt ? formatResetText(windowState.resetAt, now) : 'Ready';
    const resetAt = windowState.resetAt ? formatAbsoluteTimestamp(windowState.resetAt) : 'n/a';

    return `
      <div class="window-card">
        <div class="window-title">${escapeHtml(label)}</div>
        <div class="window-line"><strong>Usage:</strong> ${windowState.usedPercent.toFixed(1)}%</div>
        <div class="window-line"><strong>Status:</strong> ${escapeHtml(status)}</div>
        <div class="window-line"><strong>Reset at:</strong> ${escapeHtml(resetAt)}</div>
      </div>
    `;
  }

  async buildProfileViewModels(profiles, activeProfileId, now) {
    const quickPickSettings = getProfileQuickPickSettings();
    const lowWeeklyOptions = {
      activeProfileId,
      lowRemainingPercentThreshold: quickPickSettings.lowWeeklyRemainingZeroThreshold
    };
    const sortedProfiles = sortProfilesForDisplay(profiles, activeProfileId, now, lowWeeklyOptions);

    return Promise.all(sortedProfiles.map(async (profile, index) => {
      const status = getProfileRateStatus(profile, now, { activeProfileId });
      const weeklyTokensLow = isProfileWeeklyTokensLow(profile, now, lowWeeklyOptions);
      const tokens = await this.profileManager.readStoredTokens(profile.id);
      const authState = hasRequiredStoredTokens(tokens)
        ? {
            hasIssue: false,
            description: 'Stored'
          }
        : {
            hasIssue: true,
            description: tokens ? 'Auth issue' : 'Auth required'
          };
      const operationalStatus = getOperationalStatus(
        profile,
        status,
        authState,
        weeklyTokensLow,
        activeProfileId
      );
      const viewModel = {
        id: profile.id,
        index,
        name: displayProfileName(profile),
        rawName: profile.name || '',
        email: displayProfileEmail(profile.email || 'Unknown'),
        plan: status.planText || 'Unknown',
        profileGroup: normalizeProfileGroup(profile.group),
        active: profile.id === activeProfileId,
        weeklyLow: weeklyTokensLow,
        authIssue: authState.hasIssue,
        authStatus: authState.description,
        operationalStatus,
        statusText: status.compactText,
        fiveHourText: formatWindowCell(status.primary, now),
        weeklyText: formatWindowCell(status.secondary, now),
        cooldownUntilText: status.cooldownUntil
          ? formatAbsoluteTimestamp(status.cooldownUntil)
          : 'n/a',
        observedAtText: status.observedAt ? formatAbsoluteTimestamp(status.observedAt) : 'n/a',
        observedAt: status.observedAt || 0,
        sourceText: status.isEstimatedRateLimitData
          ? `${status.sourceType || 'unknown'} estimate`
          : status.sourceType || 'n/a',
        isEstimatedRateLimitData: status.isEstimatedRateLimitData,
        hasFreshUsageApiData: status.hasFreshUsageApiData
      };
      viewModel.problem = isProblemAccount(viewModel);
      return viewModel;
    }));
  }

  renderCurrentAuthSummary(currentAuthData, currentMatch, profilesById) {
    if (!currentMatch || !currentMatch.hasAuth) {
      return `
        <div class="summary-card">
          <div class="section-title">Current auth.json</div>
          <div class="muted">No readable Codex auth.json account.</div>
          <div class="card-actions">
            <button data-action="open-command" data-command-action="login">Login</button>
            <button data-action="open-command" data-command-action="restoreBackup">Restore backup</button>
          </div>
        </div>
      `;
    }

    const matchedProfile = currentMatch.profileId ? profilesById.get(currentMatch.profileId) : null;
    const accountLabel = currentAuthData && currentAuthData.email
      ? displayProfileEmail(currentAuthData.email)
      : 'Unknown account';

    if (matchedProfile) {
      return `
        <div class="summary-card">
          <div class="section-title">Current auth.json</div>
          <div class="metric-main">${escapeHtml(displayProfileName(matchedProfile))}</div>
          <div class="muted">${escapeHtml(accountLabel)} - managed account</div>
        </div>
      `;
    }

    return `
      <div class="summary-card warning-card">
        <div class="section-title">Current auth.json</div>
        <div class="metric-main">Unmanaged account</div>
        <div class="muted">${escapeHtml(accountLabel)}</div>
        <div class="card-actions">
          <button data-action="open-command" data-command-action="addCurrent">Add current</button>
          <button data-action="open-command" data-command-action="doctor">Doctor</button>
        </div>
      </div>
    `;
  }

  renderStatsCards(profileViews) {
    const readyCount = profileViews.filter((profile) => profile.operationalStatus === 'Ready').length;
    const problemCount = profileViews.filter((profile) => profile.problem).length;
    const authIssueCount = profileViews.filter((profile) => profile.authIssue).length;
    const weeklyLowCount = profileViews.filter((profile) => profile.weeklyLow).length;

    return `
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-value">${profileViews.length}</div>
          <div class="stat-label">Accounts</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${readyCount}</div>
          <div class="stat-label">Ready</div>
        </div>
        <div class="stat-card${problemCount ? ' warning-card' : ''}">
          <div class="stat-value">${problemCount}</div>
          <div class="stat-label">Needs attention</div>
        </div>
        <div class="stat-card${authIssueCount ? ' danger-card' : ''}">
          <div class="stat-value">${authIssueCount}</div>
          <div class="stat-label">Auth issues</div>
        </div>
        <div class="stat-card${weeklyLowCount ? ' warning-card' : ''}">
          <div class="stat-value">${weeklyLowCount}</div>
          <div class="stat-label">Weekly low</div>
        </div>
      </div>
    `;
  }

  renderTokenUsage(lastObservation, lastRefreshResult, activeProfile) {
    if (!lastObservation || !activeProfile) {
      return '';
    }

    return `
      <div class="summary-card">
        <div class="section-title">Token usage</div>
        <div class="window-line"><strong>Total:</strong> ${escapeHtml(
          formatTokenUsage(lastObservation.totalUsage)
        )}</div>
        <div class="window-line"><strong>Last:</strong> ${escapeHtml(
          formatTokenUsage(lastObservation.lastUsage)
        )}</div>
        <div class="window-line"><strong>Source:</strong> ${escapeHtml(
          lastObservation.filePath ||
            (lastRefreshResult && lastRefreshResult.source === 'usageApi'
              ? 'Usage API'
              : 'n/a')
        )}</div>
      </div>
    `;
  }

  renderQuickPickSettings(quickPickSettings) {
    const sectionRows = quickPickSettings.sectionOrder.map((sectionId, index) => {
      const visible = isProfileQuickPickSectionVisible(quickPickSettings, sectionId);
      const label = getProfileQuickPickSectionLabel(sectionId);
      return `
        <div class="settings-row">
          <label class="checkbox-label">
            <input
              type="checkbox"
              data-quickpick-section="${escapeHtml(sectionId)}"
              ${visible ? 'checked' : ''}
            >
            ${escapeHtml(label)}
          </label>
          <div class="settings-row-actions">
            <button
              class="secondary"
              data-action="quickpick-section-up"
              data-section-id="${escapeHtml(sectionId)}"
              ${index === 0 ? 'disabled' : ''}
            >Up</button>
            <button
              class="secondary"
              data-action="quickpick-section-down"
              data-section-id="${escapeHtml(sectionId)}"
              ${index === quickPickSettings.sectionOrder.length - 1 ? 'disabled' : ''}
            >Down</button>
          </div>
        </div>
      `;
    });
    const sortOptions = PROFILE_QUICK_PICK_SORT_OPTIONS.map((option) => {
      return `<option value="${escapeHtml(option.id)}" ${
        quickPickSettings.profileSort === option.id ? 'selected' : ''
      }>${escapeHtml(option.label)}</option>`;
    });
    const secondarySortOptions = PROFILE_QUICK_PICK_SECONDARY_SORT_OPTIONS.map((option) => {
      return `<option value="${escapeHtml(option.id)}" ${
        quickPickSettings.secondaryProfileSort === option.id ? 'selected' : ''
      }>${escapeHtml(option.label)}</option>`;
    });
    const lowWeeklyThresholdText = formatLowRemainingPercentThreshold(
      quickPickSettings.lowWeeklyRemainingZeroThreshold
    );

    return `
      <div class="summary-card account-switcher-settings">
        <div class="section-title">Account switcher popup</div>
        <div class="settings-grid">
          <div class="settings-column">
            <div class="settings-label">Visible groups</div>
            <div class="settings-list">${sectionRows.join('')}</div>
          </div>
          <div class="settings-column">
            <label class="settings-label" for="quickPickSortSelect">Account sort</label>
            <select id="quickPickSortSelect">${sortOptions.join('')}</select>
            <label class="settings-label" for="quickPickSecondarySortSelect">Tie-break sort</label>
            <select id="quickPickSecondarySortSelect">${secondarySortOptions.join('')}</select>
            <div class="muted">The tie-break sort is used only when two accounts have the same primary sort value. Weekly reset ignores accounts with 0% weekly remaining.</div>
            <label class="checkbox-label settings-toggle">
              <input id="roundLowWeeklyRemainingInput" type="checkbox" ${
                quickPickSettings.roundLowWeeklyRemainingToZero ? 'checked' : ''
              }>
              Show weekly remaining below threshold as 0%
            </label>
            <label class="settings-label" for="lowWeeklyRemainingZeroThresholdInput">Weekly zero threshold</label>
            <div class="inline-setting">
              <input
                id="lowWeeklyRemainingZeroThresholdInput"
                type="number"
                min="0"
                max="100"
                step="0.1"
                value="${escapeHtml(lowWeeklyThresholdText)}"
              >
              <span>%</span>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  renderErrorPage(error) {
    const message = getErrorMessage(error);
    return `<!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Codex Accounts</title>
          <style>
            body {
              margin: 0;
              padding: 20px;
              color: var(--vscode-editor-foreground);
              background: var(--vscode-editor-background);
              font-family: var(--vscode-font-family);
            }
            .error {
              color: var(--vscode-errorForeground);
              border: 1px solid var(--vscode-inputValidation-errorBorder);
              background: var(--vscode-inputValidation-errorBackground);
              padding: 14px;
              border-radius: 6px;
            }
          </style>
        </head>
        <body>
          <h1>Codex Accounts</h1>
          <div class="error">${escapeHtml(message)}</div>
        </body>
      </html>`;
  }

  async update() {
    try {
      const profiles = await this.profileManager.listProfiles();
      const activeProfileId = await this.profileManager.getActiveProfileId();
      const activeProfile = activeProfileId
        ? profiles.find((profile) => profile.id === activeProfileId) || null
        : null;
      const profilesById = new Map(profiles.map((profile) => [profile.id, profile]));
      const now = Date.now();
      const activeStatus = activeProfile
        ? getProfileRateStatus(activeProfile, now, { activeProfileId })
        : null;
      const profileViews = await this.buildProfileViewModels(profiles, activeProfileId, now);
      const currentAuthData = await this.profileManager.loadCurrentAuthData();
      const currentMatch = await this.profileManager.getCurrentAuthProfileMatch();
      const lastObservation = this.rateLimitMonitor.getLastObservation();
      const lastError = this.rateLimitMonitor.getLastError();
      const lastRefreshResult = this.rateLimitMonitor.getLastRefreshResult
        ? this.rateLimitMonitor.getLastRefreshResult()
        : null;

      const activeWindowsHtml = activeProfile
        ? [
            this.renderWindow(activeStatus.primary, 'Primary', now),
            this.renderWindow(activeStatus.secondary, 'Secondary', now)
          ]
            .filter(Boolean)
            .join('')
        : '';
      const groupChoices = this.getProfileGroupChoices(profiles);
      const quickPickSettings = getProfileQuickPickSettings();

      this.panel.webview.html = this.renderHtml({
        activeProfile,
        activeStatus,
        activeWindowsHtml,
        currentAuthData,
        currentMatch,
        groupChoices,
        lastError,
        lastObservation,
        lastRefreshResult,
        profileViews,
        profilesById,
        quickPickSettings
      });
    } catch (error) {
      this.reportOperationError('render', error);
      this.panel.webview.html = this.renderErrorPage(error);
    }
  }

  renderHtml(data) {
    const {
      activeProfile,
      activeStatus,
      activeWindowsHtml,
      currentAuthData,
      currentMatch,
      groupChoices,
      lastError,
      lastObservation,
      lastRefreshResult,
      profileViews,
      profilesById,
      quickPickSettings
    } = data;
    const accountsJson = escapeScriptJson(profileViews);
    const groupChoicesJson = escapeScriptJson(groupChoices);
    const tokenUsageHtml = this.renderTokenUsage(
      lastObservation,
      lastRefreshResult,
      activeProfile
    );

    return `<!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Codex Accounts</title>
          <style>
            :root {
              color-scheme: light dark;
            }
            body {
              font-family: var(--vscode-font-family);
              margin: 0;
              padding: 20px;
              color: var(--vscode-editor-foreground);
              background: var(--vscode-editor-background);
            }
            .layout {
              display: grid;
              gap: 16px;
              max-width: 1600px;
            }
            .page-header,
            .toolbar,
            .title-row,
            .control-row,
            .bulk-bar,
            .card-actions,
            .row-actions {
              display: flex;
              align-items: center;
              gap: 8px;
            }
            .page-header {
              justify-content: space-between;
              align-items: flex-start;
              gap: 16px;
            }
            .title {
              margin: 0;
              font-size: 22px;
              line-height: 1.2;
              font-weight: 650;
            }
            .subtitle,
            .muted,
            .empty,
            .stat-label {
              color: var(--vscode-descriptionForeground);
            }
            .subtitle {
              margin-top: 4px;
            }
            .toolbar,
            .control-row,
            .bulk-bar {
              flex-wrap: wrap;
            }
            button,
            select,
            input[type="search"] {
              font: inherit;
            }
            button {
              border: 0;
              border-radius: 5px;
              min-height: 30px;
              padding: 5px 10px;
              cursor: pointer;
              color: var(--vscode-button-foreground);
              background: var(--vscode-button-background);
            }
            button:hover {
              background: var(--vscode-button-hoverBackground);
            }
            button.secondary {
              color: var(--vscode-button-secondaryForeground);
              background: var(--vscode-button-secondaryBackground);
            }
            button.secondary:hover {
              background: var(--vscode-button-secondaryHoverBackground);
            }
            button.danger {
              color: var(--vscode-errorForeground);
              background: transparent;
              border: 1px solid var(--vscode-inputValidation-errorBorder);
            }
            button:disabled {
              cursor: default;
              opacity: 0.55;
            }
            input[type="search"],
            select {
              min-height: 30px;
              border: 1px solid var(--vscode-input-border);
              border-radius: 4px;
              padding: 4px 8px;
              color: var(--vscode-input-foreground);
              background: var(--vscode-input-background);
            }
            input[type="search"] {
              min-width: min(320px, 100%);
            }
            label.checkbox-label {
              display: inline-flex;
              align-items: center;
              gap: 6px;
              min-height: 30px;
            }
            .summary-grid {
              display: grid;
              grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
              gap: 12px;
            }
            .stats-grid {
              display: grid;
              grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
              gap: 12px;
            }
            .summary-card,
            .window-card,
            .stat-card,
            .accounts-panel {
              border: 1px solid var(--vscode-panel-border);
              border-radius: 8px;
              padding: 14px;
              background: var(--vscode-sideBar-background);
            }
            .summary-card.active-profile-card {
              border-color: var(--vscode-focusBorder);
              box-shadow: inset 0 0 0 1px var(--vscode-focusBorder);
            }
            .warning-card {
              border-color: var(--vscode-inputValidation-warningBorder);
            }
            .danger-card {
              border-color: var(--vscode-inputValidation-errorBorder);
            }
            .section-title,
            .window-title,
            .group-title {
              font-size: 15px;
              font-weight: 650;
              margin-bottom: 10px;
            }
            .metric-main {
              font-size: 16px;
              font-weight: 650;
              margin-bottom: 4px;
            }
            .stat-value {
              font-size: 22px;
              line-height: 1;
              font-weight: 700;
            }
            .stat-label {
              margin-top: 5px;
            }
            .window-grid {
              display: grid;
              grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
              gap: 12px;
            }
            .window-line {
              margin-top: 6px;
            }
            .card-actions {
              margin-top: 12px;
              flex-wrap: wrap;
            }
            .settings-grid {
              display: grid;
              grid-template-columns: minmax(260px, 1.2fr) minmax(220px, 0.8fr);
              gap: 18px;
            }
            .settings-column {
              display: grid;
              align-content: start;
              gap: 10px;
            }
            .settings-label {
              color: var(--vscode-descriptionForeground);
              font-weight: 650;
            }
            .settings-list {
              display: grid;
              gap: 8px;
            }
            .settings-row {
              display: flex;
              align-items: center;
              justify-content: space-between;
              gap: 12px;
              min-height: 34px;
              padding: 7px 9px;
              border: 1px solid var(--vscode-panel-border);
              border-radius: 6px;
              background: var(--vscode-editorWidget-background);
            }
            .settings-row-actions {
              display: flex;
              align-items: center;
              gap: 6px;
            }
            .settings-row-actions button {
              min-height: 24px;
              padding: 2px 7px;
            }
            .settings-toggle {
              margin-top: 4px;
            }
            .inline-setting {
              display: flex;
              align-items: center;
              gap: 6px;
            }
            .inline-setting input {
              max-width: 90px;
            }
            .badge {
              display: inline-flex;
              align-items: center;
              margin-left: 6px;
              padding: 2px 6px;
              border-radius: 5px;
              background: var(--vscode-badge-background);
              color: var(--vscode-badge-foreground);
              font-size: 11px;
              font-weight: 650;
              white-space: nowrap;
            }
            .badge.warning {
              background: var(--vscode-inputValidation-warningBorder);
              color: var(--vscode-editor-background);
            }
            .badge.danger {
              background: var(--vscode-inputValidation-errorBorder);
              color: var(--vscode-editor-background);
            }
            .error {
              color: var(--vscode-errorForeground);
            }
            .accounts-panel {
              padding: 0;
              overflow: hidden;
            }
            .accounts-header {
              display: grid;
              gap: 12px;
              padding: 14px;
              border-bottom: 1px solid var(--vscode-panel-border);
            }
            .bulk-bar {
              min-height: 34px;
              padding: 8px 10px;
              border: 1px solid var(--vscode-panel-border);
              border-radius: 6px;
              background: var(--vscode-editorWidget-background);
            }
            .bulk-bar[hidden] {
              display: none;
            }
            .accounts-root {
              display: grid;
              gap: 12px;
              padding: 14px;
            }
            .group-section {
              display: grid;
              gap: 8px;
            }
            .group-title {
              display: flex;
              align-items: center;
              justify-content: space-between;
              margin: 0;
            }
            .table-wrap {
              overflow: auto;
              border: 1px solid var(--vscode-panel-border);
              border-radius: 6px;
            }
            table {
              width: 100%;
              min-width: 1040px;
              border-collapse: collapse;
            }
            th,
            td {
              text-align: left;
              padding: 9px 8px;
              border-bottom: 1px solid var(--vscode-panel-border);
              vertical-align: middle;
            }
            th {
              color: var(--vscode-descriptionForeground);
              font-weight: 650;
              background: var(--vscode-sideBar-background);
              position: sticky;
              top: 0;
              z-index: 1;
            }
            tr:last-child td {
              border-bottom: 0;
            }
            tr.active-row td {
              background: color-mix(in srgb, var(--vscode-charts-green, #2ea043) 14%, transparent);
            }
            tr.problem-row td:first-child {
              box-shadow: inset 3px 0 0 var(--vscode-inputValidation-warningBorder);
            }
            tr.auth-problem-row td:first-child {
              box-shadow: inset 3px 0 0 var(--vscode-inputValidation-errorBorder);
            }
            .name-cell {
              font-weight: 650;
            }
            .email-cell,
            .small-cell {
              color: var(--vscode-descriptionForeground);
            }
            .row-actions {
              flex-wrap: nowrap;
            }
            .row-actions button {
              min-height: 26px;
              padding: 3px 7px;
            }
            .group-select {
              max-width: 150px;
            }
            .empty {
              padding: 18px;
              border: 1px dashed var(--vscode-panel-border);
              border-radius: 6px;
            }
            @media (max-width: 720px) {
              body {
                padding: 12px;
              }
              .page-header {
                display: grid;
              }
              .toolbar button,
              .control-row select,
              .control-row input[type="search"] {
                width: 100%;
              }
              .control-row {
                display: grid;
              }
              .settings-grid {
                grid-template-columns: 1fr;
              }
              .settings-row {
                align-items: flex-start;
              }
            }
          </style>
        </head>
        <body>
          <div class="layout">
            <div class="page-header">
              <div>
                <h1 class="title">Codex Accounts</h1>
                <div class="subtitle">${
                  activeProfile
                    ? `${escapeHtml(displayProfileName(activeProfile))} - ${escapeHtml(activeStatus.compactText)}`
                    : 'No active profile selected'
                }</div>
              </div>
              <div class="toolbar">
                <button data-action="refresh">Refresh</button>
                <button data-action="open-command" data-command-action="login">Login</button>
                <button data-action="open-command" data-command-action="addCurrent">Add current</button>
                <button class="secondary" data-action="open-command" data-command-action="addFromFile">Import auth.json</button>
                <button class="secondary" data-action="open-command" data-command-action="importProfiles">Import profiles</button>
                <button class="secondary" data-action="open-command" data-command-action="exportProfiles">Export profiles</button>
                <button class="secondary" data-action="open-command" data-command-action="restoreBackup">Restore backup</button>
                <button data-action="open-command" data-command-action="doctor">Doctor</button>
                <button class="secondary" data-action="open-command" data-command-action="settings">Settings</button>
              </div>
            </div>

            ${this.renderStatsCards(profileViews)}

            <div class="summary-grid">
              <div class="summary-card${activeProfile ? ' active-profile-card' : ''}">
                <div class="section-title">Active profile</div>
                ${
                  activeProfile
                    ? `
                      <div class="metric-main">${escapeHtml(displayProfileName(activeProfile))}</div>
                      <div class="muted">${escapeHtml(displayProfileEmail(activeProfile.email || 'Unknown'))}</div>
                      <div class="window-line"><strong>Status:</strong> ${escapeHtml(activeStatus.compactText)}</div>
                      <div class="window-line"><strong>Plan:</strong> ${escapeHtml(activeStatus.planText)}</div>
                    `
                    : '<div class="muted">No active profile selected.</div>'
                }
              </div>

              ${this.renderCurrentAuthSummary(currentAuthData, currentMatch, profilesById)}

              <div class="summary-card${lastError ? ' danger-card' : ''}">
                <div class="section-title">Monitor</div>
                ${
                  lastError
                    ? `<div class="window-line error"><strong>Error:</strong> ${escapeHtml(lastError)}</div>`
                    : '<div class="window-line"><strong>Error:</strong> none</div>'
                }
                <div class="window-line"><strong>Source:</strong> ${escapeHtml(
                  formatRefreshResult(lastRefreshResult)
                )}</div>
              </div>
            </div>

            ${
              activeWindowsHtml
                ? `<div class="window-grid">${activeWindowsHtml}</div>`
                : activeProfile
                  ? '<div class="summary-card"><div class="section-title">Current cooldown</div><div class="empty">No active cooldown windows for the selected profile.</div></div>'
                  : ''
            }

            ${tokenUsageHtml}

            <div class="accounts-panel">
              <div class="accounts-header">
                <div class="title-row">
                  <div class="section-title" style="margin: 0;">Accounts</div>
                  <span id="visibleCount" class="muted"></span>
                </div>
                <div class="control-row">
                  <input id="searchInput" type="search" placeholder="Search name, email, group">
                  <select id="groupBySelect">
                    <option value="status">By status</option>
                    <option value="plan">By plan</option>
                    <option value="group">By group</option>
                    <option value="all">All accounts</option>
                  </select>
                  <select id="statusFilter"></select>
                  <select id="planFilter"></select>
                  <select id="sortSelect">
                    <option value="default">Best available</option>
                    <option value="name">Name</option>
                    <option value="plan">Plan</option>
                    <option value="observed">Last observation</option>
                  </select>
                  <label class="checkbox-label">
                    <input id="problemFilter" type="checkbox">
                    Only problems
                  </label>
                </div>
                <div id="bulkBar" class="bulk-bar" hidden>
                  <strong id="selectedCount">0 selected</strong>
                  <button class="secondary" data-action="bulk-group">Set group</button>
                  <button class="danger" data-action="bulk-delete">Delete selected</button>
                </div>
              </div>
              <div id="accountsRoot" class="accounts-root"></div>
            </div>

            ${this.renderQuickPickSettings(quickPickSettings)}
          </div>

          <script>
            const vscode = acquireVsCodeApi();
            const accounts = ${accountsJson};
            const groupChoices = ${groupChoicesJson};
            const customGroupValue = ${JSON.stringify(CUSTOM_GROUP_VALUE)};
            const savedState = vscode.getState() || {};
            const accountIds = new Set(accounts.map((account) => account.id));
            const selectedIds = new Set(
              Array.isArray(savedState.selectedIds)
                ? savedState.selectedIds.filter((profileId) => accountIds.has(profileId))
                : []
            );

            const elements = {
              accountsRoot: document.getElementById('accountsRoot'),
              bulkBar: document.getElementById('bulkBar'),
              groupBySelect: document.getElementById('groupBySelect'),
              planFilter: document.getElementById('planFilter'),
              problemFilter: document.getElementById('problemFilter'),
              quickPickSecondarySortSelect: document.getElementById('quickPickSecondarySortSelect'),
              quickPickSortSelect: document.getElementById('quickPickSortSelect'),
              lowWeeklyRemainingZeroThresholdInput: document.getElementById('lowWeeklyRemainingZeroThresholdInput'),
              roundLowWeeklyRemainingInput: document.getElementById('roundLowWeeklyRemainingInput'),
              searchInput: document.getElementById('searchInput'),
              selectedCount: document.getElementById('selectedCount'),
              sortSelect: document.getElementById('sortSelect'),
              statusFilter: document.getElementById('statusFilter'),
              visibleCount: document.getElementById('visibleCount')
            };

            function post(command, payload = {}) {
              vscode.postMessage({ command, ...payload });
            }

            function selectHasValue(select, value) {
              return [...select.options].some((option) => option.value === value);
            }

            function setSelectValue(select, value) {
              if (typeof value === 'string' && selectHasValue(select, value)) {
                select.value = value;
              }
            }

            function saveState() {
              vscode.setState({
                search: elements.searchInput.value,
                groupBy: elements.groupBySelect.value,
                statusFilter: elements.statusFilter.value,
                planFilter: elements.planFilter.value,
                sort: elements.sortSelect.value,
                onlyProblems: elements.problemFilter.checked,
                selectedIds: [...selectedIds].filter((profileId) => accountIds.has(profileId))
              });
            }

            function restoreState() {
              if (typeof savedState.search === 'string') {
                elements.searchInput.value = savedState.search;
              }
              setSelectValue(elements.groupBySelect, savedState.groupBy);
              setSelectValue(elements.statusFilter, savedState.statusFilter);
              setSelectValue(elements.planFilter, savedState.planFilter);
              setSelectValue(elements.sortSelect, savedState.sort);
              elements.problemFilter.checked = savedState.onlyProblems === true;
              saveState();
            }

            function unique(values) {
              return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
            }

            function populateFilter(select, label, values) {
              const current = select.value;
              select.textContent = '';
              const allOption = document.createElement('option');
              allOption.value = '';
              allOption.textContent = label;
              select.appendChild(allOption);
              for (const value of values) {
                const option = document.createElement('option');
                option.value = value;
                option.textContent = value;
                select.appendChild(option);
              }
              select.value = [...select.options].some((option) => option.value === current) ? current : '';
            }

            function setupFilters() {
              populateFilter(elements.statusFilter, 'Any status', unique(accounts.map((account) => account.operationalStatus)));
              populateFilter(elements.planFilter, 'Any plan', unique(accounts.map((account) => account.plan)));
            }

            function accountSearchText(account) {
              return [
                account.name,
                account.email,
                account.plan,
                account.profileGroup,
                account.operationalStatus,
                account.authStatus,
                account.sourceText
              ].join(' ').toLowerCase();
            }

            function getFilteredAccounts() {
              const query = elements.searchInput.value.trim().toLowerCase();
              const status = elements.statusFilter.value;
              const plan = elements.planFilter.value;
              const onlyProblems = elements.problemFilter.checked;
              return accounts.filter((account) => {
                if (query && !accountSearchText(account).includes(query)) {
                  return false;
                }
                if (status && account.operationalStatus !== status) {
                  return false;
                }
                if (plan && account.plan !== plan) {
                  return false;
                }
                if (onlyProblems && !account.problem) {
                  return false;
                }
                return true;
              });
            }

            function getSortedAccounts(filteredAccounts) {
              const sortMode = elements.sortSelect.value;
              const sorted = [...filteredAccounts];
              if (sortMode === 'name') {
                sorted.sort((left, right) => left.name.localeCompare(right.name));
              } else if (sortMode === 'plan') {
                sorted.sort((left, right) => left.plan.localeCompare(right.plan) || left.name.localeCompare(right.name));
              } else if (sortMode === 'observed') {
                sorted.sort((left, right) => right.observedAt - left.observedAt || left.name.localeCompare(right.name));
              } else {
                sorted.sort((left, right) => left.index - right.index);
              }
              return sorted;
            }

            function getGroupLabel(account) {
              const groupBy = elements.groupBySelect.value;
              if (groupBy === 'plan') {
                return account.plan || 'Unknown';
              }
              if (groupBy === 'group') {
                return account.profileGroup || 'Ungrouped';
              }
              if (groupBy === 'all') {
                return 'All accounts';
              }
              return account.operationalStatus || 'Unknown';
            }

            function createCell(text, className) {
              const cell = document.createElement('td');
              if (className) {
                cell.className = className;
              }
              cell.textContent = text == null ? '' : String(text);
              return cell;
            }

            function addBadge(container, text, className) {
              const badge = document.createElement('span');
              badge.className = className ? 'badge ' + className : 'badge';
              badge.textContent = text;
              container.appendChild(badge);
            }

            function createProfileCell(account) {
              const cell = document.createElement('td');
              const name = document.createElement('div');
              name.className = 'name-cell';
              name.textContent = account.name;
              cell.appendChild(name);
              if (account.active) {
                addBadge(name, 'THIS WINDOW');
              }
              if (account.weeklyLow) {
                addBadge(name, 'WEEKLY LOW', 'warning');
              }
              if (account.authIssue) {
                addBadge(name, account.authStatus, 'danger');
              }
              const email = document.createElement('div');
              email.className = 'email-cell';
              email.textContent = account.email;
              cell.appendChild(email);
              return cell;
            }

            function createCheckboxCell(account) {
              const cell = document.createElement('td');
              const checkbox = document.createElement('input');
              checkbox.type = 'checkbox';
              checkbox.dataset.profileId = account.id;
              checkbox.checked = selectedIds.has(account.id);
              checkbox.setAttribute('aria-label', 'Select ' + account.name);
              cell.appendChild(checkbox);
              return cell;
            }

            function createGroupCell(account) {
              const cell = document.createElement('td');
              const select = document.createElement('select');
              select.className = 'group-select';
              select.dataset.profileId = account.id;
              for (const group of groupChoices) {
                const option = document.createElement('option');
                option.value = group;
                option.textContent = group;
                select.appendChild(option);
              }
              const customOption = document.createElement('option');
              customOption.value = customGroupValue;
              customOption.textContent = 'Custom...';
              select.appendChild(customOption);
              select.value = groupChoices.includes(account.profileGroup) ? account.profileGroup : 'Ungrouped';
              cell.appendChild(select);
              return cell;
            }

            function createActionsCell(account) {
              const cell = document.createElement('td');
              const actions = document.createElement('div');
              actions.className = 'row-actions';

              const activate = document.createElement('button');
              activate.className = 'secondary';
              activate.dataset.action = 'activate';
              activate.dataset.profileId = account.id;
              activate.textContent = account.active ? 'Active' : 'Activate';
              activate.disabled = account.active;
              actions.appendChild(activate);

              const rename = document.createElement('button');
              rename.className = 'secondary';
              rename.dataset.action = 'rename';
              rename.dataset.profileId = account.id;
              rename.textContent = 'Rename';
              actions.appendChild(rename);

              const reauth = document.createElement('button');
              reauth.className = 'secondary';
              reauth.dataset.action = 'reauth';
              reauth.dataset.profileId = account.id;
              reauth.textContent = 'Re-auth';
              actions.appendChild(reauth);

              const remove = document.createElement('button');
              remove.className = 'danger';
              remove.dataset.action = 'delete';
              remove.dataset.profileId = account.id;
              remove.textContent = 'Delete';
              actions.appendChild(remove);

              cell.appendChild(actions);
              return cell;
            }

            function createTable(accountsInGroup) {
              const wrap = document.createElement('div');
              wrap.className = 'table-wrap';
              const table = document.createElement('table');
              const thead = document.createElement('thead');
              const headerRow = document.createElement('tr');
              ['', 'Profile', 'Group', 'Plan', 'Status', '5H', 'Weekly', 'Observed', 'Source', 'Actions'].forEach((label) => {
                const th = document.createElement('th');
                th.textContent = label;
                headerRow.appendChild(th);
              });
              thead.appendChild(headerRow);
              table.appendChild(thead);

              const tbody = document.createElement('tbody');
              for (const account of accountsInGroup) {
                const row = document.createElement('tr');
                row.className = [
                  account.active ? 'active-row' : '',
                  account.problem ? 'problem-row' : '',
                  account.authIssue ? 'auth-problem-row' : ''
                ].filter(Boolean).join(' ');
                row.appendChild(createCheckboxCell(account));
                row.appendChild(createProfileCell(account));
                row.appendChild(createGroupCell(account));
                row.appendChild(createCell(account.plan, 'small-cell'));
                row.appendChild(createCell(account.operationalStatus));
                row.appendChild(createCell(account.fiveHourText, 'small-cell'));
                row.appendChild(createCell(account.weeklyText, 'small-cell'));
                row.appendChild(createCell(account.observedAtText, 'small-cell'));
                row.appendChild(createCell(account.sourceText, 'small-cell'));
                row.appendChild(createActionsCell(account));
                tbody.appendChild(row);
              }
              table.appendChild(tbody);
              wrap.appendChild(table);
              return wrap;
            }

            function renderAccounts() {
              const filtered = getSortedAccounts(getFilteredAccounts());
              elements.visibleCount.textContent = filtered.length === accounts.length
                ? accounts.length + ' shown'
                : filtered.length + ' of ' + accounts.length + ' shown';
              elements.accountsRoot.textContent = '';

              if (!accounts.length) {
                const empty = document.createElement('div');
                empty.className = 'empty';
                empty.textContent = 'No saved accounts.';
                elements.accountsRoot.appendChild(empty);
                updateBulkBar();
                return;
              }

              if (!filtered.length) {
                const empty = document.createElement('div');
                empty.className = 'empty';
                empty.textContent = 'No accounts match the current filters.';
                elements.accountsRoot.appendChild(empty);
                updateBulkBar();
                return;
              }

              const grouped = new Map();
              for (const account of filtered) {
                const group = getGroupLabel(account);
                if (!grouped.has(group)) {
                  grouped.set(group, []);
                }
                grouped.get(group).push(account);
              }

              for (const [group, accountsInGroup] of grouped) {
                const section = document.createElement('section');
                section.className = 'group-section';
                const title = document.createElement('div');
                title.className = 'group-title';
                const name = document.createElement('span');
                name.textContent = group;
                const count = document.createElement('span');
                count.className = 'muted';
                count.textContent = accountsInGroup.length + ' account' + (accountsInGroup.length === 1 ? '' : 's');
                title.appendChild(name);
                title.appendChild(count);
                section.appendChild(title);
                section.appendChild(createTable(accountsInGroup));
                elements.accountsRoot.appendChild(section);
              }

              updateBulkBar();
            }

            function updateBulkBar() {
              const count = selectedIds.size;
              elements.bulkBar.hidden = count === 0;
              elements.selectedCount.textContent = count + ' selected';
            }

            document.addEventListener('click', (event) => {
              const button = event.target.closest('button[data-action]');
              if (!button) {
                return;
              }

              const action = button.dataset.action;
              const profileId = button.dataset.profileId;
              if (action === 'refresh') {
                post('refresh');
              } else if (action === 'open-command') {
                post('openCommand', { action: button.dataset.commandAction });
              } else if (action === 'activate') {
                post('activateProfile', { profileId });
              } else if (action === 'rename') {
                post('renameProfile', { profileId });
              } else if (action === 'reauth') {
                post('reauthenticateProfile', { profileId });
              } else if (action === 'delete') {
                post('deleteProfile', { profileId });
              } else if (action === 'bulk-delete') {
                post('deleteSelectedProfiles', { profileIds: [...selectedIds] });
              } else if (action === 'bulk-group') {
                post('promptSelectedGroup', { profileIds: [...selectedIds] });
              } else if (action === 'quickpick-section-up') {
                post('moveQuickPickSection', {
                  sectionId: button.dataset.sectionId,
                  direction: 'up'
                });
              } else if (action === 'quickpick-section-down') {
                post('moveQuickPickSection', {
                  sectionId: button.dataset.sectionId,
                  direction: 'down'
                });
              }
            });

            document.addEventListener('change', (event) => {
              const target = event.target;
              if (target.matches('input[type="checkbox"][data-profile-id]')) {
                if (target.checked) {
                  selectedIds.add(target.dataset.profileId);
                } else {
                  selectedIds.delete(target.dataset.profileId);
                }
                saveState();
                updateBulkBar();
                return;
              }

              if (target.matches('select.group-select')) {
                if (target.value === customGroupValue) {
                  post('promptProfileGroup', { profileId: target.dataset.profileId });
                } else {
                  post('setProfileGroup', {
                    profileId: target.dataset.profileId,
                    group: target.value
                  });
                }
                return;
              }

              if (target.matches('input[data-quickpick-section]')) {
                post('setQuickPickSectionVisibility', {
                  sectionId: target.dataset.quickpickSection,
                  visible: target.checked
                });
                return;
              }

              if (target === elements.quickPickSortSelect) {
                post('setQuickPickProfileSort', { sortMode: target.value });
                return;
              }

              if (target === elements.quickPickSecondarySortSelect) {
                post('setQuickPickSecondaryProfileSort', { sortMode: target.value });
                return;
              }

              if (target === elements.roundLowWeeklyRemainingInput) {
                post('setRoundLowWeeklyRemainingToZero', { enabled: target.checked });
                return;
              }

              if (target === elements.lowWeeklyRemainingZeroThresholdInput) {
                post('setLowWeeklyRemainingZeroThreshold', { threshold: Number(target.value) });
                return;
              }

              if (
                target === elements.groupBySelect ||
                target === elements.statusFilter ||
                target === elements.planFilter ||
                target === elements.sortSelect ||
                target === elements.problemFilter
              ) {
                saveState();
                renderAccounts();
              }
            });

            elements.searchInput.addEventListener('input', () => {
              saveState();
              renderAccounts();
            });

            setupFilters();
            restoreState();
            renderAccounts();
          </script>
        </body>
      </html>`;
  }
}

module.exports = {
  RateLimitDetailsPanel
};
