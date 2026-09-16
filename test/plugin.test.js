'use strict';

/*
 * Проверка самого обмена со счётчиком: onload → пульс → запрос → ответ.
 * Здесь живут дефекты, которых не видно из проверки чистых функций.
 *
 * Подменяются только границы: модуль obsidian (окно, уведомления, сеть),
 * связка ключей и часы. Разбор ответа, решение «пора ли спрашивать»,
 * пауза после отказа и запись настроек — настоящий код плагина.
 *
 * Запуск:  node test/plugin.test.js
 */

const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ── границы ─────────────────────────────────────────────────────────────────

let answer = null;      // чем ответит счётчик на следующий запрос
let requests = 0;       // сколько раз к нему обратились
let notices = [];       // что показали человеку
let keychainCalls = 0;

const TOKEN = 'sk-ant-oat01-СЕКРЕТНЫЙ-ПРОПУСК-НЕ-ДОЛЖЕН-НИКУДА-ПОПАСТЬ';

const obsidianStub = {
  Plugin: class {
    constructor() { this.intervals = []; this.domEvents = []; this.commands = []; }
    addStatusBarItem() { return makeEl(); }
    addCommand(c) { this.commands.push(c); }
    addSettingTab() { }
    registerInterval(id) { this.intervals.push(id); }
    registerDomEvent(el, type, cb) { this.domEvents.push({ el, type, cb }); }
    async loadData() { return this._data || null; }
    async saveData(d) {
      if (this._saveThrows) throw new Error('диск только для чтения');
      this._data = JSON.parse(JSON.stringify(d));
    }
  },
  PluginSettingTab: class { constructor(app, plugin) { this.app = app; this.plugin = plugin; } },
  Setting: class { },
  Notice: class { constructor(text) { notices.push(String(text)); } },
  requestUrl: async () => {
    requests++;
    if (typeof answer === 'function') return answer();
    return answer;
  },
};

function makeEl() {
  const el = {
    children: [], classes: new Set(), attrs: {}, text: '', style: {},
    empty() { this.children = []; },
    addClass(c) { this.classes.add(c); },
    toggleClass(c, on) { on ? this.classes.add(c) : this.classes.delete(c); },
    setAttribute(k, v) { this.attrs[k] = v; },
    createSpan(o) {
      const child = makeEl();
      child.text = (o && o.text) || '';
      if (o && o.cls) child.classes.add(o.cls);
      this.children.push(child);
      return child;
    },
  };
  return el;
}
/** весь текст, который человек увидит в строке состояния */
function shownText(el) {
  return el.children.map(c => c.text + shownText(c)).join(' ');
}

const realLoad = Module._load;
Module._load = function (request) {
  if (request === 'obsidian') return obsidianStub;
  if (request === 'child_process') {
    return {
      execFile: (file, args, opts, cb) => {
        keychainCalls++;
        setImmediate(() => cb(null, JSON.stringify({ claudeAiOauth: { accessToken: TOKEN } }), ''));
      },
    };
  }
  return realLoad.apply(this, arguments);
};

// часы под нашим управлением: плагин сверяется с ними, а не с настоящими
let NOW = 1789000000000;
const realNow = Date.now;
Date.now = () => NOW;

// окно и документ, которых в node нет
const timers = [];
global.window = { setInterval: (fn) => { timers.push(fn); return timers.length; } };
global.document = { hidden: false };

const ClaudianUsagePlugin = require(path.join(__dirname, '..', 'main.js'));

// ── помощники ───────────────────────────────────────────────────────────────

let failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + name
    + (ok ? '' : `\n      получили: ${JSON.stringify(got)}\n      ожидали:  ${JSON.stringify(want)}`));
}

/** процент пятичасового окна так, чтобы проверка падала внятно, а не рушилась */
const five = (p) => (p.usage && p.usage.fiveHour ? p.usage.fiveHour.percent : null);
const fiveSaved = (p) => (p._data && p._data.lastUsage && p._data.lastUsage.fiveHour
  ? p._data.lastUsage.fiveHour.percent : null);

const ok200 = (five, week, resetsAt) => ({
  status: 200,
  headers: {},
  json: {
    five_hour: { utilization: five, resets_at: resetsAt || new Date(NOW + 3600000).toISOString() },
    seven_day: { utilization: week, resets_at: new Date(NOW + 86400000).toISOString() },
  },
});
const tooOften = (retryAfter) => ({
  status: 429,
  headers: retryAfter ? { 'retry-after': String(retryAfter) } : {},
  json: {},
});

// файл-признак «Claude Code работает», которым мы управляем сами
const busyFile = path.join(os.tmpdir(), 'cu-test-busy-' + process.pid);
fs.writeFileSync(busyFile, 'x');
const idleMarks = [path.join(os.tmpdir(), 'cu-test-нет-такого-файла-' + process.pid)];

async function start(opts) {
  const o = opts || {};
  requests = 0; notices = []; keychainCalls = 0;
  const p = new ClaudianUsagePlugin();
  p._data = o.data || null;
  p._saveThrows = !!o.saveThrows;
  answer = o.answer !== undefined ? o.answer : ok200(50, 10);
  await p.onload();
  p.busyMarks = o.busy === false ? idleMarks : [busyFile];
  await settle();
  return p;
}
const settle = () => new Promise(r => setImmediate(() => setImmediate(() => setImmediate(r))));

/** прокрутить время вперёд, вызывая пульс каждые 30 секунд, как в жизни */
async function advance(plugin, seconds) {
  for (let s = 0; s < seconds; s += 30) {
    NOW += 30000;
    // след «Claude Code работает» держим свежим по нашим же часам
    fs.utimesSync(busyFile, new Date(NOW), new Date(NOW));
    plugin.tick();
    await settle();
  }
}

// ── проверки ────────────────────────────────────────────────────────────────

(async () => {
  console.log('\nОбычная работа');
  {
    const p = await start({});
    check('на запуске спрашивает счётчик сам', requests, 1);
    check('цифры показаны', [five(p), p.usage.weekly && p.usage.weekly.percent], [50, 10]);
    check('шкалы нарисованы', shownText(p.statusEl).includes('50%'), true);
    check('цифры сохранены на диск', fiveSaved(p), 50);

    answer = ok200(55, 11);
    await advance(p, 120);
    check('через 2 минуты работы обновился сам, без нажатия', five(p), 55);
    check('обращений ровно два — лишних нет', requests, 2);
  }

  console.log('\nОтказ «слишком часто» — то, с чего всё началось');
  {
    const p = await start({});
    answer = tooOften(55);
    await advance(p, 120);
    check('после отказа цифры на экране остались прежними', five(p), 50);
    check('пауза взята из ответа сервиса', Math.round((p.pauseUntil - NOW) / 1000), 60);

    const before = requests;
    await advance(p, 30);
    check('во время паузы не долбит счётчик', requests, before);

    answer = ok200(60, 12);
    await advance(p, 90);
    check('пауза кончилась — вернулся сам, нажимать не пришлось', five(p), 60);
    check('после успеха пауза снята', p.pauseUntil, 0);
  }
  {
    const p = await start({});
    answer = tooOften(0);   // сервис называет ноль и снова отказывает
    await advance(p, 120);
    check('срок «ноль секунд» не принимаем — ждём не меньше 30', (p.pauseUntil - NOW) / 1000 >= 30, true);
    let worst = 0;
    for (let i = 0; i < 40; i++) { await advance(p, 60); worst = Math.max(worst, (p.pauseUntil - NOW) / 1000); }
    check('при бесконечных отказах молчим не дольше 10 минут', worst <= 600, true);
  }

  console.log('\nОтветы, которые нельзя принимать за правду');
  {
    const p = await start({});
    answer = { status: 200, headers: {}, json: { five_hour: null, seven_day: null } };
    await advance(p, 120);
    check('ответ без цифр не стёр прежние', five(p), 50);
    check('пустышка не записана на диск', fiveSaved(p), 50);
    check('строка внизу окна не опустела', shownText(p.statusEl).includes('50%'), true);
  }
  {
    const p = await start({});
    answer = { status: 200, headers: {}, json: { five_hour: { utilization: 'много' }, seven_day: { utilization: {} } } };
    await advance(p, 120);
    check('мусор вместо процента не превратился в спокойный 0%', five(p), 50);
    check('и не записан на диск', fiveSaved(p), 50);
  }
  {
    const p = await start({});
    answer = { status: 200, headers: {}, json: null };   // прокси вернул не то
    await advance(p, 120);
    check('пустой ответ не сломал показ', five(p), 50);
  }

  console.log('\nСбой записи на диск — это не отказ счётчика');
  {
    const realErr = console.error;
    console.error = () => { };   // жалоба на диск здесь ожидаема, не засоряем вывод
    const p = await start({ saveThrows: true });
    check('цифры прочитаны', five(p), 50);
    check('ошибка счётчика не выдумана', p.error, null);
    check('опрос не заглушён паузой', p.pauseUntil, 0);
    const before = requests;
    await advance(p, 120);
    check('и через 2 минуты спросил снова', requests, before + 1);
    console.error = realErr;
  }

  console.log('\nОкно обнулилось');
  {
    const p = await start({ busy: false, answer: ok200(3, 10, new Date(NOW - 1000).toISOString()) });
    await advance(p, 3600);
    // спокойный режим — 4 плановых проверки в час плюс одна внеочередная на обнулении
    check('прошедший срок обнуления не превратился в опрос каждые полминуты', requests <= 6, true);
    check('(сколько обращений вышло за час)', requests <= 6 ? requests : requests, requests);
  }

  console.log('\nЧасы и перезапуск');
  {
    const p = await start({});
    NOW -= 30 * 60000;                 // часы перевели на полчаса назад
    const before = requests;
    await advance(p, 120);
    check('после перевода часов назад не замолчал на полчаса', requests > before, true);
  }
  {
    const p = await start({});
    answer = tooOften(300);
    await advance(p, 120);
    const saved = p._data;
    check('пауза записана на диск', saved.pauseUntil > NOW, true);

    requests = 0;
    const again = new ClaudianUsagePlugin();
    again._data = saved;
    answer = ok200(99, 99);
    await again.onload();
    await settle();
    check('перезапуск плагина не лезет к счётчику в обход паузы', requests, 0);
    check('и показывает прежние цифры, а не пустоту', five(again), 50);
  }

  console.log('\nОдновременные попытки');
  {
    const p = await start({});
    answer = () => { requests--; return new Promise(r => setTimeout(() => { requests++; r(ok200(70, 20)); }, 30)); };
    requests = 0;
    NOW += 300000;
    p.tick(); p.tick();
    p.refresh(true); p.refresh(true);
    await new Promise(r => setTimeout(r, 80));
    check('пульс и два нажатия подряд дают одно обращение', requests, 1);
  }

  console.log('\nПропуск из связки ключей');
  {
    const p = await start({});
    answer = tooOften(60);
    await advance(p, 120);
    const dump = JSON.stringify(p._data) + '\n' + notices.join('\n')
      + '\n' + JSON.stringify(p.statusEl.attrs) + shownText(p.statusEl);
    check('пропуск не попал ни в настройки, ни в уведомления, ни в подсказку', dump.includes('sk-ant'), false);
    check('на диск легла своя формулировка, а не чужой текст', p._data.lastOutcome.note, 'счётчик просит подождать');

    // хранилище у людей синхронизируется и попадает в git — чужой текст туда нельзя
    const q = await start({});
    answer = () => { throw new Error('connect ECONNREFUSED 10.0.0.7:443 пользователь ivan пароль 12345'); };
    await advance(q, 120);
    check('незнакомая ошибка обезличивается перед записью',
      q._data.lastOutcome.note, 'не удалось связаться со счётчиком');
    check('код состояния при этом сохранён', q._data.lastOutcome.ok, false);
  }

  console.log('\nПереход со старых настроек');
  {
    const old = {
      refreshSec: 600, warnPercent: 90, showEmail: false,
      lastUsage: { fiveHour: { percent: 42, resetsAt: new Date(NOW + 600000).toISOString() }, weekly: null },
      lastUsageAt: NOW - 7200000,
    };
    const p = await start({ data: old });
    check('старая частота стала спокойным режимом', p.settings.idleSec, 600);
    check('рабочая частота появилась', p.settings.activeSec, 120);
    check('старая настройка убрана', p.settings.refreshSec, undefined);
    check('порог подсветки не потерян', p.settings.warnPercent, 90);
    check('выключенная почта не включилась обратно', p.settings.showEmail, false);
  }

  console.log('\nПризнак «Claude Code работает»');
  {
    fs.utimesSync(busyFile, new Date(NOW), new Date(NOW));
    const { claudeBusySince, busyMarkers } = ClaudianUsagePlugin.__internals;
    check('свежий след — работает', claudeBusySince(NOW - 60000, [busyFile]), true);
    check('след старше вопроса — молчит', claudeBusySince(NOW + 60000, [busyFile]), false);
    check('нет файла — не падаем', claudeBusySince(NOW - 60000, idleMarks), false);
    // настоящий признак должен существовать на этой машине, иначе плагин
    // навсегда съедет в спокойный режим и симптом вернётся (§🧯)
    check('главный след ~/.claude.json на месте', fs.existsSync(busyMarkers()[0]), true);
  }

  console.log('\nНесколько учётных записей Anthropic');
  {
    // Домашнюю папку подменяем на временную: плагин узнаёт учётную запись из
    // ~/.claude.json, и другого способа «сменить аккаунт» в проверке нет.
    const realHome = os.homedir;
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-home-'));
    const login = (email) => fs.writeFileSync(path.join(fakeHome, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: email } }));
    os.homedir = () => fakeHome;

    try {
      // 1. Под учётной записью A снимаем настоящие цифры — через настоящий разбор ответа
      login('a@example.com');
      const a = await start({ answer: ok200(77, 33) });
      await advance(a, 130);
      check('цифры учётной записи A получены', five(a), 77);
      check('вместе с цифрами записано, чьи они', a._data.lastUsageEmail, 'a@example.com');

      // Снимок диска — с ним плагин запустится в следующий раз
      const diskA = JSON.parse(JSON.stringify(a._data));

      // 2. Тот же аккаунт, связи нет: показать вчерашние цифры — правильно
      login('a@example.com');
      const again = await start({ data: diskA, answer: tooOften(600) });
      check('свои прошлые цифры при обрыве связи остаются', five(again), 77);

      // 3. Вход выполнен под B, а на диске цифры A. Связи нет — свежие взять неоткуда.
      //    Показать при этом 77% значило бы солгать про другой аккаунт.
      login('b@example.com');
      const other = await start({ data: diskA, answer: tooOften(600) });
      check('чужие цифры при запуске не показываются', five(other), null);
      check('и с диска они убраны', other.settings.lastUsage, null);

      // 4. Переключение на ходу: плагин уже работает, человек сменил аккаунт
      login('a@example.com');
      const live = await start({ answer: ok200(77, 33) });
      await advance(live, 130);
      check('перед переключением цифры A на экране', five(live), 77);

      login('b@example.com');
      answer = ok200(12, 4);
      live.tick();
      await settle();
      check('после переключения чужие цифры сняты сразу', five(live) !== 77, true);
      await advance(live, 130);
      check('и заменены цифрами учётной записи B', five(live), 12);
      check('подпись под цифрами тоже новая', live._data.lastUsageEmail, 'b@example.com');

      // 5. Пауза, о которой просил счётчик прежнего аккаунта, не должна запирать новый
      login('a@example.com');
      const paused = await start({ data: diskA, answer: tooOften(600) });
      await advance(paused, 130);
      check('счётчик попросил подождать', paused.pauseUntil > NOW, true);
      const askedBefore = requests;
      login('b@example.com');
      answer = ok200(12, 4);
      paused.tick();
      await settle();
      // Пауза была выпрошена счётчиком прежнего аккаунта. Признак того, что она снята, —
      // не значение поля (следующий отказ поставит новую), а сам факт нового обращения.
      check('после смены аккаунта плагин спрашивает сразу, не досиживая чужую паузу',
        requests > askedBefore, true);
      check('и показывает цифры нового аккаунта', five(paused), 12);
    } finally {
      os.homedir = realHome;
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  }

  fs.unlinkSync(busyFile);
  Date.now = realNow;
  console.log(failed ? `\n✗ не сошлось: ${failed}\n` : '\n✓ всё сошлось\n');
  process.exit(failed ? 1 : 0);
})();
