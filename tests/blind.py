#!/usr/bin/env python3
"""
Учения над защитами плагина: ломаем каждую нарочно и смотрим, краснеют ли проверки.

Зачем отдельным скриптом: без записи, КАК именно ослепляли, таблица в README
непроверяема — ослепить `dropExpired` и ослепить `liveUsage()` даёт разные числа.
Здесь способ записан кодом, и замер воспроизводится одной командой:

    python3 tests/blind.py

Файл main.js восстанавливается обратной заменой строки (не откатом ветки) и
сверяется с исходным содержимым в конце. Прогон ничего не оставляет за собой.
"""
import io, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.join(HERE, '..', 'main.js')

# (название защиты, что ищем, на что подменяем)
BLINDS = [
    ('Чтение пропуска из файла',
     "  let raw = null;\n  try {", "  let raw = null;\n  if (true) return { token: null, reason: null };\n  try {"),
    ('Проверка срока у пропуска из связки ключей',
     "        resolve(judgeOauth(oauth, 'в связке ключей нет пропуска'));",
     "        resolve({ token: oauth.accessToken || null, reason: null });"),
    ('Различение «Claude Code не запускался» и «вход умер»',
     "  if (alive(o.refreshTokenExpiresAt)) {", "  if (false) {"),
    ('Различение секунд и миллисекунд в сроке',
     "    if (n < 1e12) n = n * 1000;", "    // ослеплено"),
    ('Отсев просроченных цифр с экрана',
     "  liveUsage() { return dropExpired(this.usage); }", "  liveUsage() { return this.usage; }"),
    ('Сохранение времени обнуления в памяти',
     "    this.usage = this.settings.lastUsage || null;", "    this.usage = dropExpired(this.settings.lastUsage);"),
    ('Поиск ближайшего обнуления по любой шкале',
     "    const times = [u.fiveHour, u.weekly]", "    const times = [u.fiveHour]"),
    ('Память о том, по какому обнулению уже ходили',
     "    this.resetSeen = this.nearestReset();", "    this.resetSeen = null;"),
    ('Подъём причины отказа с диска при перезапуске',
     "    const keepCause = !!(past && past.ok === false && inPause);", "    const keepCause = false;"),
    ('Опознание местной причины по её тексту',
     "this.localCause = keepCause ? (past.local === true || isLocalNote(past.note)) : false;",
     "this.localCause = keepCause ? past.local === true : false;"),
    ('Признак «причина местная, не от счётчика»',
     "      this.localCause = !!failure.localCause;", "      this.localCause = false;"),
    ('Короткая пауза при местной причине',
     "  if (localCause) return PAUSE_MIN_SEC;", "  // ослеплено"),
    ('Обрезка чужой паузы при перезапуске',
     "    if (this.localCause && this.pauseUntil > Date.now() + PAUSE_MIN_SEC * 1000) {",
     "    if (false) {"),
    ('Текст паузы по тому, кто её просил',
     "    if (this.lastStatus === 429) {\n      return 'Счётчик попросил паузу до '",
     "    if (!this.localCause) {\n      return 'Счётчик попросил паузу до '"),
    ('«Следующая проверка» не валит паузу на счётчик',
     "      return this.lastStatus === 429\n        ? 'Счётчик просил паузу до ' + hhmm(this.pauseUntil)\n        : 'Следующая попытка в ' + hhmm(this.pauseUntil);",
     "      return 'Счётчик просил паузу до ' + hhmm(this.pauseUntil);"),
    ('Замена чужого текста ошибки своей формулировкой',
     "    return safeNote(this.error);", "    return this.error;"),
    ('Различение «цифр не было никогда» и «устарели»',
     "    const everHad = !!(this.plugin.updatedAt && u && (u.fiveHour || u.weekly));",
     "    const everHad = !!u;"),
    ('Длительность паузы словами (не «30 сек → 1 мин»)',
     "  if (n < 60) return n + ' сек';", "  // ослеплено"),
    ('Только настоящее число в процентах',
     "    if (!node || typeof node.utilization !== 'number' || !Number.isFinite(node.utilization)) return null;",
     "    if (!node) return null;"),
    ('Показ остатка, а не израсходованного',
     "  return Math.max(0, Math.min(100, 100 - used));",
     "  return Math.max(0, Math.min(100, used));"),
    ('Только настоящее число в ChatGPT',
     "    if (!node || typeof node.usedPercent !== 'number' || !Number.isFinite(node.usedPercent)) return null;",
     "    if (!node) return null;"),
    ('Отсев просроченного окна ChatGPT',
     "function dropExpiredChatGPT(usage) {\n  if (!usage) return null;",
     "function dropExpiredChatGPT(usage) {\n  return usage;"),
    ('Чужой текст ошибки ChatGPT не выходит на экран',
     "  return CHATGPT_NOTES.includes(text) ? text : 'не удалось прочитать лимит ChatGPT';",
     "  return text;"),
]


def run(script):
    r = subprocess.run([ 'node', os.path.join(HERE, script) ], capture_output=True, text=True)
    red = sum(1 for line in r.stdout.splitlines() if line.startswith(('  ❌', '  ✗')))
    return red if red else (1 if r.returncode else 0)


def main():
    original = io.open(PLUGIN, encoding='utf-8').read()
    base = (run('check.js'), run('e2e-onload.js'), run('chatgpt.js'))
    if base != (0, 0, 0):
        print(f'СТОП: до учений уже есть красные проверки {base}. Сначала починить.')
        return 1

    print(f'{"Защита":52} check  e2e  gpt')
    bad = []
    for name, old, new in BLINDS:
        if original.count(old) != 1:
            print(f'{name:52}  ── строка не найдена ровно один раз')
            bad.append(name)
            continue
        io.open(PLUGIN, 'w', encoding='utf-8').write(original.replace(old, new))
        a, b, c = run('check.js'), run('e2e-onload.js'), run('chatgpt.js')
        io.open(PLUGIN, 'w', encoding='utf-8').write(original)
        mark = '' if (a + b + c) else '   ← НЕ ПОКРЫТА'
        print(f'{name:52} {a:>5} {b:>4} {c:>4}{mark}')
        if not (a + b + c):
            bad.append(name)

    now = io.open(PLUGIN, encoding='utf-8').read()
    print()
    print('файл восстановлен: ' + ('да' if now == original else 'НЕТ — сверить с копией!'))
    if bad:
        print('не покрыты проверками: ' + ', '.join(bad))
        return 1
    print('все защиты покрыты: каждая при поломке даёт красные проверки')
    return 0


if __name__ == '__main__':
    sys.exit(main())
