#!/bin/bash
# Установка плагина в Obsidian из этой папки (для разработки).
# Обычным пользователям это не нужно — ставьте через BRAT, см. README.
#
# Запуск:  bash install.sh /путь/к/хранилищу
# Без аргумента возьмётся хранилище из переменной OBSIDIAN_VAULT.

set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_ID="$(python3 -c "import json;print(json.load(open('$SRC/manifest.json'))['id'])")"
VAULT="${1:-${OBSIDIAN_VAULT:-}}"

if [ -z "$VAULT" ]; then
  echo "Укажи путь к хранилищу: bash install.sh /путь/к/vault" >&2
  exit 1
fi
if [ ! -d "$VAULT/.obsidian" ]; then
  echo "В $VAULT нет папки .obsidian — это не хранилище Obsidian" >&2
  exit 1
fi

DST="$VAULT/.obsidian/plugins/$PLUGIN_ID"
echo "Источник:  $SRC"
echo "Установка: $DST"

if command -v node >/dev/null 2>&1; then
  node --check "$SRC/main.js"
  echo "✓ синтаксис main.js в порядке"
else
  echo "⚠ node не найден — проверка синтаксиса пропущена"
fi

mkdir -p "$DST"
cp "$SRC/main.js" "$SRC/manifest.json" "$SRC/styles.css" "$DST/"

ok=1
for f in main.js manifest.json styles.css; do
  a=$(md5 -q "$SRC/$f" 2>/dev/null || md5sum "$SRC/$f" | cut -d' ' -f1)
  b=$(md5 -q "$DST/$f" 2>/dev/null || md5sum "$DST/$f" | cut -d' ' -f1)
  if [ "$a" = "$b" ]; then echo "✓ $f совпадает"; else echo "✗ $f НЕ совпадает"; ok=0; fi
done
[ "$ok" = "1" ] || exit 1

CP="$VAULT/.obsidian/community-plugins.json"
if [ -f "$CP" ]; then
  python3 - "$CP" "$PLUGIN_ID" <<'PY'
import json, sys
path, pid = sys.argv[1], sys.argv[2]
lst = json.load(open(path))
if pid not in lst:
    lst.append(pid)
    json.dump(lst, open(path, 'w'), indent=2, ensure_ascii=False)
    print('✓ плагин добавлен в список включённых')
else:
    print('✓ плагин уже в списке включённых')
PY
fi

echo
echo "Готово. Перезапусти Obsidian (Cmd+Q → открыть заново)."
