'use strict';

/*
 * Проверка механики обновления — того самого места, из-за которого цифры
 * застывали и приходилось нажимать на них рукой.
 *
 * Подменяется только внешнее: модуль obsidian (окно, уведомления, сеть).
 * Сами решения «пора ли спрашивать» и «сколько молчать после отказа»
 * считаются настоящим кодом плагина — иначе проверка ничего не доказывает.
 *
 * Запуск:  node test/schedule.test.js
 */

const Module = require('module');
const path = require('path');

// заглушка модуля obsidian: плагин требует его при загрузке
const stub = {
  Plugin: class { },
  PluginSettingTab: class { },
  Setting: class { },
  Notice: class { },
  requestUrl: async () => { throw new Error('в проверке сеть не трогаем'); },
};
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'obsidian') return stub;
  return realLoad.apply(this, arguments);
};

const { decidePoll, pauseSeconds, humanAge } = require(path.join(__dirname, '..', 'main.js')).__internals;

let failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (ok ? '' : `\n      получили: ${JSON.stringify(got)}\n      ожидали:  ${JSON.stringify(want)}`));
}

const NOW = 1789000000000;
const base = {
  now: NOW,
  lastAttemptAt: NOW - 600000,
  pauseUntil: 0,
  pending: false,
  busy: false,
  activeSec: 120,
  idleSec: 900,
  resetsAt: new Date(NOW + 3600000).toISOString(),
};
const at = (over) => decidePoll(Object.assign({}, base, over));

console.log('\nКогда плагин обращается к счётчику');
check('сразу после обращения — не дёргаем',
  at({ lastAttemptAt: NOW - 10000, busy: true }), null);
check('Claude Code работает, прошло 2 мин — спрашиваем',
  at({ lastAttemptAt: NOW - 120000, busy: true }), 'Claude Code работает');
check('Claude Code работает, прошла 1 мин — рано',
  at({ lastAttemptAt: NOW - 60000, busy: true }), null);
check('Claude Code молчит, прошло 2 мин — не тратим обращение',
  at({ lastAttemptAt: NOW - 120000, busy: false }), null);
check('Claude Code молчит, прошло 15 мин — плановая проверка',
  at({ lastAttemptAt: NOW - 900000, busy: false }), 'плановая проверка');
check('окно обнулилось — спрашиваем вне очереди',
  at({ lastAttemptAt: NOW - 120000, busy: false, resetsAt: new Date(NOW - 1000).toISOString() }),
  'окно обнулилось');
check('окно обнулилось, но обращались 10 сек назад — всё равно ждём',
  at({ lastAttemptAt: NOW - 10000, resetsAt: new Date(NOW - 1000).toISOString() }), null);
check('счётчик просил паузу — молчим, даже если давно не спрашивали',
  at({ lastAttemptAt: NOW - 3600000, busy: true, pauseUntil: NOW + 60000 }), null);
check('пауза кончилась — возвращаемся сами, без нажатия',
  at({ lastAttemptAt: NOW - 3600000, busy: true, pauseUntil: NOW - 1000 }), 'Claude Code работает');
check('обращение уже идёт — второе не шлём',
  at({ lastAttemptAt: NOW - 3600000, busy: true, pending: true }), null);
check('первый пульс после запуска — спрашиваем сразу',
  at({ lastAttemptAt: 0, busy: false }), 'плановая проверка');

console.log('\nСколько молчим после отказа');
check('429 со сроком 20 сек — ждём не меньше 30', pauseSeconds(429, 20, 1), 30);
check('429 со сроком 200 сек — слушаемся сервиса', pauseSeconds(429, 200, 1), 205);
check('429 со сроком 5000 сек — не больше 10 мин', pauseSeconds(429, 5000, 1), 600);
check('429 без срока, первый отказ — минута', pauseSeconds(429, null, 1), 60);
check('429 без срока, второй отказ — две', pauseSeconds(429, null, 2), 120);
check('вход устарел — 5 минут', pauseSeconds(401, null, 1), 300);
check('сеть отвалилась, первый раз — минута', pauseSeconds(null, null, 1), 60);

// то, из-за чего всё началось: прошлая версия после серии отказов
// замолкала на полчаса, и цифры на экране застывали
let worst = 0;
for (let streak = 1; streak <= 20; streak++) {
  for (const status of [429, 500, null]) {
    worst = Math.max(worst, pauseSeconds(status, null, streak));
    worst = Math.max(worst, pauseSeconds(status, 99999, streak));
  }
}
check('после любой серии отказов молчим не дольше 10 минут', worst, 600);

console.log('\nВозраст цифр словами');
check('минуту назад — «только что»', humanAge(50000), 'только что');
check('12 минут', humanAge(12 * 60000), '12 мин назад');
check('час с четвертью', humanAge(75 * 60000), '1 ч 15 мин назад');
check('ещё не читались', humanAge(null), 'ещё не читались');

console.log(failed ? `\n✗ не сошлось: ${failed}\n` : '\n✓ всё сошлось\n');
process.exit(failed ? 1 : 0);
