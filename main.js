'use strict';

/*
 * Claudian Usage — строка внизу окна Obsidian:
 * сколько осталось по лимитам Claude и ChatGPT/Codex.
 *
 * Откуда берутся данные (всё локально, ни одного обращения к модели):
 *   • почта      — ~/.claude.json, поле oauthAccount.emailAddress (просто чтение файла);
 *   • пропуск    — оттуда, где его держит Claude Code на этой системе: если связка
 *                  ключей на машине есть (macOS) — сначала она, иначе и при её отказе
 *                  файл ~/.claude/.credentials.json (так хранит Linux-версия);
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
 * Почему обновление устроено именно так (важно, версии 1.4.0 и 1.4.3)
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

const TICK_MS = 30000;          // как часто плагин просыпается и решает, спрашивать ли счётчик
const MIN_GAP_MS = 45000;       // ближе этого к прошлому обращению не спрашиваем никогда
const PAUSE_MIN_SEC = 30;       // нижняя граница паузы после отказа
const PAUSE_MAX_SEC = 600;      // верхняя граница той же паузы — дольше 10 минут не молчим
const CHATGPT_TIMEOUT_MS = 12000;

const DEFAULTS = {
  activeSec: 120,        // как часто обновлять, пока Claude Code работает
  idleSec: 900,          // как часто обновлять, когда он молчит
  showEmail: true,       // показывать почту учётной записи
  showFiveHour: true,    // шкала пятичасового окна
  showWeekly: true,      // шкала недельного лимита
  showChatGPT: true,     // шкалы плана ChatGPT, которые отдаёт локальный Codex
  chatgptSec: 300,       // как часто обновлять ChatGPT/Codex (вызов метаданных, не модели)
  warnRemainingPercent: 20, // когда остаток стал не больше этого — тревожный цвет
  lastUsage: null,       // последние прочитанные цифры — чтобы после запуска не быть пустым
  lastUsageAt: null,     // когда они прочитаны
  lastUsageEmail: null,  // чьи это цифры: у владельца несколько учётных записей Anthropic,
                         // и показывать расход одной под именем другой — хуже, чем не показывать
  lastOutcome: null,     // чем закончилось последнее обращение — видно в настройках
  pauseUntil: 0,         // до какого времени счётчик просил не беспокоить (переживает перезапуск)
  lastChatGPTUsage: null,
  lastChatGPTUsageAt: null,
  lastChatGPTOutcome: null,
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
 * Пропуск Claude Code — из того хранилища, которое есть на ЭТОЙ системе.
 *
 * Claude Code держит пропуск в разных местах в зависимости от системы:
 *   • Linux  — файл ~/.claude/.credentials.json (права 600);
 *   • macOS  — связка ключей, запись «Claude Code-credentials».
 * Спрашиваем оба и берём тот, что ответил. Не «если macOS», а «где лежит»:
 * так плагин работает на обеих машинах владельца без отдельной настройки.
 *
 * Причина появления (26.09.2026): на машине devbox (Linux) плагин звал
 * /usr/bin/security, которого там нет вовсе. Каждый опрос падал, и внизу окна
 * висели последние удачные цифры двенадцатидневной давности — 81 % недельного
 * лимита при настоящих 56 %.
 *
 * Связку ключей читаем не блокирующе: она может попросить отпечаток или быть
 * заперта, и синхронное чтение подвесило бы окно Obsidian на десять секунд.
 * Текст чужой ошибки наружу не отдаём — в нём мог бы оказаться кусок пропуска.
 */
function tokenFromFile() {
  let raw = null;
  try {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    raw = fs.readFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8');
  } catch (e) {
    return { token: null, reason: null };   // файла нет — на этой машине пропуск не здесь
  }
  let oauth = null;
  try {
    oauth = (JSON.parse(raw) || {}).claudeAiOauth || {};
  } catch (e) {
    return { token: null, reason: 'файл с пропуском не читается' };
  }
  return judgeOauth(oauth, 'в файле нет пропуска');
}

/**
 * Разбор записи о пропуске — общий для файла и для связки ключей.
 *
 * ⚠️ Здесь легко наврать человеку, и однажды уже наврали. Пропусков в записи ДВА:
 *   • accessToken  — короткий, живёт ~8 часов, Claude Code обновляет его сам
 *                    при запуске. Его истечение — не «вход умер», а «Claude Code
 *                    давно не запускался»;
 *   • refreshToken — длинный (около месяца). Вот его смерть и означает «войди заново».
 *
 * Поэтому три разных состояния и три разных совета. Сказать «выполни вход», когда
 * достаточно запустить claude, — это отправить человека делать лишнюю работу.
 */
function judgeOauth(oauth, missingReason) {
  const o = oauth || {};
  if (!o.accessToken) return { token: null, reason: missingReason };
  const alive = (v) => {
    let n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return true;   // срока нет или он нечитаем — считаем живым
    // Секунды или миллисекунды? Значение меньше 10^12 — это заведомо секунды
    // (10^12 мс — это 2001 год). Иначе срок «в секундах» выглядел бы истёкшим
    // тридцать лет назад, и плагин уверенно врал бы «вход устарел» при живом входе.
    if (n < 1e12) n = n * 1000;
    return n > Date.now();
  };
  if (alive(o.expiresAt)) return { token: o.accessToken, reason: null };
  // Длинного срока в записи может не быть вовсе (старый формат) — тогда сказать
  // «вход заново не нужен» было бы обещанием, которого мы не можем дать.
  // Именно читаемое число: 0, -1, '' и 'неизвестно' знанием не являются, а обещать
  // на их основании «вход заново не нужен» — давать обещание, которого мы не можем дать.
  const refreshRaw = Number(o.refreshTokenExpiresAt);
  const knowsRefresh = Number.isFinite(refreshRaw) && refreshRaw > 0;
  if (alive(o.refreshTokenExpiresAt)) {
    // Вход в порядке, просто короткий пропуск устарел: Claude Code обновит его сам.
    return {
      token: null,
      reason: knowsRefresh ? 'Claude Code давно не запускался' : 'пропуск устарел',
      needsClaude: true,
      refreshKnown: knowsRefresh,
    };
  }
  return { token: null, reason: 'вход устарел', expired: true };
}

/** Есть ли на этой машине связка ключей macOS — по наличию самой команды */
function keychainAvailable() {
  try {
    return require('fs').existsSync('/usr/bin/security');
  } catch (e) {
    return false;
  }
}

function tokenFromKeychain() {
  const { execFile } = require('child_process');
  return new Promise((resolve) => {
    execFile(
      '/usr/bin/security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
      { encoding: 'utf8', timeout: 10000 },
      (err, stdout) => {
        // Текст чужой ошибки наружу не отдаём: в нём мог бы оказаться кусок пропуска.
        if (err) return resolve({ token: null, reason: 'связка ключей не отдала пропуск' });
        let oauth = null;
        try {
          oauth = (JSON.parse(stdout) || {}).claudeAiOauth || {};
        } catch (e) {
          return resolve({ token: null, reason: 'запись в связке ключей не читается' });
        }
        // Срок проверяем ровно так же, как у файла: иначе просроченный пропуск из
        // связки закрыл бы дорогу к годному из файла — связку спрашиваем первой.
        resolve(judgeOauth(oauth, 'в связке ключей нет пропуска'));
      },
    );
  });
}

/**
 * Пропуск — из главного хранилища этой системы.
 *
 * Порядок: на macOS главная — связка ключей, именно её обновляет сам Claude Code,
 * а файл ~/.claude/.credentials.json там может остаться от прежних версий и быть
 * несвежим. На Linux связки нет вовсе, и главный — файл. Поэтому сначала связка,
 * но только если она на машине есть; иначе сразу файл.
 */
async function readAccessToken() {
  const tried = [];
  if (keychainAvailable()) {
    const fromKeychain = await tokenFromKeychain();
    if (fromKeychain.token) return fromKeychain.token;
    tried.push(fromKeychain);
  }
  const fromFile = tokenFromFile();
  if (fromFile.token) return fromFile.token;
  tried.push(fromFile);

  // Порядок важности причин — от самой полезной человеку к самой общей.
  // «Claude Code давно не запускался» идёт первой: лечится одной командой,
  // и говорить в этом случае «войди заново» значит послать делать лишнее.
  const needsClaude = tried.find((r) => r.needsClaude);
  if (needsClaude) {
    const err = new Error(needsClaude.reason);
    err.localCause = true;    // к счётчику не ходили — пауза не его, и сказать надо иначе
    throw err;
  }
  const expired = tried.find((r) => r.expired);
  if (expired) {
    const err = new Error('вход устарел');
    err.status = 401;
    err.localCause = true;
    throw err;
  }
  const named = tried.find((r) => r.reason);
  const err = new Error(named ? named.reason : 'пропуск Claude Code не найден');
  err.localCause = true;
  throw err;
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

/** Найти Codex CLI, не полагаясь на PATH графического приложения Obsidian. */
function findCodexBinary() {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const home = os.homedir();
  const candidates = [
    process.env.CODEX_BIN,
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    path.join(home, '.local', 'bin', 'codex'),
    path.join(home, '.npm-global', 'bin', 'codex'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch (e) { /* следующая кандидатура */ }
  }
  // Последняя попытка — PATH, который Obsidian получил при запуске.
  return 'codex';
}

function unixSecondsToIso(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n < 1e12 ? n * 1000 : n;
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/**
 * Привести ответ Codex app-server к тем же узлам, которые рисует шкала Claude.
 * Проценты в ответе — ИЗРАСХОДОВАНО; остаток вычисляется только при показе.
 */
function normalizeChatGPTUsage(result) {
  const data = result || {};
  const byId = data.rateLimitsByLimitId || {};
  const first = Object.keys(byId).map((k) => byId[k]).find(Boolean);
  const snapshot = byId.codex || data.rateLimits || first || null;
  if (!snapshot) throw new Error('счётчик ChatGPT ответил без цифр');

  const pick = (node) => {
    if (!node || typeof node.usedPercent !== 'number' || !Number.isFinite(node.usedPercent)) return null;
    return {
      percent: node.usedPercent,
      resetsAt: unixSecondsToIso(node.resetsAt),
      windowMinutes: Number.isFinite(Number(node.windowDurationMins))
        ? Number(node.windowDurationMins) : null,
    };
  };
  const usage = {
    limitId: snapshot.limitId || 'codex',
    planType: snapshot.planType || null,
    primary: pick(snapshot.primary),
    secondary: pick(snapshot.secondary),
    credits: snapshot.credits && typeof snapshot.credits === 'object'
      ? { hasCredits: !!snapshot.credits.hasCredits, balance: snapshot.credits.balance || null }
      : null,
  };
  if (!usage.primary && !usage.secondary) {
    throw new Error('счётчик ChatGPT ответил без цифр');
  }
  return usage;
}

/**
 * Свежие лимиты ChatGPT через локальный `codex app-server`.
 *
 * Плагин не читает и не сохраняет OAuth-пропуск: им распоряжается сам Codex.
 * `account/rateLimits/read` — запрос метаданных об остатках, не обращение к модели.
 * Процесс живёт только на время одного чтения и завершается сразу после ответа.
 */
function fetchChatGPTUsage(options) {
  const opts = options || {};
  const binary = opts.binary || findCodexBinary();
  const spawn = opts.spawn || require('child_process').spawn;
  const timeoutMs = Number(opts.timeoutMs) || CHATGPT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    if (typeof spawn !== 'function') {
      reject(new Error('Codex CLI не найден'));
      return;
    }

    let child = null;
    let done = false;
    let buffer = '';
    let initialized = false;
    let timer = null;

    const finish = (err, value) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (child) {
        try { child.kill(); } catch (e) { /* уже завершился */ }
      }
      if (err) reject(err); else resolve(value);
    };
    const write = (message) => {
      try {
        child.stdin.write(JSON.stringify(message) + '\n');
      } catch (e) {
        finish(new Error('Codex CLI не отвечает'));
      }
    };
    const handle = (message) => {
      if (!message || typeof message !== 'object') return;
      if (message.id === 1 && message.result && !initialized) {
        initialized = true;
        write({ method: 'initialized' });
        write({
          id: 2,
          method: 'account/rateLimits/read',
          params: { excludeResetCreditDetails: true, supportsLunaReserve: false },
        });
        return;
      }
      if (message.id !== 2) return;
      if (message.error) {
        const raw = JSON.stringify(message.error);
        const own = /auth|login|unauthor|401|403/i.test(raw)
          ? 'ChatGPT просит войти в Codex'
          : 'не удалось прочитать лимит ChatGPT';
        finish(new Error(own));
        return;
      }
      try {
        finish(null, normalizeChatGPTUsage(message.result));
      } catch (e) {
        finish(new Error(e && e.message === 'счётчик ChatGPT ответил без цифр'
          ? e.message : 'не удалось прочитать лимит ChatGPT'));
      }
    };

    try {
      child = spawn(binary, ['app-server', '--stdio'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      finish(new Error('Codex CLI не найден'));
      return;
    }

    child.once('error', () => finish(new Error('Codex CLI не найден')));
    child.once('exit', () => {
      if (!done) finish(new Error('Codex CLI не отвечает'));
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try { handle(JSON.parse(line)); } catch (e) { /* служебная строка не JSON */ }
      }
    });
    // stderr намеренно не читаем в тексты интерфейса: там могут оказаться детали среды.
    if (child.stderr && child.stderr.resume) child.stderr.resume();
    timer = setTimeout(() => finish(new Error('Codex CLI не отвечает')), timeoutMs);
    write({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'claudian-usage', title: 'Claudian Usage', version: '1.5.0' },
      },
    });
  });
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
function pauseSeconds(status, retryAfter, failStreak, localCause) {
  const ladder = [60, 120, 240, 480, 600];
  const own = ladder[Math.min(Math.max(failStreak, 1) - 1, ladder.length - 1)];
  const clamp = (v) => Math.min(PAUSE_MAX_SEC, Math.max(PAUSE_MIN_SEC, Math.ceil(v)));

  if (status === 429) return retryAfter ? clamp(retryAfter + 5) : clamp(own);
  // Местная беда (пропуск) проверяется чтением файла, сети не касается вовсе.
  // Стоит ВЫШЕ проверки кода 401: мёртвый длинный пропуск — тоже местная причина,
  // и держать человека пять минут после того, как он выполнил вход, незачем.
  if (localCause) return PAUSE_MIN_SEC;
  if (status === 401 || status === 403) return 300;   // пока не войдут заново — спрашивать бесполезно
  return clamp(own);
}

/**
 * Что можно записать на диск про неудачу.
 * Только свои формулировки: чужой текст ошибки уносит в хранилище лишнее,
 * а хранилище у людей нередко и синхронизируется, и лежит в git.
 */
/**
 * Причины, которые возникают у нас дома, без обращения к счётчику.
 * Нужен отдельный список: записи от прежних версий плагина поля «чья причина»
 * не имели, и после обновления местная беда снова выдавалась за занятый счётчик.
 */
const LOCAL_NOTES = [
  'пропуск Claude Code не найден',
  'Claude Code давно не запускался',
  'пропуск устарел',
  'вход устарел',
  'файл с пропуском не читается',
  'в файле нет пропуска',
  'связка ключей не отдала пропуск',
  'запись в связке ключей не читается',
  'в связке ключей нет пропуска',
];
const isLocalNote = (note) => LOCAL_NOTES.includes(String(note || ''));

const KNOWN_NOTES = [
  'счётчик просит подождать',
  'вход устарел',
  'счётчик ответил без цифр',
  'пропуск Claude Code не найден',
  'Claude Code давно не запускался',
  'пропуск устарел',
  'файл с пропуском не читается',
  'в файле нет пропуска',
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

const CHATGPT_NOTES = [
  'Codex CLI не найден',
  'Codex CLI не отвечает',
  'ChatGPT просит войти в Codex',
  'счётчик ChatGPT ответил без цифр',
  'не удалось прочитать лимит ChatGPT',
];
function safeChatGPTNote(message) {
  const text = String(message || '');
  return CHATGPT_NOTES.includes(text) ? text : 'не удалось прочитать лимит ChatGPT';
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

/**
 * Убрать цифры, срок которых уже вышел.
 *
 * У каждого лимита есть свой момент обнуления. Когда он прошёл, окно началось
 * заново и старый процент к нему уже не относится — это не «слегка устаревшее
 * число», а число про другое окно. Показать его значит соврать: 81 % при
 * настоящих 56 % (ровно это и висело на devbox 26.09.2026).
 *
 * Поэтому просроченную цифру не приглушаем, а выбрасываем: пусть внизу окна
 * будет честное «цифр нет», чем уверенная неправда. Приглушение по возрасту
 * (класс cu-stale) остаётся — оно про «минуты назад», а это про «окно другое».
 */
function dropExpired(usage) {
  if (!usage) return null;
  const now = Date.now();
  const alive = (node) => {
    if (!node) return null;
    if (!node.resetsAt) return node;              // срока не знаем — судить не берёмся
    const at = new Date(node.resetsAt).getTime();
    if (!Number.isFinite(at)) return node;
    return at > now ? node : null;
  };
  const fiveHour = alive(usage.fiveHour);
  const weekly = alive(usage.weekly);
  if (!fiveHour && !weekly) return null;
  return { fiveHour, weekly };
}

/** Та же защита от просроченных окон для ответа ChatGPT/Codex. */
function dropExpiredChatGPT(usage) {
  if (!usage) return null;
  const now = Date.now();
  const alive = (node) => {
    if (!node) return null;
    if (!node.resetsAt) return node;
    const at = new Date(node.resetsAt).getTime();
    if (!Number.isFinite(at)) return node;
    return at > now ? node : null;
  };
  const primary = alive(usage.primary);
  const secondary = alive(usage.secondary);
  if (!primary && !secondary) return null;
  return Object.assign({}, usage, { primary, secondary });
}

function remainingPercent(node) {
  const used = node && typeof node.percent === 'number' && Number.isFinite(node.percent)
    ? node.percent : 0;
  return Math.max(0, Math.min(100, 100 - used));
}

/** Короткое имя окна по его настоящей длительности, а не по позиции в ответе. */
function rateWindowLabel(node, fallback) {
  const mins = Number(node && node.windowMinutes);
  if (!Number.isFinite(mins) || mins <= 0) return fallback;
  if (mins >= 10000 && mins <= 10200) return 'нед';
  if (mins >= 270 && mins <= 330) return '5 ч';
  if (mins === 1440) return 'сут';
  if (mins % 1440 === 0) return (mins / 1440) + ' д';
  if (mins % 60 === 0) return (mins / 60) + ' ч';
  return mins + ' мин';
}

function chatgptWindows(usage) {
  if (!usage) return [];
  return [usage.primary, usage.secondary]
    .filter(Boolean)
    .sort((a, b) => (Number(a.windowMinutes) || Infinity) - (Number(b.windowMinutes) || Infinity));
}

/**
 * Длительность паузы словами. Округление до минут врало на самой частой паузе:
 * тридцать секунд показывались как «пауза 1 мин».
 */
function humanWait(sec) {
  const n = Math.max(0, Math.round(Number(sec) || 0));
  if (n < 60) return n + ' сек';
  const mins = Math.round(n / 60);
  return mins + ' ' + (mins === 1 ? 'мин' : 'мин');
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
    // До 1.5.0 настройка означала «подсвечивать после N % расхода».
    // Теперь шкала показывает остаток, поэтому сохраняем тот же физический порог:
    // старые 80 % расхода превращаются в 20 % остатка.
    if (saved.warnRemainingPercent === undefined && saved.warnPercent !== undefined) {
      this.settings.warnRemainingPercent = Math.max(5, Math.min(50, 100 - Number(saved.warnPercent)));
    }
    delete this.settings.warnPercent;

    // цифры с прошлого запуска показываем сразу: лучше «час назад», чем пусто
    // Сохранённые цифры кладём как есть — даже просроченные. Внутри них лежит
    // время обнуления, и по нему плагин понимает, что окно началось заново и надо
    // спросить счётчик вне очереди. Выбрасывать их здесь значило бы ослепить этот
    // разбор: после перезапуска плагин ждал бы плановой проверки до часа.
    // Человеку просроченное не попадёт — на показ всё идёт через liveUsage().
    this.usage = this.settings.lastUsage || null;
    this.updatedAt = this.settings.lastUsageAt || null;
    // Причину прошлого отказа поднимаем вместе с паузой. Иначе после перезапуска
    // внутри паузы плагин помнил ТОЛЬКО «я молчу» и рассказывал про занятый счётчик —
    // даже когда счётчика не спрашивал вовсе и нужно было действие человека.
    const past = this.settings.lastOutcome || null;
    const inPause = Number(this.settings.pauseUntil) > Date.now();
    const keepCause = !!(past && past.ok === false && inPause);
    this.error = keepCause ? past.note : null;
    // Поле «чья причина» появилось только в 1.4.3. Для записей от прежних версий
    // узнаём это по самой формулировке — иначе после обновления человек снова
    // прочитает «жду счётчик» там, где счётчик ни при чём.
    this.localCause = keepCause ? (past.local === true || isLocalNote(past.note)) : false;
    this.lastStatus = keepCause ? (past.status || null) : null;
    this.failStreak = 0;
    // Паузу и время прошлого обращения поднимаем с диска. Иначе каждая перезагрузка
    // плагина (а при двух открытых хранилищах — сразу две) шла к счётчику в обход
    // всех ограничений, включая паузу, о которой он только что попросил.
    this.pauseUntil = Number(this.settings.pauseUntil) || 0;
    // Местную паузу не досиживаем: человек мог запустить claude и перезапустить
    // плагин именно потому, что выполнил совет. Перепроверка стоит чтения файла,
    // и держать его ещё пять минут с приказом, который он уже выполнил, — обман.
    if (this.localCause && this.pauseUntil > Date.now() + PAUSE_MIN_SEC * 1000) {
      this.pauseUntil = Date.now() + PAUSE_MIN_SEC * 1000;
      this.settings.pauseUntil = this.pauseUntil;
    }
    this.lastAttemptAt = Number(this.settings.lastUsageAt) || 0;
    this.pending = false;
    this.resetSeen = null;    // время обнуления, по которому мы уже сходили вне очереди
    this.busy = true;         // работает ли Claude Code прямо сейчас — считаем раз в пульс
    this.email = readAccountEmail();

    // ChatGPT/Codex живёт независимо от Anthropic: отдельные цифры, часы и ошибки.
    this.chatgptUsage = this.settings.lastChatGPTUsage || null;
    this.chatgptUpdatedAt = this.settings.lastChatGPTUsageAt || null;
    this.chatgptError = this.settings.lastChatGPTOutcome && this.settings.lastChatGPTOutcome.ok === false
      ? this.settings.lastChatGPTOutcome.note : null;
    this.lastChatGPTAttemptAt = Number(this.settings.lastChatGPTUsageAt) || 0;
    this.chatgptPending = false;
    this.chatgptResetSeen = null;

    // Цифры с прошлого запуска годятся, только если вход выполнен под той же учётной
    // записью. Аккаунтов у владельца несколько, и чужой расход под своим именем — это
    // не «неточность», а неверные данные для решения «продолжать или подождать».
    if (this.settings.lastUsageEmail && this.settings.lastUsageEmail !== this.email) {
      this.forgetUsage();
    }

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass('cu-status');
    this.registerDomEvent(this.statusEl, 'click', () => { this.refreshAll(true); });

    this.addCommand({
      id: 'refresh',
      name: 'Обновить остатки Claude и ChatGPT',
      callback: () => { this.refreshAll(true); },
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
  chatgptSec() { return Math.max(120, Number(this.settings.chatgptSec) || 300); }

  /**
   * Цифры, которые можно показать человеку: без тех, чьё окно уже обнулилось.
   * Единственная дверь к цифрам для любого текста и любой шкалы — чтобы
   * просроченное не вылезло где-нибудь в подсказке, когда со шкалы его убрали.
   */
  liveUsage() { return dropExpired(this.usage); }
  liveChatGPTUsage() { return dropExpiredChatGPT(this.chatgptUsage); }

  /**
   * Ближайшее известное время обнуления — по любой из шкал.
   * Раньше смотрели только на пятичасовую: если счётчик отдал её без числа
   * (бывает), плагин перестал бы замечать обнуление вовсе и ждал бы плановой
   * проверки — до часа при спокойной настройке.
   */
  nearestReset() {
    const u = this.usage || {};
    const times = [u.fiveHour, u.weekly]
      .filter((n) => n && n.resetsAt)
      .map((n) => ({ raw: n.resetsAt, ms: new Date(n.resetsAt).getTime() }))
      .filter((t) => Number.isFinite(t.ms));
    if (!times.length) return null;
    times.sort((a, b) => a.ms - b.ms);
    return times[0].raw;
  }

  nearestChatGPTReset() {
    const times = chatgptWindows(this.chatgptUsage)
      .filter((n) => n.resetsAt)
      .map((n) => ({ raw: n.resetsAt, ms: new Date(n.resetsAt).getTime() }))
      .filter((t) => Number.isFinite(t.ms));
    if (!times.length) return null;
    times.sort((a, b) => a.ms - b.ms);
    return times[0].raw;
  }

  /**
   * Забыть цифры расхода: они принадлежали другой учётной записи.
   *
   * Снимаем и паузу с задержкой опроса — их просил счётчик прежнего аккаунта,
   * к новому они отношения не имеют, а иначе новый молчал бы до конца чужой паузы.
   */
  forgetUsage() {
    this.usage = null;
    this.updatedAt = null;
    this.error = null;
    this.localCause = false;
    this.lastStatus = null;
    this.failStreak = 0;
    this.pauseUntil = 0;
    this.lastAttemptAt = 0;
    this.resetSeen = null;
    this.settings.lastUsage = null;
    this.settings.lastUsageAt = null;
    this.settings.pauseUntil = 0;
  }

  /** Пульс: перерисовать время и, если пора, спросить счётчик */
  tick() {
    // Учётную запись могли сменить на ходу — тогда показанные цифры уже не про неё.
    // Проверяем каждый пульс: файл небольшой, а показать чужой расход дороже.
    const emailNow = readAccountEmail();
    if (emailNow !== this.email) {
      this.email = emailNow;
      this.forgetUsage();
      this.persist();
    }

    this.busy = claudeBusySince(this.lastAttemptAt);
    this.render();
    const why = decidePoll({
      now: Date.now(),
      lastAttemptAt: this.lastAttemptAt,
      pauseUntil: this.pauseUntil,
      pending: this.pending,
      busy: this.busy,
      activeSec: this.activeSec(),
      idleSec: this.idleSec(),
      resetsAt: this.nearestReset(),
      resetSeen: this.resetSeen,
    });
    if (why) this.refresh(false);

    if (this.settings.showChatGPT) {
      const chatgptWhy = decidePoll({
        now: Date.now(),
        lastAttemptAt: this.lastChatGPTAttemptAt,
        pauseUntil: 0,
        pending: this.chatgptPending,
        busy: false,
        activeSec: this.chatgptSec(),
        idleSec: this.chatgptSec(),
        resetsAt: this.nearestChatGPTReset(),
        resetSeen: this.chatgptResetSeen,
      });
      if (chatgptWhy) this.refreshChatGPT(false);
    }
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

  /** Обновить оба независимых счётчика и показать одну общую сводку. */
  async refreshAll(loud) {
    const jobs = [this.refresh(loud, false)];
    if (this.settings.showChatGPT) jobs.push(this.refreshChatGPT(loud, false));
    await Promise.all(jobs);
    if (loud) new Notice(this.fullSummaryText(), 9000);
  }

  async refresh(loud, notify) {
    const shouldNotify = notify === undefined ? loud : notify;
    const now = Date.now();

    if (this.pauseUntil && now < this.pauseUntil) {
      // Счётчик попросил паузу. Сами не лезем, но человеку разрешаем перебить:
      // именно он смотрит на застывшие цифры и хочет их сдвинуть. MIN_GAP_MS
      // не даёт превратить это в частые нажатия подряд.
      const mayOverride = loud && (now - this.lastAttemptAt >= MIN_GAP_MS);
      if (!mayOverride) {
        if (shouldNotify) new Notice(this.pauseText(), 7000);
        this.render();
        return;
      }
    }
    if (this.pending) {
      if (shouldNotify) new Notice('Уже спрашиваю счётчик Claude, секунду…', 3000);
      return;
    }

    this.pending = true;
    this.lastAttemptAt = now;
    // отмечаем, что по этому времени обнуления мы сходили — второй раз не пойдём
    this.resetSeen = this.nearestReset();

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
      this.localCause = false;
      this.lastStatus = null;
      this.failStreak = 0;
      this.pauseUntil = 0;
      this.updatedAt = Date.now();
      this.email = readAccountEmail() || this.email;
      this.settings.lastUsage = this.usage;
      this.settings.lastUsageAt = this.updatedAt;
      this.settings.lastUsageEmail = this.email;   // чьи это цифры — проверим при следующем запуске
      this.settings.pauseUntil = 0;
      this.settings.lastOutcome = { at: this.updatedAt, ok: true, note: 'счётчик ответил' };
    } else {
      const status = failure.status || null;
      this.error = failure.message || 'неизвестная причина';
      // Причина местная (пропуск), а не от счётчика: к нему не ходили вовсе.
      // Без этого признака человеку рассказывали про занятый счётчик и «нажимать
      // не нужно» — там, где как раз нужно его действие.
      this.localCause = !!failure.localCause;
      this.lastStatus = status;
      this.failStreak += 1;
      const waitSec = pauseSeconds(status, failure.retryAfter, this.failStreak, this.localCause);
      this.pauseUntil = Date.now() + waitSec * 1000;
      this.settings.pauseUntil = this.pauseUntil;
      // на диск кладём только свои же формулировки и код состояния —
      // чужой текст ошибки может унести в хранилище лишнее
      this.settings.lastOutcome = {
        at: Date.now(), ok: false, status: status, note: safeNote(this.error), waitSec,
        local: this.localCause,   // чья причина — нужно после перезапуска, иначе врём про счётчик
      };
    }

    await this.persist();
    this.pending = false;
    this.render();

    if (shouldNotify) {
      new Notice(fresh ? this.summaryText() : this.failText(failure.status || null), fresh ? 6000 : 8000);
    }
  }

  async refreshChatGPT(loud, notify) {
    const shouldNotify = notify === undefined ? loud : notify;
    const now = Date.now();
    if (this.chatgptPending) {
      if (shouldNotify) new Notice('Уже спрашиваю счётчик ChatGPT, секунду…', 3000);
      return;
    }
    // Ручное нажатие сразу после автоматического ответа не должно плодить процессы.
    if (now - this.lastChatGPTAttemptAt < MIN_GAP_MS) {
      if (shouldNotify) new Notice(this.chatgptSummaryText(), 5000);
      return;
    }

    this.chatgptPending = true;
    this.lastChatGPTAttemptAt = now;
    this.chatgptResetSeen = this.nearestChatGPTReset();
    let fresh = null;
    let failure = null;
    try {
      fresh = await fetchChatGPTUsage();
    } catch (e) {
      failure = e || new Error('не удалось прочитать лимит ChatGPT');
    }

    if (fresh) {
      this.chatgptUsage = fresh;
      this.chatgptUpdatedAt = Date.now();
      this.chatgptError = null;
      this.settings.lastChatGPTUsage = fresh;
      this.settings.lastChatGPTUsageAt = this.chatgptUpdatedAt;
      this.settings.lastChatGPTOutcome = {
        at: this.chatgptUpdatedAt, ok: true, note: 'счётчик ChatGPT ответил',
      };
    } else {
      this.chatgptError = safeChatGPTNote(failure && failure.message);
      this.settings.lastChatGPTOutcome = {
        at: Date.now(), ok: false, note: this.chatgptError,
      };
    }
    this.chatgptPending = false;
    await this.persist();
    this.render();
    if (shouldNotify) new Notice(this.chatgptSummaryText(), fresh ? 6000 : 8000);
  }

  // ── тексты ────────────────────────────────────────────────────────────────

  stamp() {
    return this.updatedAt ? hhmm(this.updatedAt) : '—';
  }

  chatgptStamp() {
    return this.chatgptUpdatedAt ? hhmm(this.chatgptUpdatedAt) : '—';
  }

  /**
   * Что показать во время паузы, когда Vadim нажал на строку.
   * Про занятый счётчик говорим только если пауза правда из-за него: при местной
   * причине (пропуск) к счётчику не ходили, и «обновлю сам» было бы обманом —
   * там нужно действие человека.
   */
  pauseText() {
    const had = this.liveUsage() ? 'На экране цифры от ' + this.stamp() + '. ' : '';
    // «Счётчик попросил паузу» правдиво ровно в одном случае — когда он ответил
    // «слишком часто». При местной беде и при его отказе (401, 500, ответ без цифр)
    // паузу назначили мы сами, и «обновлю сам» было бы обманом: там ждут действия.
    if (this.lastStatus === 429) {
      return 'Счётчик попросил паузу до ' + hhmm(this.pauseUntil) + '.\n'
           + 'Тот же счётчик спрашивает и сам Claude Code, поэтому на всех сразу он не отвечает.\n'
           + had + 'Обновлю сам — нажимать не нужно.';
    }
    if (this.needsAction()) {
      return 'Спрошу счётчик снова в ' + hhmm(this.pauseUntil) + '.\n'
           + 'Пока не получается: ' + this.reasonText() + '.\n'
           + had + this.localAdvice();
    }
    const why = this.error ? this.reasonText() : null;
    return 'Спрошу счётчик снова в ' + hhmm(this.pauseUntil) + '.\n'
         + (why ? (why === 'не удалось связаться со счётчиком'
             ? 'Прошлый раз связаться не удалось.\n'
             : 'Прошлый раз не получилось: ' + why + '.\n') : '')
         + had + 'Вернусь сам — нажимать не нужно.';
  }

  /** Нужно ли действие человека, или плагин справится сам */
  needsAction() {
    return !!this.localCause || this.lastStatus === 401 || this.lastStatus === 403;
  }

  /**
   * Причина отказа в том виде, в каком её можно показать.
   * Чужой текст ошибки на экран не выпускаем по той же причине, по которой не
   * пишем его на диск: в нём мог бы оказаться кусок пропуска.
   */
  reasonText() {
    return safeNote(this.error);
  }

  /** Что человеку сделать, когда дело в пропуске, а не в счётчике */
  localAdvice() {
    if (this.error === 'Claude Code давно не запускался') {
      return 'Открой терминал и набери claude — пропуск обновится сам, вход заново не нужен.';
    }
    if (this.error === 'пропуск устарел') {
      // Длинного срока в записи нет, и обещать «вход не нужен» мы не можем.
      return 'Открой терминал и набери claude — если попросит войти, выполни вход.';
    }
    if (this.error === 'вход устарел') {
      return 'Открой терминал, набери claude и выполни вход — дальше цифры вернутся сами.';
    }
    return 'Открой терминал и набери claude — плагин подхватит пропуск сам.';
  }

  /** Что показать, когда обращение не удалось */
  failText(status) {
    const back = hhmm(this.pauseUntil);
    const had = this.liveUsage() ? 'На экране цифры от ' + this.stamp() + '. ' : '';
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
           + (this.liveUsage() ? had + 'Старые цифры не трогаю, попробую' : 'Попробую')
           + ' сам в ' + back + '.';
    }
    if (this.needsAction()) {
      return 'Расход пока не читается: ' + this.reasonText() + '.\n' + had + this.localAdvice();
    }
    const why = this.reasonText();
    return (why === 'не удалось связаться со счётчиком'
      ? 'Не удалось связаться со счётчиком.'
      : 'Не получилось спросить счётчик: ' + why + '.')
      + '\n' + had + 'Попробую сам в ' + back + '.';
  }

  summaryText() {
    const live = this.liveUsage();
    if (!live) return 'Остаток Claude пока не прочитан';
    const rows = [];
    if (live.fiveHour) {
      rows.push('Claude · пять часов: осталось ' + Math.round(remainingPercent(live.fiveHour))
        + '% (израсходовано ' + Math.round(live.fiveHour.percent) + '%) — ' + humanReset(live.fiveHour.resetsAt));
    }
    if (live.weekly) {
      rows.push('Claude · неделя: осталось ' + Math.round(remainingPercent(live.weekly))
        + '% (израсходовано ' + Math.round(live.weekly.percent) + '%) — ' + humanReset(live.weekly.resetsAt));
    }
    if (this.email) rows.push('Вход: ' + this.email);
    return rows.join('\n');
  }

  chatgptSummaryText() {
    const live = this.liveChatGPTUsage();
    if (!live) {
      return this.chatgptError
        ? 'Остаток ChatGPT не читается: ' + safeChatGPTNote(this.chatgptError)
        : 'Остаток ChatGPT пока не прочитан';
    }
    const rows = chatgptWindows(live).map((node, index) => {
      const label = rateWindowLabel(node, index ? 'лимит 2' : 'лимит 1');
      return 'ChatGPT · ' + label + ': осталось ' + Math.round(remainingPercent(node))
        + '% (израсходовано ' + Math.round(node.percent) + '%) — ' + humanReset(node.resetsAt);
    });
    if (live.credits && live.credits.hasCredits && live.credits.balance !== null) {
      rows.push('Кредиты ChatGPT: ' + live.credits.balance);
    }
    return rows.join('\n');
  }

  fullSummaryText() {
    const parts = [this.summaryText()];
    if (this.settings.showChatGPT) parts.push(this.chatgptSummaryText());
    return parts.join('\n\n');
  }

  /** Когда плагин собирается спросить счётчик в следующий раз — чтобы механика была видна */
  nextPollText() {
    if (this.pauseUntil && Date.now() < this.pauseUntil) {
      // Третье место, где печаталась эта мысль, и его забыли поправить вместе с
      // двумя другими: «счётчик просил паузу» правдиво только при его «слишком часто».
      return this.lastStatus === 429
        ? 'Счётчик просил паузу до ' + hhmm(this.pauseUntil)
        : 'Следующая попытка в ' + hhmm(this.pauseUntil);
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

  nextChatGPTPollText() {
    const when = Math.max(
      Date.now(),
      (this.lastChatGPTAttemptAt || 0) + Math.max(MIN_GAP_MS, this.chatgptSec() * 1000),
    );
    return 'Следующая проверка ChatGPT около ' + hhmm(when);
  }

  // ── рисование ─────────────────────────────────────────────────────────────

  render() {
    const el = this.statusEl;
    if (!el) return;
    el.empty();

    const age = this.updatedAt ? Date.now() - this.updatedAt : null;
    const staleAfter = Math.max(900000, (Number(this.settings.idleSec) || 900) * 2000);
    const stale = age === null || age > staleAfter;

    if (this.settings.showEmail && this.email) {
      const acc = el.createSpan({ cls: 'cu-account', text: this.email });
      acc.setAttribute('title', 'Учётная запись Claude Code');
    }

    const claude = el.createSpan({ cls: 'cu-provider' });
    claude.toggleClass('cu-stale', !!stale);
    claude.createSpan({ cls: 'cu-service', text: 'Claude' });
    const live = this.liveUsage();
    const hasNumbers = !!(live && (live.fiveHour || live.weekly));
    if (!hasNumbers) {
      const waiting = this.pauseUntil && Date.now() < this.pauseUntil;
      const hint = this.error === 'вход устарел' ? 'просит войти заново'
                 : (this.error === 'Claude Code давно не запускался' || this.error === 'пропуск устарел')
                   ? 'запусти claude'
                 : this.needsAction() && this.error ? 'не читается: ' + this.reasonText()
                 : waiting ? 'жду счётчик…'
                 : this.error ? 'не читается: ' + this.reasonText()
                 : 'считаю…';
      claude.createSpan({ cls: 'cu-error', text: hint });
    } else {
      if (this.settings.showFiveHour) this.renderGauge(claude, '5 ч', live.fiveHour, 'left');
      if (this.settings.showWeekly) this.renderGauge(claude, 'нед', live.weekly, 'when');
    }

    if (this.pauseUntil && Date.now() < this.pauseUntil) {
      const wait = claude.createSpan({ cls: 'cu-wait', text: '⏳' });
      wait.setAttribute('title', this.pauseText());
    }

    if (this.settings.showChatGPT) {
      el.createSpan({ cls: 'cu-separator', text: '|' });
      const gpt = el.createSpan({ cls: 'cu-provider' });
      const gptAge = this.chatgptUpdatedAt ? Date.now() - this.chatgptUpdatedAt : null;
      const gptStale = gptAge === null || gptAge > Math.max(600000, this.chatgptSec() * 2000);
      gpt.toggleClass('cu-stale', !!gptStale);
      gpt.createSpan({ cls: 'cu-service', text: 'ChatGPT' });
      const windows = chatgptWindows(this.liveChatGPTUsage());
      if (!windows.length) {
        const hint = this.chatgptPending ? 'считаю…'
          : this.chatgptError ? safeChatGPTNote(this.chatgptError)
          : 'считаю…';
        gpt.createSpan({ cls: 'cu-error', text: hint });
      } else {
        windows.forEach((node, index) => {
          const label = rateWindowLabel(node, index ? 'лимит 2' : 'лимит 1');
          const extra = Number(node.windowMinutes) > 0 && Number(node.windowMinutes) <= 360 ? 'left' : 'when';
          this.renderGauge(gpt, label, node, extra);
        });
      }
    }

    el.setAttribute('title',
      this.fullSummaryText()
      + '\n\nClaude: цифры от ' + this.stamp() + ' (' + humanAge(age) + ')'
      + '\n' + this.nextPollText()
      + (this.error ? '\nПоследняя попытка не удалась: ' + this.reasonText()
        + (this.needsAction() ? '\n' + this.localAdvice() : '') : '')
      + (this.settings.showChatGPT
        ? '\n\nChatGPT: цифры от ' + this.chatgptStamp() + ' ('
          + humanAge(this.chatgptUpdatedAt ? Date.now() - this.chatgptUpdatedAt : null) + ')'
          + '\n' + this.nextChatGPTPollText()
          + (this.chatgptError ? '\nПоследняя попытка не удалась: ' + safeChatGPTNote(this.chatgptError) : '')
        : '')
      + '\n\nНажми, чтобы спросить сейчас. Токены на это не тратятся.');
  }

  renderGauge(parent, label, node, extra) {
    if (!node) return;
    if (typeof node.percent !== 'number' || !Number.isFinite(node.percent)) return;
    const used = Math.max(0, Math.min(100, node.percent));
    const remaining = remainingPercent({ percent: used });
    const wrap = parent.createSpan({ cls: 'cu-gauge' });
    wrap.createSpan({ cls: 'cu-label', text: label });
    const bar = wrap.createSpan({ cls: 'cu-bar' });
    const fill = bar.createSpan({ cls: 'cu-fill' });
    fill.style.width = remaining + '%';
    const warn = Number(this.settings.warnRemainingPercent) || 20;
    if (remaining <= 5) fill.addClass('is-critical');
    else if (remaining <= warn) fill.addClass('is-warn');
    const num = wrap.createSpan({ cls: 'cu-num', text: Math.round(remaining) + '%' });
    num.setAttribute('title', 'Осталось ' + Math.round(remaining)
      + ' %, израсходовано ' + Math.round(used) + ' %');

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
    containerEl.createEl('h2', { text: 'Claudian Usage — остатки Claude и ChatGPT' });
    containerEl.createEl('p', {
      text: 'Claude читается из его служебного счётчика, ChatGPT — через локальный Codex app-server. '
          + 'Оба запроса читают метаданные лимитов и не обращаются к модели.',
      cls: 'setting-item-description',
    });

    // живое состояние: видно, что плагин сам ходит к счётчику, и чем закончился прошлый раз
    const state = containerEl.createEl('p', { cls: 'setting-item-description' });
    const outcome = s.lastOutcome;
    // Про цифры говорим только если они на экране правда есть: у просроченных
    // окно обнулилось, их убрали со шкалы — и обещать их здесь нельзя.
    const shown = this.plugin.liveUsage();
    // «Устарели» можно говорить только про настоящие цифры. В настройках мог
    // остаться объект с двумя пустыми шкалами — там ничего не обнулялось,
    // и ни время чтения, ни наличие объекта сами по себе этого не различают.
    const u = this.plugin.usage;
    const everHad = !!(this.plugin.updatedAt && u && (u.fiveHour || u.weekly));
    const lines = [
      shown
        ? 'Цифры на экране: от ' + this.plugin.stamp()
            + ' (' + humanAge(this.plugin.updatedAt ? Date.now() - this.plugin.updatedAt : null) + ').'
        : everHad
          ? 'Цифр на экране нет: прошлые устарели — их окно уже обнулилось.'
          : 'Цифр на экране пока нет — счётчик ещё не отвечал.',
      this.plugin.nextPollText() + '.',
    ];
    if (outcome) {
      lines.push('Прошлое обращение в ' + hhmm(outcome.at) + ': '
        + (outcome.ok ? 'счётчик ответил' : 'отказ — ' + outcome.note
            + (outcome.waitSec ? ' (пауза ' + humanWait(outcome.waitSec) + ')' : '')) + '.');
    }
    state.setText(lines.join(' '));

    const gptState = containerEl.createEl('p', { cls: 'setting-item-description' });
    const gptShown = this.plugin.liveChatGPTUsage();
    const gptOutcome = s.lastChatGPTOutcome;
    const gptLines = [
      gptShown
        ? 'ChatGPT: цифры от ' + this.plugin.chatgptStamp() + ' ('
          + humanAge(this.plugin.chatgptUpdatedAt ? Date.now() - this.plugin.chatgptUpdatedAt : null) + ').'
        : 'ChatGPT: цифр на экране пока нет.',
      this.plugin.nextChatGPTPollText() + '.',
    ];
    if (gptOutcome) {
      gptLines.push('Прошлое обращение в ' + hhmm(gptOutcome.at) + ': '
        + (gptOutcome.ok ? 'счётчик ответил' : safeChatGPTNote(gptOutcome.note)) + '.');
    }
    gptState.setText(gptLines.join(' '));

    new Setting(containerEl)
      .setName('Показывать почту учётной записи')
      .addToggle(t => t.setValue(s.showEmail).onChange(async v => { s.showEmail = v; await save(); }));

    new Setting(containerEl)
      .setName('Claude: пятичасовое окно')
      .addToggle(t => t.setValue(s.showFiveHour).onChange(async v => { s.showFiveHour = v; await save(); }));

    new Setting(containerEl)
      .setName('Claude: недельный лимит')
      .addToggle(t => t.setValue(s.showWeekly).onChange(async v => { s.showWeekly = v; await save(); }));

    new Setting(containerEl)
      .setName('Показывать ChatGPT')
      .setDesc('Показывает лимиты плана ChatGPT/Codex. OAuth-пропуск остаётся внутри Codex и плагину не передаётся.')
      .addToggle(t => t.setValue(s.showChatGPT).onChange(async v => {
        s.showChatGPT = v;
        await save();
        if (v && !this.plugin.liveChatGPTUsage()) this.plugin.refreshChatGPT(false);
      }));

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
      .setName('Обновлять ChatGPT')
      .setDesc('В секундах. Запускает только локальное чтение лимитов через Codex; модель не вызывается.')
      .addSlider(sl => sl.setLimits(120, 1800, 60).setValue(Number(s.chatgptSec) || 300).setDynamicTooltip()
        .onChange(async v => { s.chatgptSec = v; await save(); }));

    new Setting(containerEl)
      .setName('Подсвечивать, когда осталось не больше')
      .setDesc('Проценты остатка. При 5 % и меньше шкала краснеет.')
      .addSlider(sl => sl.setLimits(5, 50, 5).setValue(Number(s.warnRemainingPercent) || 20).setDynamicTooltip()
        .onChange(async v => { s.warnRemainingPercent = v; await save(); }));

    new Setting(containerEl)
      .setName('Проверить сейчас')
      .addButton(b => b.setButtonText('Обновить').onClick(async () => {
        await this.plugin.refreshAll(true);
        this.display();
      }));
  }
}

module.exports = ClaudianUsagePlugin;

// открыто для проверок из node: решения про частоту считаются здесь и нигде больше
module.exports.__internals = {
  decidePoll, pauseSeconds, safeNote, safeChatGPTNote, humanAge, shortLeft, weekdayTime,
  claudeBusySince, busyMarkers, fetchUsage, readAccountEmail,
  dropExpired, tokenFromFile, tokenFromKeychain, readAccessToken, keychainAvailable, judgeOauth,
  dropExpiredChatGPT, remainingPercent, rateWindowLabel, chatgptWindows,
  normalizeChatGPTUsage, fetchChatGPTUsage, findCodexBinary, unixSecondsToIso,
  ClaudianUsageSettingTab, isLocalNote, LOCAL_NOTES, humanWait,
  TICK_MS, MIN_GAP_MS, PAUSE_MIN_SEC, PAUSE_MAX_SEC, CHATGPT_TIMEOUT_MS, DEFAULTS,
};
