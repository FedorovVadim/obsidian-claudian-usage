// Учения для плагина Claudian Usage: проверяем поведение, а не «синтаксис ок».
//
// Что подменяется: только граница с системой — домашняя папка, наличие команды
// связки ключей и её вывод. Сам разбор пропусков и цифр — настоящий, из main.js.
// Настоящий ~/.claude/.credentials.json не читается и не трогается ни разу:
// домашняя папка подменена на временную, пропуски в ней заведомо поддельные.
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-check-'));
// Настоящий дом не используется НИ РАЗУ: песочница задана сразу, до первой проверки.
let fakeHome = SANDBOX;
let fakeKeychain = null;    // null → связки нет; иначе {err} либо {out: '<json>'}

let netAnswer = () => ({ status: 500, headers: {}, json: null });   // что «отвечает» счётчик
const realOs = require('os');
const realFs = require('fs');
const realCp = require('child_process');
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === 'obsidian') {
    class Stub { constructor() {} }
    return { Plugin: Stub, PluginSettingTab: Stub, Setting: Stub, Notice: Stub, requestUrl: async () => netAnswer() };
  }
  if (req === 'os') {
    // Прокси, а не копия: у os есть свойства только для чтения, Object.assign на них падает.
    return new Proxy(realOs, { get: (t, k) => (k === 'homedir' ? () => (fakeHome || realOs.homedir()) : t[k]) });
  }
  if (req === 'fs') {
    return new Proxy(realFs, {
      get: (t, k) => (k === 'existsSync'
        ? (p) => (p === '/usr/bin/security' ? fakeKeychain !== null : realFs.existsSync(p))
        : t[k]),
    });
  }
  if (req === 'child_process') {
    return new Proxy(realCp, {
      get: (t, k) => (k === 'execFile'
        ? (file, args, opts, cb) => {
            if (file !== '/usr/bin/security') return realCp.execFile(file, args, opts, cb);
            const k2 = fakeKeychain || { err: new Error('нет связки') };
            setImmediate(() => (k2.err ? cb(k2.err, '') : cb(null, k2.out)));
          }
        : t[k]),
    });
  }
  return origLoad(req, parent, isMain);
};

const PLUGIN = path.join(__dirname, '..', 'main.js');
const I = require(PLUGIN).__internals;
const { dropExpired, tokenFromFile, tokenFromKeychain, readAccessToken, keychainAvailable, judgeOauth, decidePoll } = I;

let failed = 0;
const check = (name, ok, got) => {
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (ok ? '' : '   ← получили: ' + JSON.stringify(got)));
  if (!ok) failed++;
};
// Неожидаемое исключение — это одна красная проверка, а не смерть всего прогона:
// иначе при ослеплении сюита умирает на первой же и остальные молча не выполняются.
const guard = async (name, fn) => {
  try {
    const r = await fn();
    check(name, r === true, r);   // только явное «да»: тело без return — это пустая проверка
  } catch (e) {
    check(name, false, 'исключение: ' + e.message);
  }
};

function makeHome(oauth) {
  const home = fs.mkdtempSync(path.join(SANDBOX, 'home-'));
  fs.mkdirSync(path.join(home, '.claude'));
  if (oauth !== undefined) {
    fs.writeFileSync(path.join(home, '.claude', '.credentials.json'),
      typeof oauth === 'string' ? oauth : JSON.stringify({ claudeAiOauth: oauth }));
  }
  return home;
}
const FAKE_FILE = 'ThisIsNotARealToken-файл-0123456789';
const FAKE_KEYS = 'ThisIsNotARealToken-связка-0123456789';
const H = 3600e3;
const LIVE  = { expiresAt: Date.now() + H, refreshTokenExpiresAt: Date.now() + 30 * 24 * H };
const SHORT = { expiresAt: Date.now() - H, refreshTokenExpiresAt: Date.now() + 30 * 24 * H }; // Claude Code не запускался
const DEAD  = { expiresAt: Date.now() - H, refreshTokenExpiresAt: Date.now() - H };           // вход правда умер
const keys = (oauth, token) => ({ out: JSON.stringify({ claudeAiOauth: Object.assign({ accessToken: token }, oauth) }) });
const future = new Date(Date.now() + H).toISOString();
const past   = new Date(Date.now() - H).toISOString();

(async () => {

console.log('── 1. отсев просроченных цифр ──');
let r = dropExpired({ fiveHour: { percent: 12, resetsAt: future }, weekly: { percent: 56, resetsAt: future } });
check('живые цифры проходят целиком', r && r.fiveHour && r.weekly && r.weekly.percent === 56, r);
r = dropExpired({ fiveHour: { percent: 0, resetsAt: past }, weekly: { percent: 81, resetsAt: past } });
check('обе просрочены → цифр нет вовсе', r === null, r);
r = dropExpired({ fiveHour: { percent: 3, resetsAt: past }, weekly: { percent: 56, resetsAt: future } });
check('просрочена только пятичасовая → остаётся недельная', r && r.fiveHour === null && r.weekly.percent === 56, r);
check('срок неизвестен → цифру не выбрасываем', !!(dropExpired({ fiveHour: { percent: 7, resetsAt: null }, weekly: null }) || {}).fiveHour, null);
check('пусто на входе → пусто на выходе', dropExpired(null) === null, dropExpired(null));

console.log('── 2. три состояния пропуска (не путать «не запускался» и «войди заново») ──');
let j = judgeOauth(Object.assign({ accessToken: FAKE_FILE }, LIVE), 'нет пропуска');
check('живой пропуск отдаётся', j.token === FAKE_FILE, j);
j = judgeOauth(Object.assign({ accessToken: FAKE_FILE }, SHORT), 'нет пропуска');
check('короткий истёк, вход жив → «Claude Code давно не запускался»', j.token === null && j.reason === 'Claude Code давно не запускался' && j.needsClaude === true, j);
j = judgeOauth(Object.assign({ accessToken: FAKE_FILE }, DEAD), 'нет пропуска');
check('умер и длинный → «вход устарел»', j.token === null && j.reason === 'вход устарел' && j.expired === true, j);
j = judgeOauth({ accessToken: FAKE_FILE }, 'нет пропуска');
check('сроков нет вовсе → пропуск принимается', j.token === FAKE_FILE, j);
j = judgeOauth({}, 'нет пропуска');
check('пропуска нет → своя причина', j.token === null && j.reason === 'нет пропуска', j);

console.log('── 3. чтение из файла ──');
fakeKeychain = null;
fakeHome = makeHome(Object.assign({ accessToken: FAKE_FILE }, LIVE));
check('живой пропуск из файла читается', tokenFromFile().token === FAKE_FILE, tokenFromFile());
fakeHome = makeHome('это не json');
check('нечитаемый файл → своя внятная причина', tokenFromFile().reason === 'файл с пропуском не читается', tokenFromFile());
fakeHome = makeHome({});
check('файл есть, пропуска нет → своя внятная причина', tokenFromFile().reason === 'в файле нет пропуска', tokenFromFile());
fakeHome = makeHome(undefined);
r = tokenFromFile();
check('файла нет → это не причина отказа, просто не здесь', r.token === null && r.reason === null, r);

console.log('── 4. порядок источников: связка ключей против файла ──');
fakeKeychain = keys(LIVE, FAKE_KEYS);
check('связка на машине обнаружена', keychainAvailable() === true, keychainAvailable());
fakeHome = makeHome(Object.assign({ accessToken: FAKE_FILE }, LIVE));
check('оба живы → берём связку (на macOS она главная)', await readAccessToken() === FAKE_KEYS, await readAccessToken());

fakeKeychain = keys(SHORT, FAKE_KEYS);   // в связке просроченный
check('в связке просроченный, в файле живой → берём файл', await readAccessToken() === FAKE_FILE, await readAccessToken());

fakeKeychain = { err: new Error('связка заперта') };
check('связка заперта, файл живой → берём файл', await readAccessToken() === FAKE_FILE, await readAccessToken());

fakeKeychain = { err: new Error('связка заперта') };
fakeHome = makeHome(Object.assign({ accessToken: FAKE_FILE }, SHORT));
try {
  await readAccessToken();
  check('связка заперта, файл просрочен → совет запустить claude', false, 'ошибки не было');
} catch (e) {
  check('связка заперта, файл просрочен → совет запустить claude', e.message === 'Claude Code давно не запускался' && e.localCause === true && !e.status, { m: e.message, s: e.status });
}

fakeHome = makeHome(Object.assign({ accessToken: FAKE_FILE }, DEAD));
try {
  await readAccessToken();
  check('оба мертвы → «вход устарел» с кодом 401', false, 'ошибки не было');
} catch (e) {
  check('оба мертвы → «вход устарел» с кодом 401', e.message === 'вход устарел' && e.status === 401 && e.localCause === true, { m: e.message, s: e.status });
}

fakeKeychain = null;                 // связки на машине нет (Linux)
fakeHome = makeHome(undefined);      // и файла нет
check('без связки её не спрашиваем', keychainAvailable() === false, keychainAvailable());
try {
  await readAccessToken();
  check('ни файла, ни связки → «пропуск Claude Code не найден»', false, 'ошибки не было');
} catch (e) {
  check('ни файла, ни связки → «пропуск Claude Code не найден»', e.message === 'пропуск Claude Code не найден' && e.localCause === true, { m: e.message, s: e.status });
}

fakeKeychain = keys(LIVE, FAKE_KEYS);
fakeHome = makeHome(undefined);
check('файла нет, связка жива → берём связку', await readAccessToken() === FAKE_KEYS, await readAccessToken());

console.log('── 5. окно обнулилось → опрос вне очереди ──');
const base = { now: Date.now(), lastAttemptAt: Date.now() - 5 * 60000, pauseUntil: 0, pending: false, busy: false, activeSec: 120, idleSec: 600, resetSeen: null };
check('просроченное окно замечено → идём к счётчику сразу', !!decidePoll(Object.assign({}, base, { resetsAt: '2026-09-14T07:30:00Z' })), null);
check('без времени обнуления повода идти вне очереди нет', !decidePoll(Object.assign({}, base, { resetsAt: null })), null);
check('по этому обнулению уже ходили → второй раз не идём', !decidePoll(Object.assign({}, base, { resetsAt: '2026-09-14T07:30:00Z', resetSeen: '2026-09-14T07:30:00Z' })), null);

console.log('── 5б. когда плагин обязан МОЛЧАТЬ ──');
const { MIN_GAP_MS } = I;
const now = Date.now();
check('пауза соблюдается', !decidePoll({ now, lastAttemptAt: now - 600000, pauseUntil: now + 60000, pending: false, busy: true, activeSec: 120, idleSec: 600, resetsAt: null, resetSeen: null }), null);
check('ближе минимального промежутка не спрашиваем', !decidePoll({ now, lastAttemptAt: now - 5000, pauseUntil: 0, pending: false, busy: true, activeSec: 120, idleSec: 600, resetsAt: null, resetSeen: null }), null);
check('пока запрос в работе — второй не начинаем', !decidePoll({ now, lastAttemptAt: now - 600000, pauseUntil: 0, pending: true, busy: true, activeSec: 120, idleSec: 600, resetsAt: null, resetSeen: null }), null);
check('Claude Code работает → спрашиваем по рабочему ритму', !!decidePoll({ now, lastAttemptAt: now - 130000, pauseUntil: 0, pending: false, busy: true, activeSec: 120, idleSec: 600, resetsAt: null, resetSeen: null }), null);
check('Claude Code молчит → по рабочему ритму ещё рано', !decidePoll({ now, lastAttemptAt: now - 130000, pauseUntil: 0, pending: false, busy: false, activeSec: 120, idleSec: 600, resetsAt: null, resetSeen: null }), null);
check('минимальный промежуток длиннее 30 секунд', MIN_GAP_MS >= 30000, MIN_GAP_MS);

console.log('── 5в. причина «местная» узнаётся и по одному тексту ──');
const { isLocalNote } = I;
check('причина от прежней версии опознана как местная', isLocalNote('связка ключей не отдала пропуск') === true, null);
check('и новая тоже', isLocalNote('Claude Code давно не запускался') === true, null);
check('а отказ счётчика местным не считается', isLocalNote('счётчик просит подождать') === false, null);
check('и пустая строка тоже', isLocalNote(null) === false, null);

console.log('── 5г. длительность паузы словами ──');
const { humanWait } = I;
check('тридцать секунд — это секунды, а не «1 мин»', humanWait(30) === '30 сек', humanWait(30));
check('минута — это минута', humanWait(60) === '1 мин', humanWait(60));
check('десять минут', humanWait(600) === '10 мин', humanWait(600));

console.log('── 6. срок в секундах вместо миллисекунд (ложное «вход устарел») ──');
const secs = (d) => Math.floor((Date.now() + d) / 1000);
let js = judgeOauth({ accessToken: FAKE_FILE, expiresAt: secs(H), refreshTokenExpiresAt: secs(30 * 24 * H) }, 'нет');
check('срок в секундах понят верно → пропуск живой', js.token === FAKE_FILE, js);
js = judgeOauth({ accessToken: FAKE_FILE, expiresAt: secs(-H), refreshTokenExpiresAt: secs(30 * 24 * H) }, 'нет');
check('в секундах истёкший короткий → «не запускался», не «вход устарел»', js.reason === 'Claude Code давно не запускался', js);
js = judgeOauth({ accessToken: FAKE_FILE, expiresAt: Date.now() - H }, 'нет');
check('длинного срока в записи нет → совет без обещания «вход не нужен»', js.reason === 'пропуск устарел' && js.refreshKnown === false, js);
js = judgeOauth({ accessToken: FAKE_FILE, expiresAt: 'не число' }, 'нет');
check('нечитаемый срок → пропуск не выбрасываем', js.token === FAKE_FILE, js);

console.log('── 7. чужой текст ошибки не уходит ни на диск, ни на экран ──');
const { safeNote } = I;
check('свою формулировку пропускаем', safeNote('вход устарел') === 'вход устарел', safeNote('вход устарел'));
check('новую формулировку тоже', safeNote('Claude Code давно не запускался') === 'Claude Code давно не запускался', null);
check('код состояния пропускаем', safeNote('сервис ответил 503') === 'сервис ответил 503', safeNote('сервис ответил 503'));
const leak = 'socket hang up sk-ant-oat01-ЧТО-ТО-ПОХОЖЕЕ-НА-ПРОПУСК';
check('чужой текст с похожим на пропуск заменяется', safeNote(leak) === 'не удалось связаться со счётчиком', safeNote(leak));

console.log('── 8. счётчик ответил, но цифр нет (самая опасная ошибка плагина) ──');
const { fetchUsage } = I;
let answer = { status: 200, headers: {}, json: { five_hour: { utilization: '12', resets_at: future }, seven_day: { utilization: 56, resets_at: future } } };
netAnswer = () => answer;
fakeKeychain = null;
fakeHome = makeHome(Object.assign({ accessToken: FAKE_FILE }, LIVE));
await guard('строка вместо числа не превращается в 0%', async () => {
  const u = await fetchUsage();
  return u.fiveHour === null && u.weekly && u.weekly.percent === 56;
});
answer = { status: 200, headers: {}, json: { five_hour: null, seven_day: null } };
await guard('ответ 200 совсем без цифр → это отказ, а не «0%»', async () => {
  try { await fetchUsage(); return 'ошибки не было'; } catch (e) { return e.message === 'счётчик ответил без цифр'; }
});
answer = { status: 429, headers: { 'retry-after': '90' }, json: null };
await guard('«слишком часто» → просьба подождать с её сроком', async () => {
  try { await fetchUsage(); return 'ошибки не было'; } catch (e) { return e.status === 429 && e.retryAfter === 90; }
});

console.log('── 9. как долго молчим после отказа ──');
const { pauseSeconds } = I;
check('местная беда → минимальная пауза, не лестница', pauseSeconds(null, null, 5, true) === 30, pauseSeconds(null, null, 5, true));
check('отказ счётчика → лестница растёт', pauseSeconds(null, null, 5, false) === 600, pauseSeconds(null, null, 5, false));
check('«слишком часто» со сроком → срок плюс запас', pauseSeconds(429, 90, 1, false) === 95, pauseSeconds(429, 90, 1, false));
check('вход отозван → пять минут', pauseSeconds(401, null, 1, false) === 300, pauseSeconds(401, null, 1, false));

fakeHome = SANDBOX; fakeKeychain = null;
fs.rmSync(SANDBOX, { recursive: true, force: true });
console.log(failed ? `\nПРОВАЛЕНО проверок: ${failed}` : '\nВсе проверки прошли');
process.exit(failed ? 1 : 0);
})();
