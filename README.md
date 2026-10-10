# Claudian Usage

Remaining Claude and ChatGPT/Codex allowances in the Obsidian status bar.

```text
Claude  5 h 69% · 45 min  week 81% · Thu 12:00 | ChatGPT  week 99% · Sat 14:27
```

The percentages are **remaining**, not spent. Hover for the used percentage, exact reset time, data age and next refresh. Click the status item to refresh both services.

## Data sources

| Service | Source | Model request? |
|---|---|---|
| Claude | Claude Code account plus `api.anthropic.com/api/oauth/usage` | No |
| ChatGPT/Codex | local `codex app-server` method `account/rateLimits/read` | No |

For Claude, the plugin reads the credential from the macOS Keychain or `~/.claude/.credentials.json` on Linux. It never writes the token to settings or logs.

For ChatGPT, the plugin does **not** read the OpenAI OAuth token. Codex owns authentication and returns only quota metadata to the plugin. ChatGPT display requires Codex CLI to be installed and signed in with a ChatGPT account.

## Refresh behavior

- Claude: every 2 minutes while Claude Code is active, every 15 minutes while idle.
- ChatGPT/Codex: every 5 minutes by default.
- A 30-second heartbeat catches up after Obsidian has been backgrounded.
- Expired windows are removed instead of showing a percentage from the previous window.
- Old readings are dimmed and their age is shown in the tooltip.

All intervals and visible gauges can be changed in **Settings → Claudian Usage**.

## Install

**BRAT:** add `FedorovVadim/obsidian-claudian-usage`, then enable **Claudian Usage**.

**Manual:** copy `main.js`, `manifest.json`, and `styles.css` into:

```text
<vault>/.obsidian/plugins/claudian-usage/
```

Restart Obsidian after updating the plugin.

## Development

```bash
node --check main.js
node tests/check.js
node tests/chatgpt.js
node tests/e2e-onload.js
python3 tests/blind.py
bash install.sh /path/to/vault
```

## Troubleshooting

| Status text | Action |
|---|---|
| `Claude · запусти claude` | Run `claude`; sign in only if Claude Code asks. |
| `Claude · просит войти заново` | Run `claude` and sign in. |
| `ChatGPT · Codex CLI не найден` | Install Codex CLI or set `CODEX_BIN` to its executable. |
| `ChatGPT · ChatGPT просит войти в Codex` | Run `codex login`. |
| Dimmed gauges | The saved reading is older than the configured refresh interval. |

## License

MIT © Vadim Fedorov

---

## По-русски

Плагин показывает внизу Obsidian **остатки** лимитов Claude и ChatGPT/Codex. Например, `69%` означает, что осталось 69 %, а не что столько израсходовано.

Claude читается из служебного счётчика Claude Code. ChatGPT читается через локальный `codex app-server`: сам плагин не получает OAuth-пропуск и не вызывает модель. Для шкалы ChatGPT нужен установленный Codex CLI со входом в нужную учётную запись ChatGPT.

Наведение показывает расход, точное время сброса и возраст цифр. Нажатие обновляет оба счётчика. Установка через BRAT: `FedorovVadim/obsidian-claudian-usage`.
