"""
Создаёт учебный файл данные/статистика_совещаний.csv — 60 рабочих дней наблюдений.

ВНИМАНИЕ: данные СГЕНЕРИРОВАНЫ (сид 2026), это пример, а не реальная статистика.
Формат как у русского Excel: разделитель «;», дробная часть через запятую.

Заложено специально (пригодится на этапе 4 — зависимые факторы):
  в дождливые дни автобус опаздывает чаще и сильнее. Если брать столбцы по отдельности,
  эта связь теряется.

Запуск из корня проекта:  python tools/make_sample_data.py
Печатает JSON-массивы столбцов — их же содержит шаблон «Совещание по статистике» в engine/templates.js.
"""
import datetime as dt
import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "данные" / "статистика_совещаний.csv"


def main():
    rng = np.random.default_rng(2026)
    days, d = [], dt.date(2026, 9, 1)
    while len(days) < 60:
        if d.weekday() < 5:
            days.append(d)
        d += dt.timedelta(days=1)

    rows = []
    for day in days:
        rain = rng.random() < 0.3
        # автобус: в дождь вероятность опоздания 80%, обычно 40%; в дождь опоздания длиннее
        if rng.random() < (0.8 if rain else 0.4):
            bus = float(rng.integers(2, 10) + (rng.integers(5, 15) if rain else 0))
        else:
            bus = 0.0
        # обед: 55% вовремя, иначе затягивается на 5–25 мин (иногда с половиной минуты)
        lunch = 0.0 if rng.random() < 0.55 else float(rng.integers(10, 51)) / 2
        # переговорка: в 25% дней прошлое совещание затягивается на 5–15 мин
        room = float(rng.integers(5, 16)) if rng.random() < 0.25 else 0.0
        rows.append((day, bus, lunch, room, rain))

    fmt = lambda v: (f"{v:.1f}".rstrip("0").rstrip(".")).replace(".", ",")  # noqa: E731
    lines = ["Дата;Автобус_мин;Обед_затянулся_мин;Переговорка_занята_мин;Дождь"]
    for day, bus, lunch, room, rain in rows:
        lines.append(f"{day:%d.%m.%Y};{fmt(bus)};{fmt(lunch)};{fmt(room)};{'да' if rain else 'нет'}")
    OUT.parent.mkdir(exist_ok=True)
    # utf-8-sig: Excel на Windows тогда правильно показывает русские буквы
    OUT.write_text("\n".join(lines) + "\n", encoding="utf-8-sig")
    print(f"Записано: {OUT} ({len(rows)} дней)")

    cols = list(zip(*rows))
    for name, k in (("Автобус", 1), ("Обед", 2), ("Переговорка", 3)):
        print(name, json.dumps([v if v % 1 else int(v) for v in cols[k]]))
    bus, rain = np.array(cols[1]), np.array(cols[4])
    print(f"Средний автобус: в дождь {bus[rain].mean():.1f} мин ({rain.sum()} дн.), без дождя {bus[~rain].mean():.1f} мин")
    p_bus = (bus <= 5).mean()
    p_lunch = (np.maximum(np.array(cols[2]) - 10, 0) <= 5).mean()
    p_room = (np.array(cols[3]) <= 5).mean()
    print(f"Доли «≤ 5 мин»: автобус {p_bus:.4f}, Мария {p_lunch:.4f}, переговорка {p_room:.4f}, "
          f"произведение {p_bus * p_lunch * p_room:.4f}")
    together = ((bus <= 5) & (np.maximum(np.array(cols[2]) - 10, 0) <= 5) & (np.array(cols[3]) <= 5)).mean()
    print(f"Доля дней, где вовремя всё сразу (по самим дням): {together:.4f}")


if __name__ == "__main__":
    main()
