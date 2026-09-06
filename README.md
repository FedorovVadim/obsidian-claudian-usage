# Claudian Usage

Your Claude Code account and two live limit gauges — five-hour session and weekly — in the Obsidian status bar.

```
fedorovvadim@example.com    5 ч ▓▓░░░░ 13%    нед ▓▓▓░░░ 16%
```

Hover to see when each limit resets. Click to refresh right away. The bar turns amber at 80 % and red at 95 %.

> macOS only — the access token is read from the macOS Keychain.

---

## It does not spend tokens

The plugin never talks to a model. It reads the same usage endpoint the Claude app itself uses to draw your limits — a metadata call about quotas, not an inference request.

Measured rather than assumed: 30+ consecutive calls did not move the weekly figure at all (16.0 % before, 16.0 % after), and two control readings a minute apart returned identical numbers.

**Side finding from that test:** the endpoint has its own rate limit. A burst of 30 calls gets `429` with `Retry-After: 133`. So the plugin polls every 90 seconds, refuses to go below 60, and when it does get throttled it waits exactly as long as asked while keeping the previous numbers on screen instead of flashing an error.

## Where the data comes from

| What | Source | Leaves your machine? |
|---|---|---|
| Account e-mail | `~/.claude.json` → `oauthAccount.emailAddress` | no, read only |
| Access token | macOS Keychain, item `Claude Code-credentials` | only to Anthropic's usage endpoint |
| Percentages, reset times | `api.anthropic.com/api/oauth/usage` | — |

The token is never written to plugin settings, logs or your vault. It is read fresh on every poll, so when Claude Code refreshes it, the plugin follows automatically.

## Install

**Via [BRAT](https://github.com/TfTHacker/obsidian42-brat) (recommended)**

1. Install BRAT from Community Plugins.
2. BRAT → *Add Beta plugin* → paste `FedorovVadim/obsidian-claudian-usage`.
3. Enable **Claudian Usage** in Community Plugins.

**Manually**

Download `main.js`, `manifest.json`, `styles.css` from the [latest release](../../releases/latest) into `<vault>/.obsidian/plugins/claudian-usage/`, then restart Obsidian.

No configuration needed — if you are logged into Claude Code, the numbers appear on their own.

## Settings

Hide the e-mail, show only one of the gauges, change the poll interval (60–300 s) or the warning threshold.

## Troubleshooting

| What you see | What it means |
|---|---|
| `Claude Code просит войти заново` | The token expired. Run `claude` in a terminal and log in — no Obsidian restart needed. |
| `считаю…` that never changes | Keychain item missing. Check `security find-generic-password -s "Claude Code-credentials" -w`. |
| Numbers stop updating for a couple of minutes | The endpoint throttled us; the plugin is waiting it out on purpose. |

## Position in the status bar

The status item asks to be leftmost (`order: -100`). Other plugins may still land to its left depending on load order — override `.cu-status { order: … }` in a CSS snippet if you want it elsewhere.

## Interface language

Russian, same as its sibling [Claudian Voice](https://github.com/FedorovVadim/obsidian-claudian-voice). Pull requests adding i18n are welcome.

## License

MIT © Vadim Fedorov

---

## По-русски

Внизу окна видно, под какой почтой выполнен вход в Claude Code, и две шкалы расхода — пятичасовое окно и неделя. Наведёшь мышь — покажет, когда лимит обнулится; нажмёшь — обновит сразу.

Токены не тратит: читает служебный счётчик лимитов, тот же, что и само приложение Claude. Проверено замером — тридцать обращений подряд не сдвинули недельный расход. У счётчика есть свой предел частоты, поэтому плагин спрашивает раз в полторы минуты, а при отказе молча ждёт и показывает прошлые цифры.

Установка через BRAT: адрес `FedorovVadim/obsidian-claudian-usage`. Настраивать ничего не нужно.
