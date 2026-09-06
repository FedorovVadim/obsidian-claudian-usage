'use strict';

/*
 * Claudian Usage — строка внизу окна Obsidian:
 * под какой учётной записью выполнен вход в Claude Code и сколько израсходовано
 * по двум лимитам — пятичасовому окну и недельному.
 *
 * Откуда берутся данные (всё локально, ни одного обращения к модели):
 *   • почта      — ~/.claude.json, поле oauthAccount.emailAddress (просто чтение файла);
 *   • пропуск    — связка ключей macOS, запись «Claude Code-credentials»;
 *   • расход     — служебный адрес api.anthropic.com/api/oauth/usage — тот же,
 *                  откуда счётчик берёт само приложение Claude.
 *
 * ⚠️ Токены не расходуются: это справочный адрес про лимиты, а не запрос к модели.
 * Ответ не тарифицируется и в счётчик расхода не попадает — проверено 06.09.2026
 * замером «до и после» (см. заметку про плагин в хранилище).
 *
 * Пропуск наружу не уходит: используется только для этого одного адреса
 * и нигде не сохраняется — ни в настройках, ни в журнале.
 */

const { Plugin, PluginSettingTab, Setting, Notice, requestUrl } = require('obsidian');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

const DEFAULTS = {
  refreshSec: 600,       // как часто обновлять шкалы (запас обращений у счётчика очень небольшой)
  lastUsage: null,       // последние прочитанные цифры — чтобы после запуска не быть пустым
  lastUsageAt: null,     // когда они прочитаны
  showEmail: true,       // показывать почту учётной записи
  showFiveHour: true,    // шкала пятичасового окна
  showWeekly: true,      // шкала недельного лимита
  warnPercent: 80,       // с какого процента красить в тревожный цвет
};

// ────────────────────────────────────────────────────────────────────────────
// Источники данных
// ────────────────────────────────────────────────────────────────────────────

/** Почта учётной записи, под которой выполнен вход в Claude Code */
function readAccountEmail() {
  try {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const raw = fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8');
    const acc = (JSON.parse(raw) || {}).oauthAccount || {};
    return acc.emailAddress || null;
  } catch (e) {
    return null;
  }
}

/** Пропуск Claude Code из связки ключей macOS */
function readAccessToken() {
  const { execFileSync } = require('child_process');
  const raw = execFileSync(
    '/usr/bin/security',
    ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
    { encoding: 'utf8', timeout: 10000 },
  );
  const oauth = (JSON.parse(raw) || {}).claudeAiOauth || {};
  if (!oauth.accessToken) throw new Error('в связке ключей нет пропуска');
  return oauth.accessToken;
}

/** Проценты расхода по двум лимитам */
async function fetchUsage() {
  const token = readAccessToken();
  const resp = await requestUrl({
    url: USAGE_URL,
    method: 'GET',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
      'anthropic-beta': 'oauth-2025-04-20',
    },
    throw: false,
  });
  if (resp.status === 401 || resp.status === 403) throw new Error('вход устарел');
  if (resp.status === 429) {
    // у счётчика свой предел частоты обращений: он сам говорит, сколько подождать
    const headers = resp.headers || {};
    const after = Number(headers['retry-after'] || headers['Retry-After'] || 120);
    const err = new Error('счётчик просит подождать');
    err.retryAfter = Number.isFinite(after) ? after : 120;
    throw err;
  }
  if (resp.status >= 400) throw new Error('сервис ответил ' + resp.status);

  const data = resp.json || {};
  const pick = (node) => {
    if (!node || node.utilization === null || node.utilization === undefined) return null;
    return { percent: Number(node.utilization), resetsAt: node.resets_at || null };
  };
  return {
    fiveHour: pick(data.five_hour),
    weekly: pick(data.seven_day),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Показ времени сброса
// ────────────────────────────────────────────────────────────────────────────

function humanReset(resetsAt) {
  if (!resetsAt) return 'время сброса неизвестно';
  const when = new Date(resetsAt);
  if (isNaN(when.getTime())) return 'время сброса неизвестно';
  const left = when.getTime() - Date.now();
  if (left <= 0) return 'сбрасывается прямо сейчас';

  const totalMin = Math.round(left / 60000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;

  const parts = [];
  if (days) parts.push(days + ' дн');
  if (hours) parts.push(hours + ' ч');
  if (!days && mins) parts.push(mins + ' мин');

  const clock = when.toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  return 'обнулится через ' + (parts.join(' ') || 'меньше минуты') + ' — ' + clock;
}

// ────────────────────────────────────────────────────────────────────────────
// Плагин
// ────────────────────────────────────────────────────────────────────────────

module.exports = class ClaudianUsagePlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
    // цифры с прошлого запуска показываем сразу: лучше «час назад», чем пусто
    this.usage = this.settings.lastUsage || null;
    this.error = null;
    this.updatedAt = this.settings.lastUsageAt || null;
    this.failStreak = 0;
    this.email = readAccountEmail();

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass('cu-status');
    this.statusEl.addEventListener('click', () => this.refresh(true));

    this.addCommand({
      id: 'refresh',
      name: 'Обновить расход Claude',
      callback: () => this.refresh(true),
    });

    this.addSettingTab(new ClaudianUsageSettingTab(this.app, this));

    this.render();
    this.refresh(false);
    this.scheduleRefresh();

    // вернулись к окну — показываем свежее, а не то, что было полчаса назад
    this.registerDomEvent(window, 'focus', () => {
      if (!this.updatedAt || Date.now() - this.updatedAt > 300000) this.refresh(false);
    });
  }

  onunload() {
    if (this.retryTimer) window.clearTimeout(this.retryTimer);
  }

  scheduleRefresh() {
    if (this.timer) window.clearInterval(this.timer);
    const sec = Math.max(300, Number(this.settings.refreshSec) || 600);
    this.timer = window.setInterval(() => this.refresh(false), sec * 1000);
    this.registerInterval(this.timer);
  }

  async refresh(loud) {
    // счётчик попросил паузу — молча ждём, старые цифры остаются на экране
    if (this.backoffUntil && Date.now() < this.backoffUntil) {
      const left = Math.ceil((this.backoffUntil - Date.now()) / 1000);
      if (loud) new Notice('Счётчик просит подождать ещё ' + left + ' сек — пока показываю прошлые цифры', 5000);
      this.render();
      return;
    }
    try {
      this.usage = await fetchUsage();
      this.error = null;
      this.backoffUntil = 0;
      this.updatedAt = Date.now();
      this.failStreak = 0;
      this.settings.lastUsage = this.usage;
      this.settings.lastUsageAt = this.updatedAt;
      await this.saveData(this.settings);
      this.email = readAccountEmail() || this.email;
      if (loud) new Notice(this.summaryText(), 6000);
    } catch (e) {
      this.error = (e && e.message) ? e.message : String(e);
      if (e && e.retryAfter) {
        // сервис иногда отвечает «подожди 0 секунд» и снова отказывает.
        // Держим свою нижнюю границу и увеличиваем паузу с каждым отказом:
        // 2 минуты, 5, 10, 20 и дальше не чаще получаса.
        this.failStreak = (this.failStreak || 0) + 1;
        const ladder = [120, 300, 600, 1200, 1800];
        const own = ladder[Math.min(this.failStreak - 1, ladder.length - 1)];
        const waitMs = Math.max(own, e.retryAfter + 5) * 1000;
        this.backoffUntil = Date.now() + waitMs;
        // не ждём очередного круга опроса: спросим ровно тогда, когда разрешили
        if (this.retryTimer) window.clearTimeout(this.retryTimer);
        this.retryTimer = window.setTimeout(() => this.refresh(false), waitMs + 1000);
      }
      if (loud) new Notice('Расход Claude не читается: ' + this.error, 6000);
    }
    this.render();
  }

  summaryText() {
    if (!this.usage) return 'Расход Claude пока не прочитан';
    const rows = [];
    if (this.usage.fiveHour) {
      rows.push('Пять часов: ' + Math.round(this.usage.fiveHour.percent) + '% — ' + humanReset(this.usage.fiveHour.resetsAt));
    }
    if (this.usage.weekly) {
      rows.push('Неделя: ' + Math.round(this.usage.weekly.percent) + '% — ' + humanReset(this.usage.weekly.resetsAt));
    }
    if (this.email) rows.push('Вход: ' + this.email);
    return rows.join('\n');
  }

  render() {
    const el = this.statusEl;
    el.empty();
    el.toggleClass('cu-stale', !!this.error);

    if (this.settings.showEmail && this.email) {
      const acc = el.createSpan({ cls: 'cu-account', text: this.email });
      acc.setAttribute('title', 'Учётная запись Claude Code');
    }

    if (this.error && !this.usage) {
      // пока цифр нет, но причина временная — не пугаем красными словами
      const waiting = this.backoffUntil && Date.now() < this.backoffUntil;
      const hint = this.error === 'вход устарел' ? 'Claude Code просит войти заново'
                 : waiting ? 'жду счётчик…'
                 : 'расход не читается: ' + this.error;
      el.createSpan({ cls: 'cu-error', text: hint });
      el.setAttribute('title', waiting
        ? 'Счётчик ограничивает частоту обращений. Сам спрошу ещё раз через несколько секунд.'
        : 'Нажми, чтобы попробовать ещё раз');
      return;
    }
    if (!this.usage) {
      el.createSpan({ cls: 'cu-error', text: 'считаю…' });
      return;
    }

    if (this.settings.showFiveHour) this.renderGauge(el, '5 ч', this.usage.fiveHour);
    if (this.settings.showWeekly) this.renderGauge(el, 'нед', this.usage.weekly);

    const stamp = this.updatedAt
      ? new Date(this.updatedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
      : '—';
    el.setAttribute('title',
      this.summaryText() +
      '\nОбновлено в ' + stamp + (this.error ? ' (последняя попытка не удалась: ' + this.error + ')' : '') +
      '\nНажми, чтобы обновить сейчас. Токены на это не тратятся.');
  }

  renderGauge(parent, label, node) {
    if (!node) return;
    const percent = Math.max(0, Math.min(100, Number(node.percent) || 0));
    const wrap = parent.createSpan({ cls: 'cu-gauge' });
    wrap.createSpan({ cls: 'cu-label', text: label });
    const bar = wrap.createSpan({ cls: 'cu-bar' });
    const fill = bar.createSpan({ cls: 'cu-fill' });
    fill.style.width = percent + '%';
    const warn = Number(this.settings.warnPercent) || 80;
    if (percent >= 95) fill.addClass('is-critical');
    else if (percent >= warn) fill.addClass('is-warn');
    wrap.createSpan({ cls: 'cu-num', text: Math.round(percent) + '%' });
  }
};

// ────────────────────────────────────────────────────────────────────────────
// Настройки
// ────────────────────────────────────────────────────────────────────────────

class ClaudianUsageSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }

  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    const save = async () => { await this.plugin.saveData(s); this.plugin.render(); };

    containerEl.empty();
    containerEl.createEl('h2', { text: 'Claudian Usage — расход Claude внизу окна' });
    containerEl.createEl('p', {
      text: 'Данные берутся из того же служебного счётчика, что показывает само приложение Claude. '
          + 'Это справочный запрос про лимиты, а не обращение к модели — токены на него не тратятся.',
      cls: 'setting-item-description',
    });

    new Setting(containerEl)
      .setName('Показывать почту учётной записи')
      .addToggle(t => t.setValue(s.showEmail).onChange(async v => { s.showEmail = v; await save(); }));

    new Setting(containerEl)
      .setName('Шкала пятичасового окна')
      .addToggle(t => t.setValue(s.showFiveHour).onChange(async v => { s.showFiveHour = v; await save(); }));

    new Setting(containerEl)
      .setName('Шкала недельного лимита')
      .addToggle(t => t.setValue(s.showWeekly).onChange(async v => { s.showWeekly = v; await save(); }));

    new Setting(containerEl)
      .setName('Как часто обновлять')
      .setDesc('В секундах. Чаще пяти минут нельзя: запас обращений у счётчика очень небольшой. Лимиты живут часами, так что чаще и незачем.')
      .addSlider(sl => sl.setLimits(300, 1800, 60).setValue(s.refreshSec).setDynamicTooltip()
        .onChange(async v => { s.refreshSec = v; await save(); this.plugin.scheduleRefresh(); }));

    new Setting(containerEl)
      .setName('С какого процента подсвечивать')
      .setDesc('Ниже — спокойный цвет, выше — тревожный. С 95 % шкала краснеет.')
      .addSlider(sl => sl.setLimits(50, 95, 5).setValue(s.warnPercent).setDynamicTooltip()
        .onChange(async v => { s.warnPercent = v; await save(); }));

    new Setting(containerEl)
      .setName('Проверить сейчас')
      .addButton(b => b.setButtonText('Обновить').onClick(() => this.plugin.refresh(true)));
  }
}
