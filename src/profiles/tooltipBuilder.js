'use strict';

const vscode = require('vscode');
const {
  formatCompactRateSummary,
  getProfileRateStatus,
  formatPlanType,
  isProfileWeeklyTokensLow,
  sortProfilesForDisplay
} = require('./profileStatus');
const { displayProfileName } = require('./privacy');

function escapeMarkdown(text) {
  return String(text || '').replace(/\\/g, '\\\\').replace(/([`*_{}[\]()#+\-.!|])/g, '\\$1');
}

function buildCommandUri(command, args) {
  return `command:${command}?${encodeURIComponent(JSON.stringify(args || []))}`;
}

function getOtherWindowUsageEntries(profileId, otherWindowProfileUsageByProfileId) {
  if (!profileId || !otherWindowProfileUsageByProfileId) {
    return [];
  }

  if (typeof otherWindowProfileUsageByProfileId.get === 'function') {
    return otherWindowProfileUsageByProfileId.get(profileId) || [];
  }

  return otherWindowProfileUsageByProfileId[profileId] || [];
}

function formatOtherWindowUsage(entries) {
  if (!entries || !entries.length) {
    return '';
  }

  const labels = [...new Set(
    entries
      .map((entry) => String((entry && entry.workspaceLabel) || '').trim())
      .filter(Boolean)
  )];
  const visibleLabels = labels.slice(0, 2).map(escapeMarkdown);
  const hiddenCount = Math.max(0, labels.length - visibleLabels.length);
  const suffix = hiddenCount > 0 ? `, +${hiddenCount}` : '';
  const windowText = entries.length === 1 ? '1 other window' : `${entries.length} other windows`;
  return `${escapeMarkdown(windowText)}${visibleLabels.length ? `: ${visibleLabels.join(', ')}${suffix}` : ''}`;
}

function createProfileTooltip(activeProfile, profiles, otherWindowProfileUsageByProfileId) {
  const tooltip = new vscode.MarkdownString();
  tooltip.supportThemeIcons = true;
  tooltip.supportHtml = true;
  tooltip.isTrusted = {
    enabledCommands: [
      'codex-switch.profile.manage',
      'codex-switch.profile.activate',
      'codex-switch.profile.switch',
      'codexTerminalRecorder.openSettings'
    ]
  };

  if (!profiles || profiles.length === 0) {
    tooltip.appendMarkdown('No profiles yet.\n\n');
  } else {
    const activeId = activeProfile ? activeProfile.id : undefined;
    const now = Date.now();
    const sortedProfiles = sortProfilesForDisplay(profiles, activeId, now);

    tooltip.appendMarkdown('| Account | Plan | Limits | Other windows |\n');
    tooltip.appendMarkdown('| --- | --- | --- | --- |\n');

    sortedProfiles.forEach((profile) => {
      const status = getProfileRateStatus(profile, now, { activeProfileId: activeId });
      const switchUri = buildCommandUri('codex-switch.profile.activate', [profile.id]);
      const plan = escapeMarkdown(formatPlanType(profile.planType));
      const linkedName = `[${escapeMarkdown(displayProfileName(profile))}](${switchUri})`;
      const activeBadge = activeId === profile.id ? '**ACTIVE** ' : '';
      const weeklyTokensLow = isProfileWeeklyTokensLow(profile, now, {
        activeProfileId: activeId
      });
      const lowWeeklyBadge = weeklyTokensLow ? ' `W < 5%`' : '';
      const summary = formatCompactRateSummary(status, now, {
        includePrimaryCountdown: true,
        includeSecondaryCountdown: true,
        percentageMode: 'remaining'
      })
        .split(' | ')
        .map((windowText) => escapeMarkdown(windowText))
        .join('<br>');
      const estimateSuffix = status.isEstimatedRateLimitData ? ' - estimate' : '';
      const otherWindowUsage = formatOtherWindowUsage(
        getOtherWindowUsageEntries(profile.id, otherWindowProfileUsageByProfileId)
      );

      tooltip.appendMarkdown(
        `| ${activeBadge}${linkedName}${lowWeeklyBadge} | ${plan} | ${summary}${estimateSuffix} | ${otherWindowUsage} |\n`
      );
    });

    tooltip.appendMarkdown('\n');
  }

  tooltip.appendMarkdown(formatReloadWarning());
  tooltip.appendMarkdown('\n');
  tooltip.appendMarkdown('---\n\n');
  tooltip.appendMarkdown(
    '[Switch profile](command:codex-switch.profile.switch) • [Manage profiles](command:codex-switch.profile.manage) • [Send to Codex settings](command:codexTerminalRecorder.openSettings)\n\n'
  );
  return tooltip;
}

function formatReloadWarning() {
  const reloadAfterSwitch = vscode.workspace
    .getConfiguration('codexSwitch')
    .get('reloadWindowAfterProfileSwitch', true);

  return reloadAfterSwitch
    ? '$(warning) VS Code window will reload after switching accounts.\n'
    : '$(warning) After switching accounts, a VS Code window reload may be required.\n';
}

module.exports = {
  createProfileTooltip
};
