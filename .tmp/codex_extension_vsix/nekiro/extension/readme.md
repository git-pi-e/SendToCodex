# Codex Account Switcher

Switch between multiple Codex accounts directly from VS Code — no manual file copying required.

## Features

- **Switch accounts** — quickly switch between saved Codex accounts via a quick pick menu
- **Save current account** — save the currently signed-in account under a custom name
- **Add new account** — clear the current session and sign into a new account, then save it
- **Delete account** — remove a saved account archive
- **Status bar indicator** — always see which account is currently active at a glance

## Usage

All commands are available via the **Command Palette** (`Ctrl+Shift+P`):

| Command                       | Description                                      |
| ----------------------------- | ------------------------------------------------ |
| `Codex: Switch Account`       | Open account picker and switch                   |
| `Codex: Save Current Account` | Save the current session under a name            |
| `Codex: Add New Account`      | Clear session and prepare a slot for a new login |
| `Codex: Delete Account`       | Delete a saved account archive                   |
| `Codex: Refresh Status`       | Refresh the status bar indicator                 |

You can also click the **status bar item** (bottom left) to quickly open the account switcher.

## How it works

The extension archives and restores the `.codex` folder in your user directory. Each saved account is stored as a separate zip archive. Switching accounts replaces the active `.codex` folder with the selected archive and reloads VS Code.

## Requirements

- VS Code `1.85.0` or newer
- Codex extension installed and at least one account signed in

## License

MIT
