## Sourced observations

Your repo is already beyond the basic switchers: it combines Send-to-Codex, profile switching, per-profile 5h/weekly limit display, import/export, current `auth.json` import, file import, reauth, reload-after-switch, workspace/global active profile scope, and SecretStorage/remote-file storage modes. 

Most public tools converge on the same foundation: Codex auth is treated as a local `~/.codex/auth.json` payload, and switching means restoring a saved copy/snapshot. Loongphy’s `codex-auth`, luccasoliva’s Marketplace extension, nekiro’s Marketplace extension, and the OpenClaw skill all describe this basic save/switch model. ([GitHub][1])

The mature tools emphasize that a switch may not affect an already-running client until restart/reload. Loongphy explicitly says Codex CLI/App users should restart after switching; the official Codex IDE docs also mention restarting VS Code if the extension does not appear after install, and Dondake exposes reload behavior as a setting. ([GitHub][2])

Usage data is the hardest part. Loongphy documents two usage sources: direct API usage and local session-file scanning, and warns that local `rate_limits` can be stale or null while API probing sends the access token to OpenAI/ChatGPT endpoints and may carry risk. ([GitHub][1]) Dondake uses a more productized version of this: usage source mode, status-bar usage, details panel, history, “Unknown” when no fresh data exists, and graceful fallback from experimental web probing. ([Visual Studio Marketplace][3])

The OpenClaw skill has two especially good ideas: explicit sensitive-file declarations/security model, and explicit `sync`/`--sync` rather than silently propagating tokens to other agent stores. It also logs account switch activity so session-derived usage can be attributed to the account active at the time. ([GitHub][4])

The simple VS Code extensions focus on UX basics: luccasoliva exposes an Activity Bar panel, creates a backup before switching, uses isolated `CODEX_HOME` when adding a session, and says credentials stay local; nekiro advertises QuickPick switching, “save current account,” “add new account,” delete, and a status bar indicator. ([Visual Studio Marketplace][5])

bjesuiter’s `cdx` is useful mostly for operational hardening ideas: cross-platform secure storage, `doctor`/keyring checks, `relogin`, `usage`, `--next`, direct ID/label switching, and validation of target auth paths for Codex/OpenCode/Pi. ([GitHub][6]) VS Code’s own docs say `ExtensionContext.secrets` is encrypted global storage for sensitive data and not synced across machines, so using SecretStorage as your default remains the right VS Code-native baseline. ([Visual Studio Code][7])

## Prioritized recommendations for your codebase

1. **Add an isolated “Add new profile without disturbing current auth” flow.**
   Today your flow appears to run `codex logout && codex login` against the active Codex home, then import the resulting `auth.json`. Keep that for reauth, but add a safer add-new command that creates a temp profile home, runs Codex login with `CODEX_HOME=<temp>`, imports `<temp>/auth.json`, and then removes or archives the temp folder. This adopts luccasoliva’s isolated-session idea and avoids temporarily breaking the active account.

2. **Add pre-switch backups and a one-click restore/recover action.**
   You already write `auth.json` via temp file + rename/copy, which is good, but public tools make recovery visible. Before overwriting the active `auth.json`, save a timestamped backup of any unmanaged/current payload, then expose “Restore last active auth backup” in Manage Profiles. This is cheap and protects against broken profile metadata, interrupted WSL path resolution, or an unexpected Codex auth format change.

3. **Make usage source transparency first-class.**
   Your settings already include `codexRatelimit.preferUsageApi` and a local sessions fallback. Add a visible “last refresh source/outcome” everywhere usage is shown: `usage API`, `local sessions`, `cached`, `unknown`, `no newer data`, `auth failed`, or `rate_limits null`. Dondake’s “Unknown instead of pretending” is exactly right. The status bar should avoid optimistic green when data is stale.

4. **Do not auto-enable undocumented web/API probing.**
   Keep API-backed usage as explicit opt-in or clearly documented default with a warning. Loongphy’s README is unusually transparent that API refresh sends ChatGPT access tokens to specific endpoints and may carry risk. For your extension, label it as “live usage refresh” with a tooltip explaining what is sent, and provide `localOnly`, `appServer/API`, and `auto` modes.

5. **Add low-usage switch suggestions, not silent auto-switch by default.**
   Your QuickPick already shows compact per-profile 5h/weekly state. Next step: when active profile is near exhausted and another profile has recent cached capacity, show “Switch to <profile>?” with a freshness threshold. Default should be `ask`, not `auto`; silent switching can surprise users and can disrupt a running Codex session.

6. **Add privacy masking for profile names/emails.**
   Dondake’s masking option is worth copying as a product idea. Implement `codexSwitch.maskProfileNames` and `codexSwitch.maskProfileEmails` across status bar, QuickPick descriptions, details webview, diagnostics, and logs. This is especially useful for screen sharing and bug reports.

7. **Add a diagnostics/doctor panel for profile switching only.**
   You already have diagnostics logging, but profile auth deserves a focused “Codex Multitool: Profile Doctor”: resolved native/WSL `auth.json` path, whether `openai.chatgpt` is installed, Codex CLI availability, current active profile match, storage mode, auth watcher state, last switch result, last usage refresh source, and stale/broken token warnings. bjesuiter’s `doctor`/keyring focus is the right mental model.

8. **Encrypt profile exports.**
   Your `storageMode: secretStorage` is good for normal use, but exported profile bundles are the dangerous path. Add export choices: “Encrypted, recommended” and “Plain JSON, advanced.” Use a passphrase-based AES-GCM format with versioned metadata, and keep old plain JSON import support for compatibility. Dondake already validates this as a user-facing feature. ([Visual Studio Marketplace][3])

9. **Track profile-specific Codex config state only after auth is stable.**
   Dondake preserves Codex config state per profile, which is powerful for different model/reasoning defaults. I would not do this immediately unless users ask. Auth switching is already high-risk; preserving `config.toml` per profile adds another mutable file and more edge cases. Put it behind a future setting like `codexSwitch.preserveProfileConfig`.

10. **Keep the architecture inside VS Code, not as a bundled CLI clone.**
    The CLI tools have useful ideas, but your extension already has the better host context: status bar, QuickPick, SecretStorage, webview details, WSL setting awareness, and OpenAI extension warm-up. Adopt their flows and failure handling, not their storage layout or scripts.

[1]: https://github.com/Loongphy/codex-auth/blob/main/README.md "codex-auth/README.md at main · Loongphy/codex-auth · GitHub"
[2]: https://github.com/loongphy/codex-auth "GitHub - Loongphy/codex-auth: A CLI tool to switch and manage Codex accounts · GitHub"
[3]: https://marketplace.visualstudio.com/items?itemName=DondakeLtd.vscode-codex-switcher "
        Codex Account Switcher - Visual Studio Marketplace
    "
[4]: https://raw.githubusercontent.com/openclaw/skills/main/skills/odrobnik/codex-account-switcher/SKILL.md "raw.githubusercontent.com"
[5]: https://marketplace.visualstudio.com/items?itemName=luccasoliva.codex-switcher&utm_source=chatgpt.com "Codex Session Switcher"
[6]: https://github.com/bjesuiter/codex-switcher "GitHub - bjesuiter/codex-switcher: Switch pi, codex and opencode auth between multiple openAI Plus and Pro accounts · GitHub"
[7]: https://code.visualstudio.com/api/extension-capabilities/common-capabilities?utm_source=chatgpt.com "Common Capabilities | Visual Studio Code Extension API"
