'use strict';

// Проверка новой границы ChatGPT: настоящий OAuth не читается, сеть не трогается.
// Поддельный app-server принимает initialize и account/rateLimits/read, затем
// отдаёт два окна. Если плагин вдруг попробует вызвать модель, проверка покраснеет.

const Module = require('module');
const EventEmitter = require('events');
const path = require('path');

const realLoad = Module._load;
Module._load = function (request) {
  if (request === 'obsidian') {
    return {
      Plugin: class {}, PluginSettingTab: class {}, Setting: class {}, Notice: class {},
      requestUrl: async () => { throw new Error('сеть в проверке запрещена'); },
    };
  }
  return realLoad.apply(this, arguments);
};

const PluginClass = require(path.join(__dirname, '..', 'main.js'));
const I = PluginClass.__internals;
const {
  fetchChatGPTUsage, normalizeChatGPTUsage, remainingPercent,
  rateWindowLabel, dropExpiredChatGPT, safeChatGPTNote,
} = I;

let failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + name
    + (ok ? '' : `\n      получили: ${JSON.stringify(got)}\n      ожидали:  ${JSON.stringify(want)}`));
}

const RESET_SEC = Math.floor((Date.now() + 3600000) / 1000);
const RESULT = {
  rateLimits: {
    limitId: 'codex', planType: 'plus',
    primary: { usedPercent: 31, windowDurationMins: 300, resetsAt: RESET_SEC },
    secondary: { usedPercent: 19, windowDurationMins: 10080, resetsAt: RESET_SEC + 86400 },
    credits: { hasCredits: false, unlimited: false, balance: '0' },
  },
  rateLimitsByLimitId: null,
};

function fakeSpawnFactory(seen) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter();
    child.stderr.resume = () => {};
    child.kill = () => { child.killed = true; };
    child.stdin = {
      write(line) {
        const message = JSON.parse(line);
        seen.push(message);
        if (message.method === 'initialize') {
          setImmediate(() => child.stdout.emit('data', JSON.stringify({ id: 1, result: { userAgent: 'test' } }) + '\n'));
        } else if (message.method === 'account/rateLimits/read') {
          setImmediate(() => child.stdout.emit('data', JSON.stringify({ id: 2, result: RESULT }) + '\n'));
        }
      },
    };
    return child;
  };
}

function makeEl() {
  return {
    children: [], classes: new Set(), attrs: {}, text: '', style: {},
    empty() { this.children = []; },
    addClass(c) { this.classes.add(c); },
    toggleClass(c, on) { on ? this.classes.add(c) : this.classes.delete(c); },
    setAttribute(k, v) { this.attrs[k] = v; },
    createSpan(o = {}) {
      const child = makeEl();
      child.text = o.text || '';
      if (o.cls) child.classes.add(o.cls);
      this.children.push(child);
      return child;
    },
  };
}
const shownText = (el) => [el.text || '', ...el.children.map(shownText)].join(' ').replace(/\s+/g, ' ').trim();

(async () => {
  console.log('\nРазбор ответа ChatGPT/Codex');
  const parsed = normalizeChatGPTUsage(RESULT);
  check('пятичасовое окно прочитано', [parsed.primary.percent, parsed.primary.windowMinutes], [31, 300]);
  check('недельное окно прочитано', [parsed.secondary.percent, parsed.secondary.windowMinutes], [19, 10080]);
  check('остаток считается как 100 − расход', remainingPercent(parsed.primary), 69);
  check('окна подписаны по длительности',
    [rateWindowLabel(parsed.primary, '?'), rateWindowLabel(parsed.secondary, '?')], ['5 ч', 'нед']);
  check('живые окна не выбрасываются', !!dropExpiredChatGPT(parsed), true);
  const expired = Object.assign({}, parsed, {
    primary: Object.assign({}, parsed.primary, { resetsAt: new Date(Date.now() - 1000).toISOString() }),
    secondary: null,
  });
  check('окно после сброса не выдаётся за текущее', dropExpiredChatGPT(expired), null);
  let badRejected = false;
  try {
    normalizeChatGPTUsage({ rateLimits: { primary: { usedPercent: '31' }, secondary: null } });
  } catch (e) { badRejected = true; }
  check('строка вместо процента не превращается в число', badRejected, true);

  console.log('\nНастоящая отрисовка строки');
  const plugin = new PluginClass();
  plugin.settings = Object.assign({}, I.DEFAULTS, { showEmail: false });
  plugin.statusEl = makeEl();
  plugin.usage = {
    fiveHour: { percent: 31, resetsAt: new Date(Date.now() + 3600000).toISOString() },
    weekly: { percent: 19, resetsAt: new Date(Date.now() + 86400000).toISOString() },
  };
  plugin.updatedAt = Date.now();
  plugin.email = null;
  plugin.error = null;
  plugin.localCause = false;
  plugin.lastStatus = null;
  plugin.pauseUntil = 0;
  plugin.lastAttemptAt = Date.now();
  plugin.busy = false;
  plugin.chatgptUsage = parsed;
  plugin.chatgptUpdatedAt = Date.now();
  plugin.chatgptError = null;
  plugin.chatgptPending = false;
  plugin.lastChatGPTAttemptAt = Date.now();
  plugin.render();
  const visible = shownText(plugin.statusEl);
  check('в строке есть оба сервиса', /Claude.*ChatGPT/.test(visible), true);
  check('на экране остатки 69% и 81%, а не расход 31% и 19%',
    visible.includes('69%') && visible.includes('81%') && !visible.includes('31%'), true);

  console.log('\nПротокол локального app-server');
  const seen = [];
  const fromServer = await fetchChatGPTUsage({
    binary: '/fake/codex', spawn: fakeSpawnFactory(seen), timeoutMs: 1000,
  });
  check('получены обе цифры', [fromServer.primary.percent, fromServer.secondary.percent], [31, 19]);
  check('сначала выполняется initialize', seen[0].method, 'initialize');
  check('после инициализации отправлено initialized', seen[1].method, 'initialized');
  check('запрошены только метаданные лимитов', seen[2].method, 'account/rateLimits/read');
  check('никакого вызова модели нет', seen.some((m) => /thread|turn|response/i.test(m.method || '')), false);

  console.log('\nБезопасные ошибки');
  check('своя причина остаётся', safeChatGPTNote('Codex CLI не найден'), 'Codex CLI не найден');
  check('чужой текст не выходит на экран',
    safeChatGPTNote('Bearer eyJ... пароль 123'), 'не удалось прочитать лимит ChatGPT');

  console.log(failed ? `\n✗ не сошлось: ${failed}\n` : '\n✓ всё сошлось\n');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
