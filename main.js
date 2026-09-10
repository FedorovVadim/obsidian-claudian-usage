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
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Почему обновление устроено именно так (важно, версия 1.4.0)
 *
 * У этого адреса свой предел частоты обращений, и делим мы его с самим
 * Claude Code: он спрашивает тот же счётчик, и когда работают несколько
 * его окон сразу, плагину отвечают «слишком часто» (429). Раньше плагин
 * после такого отказа замолкал на срок до получаса, цифры на экране
 * застывали, и выглядело это как «сам не обновляется, надо нажимать».
 *
 * Теперь три правила:
 *   1. Просыпаемся каждые 30 секунд и решаем по часам, пора ли спрашивать.
 *      Прошлая версия полагалась на один длинный таймер, а Obsidian в фоне
 *      такие таймеры придерживает — отсюда ещё часть «застываний».
 *   2. Спрашиваем часто, только когда Claude Code работает (это видно по его
 *      служебным файлам). Когда он молчит, расти проценту неоткуда — и мы
 *      не тратим обращения впустую, оставляя запас на рабочие минуты.
 *   3. Отказ «слишком часто» — обычное дело, а не поломка: ждём ровно
 *      столько, сколько назвал сервис, и молча возвращаемся сами.
 */

const { Plugin, PluginSettingTab, Setting, Notice, requestUrl } = require('obsidian');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

const TICK_MS = 30000;      // как часто плагин просыпается и решает, спрашивать ли счётчик
const MIN_GAP_MS = 45000;   // ближе этого к прошлому обращению не спрашиваем никогда
const PAUSE_MIN_SEC = 30;   // нижняя граница паузы после отказа
const PAUSE_MAX_SEC = 600;  // верхняя граница той же паузы — дольше 10 минут не молчим

const DEFAULTS = {
  activeSec: 120,        // как часто обновлять, пока Claude Code работает
  idleSec: 900,          // как часто обновлять, когда он молчит
  showEmail: true,       // показывать почту учётной записи
  showFiveHour: true,    // шкала пятичасового окна
  showWeekly: true,      // шкала недельного лимита
  warnPercent: 80,       // с какого процента красить в тревожный цвет
  lastUsage: null,       // последние прочитанные цифры — чтобы после запуска не быть пустым
  lastUsageAt: null,     // когда они прочитаны
  lastOutcome: null,     // чем закончилось последнее обращение — видно в настройках
  pauseUntil: 0,         // до какого времени счётчик просил не беспокоить (переживает перезапуск)
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

/**
 * Работал ли Claude Code после указанного момента.
 *
 * Пока он занят, он постоянно переписывает свои служебные файлы — по их времени
 * изменения и видно, что расход прямо сейчас растёт. Это несколько обращений
 * к файловой системе, сеть не трогается вовсе.
 *
 * Осознанное упущение: расход с сайта claude.ai и с телефона идёт в тот же лимит,
 * а локальных следов не оставляет. Поэтому в спокойном режиме мы всё равно
 * заглядываем к счётчику раз в четверть часа — иначе такой расход остался бы незамеченным.
 */
function busyMarkers() {
  const os = require('os');
  const path = require('path');
  const home = os.homedir();
  // Рабочая лошадка здесь одна — ~/.claude.json: Claude Code переписывает его
  // каждые 15-60 секунд, пока занят. Две папки ниже меняются заметно реже
  // (только когда внутри появляется новый файл) и идут вторым эшелоном.
  return [
    path.join(home, '.claude.json'),
    path.join(home, '.claude', 'telemetry'),
    path.join(home, '.claude', 'session-env'),
  ];
}

function claudeBusySince(sinceMs, marks) {
  if (!sinceMs) return true;
  const fs = require('fs');
  for (const p of (marks || busyMarkers())) {
    try {
      if (fs.statSync(p).mtimeMs > sinceMs) return true;
    } catch (e) { /* нет файла — просто не признак */ }
  }
  return false;
}

/**
 * Пропуск Claude Code из связки ключей macOS.
 *
 * Читаем не блокирующе: связка может попросить отпечаток или быть заперта,
 * и тогда синхронное чтение подвесило бы всё окно Obsidian на десять секунд.
 * Текст ошибки наружу не отдаём — в нём мог бы оказаться кусок самого пропуска.
 */
function readAccessToken() {
  const { execFile } = require('child_process');
  return new Promise((resolve, reject) => {
    execFile(
      '/usr/bin/security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
      { encoding: 'utf8', timeout: 10000 },
      (err, stdout) => {
        if (err) return reject(new Error('связка ключей не отдала пропуск'));
        let token = null;
        try {
          token = ((JSON.parse(stdout) || {}).claudeAiOauth || {}).accessToken || null;
        } catch (e) {
          return reject(new Error('запись в связке ключей не читается'));
        }
        if (!token) return reject(new Error('в связке ключей нет пропуска'));
        resolve(token);
      },
    );
  });
}

/** Проценты расхода по двум лимитам */
async function fetchUsage() {
  const token = await readAccessToken();
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

  if (resp.status === 401 || resp.status === 403) {
    const err = new Error('вход устарел');
    err.status = resp.status;
    throw err;
  }
  if (resp.status === 429) {
    // у счётчика свой предел частоты обращений: он сам говорит, сколько подождать.
    // Иногда называет ноль и тут же отказывает снова — такому сроку не верим,
    // ниже подставим собственную нижнюю границу.
    const headers = resp.headers || {};
    const after = Number(headers['retry-after'] || headers['Retry-After']);
    const err = new Error('счётчик просит подождать');
    err.status = 429;
    err.retryAfter = Number.isFinite(after) && after > 0 ? after : null;
    throw err;
  }
  if (resp.status >= 400) {
    const err = new Error('сервис ответил ' + resp.status);
    err.status = resp.status;
    throw err;
  }

  const data = resp.json || {};
  // Берём только настоящее число. Раньше строка или объект превращались в ноль,
  // и шкала уверенно показывала «0 % — запас свободен»; из всех возможных
  // ошибок в этом плагине эта самая опасная.
  const pick = (node) => {
    if (!node || typeof node.utilization !== 'number' || !Number.isFinite(node.utilization)) return null;
    return { percent: node.utilization, resetsAt: node.resets_at || null };
  };
  const usage = {
    fiveHour: pick(data.five_hour),
    weekly: pick(data.seven_day),
  };

  // Ответ «200, но цифр нет» — это отказ, а не успех: так бывает, если поля
  // переименуют или вместо ответа придёт страница от прокси. Молча принять его
  // значило бы стереть последние хорошие цифры и оставить пустое место внизу окна.
  if (!usage.fiveHour && !usage.weekly) {
    const err = new Error('счётчик ответил без цифр');
    err.status = 'пусто';
    throw err;
  }
  return usage;
}

// ────────────────────────────────────────────────────────────────────────────
// Решения про частоту — отдельно от плагина, чтобы их можно было проверить
// ────────────────────────────────────────────────────────────────────────────

/**
 * Пора ли обращаться к счётчику. Возвращает причину («почему да») или null.
 * Ответ зависит только от переданных чисел — ни файлов, ни сети, ни времени «изнутри».
 */
function decidePoll(st) {
  if (st.pending) return null;                                  // уже спрашиваем
  if (st.pauseUntil && st.now < st.pauseUntil) return null;      // сервис просил не беспокоить

  const since = st.now - (st.lastAttemptAt || 0);
  // часы перевели назад — «прошло минус двадцать минут», и по обычному счёту
  // мы бы молчали до конца сдвига. Считаем это поводом спросить, а не молчать.
  if (since < 0) return 'часы сдвинулись';
  if (since < MIN_GAP_MS) return null;                           // слишком близко к прошлому обращению

  // Окно обнулилось — на экране заведомо неверное число, ждать общей очереди незачем.
  // Строго один раз на каждое время обнуления: если сервис почему-то продолжает
  // отдавать прошедший срок, без этой памяти мы бы спрашивали каждые полминуты
  // и сами загнали бы себя в отказ «слишком часто».
  if (st.resetsAt && st.resetsAt !== st.resetSeen) {
    const t = new Date(st.resetsAt).getTime();
    if (Number.isFinite(t) && t <= st.now) return 'окно обнулилось';
  }

  const everySec = st.busy ? st.activeSec : st.idleSec;
  if (since >= everySec * 1000) return st.busy ? 'Claude Code работает' : 'плановая проверка';
  return null;
}

/**
 * Сколько молчать после отказа.
 * Срок от сервиса главнее нашего, но не короче 30 секунд и не длиннее десяти минут:
 * прошлая версия уходила в тишину на полчаса, и цифры застывали надолго.
 */
function pauseSeconds(status, retryAfter, failStreak) {
  const ladder = [60, 120, 240, 480, 600];
  const own = ladder[Math.min(Math.max(failStreak, 1) - 1, ladder.length - 1)];
  const clamp = (v) => Math.min(PAUSE_MAX_SEC, Math.max(PAUSE_MIN_SEC, Math.ceil(v)));

  if (status === 429) return retryAfter ? clamp(retryAfter + 5) : clamp(own);
  if (status === 401 || status === 403) return 300;   // пока не войдут заново — спрашивать бесполезно
  return clamp(own);
}

/**
 * Что можно записать на диск про неудачу.
 * Только свои формулировки: чужой текст ошибки уносит в хранилище лишнее,
 * а хранилище у людей нередко и синхронизируется, и лежит в git.
 */
const KNOWN_NOTES = [
  'счётчик просит подождать',
  'вход устарел',
  'счётчик ответил без цифр',
  'связка ключей не отдала пропуск',
  'запись в связке ключей не читается',
  'в связке ключей нет пропуска',
];
function safeNote(message) {
  const text = String(message || '');
  if (KNOWN_NOTES.includes(text)) return text;
  if (/^сервис ответил \d{3}$/.test(text)) return text;
  return 'не удалось связаться со счётчиком';
}

// ────────────────────────────────────────────────────────────────────────────
// Показ времени
// ────────────────────────────────────────────────────────────────────────────

const hhmm = (ms) => new Date(ms).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

/**
 * Сколько осталось до обнуления, шагом в 5 минут.
 * Округляем вниз: лучше сказать «осталось 10 минут», когда их 14,
 * чем наоборот — на этом строятся решения «успею или нет».
 */
function shortLeft(resetsAt) {
  if (!resetsAt) return null;
  const when = new Date(resetsAt);
  if (isNaN(when.getTime())) return null;
  const left = when.getTime() - Date.now();
  if (left <= 0) return 'вот-вот';

  const step = 5;
  const totalMin = Math.floor(left / 60000 / step) * step;
  if (totalMin < step) return 'меньше 5 мин';

  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (!hours) return mins + ' мин';
  return mins ? hours + ' ч ' + mins + ' мин' : hours + ' ч';
}

/**
 * День недели и время обнуления — для недельного лимита.
 * До него живут дни, поэтому «через 3 дня 4 часа» читается хуже,
 * чем «чт 12:00»: с датой в голове проще планировать неделю.
 */
function weekdayTime(resetsAt) {
  if (!resetsAt) return null;
  const when = new Date(resetsAt);
  if (isNaN(when.getTime())) return null;

  const clock = when.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(when) - startOfDay(new Date())) / 86400000);

  if (days <= 0) return 'сегодня ' + clock;
  if (days === 1) return 'завтра ' + clock;
  const weekday = when.toLocaleDateString('ru-RU', { weekday: 'short' }).replace('.', '');
  return weekday + ' ' + clock;
}

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

/** Возраст цифр человеческими словами — чтобы старое не выдавалось за свежее */
function humanAge(ms) {
  if (ms === null || ms === undefined) return 'ещё не читались';
  if (ms < 90000) return 'только что';
  const totalMin = Math.floor(ms / 60000);
  if (totalMin < 60) return totalMin + ' мин назад';
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  return mins ? hours + ' ч ' + mins + ' мин назад' : hours + ' ч назад';
}

// ────────────────────────────────────────────────────────────────────────────
// Плагин
// ────────────────────────────────────────────────────────────────────────────

class ClaudianUsagePlugin extends Plugin {
  async onload() {
    const saved = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULTS, saved);
    // переход с одной старой настройки «как часто обновлять» на две — рабочую и спокойную
    if (saved.refreshSec && !saved.idleSec) {
      this.settings.idleSec = Math.max(300, Number(saved.refreshSec) || 900);
    }
    delete this.settings.refreshSec;

    // цифры с прошлого запуска показываем сразу: лучше «час назад», чем пусто
    this.usage = this.settings.lastUsage || null;
    this.updatedAt = this.settings.lastUsageAt || null;
    this.error = null;
    this.failStreak = 0;
    // Паузу и время прошлого обращения поднимаем с диска. Иначе каждая перезагрузка
    // плагина (а при двух открытых хранилищах — сразу две) шла к счётчику в обход
    // всех ограничений, включая паузу, о которой он только что попросил.
    this.pauseUntil = Number(this.settings.pauseUntil) || 0;
    this.lastAttemptAt = Number(this.settings.lastUsageAt) || 0;
    this.pending = false;
    this.resetSeen = null;    // время обнуления, по которому мы уже сходили вне очереди
    this.busy = true;         // работает ли Claude Code прямо сейчас — считаем раз в пульс
    this.email = readAccountEmail();

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass('cu-status');
    this.registerDomEvent(this.statusEl, 'click', () => { this.refresh(true); });

    this.addCommand({
      id: 'refresh',
      name: 'Обновить расход Claude',
      callback: () => { this.refresh(true); },
    });

    this.addSettingTab(new ClaudianUsageSettingTab(this.app, this));

    // Пульс и слушатели регистрируем ДО первой отрисовки: споткнись отрисовка,
    // плагин остался бы загруженным, но навсегда немым.
    // Один короткий пульс на всё: и остаток времени пересчитать, и решить, пора ли
    // спрашивать счётчик. Длинные таймеры Obsidian в фоне придерживает, а этот
    // сверяется с часами — опоздав, он навёрстывает сразу, а не ждёт следующего круга.
    this.registerInterval(window.setInterval(() => this.tick(), TICK_MS));

    // вернулись к окну — проверяем сразу, не дожидаясь очередного пульса
    this.registerDomEvent(window, 'focus', () => this.tick());
    this.registerDomEvent(document, 'visibilitychange', () => {
      if (!document.hidden) this.tick();
    });

    this.tick();
  }

  activeSec() { return Math.max(60, Number(this.settings.activeSec) || 120); }
  idleSec() { return Math.max(300, Number(this.settings.idleSec) || 900); }

  /** Пульс: перерисовать время и, если пора, спросить счётчик */
  tick() {
    // busyMarks задаётся только в проверках, чтобы признак «Claude Code работает»
    // можно было задать наперёд; в работе берутся настоящие пути
    this.busy = claudeBusySince(this.lastAttemptAt, this.busyMarks);
    this.render();
    const why = decidePoll({
      now: Date.now(),
      lastAttemptAt: this.lastAttemptAt,
      pauseUntil: this.pauseUntil,
      pending: this.pending,
      busy: this.busy,
      activeSec: this.activeSec(),
      idleSec: this.idleSec(),
      resetsAt: this.usage && this.usage.fiveHour ? this.usage.fiveHour.resetsAt : null,
      resetSeen: this.resetSeen,
    });
    if (why) this.refresh(false);
  }

  /** Запись настроек на диск — отдельно от разговора с счётчиком, со своей обработкой сбоя */
  async persist() {
    try {
      await this.saveData(this.settings);
    } catch (e) {
      // Диск полон или папка только для чтения — цифры на экране от этого не портятся.
      // Раньше такой сбой выдавался за отказ счётчика и глушил опрос на минуты.
      console.error('Claudian Usage: не удалось сохранить настройки', e);
    }
  }

  async refresh(loud) {
    const now = Date.now();

    if (this.pauseUntil && now < this.pauseUntil) {
      // Счётчик попросил паузу. Сами не лезем, но человеку разрешаем перебить:
      // именно он смотрит на застывшие цифры и хочет их сдвинуть. MIN_GAP_MS
      // не даёт превратить это в частые нажатия подряд.
      const mayOverride = loud && (now - this.lastAttemptAt >= MIN_GAP_MS);
      if (!mayOverride) {
        if (loud) new Notice(this.pauseText(), 7000);
        this.render();
        return;
      }
    }
    if (this.pending) {
      if (loud) new Notice('Уже спрашиваю счётчик, секунду…', 3000);
      return;
    }

    this.pending = true;
    this.lastAttemptAt = now;
    // отмечаем, что по этому времени обнуления мы сходили — второй раз не пойдём
    this.resetSeen = this.usage && this.usage.fiveHour ? this.usage.fiveHour.resetsAt : null;

    let fresh = null;
    let failure = null;
    try {
      fresh = await fetchUsage();
    } catch (e) {
      failure = e || new Error('неизвестная причина');
    }

    if (fresh) {
      this.usage = fresh;
      this.error = null;
      this.failStreak = 0;
      this.pauseUntil = 0;
      this.updatedAt = Date.now();
      this.email = readAccountEmail() || this.email;
      this.settings.lastUsage = this.usage;
      this.settings.lastUsageAt = this.updatedAt;
      this.settings.pauseUntil = 0;
      this.settings.lastOutcome = { at: this.updatedAt, ok: true, note: 'счётчик ответил' };
    } else {
      const status = failure.status || null;
      this.error = failure.message || 'неизвестная причина';
      this.failStreak += 1;
      const waitSec = pauseSeconds(status, failure.retryAfter, this.failStreak);
      this.pauseUntil = Date.now() + waitSec * 1000;
      this.settings.pauseUntil = this.pauseUntil;
      // на диск кладём только свои же формулировки и код состояния —
      // чужой текст ошибки может унести в хранилище лишнее
      this.settings.lastOutcome = {
        at: Date.now(), ok: false, status: status, note: safeNote(this.error), waitSec,
      };
    }

    await this.persist();
    this.pending = false;
    this.render();

    if (loud) {
      new Notice(fresh ? this.summaryText() : this.failText(failure.status || null), fresh ? 6000 : 8000);
    }
  }

  // ── тексты ────────────────────────────────────────────────────────────────

  stamp() {
    return this.updatedAt ? hhmm(this.updatedAt) : '—';
  }

  /** Что показать, когда сервис попросил паузу, а Vadim нажал на строку */
  pauseText() {
    return 'Счётчик попросил паузу до ' + hhmm(this.pauseUntil) + '.\n'
         + 'Тот же счётчик спрашивает и сам Claude Code, поэтому на всех сразу он не отвечает.\n'
         + 'На экране цифры от ' + this.stamp() + '. Обновлю сам — нажимать не нужно.';
  }

  /** Что показать, когда обращение не удалось */
  failText(status) {
    const back = hhmm(this.pauseUntil);
    const had = this.usage ? 'На экране цифры от ' + this.stamp() + '. ' : '';
    if (status === 429) {
      return 'Счётчик занят: его же спрашивает сам Claude Code.\n'
           + had + 'Вернусь к нему в ' + back + ' сам — нажимать не нужно.';
    }
    if (status === 401 || status === 403) {
      return 'Claude Code просит войти заново.\n'
           + 'Открой терминал, набери claude и выполни вход — дальше цифры вернутся сами.';
    }
    if (status === 'пусто') {
      return 'Счётчик ответил, но цифр в ответе не было.\n'
           + had + 'Старые цифры не трогаю, попробую сам в ' + back + '.';
    }
    return 'Не получилось спросить счётчик: ' + this.error + '.\n' + had + 'Попробую сам в ' + back + '.';
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

  /** Когда плагин собирается спросить счётчик в следующий раз — чтобы механика была видна */
  nextPollText() {
    if (this.pauseUntil && Date.now() < this.pauseUntil) {
      return 'Счётчик просил паузу до ' + hhmm(this.pauseUntil);
    }
    // признак «Claude Code работает» считается раз в пульс, здесь только читается:
    // иначе каждая отрисовка лезла бы в файловую систему заново
    const busy = this.busy;
    const everySec = busy ? this.activeSec() : this.idleSec();
    const when = Math.max(
      Date.now(),
      (this.lastAttemptAt || 0) + Math.max(MIN_GAP_MS, everySec * 1000),
    );
    return 'Следующая проверка около ' + hhmm(when)
         + (busy ? ' — Claude Code сейчас работает' : ' — Claude Code молчит, расти проценту неоткуда');
  }

  // ── рисование ─────────────────────────────────────────────────────────────

  render() {
    const el = this.statusEl;
    if (!el) return;
    el.empty();

    const age = this.updatedAt ? Date.now() - this.updatedAt : null;
    // приглушаем не по факту ошибки, а по возрасту цифр: неудачная попытка при
    // свежих цифрах ничего не портит, а вот старое число выдавать за свежее нельзя
    const staleAfter = Math.max(900000, (Number(this.settings.idleSec) || 900) * 2000);
    const stale = age === null || age > staleAfter;
    el.toggleClass('cu-stale', !!stale);

    if (this.settings.showEmail && this.email) {
      const acc = el.createSpan({ cls: 'cu-account', text: this.email });
      acc.setAttribute('title', 'Учётная запись Claude Code');
    }

    // «цифры есть, но обе пустые» — такое могло остаться в настройках от прошлых версий;
    // показываем это как «цифр нет», а не как пустое место внизу окна
    const hasNumbers = !!(this.usage && (this.usage.fiveHour || this.usage.weekly));
    if (!hasNumbers) {
      const waiting = this.pauseUntil && Date.now() < this.pauseUntil;
      const hint = this.error === 'вход устарел' ? 'Claude Code просит войти заново'
                 : waiting ? 'жду счётчик…'
                 : this.error ? 'расход не читается: ' + this.error
                 : 'считаю…';
      el.createSpan({ cls: 'cu-error', text: hint });
      el.setAttribute('title', waiting
        ? this.pauseText()
        : 'Нажми, чтобы попробовать ещё раз');
      return;
    }

    if (this.settings.showFiveHour) this.renderGauge(el, '5 ч', this.usage.fiveHour, 'left');
    if (this.settings.showWeekly) this.renderGauge(el, 'нед', this.usage.weekly, 'when');

    // пока идёт вынужденная пауза — маленький знак, что плагин жив и сам вернётся
    if (this.pauseUntil && Date.now() < this.pauseUntil) {
      const wait = el.createSpan({ cls: 'cu-wait', text: '⏳' });
      wait.setAttribute('title', this.pauseText());
    }

    el.setAttribute('title',
      this.summaryText()
      + '\n\nЦифры от ' + this.stamp() + ' (' + humanAge(age) + ')'
      + '\n' + this.nextPollText()
      + (this.error ? '\nПоследняя попытка не удалась: ' + this.error : '')
      + '\n\nНажми, чтобы спросить сейчас. Токены на это не тратятся.');
  }

  renderGauge(parent, label, node, extra) {
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

    // когда обнулится — считается на месте, без обращений к сервису
    if (extra) {
      const isLeft = extra === 'left';
      const text = isLeft ? shortLeft(node.resetsAt) : weekdayTime(node.resetsAt);
      if (text) {
        const el = wrap.createSpan({ cls: 'cu-left', text: '· ' + text });
        el.setAttribute('title', isLeft
          ? 'Через столько окно обнулится (с точностью до 5 минут)'
          : 'Когда обнулится недельный лимит');
      }
    }
  }
}

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

    // живое состояние: видно, что плагин сам ходит к счётчику, и чем закончился прошлый раз
    const state = containerEl.createEl('p', { cls: 'setting-item-description' });
    const outcome = s.lastOutcome;
    const lines = [
      'Цифры на экране: от ' + this.plugin.stamp()
        + ' (' + humanAge(this.plugin.updatedAt ? Date.now() - this.plugin.updatedAt : null) + ').',
      this.plugin.nextPollText() + '.',
    ];
    if (outcome) {
      lines.push('Прошлое обращение в ' + hhmm(outcome.at) + ': '
        + (outcome.ok ? 'счётчик ответил' : 'отказ — ' + outcome.note
            + (outcome.waitSec ? ' (пауза ' + Math.round(outcome.waitSec / 60) + ' мин)' : '')) + '.');
    }
    state.setText(lines.join(' '));

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
      .setName('Обновлять, пока Claude Code работает')
      .setDesc('В секундах. Пока идёт работа, проценты растут — в это время и стоит спрашивать чаще. '
             + 'Чаще минуты не нужно: у счётчика небольшой запас обращений, и его же спрашивает сам Claude Code.')
      .addSlider(sl => sl.setLimits(60, 600, 30).setValue(Number(s.activeSec) || 120).setDynamicTooltip()
        .onChange(async v => { s.activeSec = v; await save(); }));

    new Setting(containerEl)
      .setName('Обновлять, когда Claude Code молчит')
      .setDesc('В секундах. Без работы процент не растёт, так что заглядываем изредка — на случай расхода '
             + 'с сайта claude.ai или с телефона.')
      .addSlider(sl => sl.setLimits(300, 3600, 60).setValue(Number(s.idleSec) || 900).setDynamicTooltip()
        .onChange(async v => { s.idleSec = v; await save(); }));

    new Setting(containerEl)
      .setName('С какого процента подсвечивать')
      .setDesc('Ниже — спокойный цвет, выше — тревожный. С 95 % шкала краснеет.')
      .addSlider(sl => sl.setLimits(50, 95, 5).setValue(s.warnPercent).setDynamicTooltip()
        .onChange(async v => { s.warnPercent = v; await save(); }));

    new Setting(containerEl)
      .setName('Проверить сейчас')
      .addButton(b => b.setButtonText('Обновить').onClick(async () => {
        await this.plugin.refresh(true);
        this.display();
      }));
  }
}

module.exports = ClaudianUsagePlugin;

// открыто для проверок из node: решения про частоту считаются здесь и нигде больше
module.exports.__internals = {
  decidePoll, pauseSeconds, safeNote, humanAge, shortLeft, weekdayTime,
  claudeBusySince, busyMarkers, fetchUsage, readAccountEmail,
  TICK_MS, MIN_GAP_MS, PAUSE_MIN_SEC, PAUSE_MAX_SEC, DEFAULTS,
};
