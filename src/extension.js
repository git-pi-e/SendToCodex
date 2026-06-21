'use strict';
const vscode = require('vscode');
const {
  CONFIG_SECTION,
  DIAGNOSTICS_LOG_FILE_ENABLED_DEFAULT,
  DIAGNOSTICS_LOGGING_ENABLED_DEFAULT,
  isSendToCodexEnabled,
  OUTPUT_CHANNEL_NAME,
  SEND_TO_CODEX_ENABLED_SETTING
} = require('./config');
const { FileLogger } = require('./logging/FileLogger');
const { ActiveTerminalSelectionResolver } = require('./terminalSelection/ActiveTerminalSelectionResolver');
const { SelectionLocator } = require('./terminalSelection/SelectionLocator');
const { TerminalLogManager } = require('./terminalLogs/TerminalLogManager');
const { CodexAvailabilityController } = require('./codex/CodexAvailabilityController');
const { CodexCommandClient } = require('./codex/CodexCommandClient');
const { getFileSize, getOfficialCodexLogPath } = require('./codex/CodexSidebarConversation');
const {
  DEFAULT_PENDING_WARMUP_MAX_AGE_MS,
  DEFAULT_POST_SWITCH_WARMUP_DELAY_MS,
  DEFAULT_POST_SWITCH_RESTORE_STRATEGY,
  captureCurrentCodexChatContext,
  isPendingCodexPostSwitchWarmupFresh,
  isRestorableCodexChatContext,
  normalizePostSwitchRestoreStrategy,
  warmUpCodexAfterProfileSwitch
} = require('./codex/CodexPostSwitchWarmup');
const { EditorSelectionCodexSender } = require('./codex/EditorSelectionCodexSender');
const { ExplorerResourcesCodexSender } = require('./codex/ExplorerResourcesCodexSender');
const { TerminalSelectionCodexSender } = require('./codex/TerminalSelectionCodexSender');
const { createSelectionPopupPresenter } = require('./native/presenter');
const { registerProfileCommands } = require('./profiles/commands');
const { areProfileFeaturesEnabled } = require('./profiles/featureFlags');
const { ProfileManager } = require('./profiles/profileManager');
const { RateLimitMonitor } = require('./profiles/rateLimitMonitor');
const { displayAccountLabel } = require('./profiles/privacy');
const { NativeSelectionOverlayController } = require('./ui/NativeSelectionOverlayController');
const { EditorSelectionStatusBarController } = require('./ui/EditorSelectionStatusBarController');
const { ProfileStatusBarController } = require('./profiles/statusBar');
const { SelectionPopupSuppression } = require('./ui/SelectionPopupSuppression');
const { TerminalSelectionStatusBarController } = require('./ui/TerminalSelectionStatusBarController');

const CODEX_POST_SWITCH_WARMUP_KEY = 'codexSwitch.pendingCodexPostSwitchWarmup';
const AUTH_WATCHER_SETTLE_TIMEOUT_MS = 15 * 1000;

function activate(context) {
  const output = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  context.subscriptions.push(output);

  const logger = new FileLogger(context.logUri.fsPath, output);
  const codexLogPath = getOfficialCodexLogPath(context.logUri.fsPath);
  logger.reloadConfiguration();
  logger.info('Send to Codex extension activated.', {
    vscodeVersion: vscode.version,
    extensionVersion: context.extension && context.extension.packageJSON
      ? context.extension.packageJSON.version
      : null,
    logFilePath: logger.logFilePath
  });
  logger.debug('Codex restore debug build active.', {
    vscodeVersion: vscode.version,
    extensionVersion: context.extension && context.extension.packageJSON
      ? context.extension.packageJSON.version
      : null,
    outputChannelName: OUTPUT_CHANNEL_NAME
  });

  const manager = new TerminalLogManager(context, output, logger);
  context.subscriptions.push(manager);
  const profileManager = new ProfileManager(context, logger);
  const profileStatusBarController = new ProfileStatusBarController();
  const rateLimitMonitor = new RateLimitMonitor(profileManager, logger);
  context.subscriptions.push(profileManager);
  context.subscriptions.push(profileStatusBarController);
  context.subscriptions.push(rateLimitMonitor);
  const popupSuppression = new SelectionPopupSuppression(logger);
  const selectionResolver = new ActiveTerminalSelectionResolver(manager);
  const selectionLocator = new SelectionLocator(selectionResolver, output, popupSuppression);
  const codexCommandClient = new CodexCommandClient(logger);
  const codexAvailabilityController = new CodexAvailabilityController(
    codexCommandClient,
    logger
  );
  const editorSender = new EditorSelectionCodexSender(codexCommandClient, output, logger);
  const explorerResourcesSender = new ExplorerResourcesCodexSender(
    codexCommandClient,
    output,
    logger
  );
  const codexSender = new TerminalSelectionCodexSender(
    selectionResolver,
    codexCommandClient,
    output,
    logger,
    popupSuppression
  );
  const nativeSelectionOverlayController = new NativeSelectionOverlayController(
    createSelectionPopupPresenter(logger),
    popupSuppression,
    logger,
    codexAvailabilityController
  );
  const editorStatusBarController = new EditorSelectionStatusBarController(
    codexAvailabilityController,
    logger
  );
  const statusBarController = new TerminalSelectionStatusBarController(
    codexAvailabilityController,
    logger
  );
  context.subscriptions.push(codexAvailabilityController);
  context.subscriptions.push(nativeSelectionOverlayController);
  context.subscriptions.push(editorStatusBarController);
  context.subscriptions.push(statusBarController);

  let latestProfileUiRefreshId = 0;
  let latestAuthWatcherRefreshId = 0;
  let lastUnmanagedAuthNoticeKey;
  let unmanagedAuthNoticeInFlight = false;
  let expectedWindowAuthChange;

  const getExpectedWindowAuthChange = () => {
    if (!expectedWindowAuthChange) {
      return undefined;
    }

    if (expectedWindowAuthChange.expiresAt <= Date.now()) {
      logger.warn('Expired expected Codex auth.json change marker.', {
        expectedProfileId: expectedWindowAuthChange.profileId || null,
        requestedAt: expectedWindowAuthChange.requestedAt
      });
      expectedWindowAuthChange = undefined;
      return undefined;
    }

    return expectedWindowAuthChange;
  };

  const markWindowAuthChangeExpected = (options = {}) => {
    const profileId =
      options && typeof options.profileId === 'string' && options.profileId.trim()
        ? options.profileId.trim()
        : undefined;
    const requestedAt = Date.now();
    expectedWindowAuthChange = {
      profileId,
      requestedAt,
      expiresAt: requestedAt + 10 * 60 * 1000
    };
    logger.info('Expecting a Codex auth.json change for this VS Code window.', {
      expectedProfileId: profileId || null,
      expiresAt: expectedWindowAuthChange.expiresAt
    });
  };

  const clearExpectedWindowAuthChange = () => {
    expectedWindowAuthChange = undefined;
  };

  const shouldAcceptAuthChangeForThisWindow = async (authData) => {
    const expected = getExpectedWindowAuthChange();
    if (!expected) {
      logger.info('Ignoring Codex auth.json watcher event that this window did not initiate.');
      return false;
    }

    if (!expected.profileId) {
      return true;
    }

    const matchedProfile = authData
      ? await profileManager.findProfileMatchingAuthData(authData)
      : undefined;
    if (matchedProfile && matchedProfile.id === expected.profileId) {
      return true;
    }

    logger.warn('Ignoring Codex auth.json watcher event for an unexpected profile.', {
      expectedProfileId: expected.profileId,
      actualProfileId: matchedProfile ? matchedProfile.id : null
    });
    return false;
  };

  const getCodexChatContextForProfileSwitch = () => {
    const contextToRestore = captureCurrentCodexChatContext(logger, {
      fallbackToSidebar: true,
      codexLogPath
    });
    logger.debug('Codex restore debug: getCodexChatContextForProfileSwitch result.', {
      contextToRestore
    });
    if (isRestorableCodexChatContext(contextToRestore)) {
      return contextToRestore;
    }
    return undefined;
  };

  const getPostSwitchRestoreStrategy = () => normalizePostSwitchRestoreStrategy(
    vscode.workspace
      .getConfiguration('codexSwitch')
      .get('postSwitchRestoreStrategy', DEFAULT_POST_SWITCH_RESTORE_STRATEGY)
  );

  const getPostSwitchWarmupDelayMs = (restoreChatContext) =>
    restoreChatContext && restoreChatContext.kind === 'sidebarConversation'
      ? 1000
      : DEFAULT_POST_SWITCH_WARMUP_DELAY_MS;

  const scheduleCodexPostSwitchWarmup = async (profileId, options = {}) => {
    logger.debug('Codex restore debug: scheduleCodexPostSwitchWarmup called.', {
      profileId: profileId || null,
      changedProfile: Boolean(options.changedProfile),
      willReloadWindow: Boolean(options.willReloadWindow)
    });
    if (!profileId || !options.changedProfile) {
      logger.debug('Codex restore debug: skipping schedule because switch did not change profile.', {
        profileId: profileId || null,
        changedProfile: Boolean(options.changedProfile)
      });
      return;
    }

    const restoreChatContext = getCodexChatContextForProfileSwitch();
    const restoreStrategy = getPostSwitchRestoreStrategy();
    const codexLogSize = getFileSize(codexLogPath);
    logger.debug('Codex restore debug: captured context and strategy for profile switch.', {
      profileId,
      restoreChatContext,
      restoreStrategy,
      codexLogSize
    });
    if (options.willReloadWindow) {
      await context.workspaceState.update(CODEX_POST_SWITCH_WARMUP_KEY, {
        profileId,
        scheduledAt: Date.now(),
        restoreChatContext,
        restoreStrategy,
        codexLogSize
      });
      logger.debug('Codex restore debug: pending post-switch warm-up saved to workspaceState.', {
        key: CODEX_POST_SWITCH_WARMUP_KEY,
        profileId,
        restoreChatContext,
        restoreStrategy,
        codexLogSize
      });
      logger.info('Scheduled Codex post-switch warm-up for the next VS Code activation.', {
        profileId,
        restoreChatKind: restoreChatContext ? restoreChatContext.kind : null,
        restoreStrategy,
        codexLogSize
      });
      return;
    }

    const delayMs = getPostSwitchWarmupDelayMs(restoreChatContext);
    setTimeout(() => {
      logger.debug('Codex restore debug: running delayed no-reload post-switch warm-up.', {
        profileId,
        restoreChatContext,
        restoreStrategy,
        codexLogSize
      });
      void warmUpCodexAfterProfileSwitch('profile-switch-no-reload', logger, {
        restoreChatContext,
        restoreStrategy,
        codexLogPath,
        sidebarResumeStartOffset: codexLogSize
      });
    }, delayMs);
  };

  const runPendingCodexPostSwitchWarmup = async () => {
    const pending = context.workspaceState.get(CODEX_POST_SWITCH_WARMUP_KEY);
    if (!pending || !pending.scheduledAt) {
      logger.debug('Codex restore debug: no pending post-switch warm-up found on activation.', {
        key: CODEX_POST_SWITCH_WARMUP_KEY
      });
      return;
    }

    logger.debug('Codex restore debug: pending post-switch warm-up found on activation.', {
      key: CODEX_POST_SWITCH_WARMUP_KEY,
      pending
    });
    await context.workspaceState.update(CODEX_POST_SWITCH_WARMUP_KEY, undefined);
    if (!isPendingCodexPostSwitchWarmupFresh(pending, Date.now(), DEFAULT_PENDING_WARMUP_MAX_AGE_MS)) {
      logger.warn('Skipped stale Codex post-switch warm-up.', {
        profileId: pending.profileId || null,
        scheduledAt: pending.scheduledAt,
        maxAgeMs: DEFAULT_PENDING_WARMUP_MAX_AGE_MS
      });
      return;
    }

    const delayMs = getPostSwitchWarmupDelayMs(pending.restoreChatContext);
    setTimeout(() => {
      logger.debug('Codex restore debug: running delayed after-reload post-switch warm-up.', {
        pending,
        restoreStrategy: pending.restoreStrategy || getPostSwitchRestoreStrategy(),
        codexLogSize: pending.codexLogSize
      });
      void warmUpCodexAfterProfileSwitch('profile-switch-after-reload', logger, {
        restoreChatContext: pending.restoreChatContext,
        restoreStrategy: pending.restoreStrategy || getPostSwitchRestoreStrategy(),
        codexLogPath,
        sidebarResumeStartOffset: pending.codexLogSize
      });
    }, delayMs);
  };

  const getCurrentAuthNoticeKey = (authData) => {
    if (!authData) {
      return 'current-auth';
    }

    const identityParts = [
      authData.accountId,
      authData.defaultOrganizationId,
      authData.chatgptUserId,
      authData.userId,
      authData.subject,
      authData.email
    ]
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter(Boolean);

    return identityParts.length ? identityParts.join('|') : 'current-auth';
  };

  const maybeNotifyUnmanagedCurrentProfile = async () => {
    if (!areProfileFeaturesEnabled()) {
      return;
    }

    let shouldRecheckAfterNotice = false;
    if (unmanagedAuthNoticeInFlight) {
      return;
    }

    try {
      const currentAuthMatch = await profileManager.getCurrentAuthProfileMatch();
      if (!currentAuthMatch.hasAuth) {
        lastUnmanagedAuthNoticeKey = undefined;
        return;
      }

      if (currentAuthMatch.profileId) {
        lastUnmanagedAuthNoticeKey = undefined;
        return;
      }

      const authData = await profileManager.loadCurrentAuthData();
      const noticeKey = getCurrentAuthNoticeKey(authData);
      if (noticeKey === lastUnmanagedAuthNoticeKey) {
        return;
      }

      lastUnmanagedAuthNoticeKey = noticeKey;
      unmanagedAuthNoticeInFlight = true;
      shouldRecheckAfterNotice = true;

      const addLabel = 'Add current profile';
      const manageLabel = 'Manage profiles';
      const selection = await vscode.window.showInformationMessage(
        `Current Codex account${displayAccountLabel(authData)} is not saved in Codex Multitool.`,
        addLabel,
        manageLabel
      );

      if (selection === addLabel) {
        await vscode.commands.executeCommand('codex-switch.profile.addFromCodexAuthFile');
      } else if (selection === manageLabel) {
        await vscode.commands.executeCommand('codex-switch.profile.manage');
      }
    } catch (error) {
      logger.error('Failed to notify about unmanaged current Codex account.', {
        error: error && error.message ? error.message : String(error)
      });
    } finally {
      unmanagedAuthNoticeInFlight = false;
      if (shouldRecheckAfterNotice) {
        void maybeNotifyUnmanagedCurrentProfile();
      }
    }
  };

  const refreshProfileUi = async () => {
    const refreshId = ++latestProfileUiRefreshId;

    try {
      if (!areProfileFeaturesEnabled()) {
        profileStatusBarController.update(null, []);
        return;
      }

      const profiles = await profileManager.listProfiles();
      const activeProfileId = await profileManager.getActiveProfileId();
      if (refreshId !== latestProfileUiRefreshId) {
        return;
      }

      if (!activeProfileId) {
        profileStatusBarController.update(null, profiles);
        void maybeNotifyUnmanagedCurrentProfile();
        return;
      }

      const activeProfile = profiles.find((profile) => profile.id === activeProfileId);
      if (refreshId !== latestProfileUiRefreshId) {
        return;
      }

      if (!activeProfile) {
        await profileManager.setActiveProfileId(undefined);
        return;
      }

      profileStatusBarController.update(activeProfile, profiles);
      void maybeNotifyUnmanagedCurrentProfile();
    } catch (error) {
      logger.error('Failed to refresh the Codex profile status UI.', {
        error: error && error.message ? error.message : String(error)
      });
      profileStatusBarController.update(null, []);
    }
  };

  const handleProfileWatcherChange = async (event = {}) => {
    if (!areProfileFeaturesEnabled()) {
      await refreshProfileUi();
      return;
    }

    let shouldAcceptAuthChange = false;
    let settledAuthData = null;
    if (event.source === 'auth') {
      const authRefreshId = ++latestAuthWatcherRefreshId;
      const readiness = await profileManager.waitForCurrentAuthData({
        timeoutMs: AUTH_WATCHER_SETTLE_TIMEOUT_MS,
        intervalMs: 500,
        stableMs: 250
      });
      if (authRefreshId !== latestAuthWatcherRefreshId) {
        return;
      }

      if (readiness.authData) {
        logger.info('Codex auth.json watcher settled on a valid account.', {
          authPath: readiness.authPath,
          waitedMs: readiness.waitedMs
        });
      } else {
        logger.warn('Codex auth.json watcher did not see a valid account before refresh.', {
          authPath: readiness.authPath,
          waitedMs: readiness.waitedMs
        });
      }
      settledAuthData = readiness.authData;
      shouldAcceptAuthChange = await shouldAcceptAuthChangeForThisWindow(settledAuthData);
    }

    if (event.source === 'auth' && shouldAcceptAuthChange) {
      clearExpectedWindowAuthChange();
      await profileManager.initializeWindowActiveProfileFromCurrentAuth(true);
    }

    await profileManager.syncCurrentAuthToMatchingProfile();
    await refreshProfileUi();
    await rateLimitMonitor.refresh(true);
  };

  registerProfileCommands(context, profileManager, rateLimitMonitor, refreshProfileUi, {
    markWindowAuthChangeExpected,
    onProfileSwitchCommitted: scheduleCodexPostSwitchWarmup
  });

  const ensureSendToCodexEnabled = async () => {
    if (isSendToCodexEnabled()) {
      return true;
    }

    const enableLabel = 'Enable Send to Codex';
    const selection = await vscode.window.showInformationMessage(
      'Send to Codex is currently disabled.',
      enableLabel
    );

    if (selection === enableLabel) {
      await vscode.workspace
        .getConfiguration(CONFIG_SECTION)
        .update(SEND_TO_CODEX_ENABLED_SETTING, true, vscode.ConfigurationTarget.Global);
      return true;
    }

    return false;
  };

  context.subscriptions.push(
    codexAvailabilityController.onDidChangeAvailability(() => {
      void editorStatusBarController.refresh();
      void statusBarController.refresh();
    }),
    profileManager.onDidChange(() => {
      void refreshProfileUi();
    }),
    rateLimitMonitor.onDidChange(() => {
      void refreshProfileUi();
    }),
    ...profileManager.createWatchers((event) => {
      void handleProfileWatcherChange(event);
    }),
    vscode.commands.registerCommand('codexTerminalRecorder.openLogDirectory', async () => {
      await manager.openLogDirectory();
    }),
    vscode.commands.registerCommand('codexTerminalRecorder.openDiagnosticsLog', async () => {
      if (!logger.isLogFileEnabled() && !logger.hasLogFile()) {
        void vscode.window.showInformationMessage(
          'Diagnostics log file is disabled. Enable it in settings or with the toggle command first.'
        );
        return;
      }

      logger.info('Opening diagnostics log from command.');
      await logger.flush();
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(logger.logFilePath));
      await vscode.window.showTextDocument(document, { preview: false });
    }),
    vscode.commands.registerCommand('codexTerminalRecorder.openActiveTerminalLog', async () => {
      await manager.openActiveTerminalLog();
    }),
    vscode.commands.registerCommand('codexTerminalRecorder.openSettings', async () => {
      await vscode.commands.executeCommand(
        'workbench.action.openSettings',
        `@ext:${context.extension.id}`
      );
    }),
    vscode.commands.registerCommand(
      'codexTerminalRecorder.internal.warmUpCodexAfterProfileSwitch',
      async () => {
        await warmUpCodexAfterProfileSwitch('manual-internal-command', logger, {
          restoreChatContext: getCodexChatContextForProfileSwitch(),
          restoreStrategy: getPostSwitchRestoreStrategy(),
          codexLogPath,
          sidebarResumeStartOffset: getFileSize(codexLogPath)
        });
      }
    ),
    vscode.commands.registerCommand(
      'codexTerminalRecorder.toggleDiagnosticsLogging',
      async () => {
        const enabled = await toggleBooleanSetting(
          'diagnosticsLoggingEnabled',
          DIAGNOSTICS_LOGGING_ENABLED_DEFAULT
        );
        logger.reloadConfiguration();
        void vscode.window.showInformationMessage(
          `Send to Codex diagnostics logging ${enabled ? 'enabled' : 'disabled'}.`
        );
      }
    ),
    vscode.commands.registerCommand(
      'codexTerminalRecorder.toggleDiagnosticsLogFile',
      async () => {
        const configuration = vscode.workspace.getConfiguration(CONFIG_SECTION);
        const current = Boolean(
          configuration.get('diagnosticsLogFileEnabled', DIAGNOSTICS_LOG_FILE_ENABLED_DEFAULT)
        );
        const next = !current;

        await configuration.update(
          'diagnosticsLogFileEnabled',
          next,
          vscode.ConfigurationTarget.Global
        );
        if (next) {
          await configuration.update(
            'diagnosticsLoggingEnabled',
            true,
            vscode.ConfigurationTarget.Global
          );
        }

        logger.reloadConfiguration();
        void vscode.window.showInformationMessage(
          `Send to Codex diagnostics log file ${next ? 'enabled' : 'disabled'}.`
        );
      }),
    vscode.commands.registerCommand(
      'codexTerminalRecorder.addExplorerResourceToCodexChat',
      async (resource, selection) => {
        if (!(await ensureSendToCodexEnabled())) {
          return;
        }
        await explorerResourcesSender.sendExplorerResourcesToCodexChat(resource, selection);
      }
    ),
    vscode.commands.registerCommand(
      'codexTerminalRecorder.addExplorerFolderToCodexChat',
      async (resource, selection) => {
        if (!(await ensureSendToCodexEnabled())) {
          return;
        }
        await explorerResourcesSender.sendExplorerResourcesToCodexChat(resource, selection);
      }
    ),
    vscode.commands.registerCommand(
      'codexTerminalRecorder.locateActiveTerminalSelection',
      async () => {
        await selectionLocator.locateActiveTerminalSelection();
      }
    ),
    vscode.commands.registerCommand(
      'codexTerminalRecorder.sendActiveEditorSelectionToCodexChat',
      async () => {
        if (!(await ensureSendToCodexEnabled())) {
          return;
        }
        await editorSender.sendActiveEditorSelectionToCodexChat();
      }
    ),
    vscode.commands.registerCommand(
      'codexTerminalRecorder.sendActiveTerminalSelectionToCodexChat',
      async () => {
        if (!(await ensureSendToCodexEnabled())) {
          return;
        }
        await codexSender.sendActiveTerminalSelectionToCodexChat();
      }
    ),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(CONFIG_SECTION)) {
        logger.reloadConfiguration();
        void manager.reloadConfiguration(true);
        void codexAvailabilityController.refresh();
        void editorStatusBarController.refresh();
        void statusBarController.refresh();
      }

      if (
        event.affectsConfiguration('codexSwitch') ||
        event.affectsConfiguration('codexRatelimit')
      ) {
        void refreshProfileUi();
      }

      if (event.affectsConfiguration('codexSwitch.enabled') && areProfileFeaturesEnabled()) {
        void (async () => {
          await profileManager.syncCurrentAuthToMatchingProfile();
          await profileManager.syncActiveProfileToCodexAuthFile();
          await rateLimitMonitor.refresh(true);
        })();
      }
    })
  );

  codexAvailabilityController.activate();
  rateLimitMonitor.activate();
  nativeSelectionOverlayController.activate();
  editorStatusBarController.activate();
  statusBarController.activate();
  logger.info('Extension controllers activated.', {
    diagnosticsLogPath: logger.logFilePath,
    outputChannelName: OUTPUT_CHANNEL_NAME,
    openAiExtensionInstalled: Boolean(vscode.extensions.getExtension('openai.chatgpt')),
    terminalWriteApiAvailable: isTerminalWriteApiAvailable()
  });
  void refreshProfileUi();
  void runPendingCodexPostSwitchWarmup();
  if (areProfileFeaturesEnabled()) {
    void (async () => {
      await profileManager.syncCurrentAuthToMatchingProfile();
      await profileManager.syncActiveProfileToCodexAuthFile();
      await rateLimitMonitor.refresh(true);
    })();
  }
  void manager.activate();
}

async function toggleBooleanSetting(settingName, defaultValue) {
  const configuration = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const next = !Boolean(configuration.get(settingName, defaultValue));
  await configuration.update(settingName, next, vscode.ConfigurationTarget.Global);
  return next;
}

function deactivate() {}

function isTerminalWriteApiAvailable() {
  try {
    return typeof vscode.window.onDidWriteTerminalData === 'function';
  } catch {
    return false;
  }
}

module.exports = {
  activate,
  deactivate
};
