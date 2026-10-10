// Сквозное учение: плагин поднимается ЦЕЛИКОМ с заглушкой окна Obsidian.
// Проверяем не «функция вернула», а что человек прочитает внизу окна.
//
// Подменяется только внешнее: окно, сеть, домашняя папка, связка ключей.
// Настоящий ~/.claude/.credentials.json и ~/.claude.json не читаются:
// домашняя папка подменена на временную, всё в ней поддельное.
const realFs = require('fs');
const realOs = require('os');
const realCp = require('child_process');
const path = require('path');
const Module = require('module');

let netAnswer = () => ({ status: 429, headers: {}, json: null });   // что «отвечает» счётчик
let netCalls = 0;                                                   // сколько раз к нему сходили
const SANDBOX = realFs.mkdtempSync(path.join(realOs.tmpdir(), 'cu-e2e-'));
let fakeHome = SANDBOX;
let fakeKeychain = null;

// Obsidian живёт в окне браузера — таймеры плагин берёт оттуда.
// Гасим их сразу: пульс в учении не нужен, иначе прогон не завершится.
global.window = { setInterval: (fn, ms) => { const t = setInterval(fn, ms); clearInterval(t); return t; }, clearInterval: (t) => clearInterval(t) };
global.document = { hidden: false, addEventListener: () => {} };

function makeEl() {
  return {
    children: [], classes: new Set(), attrs: {}, text: '', style: {},
    empty() { this.children = []; },
    createSpan(o = {}) { const c = makeEl(); c.text = o.text || ''; c.cls = o.cls || ''; this.children.push(c); return c; },
    createEl(t, o = {}) { return this.createSpan(o); },
    addClass(c) { this.classes.add(c); },
    toggleClass(c, on) { on ? this.classes.add(c) : this.classes.delete(c); },
    setAttribute(k, v) { this.attrs[k] = v; },
    setText(t) { this.text = t; },
  };
}
const visibleText = (el) => [el.text || '', ...el.children.map(visibleText)].join(' ').replace(/\s+/g, ' ').trim();

const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === 'obsidian') {
    class Plugin {
      async loadData() { return this._saved || {}; }
      async saveData(d) { this._saved = d; }
      addStatusBarItem() { return makeEl(); }
      registerDomEvent() {} registerInterval() {} addCommand() {} addSettingTab() {}
    }
    class Setting {
      constructor() {} setName() { return this; } setDesc() { return this; }
      addToggle(f) { f({ setValue: () => ({ onChange: () => {} }) }); return this; }
      addSlider(f) { f({ setLimits: () => ({ setValue: () => ({ setDynamicTooltip: () => ({ onChange: () => {} }) }) }) }); return this; }
      addButton(f) { f({ setButtonText: () => ({ onClick: () => {} }) }); return this; }
      addExtraButton(f) { f({ setIcon: () => ({ setTooltip: () => ({ onClick: () => {} }) }) }); return this; }
    }
    return { Plugin, PluginSettingTab: class { constructor() {} }, Setting, Notice: class {}, requestUrl: async () => { netCalls += 1; return netAnswer(); } };
  }
  if (req === 'os') return new Proxy(realOs, { get: (t, k) => (k === 'homedir' ? () => fakeHome : t[k]) });
  if (req === 'fs') return new Proxy(realFs, { get: (t, k) => (k === 'existsSync' ? (p) => (p === '/usr/bin/security' ? fakeKeychain !== null : realFs.existsSync(p)) : t[k]) });
  if (req === 'child_process') return new Proxy(realCp, { get: (t, k) => (k === 'execFile' ? (f, a, o, cb) => { if (f !== '/usr/bin/security') return realCp.execFile(f, a, o, cb); const kk = fakeKeychain || { err: new Error('нет связки') }; setImmediate(() => (kk.err ? cb(kk.err, '') : cb(null, kk.out))); } : t[k]) });
  return origLoad(req, parent, isMain);
};

const PluginClass = require(path.join(__dirname, '..', 'main.js'));
const { ClaudianUsageSettingTab } = require(path.join(__dirname, '..', 'main.js')).__internals;

let failed = 0;
const check = (name, ok, got) => {
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (ok ? '' : '   ← получили: ' + JSON.stringify(got)));
  if (!ok) failed++;
};

async function boot(saved, oauth) {
  // своя домашняя папка на каждый прогон
  fakeHome = realFs.mkdtempSync(path.join(SANDBOX, 'home-'));
  realFs.mkdirSync(path.join(fakeHome, '.claude'));
  realFs.writeFileSync(path.join(fakeHome, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'kto-to@example.com' } }));
  if (oauth) realFs.writeFileSync(path.join(fakeHome, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: oauth }));
  const p = new PluginClass();
  // Старые учения изолируют только Claude. ChatGPT проверяется отдельно с
  // поддельным app-server, чтобы ни разу не трогать настоящий аккаунт.
  p._saved = Object.assign({ showChatGPT: false }, saved || {});
  await p.onload();
  p.render();
  return p;
}

const H = 3600e3;
const STALE_ON_DISK = {
  lastUsage: {
    fiveHour: { percent: 0, resetsAt: '2026-09-14T07:30:00.495076+00:00' },
    weekly: { percent: 81, resetsAt: '2026-09-17T09:00:00.495107+00:00' },
  },
  lastUsageAt: 1789355199538, lastUsageEmail: null, pauseUntil: 0,
};

(async () => {

console.log('── просроченные цифры в настройках (то, что было на devbox) ──');
let p = await boot(STALE_ON_DISK, { accessToken: 'ThisIsNotARealToken-x', expiresAt: Date.now() + H, refreshTokenExpiresAt: Date.now() + 30 * 24 * H });
let shown = visibleText(p.statusEl);
console.log('    внизу окна: «' + shown + '»');
check('на экране НЕТ просроченных 81%', !shown.includes('81'), shown);
check('на экране нет вообще никакого процента', !/\d+\s*%/.test(shown), shown);
check('в памяти просроченное сохранено (для разбора обнуления)', !!(p.usage && p.usage.fiveHour), p.usage);
check('liveUsage() их не отдаёт', p.liveUsage() === null, p.liveUsage());
check('время обнуления найдено по любой шкале', p.nearestReset() === '2026-09-14T07:30:00.495076+00:00', p.nearestReset());
check('подсказка не обещает цифр на экране', !(p.statusEl.attrs.title || '').includes('На экране цифры'), p.statusEl.attrs.title);
check('краткая сводка честна', p.summaryText() === 'Остаток Claude пока не прочитан', p.summaryText());
check('текст паузы не обещает цифр', !p.pauseText().includes('На экране цифры'), p.pauseText());

console.log('── живые цифры ──');
p = await boot({
  lastUsage: { fiveHour: { percent: 2, resetsAt: new Date(Date.now() + H).toISOString() }, weekly: { percent: 56, resetsAt: new Date(Date.now() + 3 * 24 * H).toISOString() } },
  lastUsageAt: Date.now() - 60000, lastUsageEmail: null, pauseUntil: 0,
}, { accessToken: 'ThisIsNotARealToken-x', expiresAt: Date.now() + H });
shown = visibleText(p.statusEl);
console.log('    внизу окна: «' + shown + '»');
check('показывается именно ОСТАТОК: 98% и 44%', shown.includes('98%') && shown.includes('44%'), shown);
check('подсказка перечисляет оба лимита', /Claude · пять часов.*Claude · неделя/s.test(p.summaryText()), p.summaryText());

console.log('── пропуск устарел, но вход жив: Claude Code просто не запускался ──');
p = await boot(STALE_ON_DISK, { accessToken: 'ThisIsNotARealToken-x', expiresAt: Date.now() - H, refreshTokenExpiresAt: Date.now() + 30 * 24 * H });
await p.refresh(false);
p.render();
shown = visibleText(p.statusEl);
console.log('    внизу окна: «' + shown + '»');
console.log('    при нажатии: «' + p.failText(null).replace(/\n/g, ' / ') + '»');
check('не говорим «войди заново» — вход-то жив', !shown.includes('войти заново') && !p.failText(null).includes('выполни вход'), { shown, fail: p.failText(null) });
check('совет — запустить claude', /набери claude/.test(p.failText(null)), p.failText(null));
check('прямо сказано, что вход заново не нужен', /вход заново не нужен/.test(p.failText(null)), p.failText(null));
check('причина помечена как местная, не от счётчика', p.localCause === true, p.localCause);
check('текст паузы не рассказывает про занятый счётчик', !p.pauseText().includes('Счётчик попросил паузу'), p.pauseText());
check('и не обещает «обновлю сам» там, где нужно действие', !p.pauseText().includes('нажимать не нужно'), p.pauseText());

console.log('── вход правда умер: и длинный пропуск просрочен ──');
p = await boot(STALE_ON_DISK, { accessToken: 'ThisIsNotARealToken-x', expiresAt: Date.now() - H, refreshTokenExpiresAt: Date.now() - H });
await p.refresh(false);
p.render();
shown = visibleText(p.statusEl);
console.log('    внизу окна: «' + shown + '»');
check('здесь как раз «войти заново»', shown.includes('войти заново'), shown);
check('и совет выполнить вход', /выполни вход/.test(p.failText(401)), p.failText(401));
// Пропуск мёртв в НАШЕМ файле — причина местная, к счётчику не ходили.
// Пауза короткая нарочно: как только человек выполнит вход, плагин заметит
// это за полминуты. Пять минут ожидания здесь были бы наказанием за послушание.
check('пауза короткая — вход заметим сразу', Math.round((p.pauseUntil - Date.now()) / 1000) <= 30, Math.round((p.pauseUntil - Date.now()) / 1000));
check('причина помечена местной, хоть код и 401', p.localCause === true && p.lastStatus === 401, { l: p.localCause, s: p.lastStatus });

console.log('── первый запуск: цифр не было никогда ──');
p = await boot({}, { accessToken: 'ThisIsNotARealToken-x', expiresAt: Date.now() + H });
check('в памяти цифр нет', p.usage === null, p.usage);
check('сводка не врёт про устаревшее', p.summaryText() === 'Остаток Claude пока не прочитан', p.summaryText());
function settingsText(plugin) {
  const box = makeEl();
  box.createEl = (tagName, o = {}) => { const c = makeEl(); c.text = (o || {}).text || ''; c.cls = (o || {}).cls || ''; box.children.push(c); return c; };
  const tab = Object.create(ClaudianUsageSettingTab.prototype);
  tab.plugin = plugin; tab.containerEl = box;
  tab.display();
  return visibleText(box);
}
let st = settingsText(p);
console.log('    в окне настроек: «' + (st.match(/Цифр[^.]*\./) || ['—'])[0] + '»');
check('в настройках сказано «счётчик ещё не отвечал», а не «устарели»', st.includes('ещё не отвечал') && !st.includes('прошлые устарели'), st.slice(0, 160));

const pStale = await boot(STALE_ON_DISK, { accessToken: 'ThisIsNotARealToken-x', expiresAt: Date.now() + H });
st = settingsText(pStale);
console.log('    при просроченных: «' + (st.match(/Цифр[^.]*\./) || ['—'])[0] + '»');
check('а при просроченных — именно «устарели»', st.includes('прошлые устарели'), st.slice(0, 160));

console.log('── перезапуск внутри паузы: помним ли, ЧЬЯ была причина ──');
// Ровно то, что лежало в настройках на devbox: пауза от местной беды.
const RESTART = Object.assign({}, STALE_ON_DISK, {
  pauseUntil: Date.now() + 8 * 60000,
  lastOutcome: { at: Date.now() - 60000, ok: false, status: null, note: 'пропуск Claude Code не найден', waitSec: 600, local: true },
});
p = await boot(RESTART, null);   // пропуска в песочнице нет вовсе
shown = visibleText(p.statusEl);
console.log('    внизу окна: «' + shown + '»');
console.log('    подсказка: «' + (p.statusEl.attrs.title || '').split('\n')[0] + '»');
check('причина поднята с диска, а не забыта', p.error === 'пропуск Claude Code не найден', p.error);
check('помним, что причина местная', p.localCause === true, p.localCause);
check('внизу окна не «жду счётчик»', !shown.includes('жду счётчик'), shown);
check('подсказка НЕ утверждает, что счётчик просил паузу', !(p.statusEl.attrs.title || '').includes('Счётчик попросил паузу'), p.statusEl.attrs.title);
check('и не обещает «нажимать не нужно»', !(p.statusEl.attrs.title || '').includes('нажимать не нужно'), p.statusEl.attrs.title);
check('зато говорит, что сделать', /набери claude/.test(p.statusEl.attrs.title || ''), p.statusEl.attrs.title);

console.log('── перезапуск внутри паузы, которую правда просил счётчик ──');
p = await boot(Object.assign({}, STALE_ON_DISK, {
  pauseUntil: Date.now() + 3 * 60000,
  lastOutcome: { at: Date.now() - 30000, ok: false, status: 429, note: 'счётчик просит подождать', waitSec: 180, local: false },
}), { accessToken: 'ThisIsNotARealToken-x', expiresAt: Date.now() + H });
check('здесь про счётчик говорить как раз можно', (p.pauseText() || '').includes('Счётчик попросил паузу'), p.pauseText());
check('и «обновлю сам» уместно', p.pauseText().includes('нажимать не нужно'), p.pauseText());

console.log('── счётчик отозвал вход (401): плагин сам не справится ──');
netAnswer = () => ({ status: 401, headers: {}, json: null });
p = await boot({ lastUsage: null, lastUsageAt: null, pauseUntil: 0 }, { accessToken: 'ThisIsNotARealToken-x', expiresAt: Date.now() + H });
await p.refresh(false);
p.render();
check('пауза не описывается как просьба счётчика', !p.pauseText().includes('Счётчик попросил паузу'), p.pauseText());
check('не обещаем «нажимать не нужно» — нужен вход', !p.pauseText().includes('нажимать не нужно'), p.pauseText());
check('внизу окна — просьба войти заново', visibleText(p.statusEl).includes('войти заново'), visibleText(p.statusEl));
// А вот 401 ОТ СЧЁТЧИКА — это сеть: штурмовать его нельзя, пауза длинная.
check('отказ счётчика → пауза 5 минут', Math.round((p.pauseUntil - Date.now()) / 1000) > 280, Math.round((p.pauseUntil - Date.now()) / 1000));
check('и причина не местная', p.localCause === false, p.localCause);
netAnswer = () => ({ status: 429, headers: {}, json: null });

console.log('── чужой текст ошибки не должен попасть человеку на экран ──');
// В тексте сетевой ошибки может оказаться кусок пропуска: на диск его не пишем,
// и на экран тоже нельзя — там его прочитает человек и увидит скриншот.
const LEAKY = 'connect ECONNREFUSED sk-ant-oat01-ПОХОЖЕ-НА-ПРОПУСК-0123456789';
netAnswer = () => { throw new Error(LEAKY); };
p = await boot({ lastUsage: null, lastUsageAt: null, pauseUntil: 0 }, { accessToken: 'ThisIsNotARealToken-x', expiresAt: Date.now() + H });
await p.refresh(false);
p.render();
const everywhere = [visibleText(p.statusEl), p.statusEl.attrs.title || '', p.failText(null), p.pauseText(), JSON.stringify(p.settings.lastOutcome)].join(' | ');
console.log('    внизу окна: «' + visibleText(p.statusEl) + '»');
check('чужого текста нет ни на экране, ни в подсказке, ни в настройках', !everywhere.includes('ECONNREFUSED') && !everywhere.includes('sk-ant-oat01'), everywhere.slice(0, 200));
check('вместо него — своя формулировка', everywhere.includes('не удалось связаться со счётчиком'), everywhere.slice(0, 200));
netAnswer = () => ({ status: 429, headers: {}, json: null });

console.log('── ближайшее обнуление, когда недельное раньше пятичасового ──');
p = await boot({
  lastUsage: {
    fiveHour: { percent: 3, resetsAt: new Date(Date.now() + 5 * H).toISOString() },
    weekly: { percent: 56, resetsAt: new Date(Date.now() + 2 * H).toISOString() },
  },
  lastUsageAt: Date.now() - 60000, pauseUntil: 0,
}, { accessToken: 'ThisIsNotARealToken-x', expiresAt: Date.now() + H });
check('берём недельное — оно ближе', p.nearestReset() === p.usage.weekly.resetsAt, { got: p.nearestReset(), weekly: p.usage.weekly.resetsAt });
p.usage.fiveHour = null;   // счётчик отдал пятичасовую без числа
check('пятичасовой нет → держимся на недельной', p.nearestReset() === p.usage.weekly.resetsAt, p.nearestReset());
p.usage = null;
check('цифр нет вовсе → обнуления не знаем', p.nearestReset() === null, p.nearestReset());

console.log('── цифры чужой учётной записи ──');
p = await boot(Object.assign({}, STALE_ON_DISK, { lastUsageEmail: 'kto-to@example.com', lastUsage: { fiveHour: { percent: 2, resetsAt: new Date(Date.now() + H).toISOString() }, weekly: null }, lastUsageAt: Date.now() - 60000 }), { accessToken: 'ThisIsNotARealToken-x', expiresAt: Date.now() + H });
check('своя учётная запись → цифры остались', !!p.usage, p.usage);
p = await boot(Object.assign({}, STALE_ON_DISK, { lastUsageEmail: 'chuzhoi@example.com', lastUsage: { fiveHour: { percent: 2, resetsAt: new Date(Date.now() + H).toISOString() }, weekly: null }, lastUsageAt: Date.now() - 60000 }), { accessToken: 'ThisIsNotARealToken-x', expiresAt: Date.now() + H });
check('чужая учётная запись → цифры забыты', p.usage === null && p.updatedAt === null, { u: p.usage, at: p.updatedAt });

console.log('── в настройках остался объект с пустыми шкалами ──');
p = await boot({ lastUsage: { fiveHour: null, weekly: null }, lastUsageAt: null, pauseUntil: 0 }, { accessToken: 'ThisIsNotARealToken-x', expiresAt: Date.now() + H });
st = settingsText(p);
console.log('    в окне настроек: «' + (st.match(/Цифр[^.]*\./) || ['—'])[0] + '»');
check('не выдумываем, что цифры были и устарели', st.includes('ещё не отвечал') && !st.includes('прошлые устарели'), st.slice(0, 160));

console.log('── обнуление окна: сходить ОДИН раз, а не штурмовать счётчик ──');
// Самое опасное место: если плагин перестанет помнить, по какому обнулению уже
// ходил, он пойдёт к счётчику на каждом пульсе и сам загонит себя в «слишком часто».
netAnswer = () => ({ status: 200, headers: {}, json: { five_hour: { utilization: 4, resets_at: new Date(Date.now() + 5 * H).toISOString() }, seven_day: { utilization: 56, resets_at: new Date(Date.now() + 3 * 24 * H).toISOString() } } });
netCalls = 0;   // считаем с самого запуска: плагин спрашивает счётчик уже при загрузке
p = await boot({
  lastUsage: { fiveHour: { percent: 9, resetsAt: new Date(Date.now() - H).toISOString() }, weekly: { percent: 56, resetsAt: new Date(Date.now() + 3 * 24 * H).toISOString() } },
  lastUsageAt: Date.now() - 4 * 60000, pauseUntil: 0,
}, { accessToken: 'ThisIsNotARealToken-x', expiresAt: Date.now() + H });
await new Promise((r) => setTimeout(r, 60));
const afterBoot = netCalls;
for (let i = 0; i < 8; i += 1) { p.tick(); await new Promise((r) => setTimeout(r, 15)); }
console.log('    обращений: при запуске ' + afterBoot + ', за восемь пульсов после — ' + (netCalls - afterBoot));
check('по обнулению сходили один раз при запуске', afterBoot === 1, afterBoot);
check('дальше не штурмуем — ни одного лишнего обращения', netCalls - afterBoot === 0, netCalls - afterBoot);
check('запомнили, по какому обнулению ходили', p.resetSeen !== null, p.resetSeen);
check('и цифры обновились на свежие', p.usage && p.usage.fiveHour && p.usage.fiveHour.percent === 4, p.usage);
netAnswer = () => ({ status: 429, headers: {}, json: null });

console.log('── «следующая проверка» тоже не валит паузу на счётчик ──');
p = await boot(Object.assign({}, STALE_ON_DISK, {
  pauseUntil: Date.now() + 5 * 60000,
  lastOutcome: { at: Date.now() - 30000, ok: false, status: null, note: 'пропуск Claude Code не найден', waitSec: 30, local: true },
}), null);
console.log('    «следующая проверка»: «' + p.nextPollText() + '»');
check('при местной причине про счётчик не выдумываем', !p.nextPollText().includes('Счётчик просил паузу'), p.nextPollText());
st = settingsText(p);
check('и в окне настроек тоже', !st.includes('Счётчик просил паузу'), st.slice(0, 200));
check('длительность паузы показана в секундах, не «1 мин»', st.includes('30 сек'), st.slice(0, 220));

p = await boot(Object.assign({}, STALE_ON_DISK, {
  pauseUntil: Date.now() + 2 * 60000,
  lastOutcome: { at: Date.now() - 30000, ok: false, status: 429, note: 'счётчик просит подождать', waitSec: 120, local: false },
}), { accessToken: 'ThisIsNotARealToken-x', expiresAt: Date.now() + H });
check('а при «слишком часто» — говорим прямо про счётчик', p.nextPollText().includes('Счётчик просил паузу'), p.nextPollText());

console.log('── обновление с прежней версии: на диске нет пометки «чья причина» ──');
// Так писала версия 1.4.2 и раньше: поля local нет вовсе, пауза по длинной лестнице.
p = await boot(Object.assign({}, STALE_ON_DISK, {
  pauseUntil: Date.now() + 9 * 60000,
  lastOutcome: { at: Date.now() - 60000, ok: false, status: null, note: 'связка ключей не отдала пропуск', waitSec: 600 },
}), null);
shown = visibleText(p.statusEl);
console.log('    внизу окна: «' + shown + '»');
check('местность узнана по самой причине', p.localCause === true, p.localCause);
check('не «жду счётчик» — счётчик тут ни при чём', !shown.includes('жду счётчик'), shown);
check('подсказка не обещает «нажимать не нужно»', !(p.statusEl.attrs.title || '').includes('нажимать не нужно'), p.statusEl.attrs.title);
check('чужую девятиминутную паузу не досиживаем', Math.round((p.pauseUntil - Date.now()) / 1000) <= 30, Math.round((p.pauseUntil - Date.now()) / 1000));

console.log('── человек нажал на строку во время паузы ──');
netCalls = 0;
p = await boot(Object.assign({}, STALE_ON_DISK, {
  pauseUntil: Date.now() + 5 * 60000, lastUsageAt: Date.now() - 5 * 60000,
  lastOutcome: { at: Date.now() - 60000, ok: false, status: 429, note: 'счётчик просит подождать', waitSec: 300, local: false },
}), { accessToken: 'ThisIsNotARealToken-x', expiresAt: Date.now() + H });
await p.refresh(true);    // нажатие
check('нажатие пробивает паузу', netCalls === 1, netCalls);
netCalls = 0;
await p.refresh(true);     // сразу второе нажатие
check('а частые нажатия подряд — нет', netCalls === 0, netCalls);

console.log('── цифры вне разумных границ ──');
netAnswer = () => ({ status: 200, headers: {}, json: { five_hour: { utilization: 137, resets_at: new Date(Date.now() + H).toISOString() }, seven_day: { utilization: -5, resets_at: new Date(Date.now() + H).toISOString() } } });
p = await boot({ lastUsage: null, lastUsageAt: null, pauseUntil: 0 }, { accessToken: 'ThisIsNotARealToken-x', expiresAt: Date.now() + H });
await p.refresh(false);
p.render();
shown = visibleText(p.statusEl);
console.log('    внизу окна: «' + shown + '»');
check('больше ста процентов не рисуем', shown.includes('100%') && !shown.includes('137'), shown);
check('и меньше нуля тоже', shown.includes('0%') && !shown.includes('-5'), shown);
netAnswer = () => ({ status: 429, headers: {}, json: null });

console.log('── в настройках объект с пустыми шкалами, но время чтения настоящее ──');
// Именно так и писали прежние версии: оба поля всегда вместе.
p = await boot({ lastUsage: { fiveHour: null, weekly: null }, lastUsageAt: Date.now() - 120000, pauseUntil: 0 }, { accessToken: 'ThisIsNotARealToken-x', expiresAt: Date.now() + H });
st = settingsText(p);
console.log('    в окне настроек: «' + (st.match(/Цифр[^.]*\./) || ['—'])[0] + '»');
check('не выдумываем «прошлые устарели» — их не было', !st.includes('прошлые устарели'), st.slice(0, 200));

fakeHome = SANDBOX;
realFs.rmSync(SANDBOX, { recursive: true, force: true });
console.log(failed ? `\nПРОВАЛЕНО проверок: ${failed}` : '\nВсе проверки прошли');
process.exit(failed ? 1 : 0);
})();
