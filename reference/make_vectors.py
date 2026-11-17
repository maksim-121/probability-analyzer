"""
Создаёт tests/vectors.js — ответы Python-эталона, с которыми сверяется браузерный движок.
Запуск из папки reference:  python make_vectors.py

Как в Gravity Drop (make_vectors.py -> вкладка «Тесты»): одинаковый сид должен давать
одинаковые числа в Python и в JavaScript. Совпадение до последнего знака = движки одинаковые.
"""
import copy
import json
from pathlib import Path

import engine_ref as E
from cases import BAD_FORMULAS, CHAIN, COMMUTE, DICE, FORMULAS, MEETING, MEETING_DISCRETE, RAIN, RAIN_DISCRETE

OUT = Path(__file__).resolve().parent.parent / "tests" / "vectors.js"

RUN_N, SENS_ROWS = 5000, 2000


def rng_vectors():
    out = []
    for seed in (0, 1, 42, 20261117, 4294967295):
        a, b = E.Rng(seed), E.Rng(seed)
        out.append({"seed": seed, "u32": [a.next_u32() for _ in range(8)], "uniform": [b.uniform() for _ in range(5)]})
    return out


DIST_SPECS = [
    {"type": "table", "values": [0, 5, 10, 20], "weights": [50, 30, 15, 5]},
    {"type": "table", "values": [1, 2, 3], "weights": [1, 0, 1]},
    {"type": "yesno", "p": 0.25},
    {"type": "uniform", "min": 5, "max": 15},
    {"type": "triangular", "min": 20, "mode": 25, "max": 50},
    {"type": "triangular", "min": 0, "mode": 0, "max": 10},
    {"type": "normal", "mean": 40, "sd": 8},
    {"type": "data", "values": [3, 1, 4, 1, 5, 9, 2, 6]},
]


def dist_vectors():
    out = []
    for spec in DIST_SPECS:
        d = E.prepare_dist(spec, "тест")
        rng = E.Rng(7)
        out.append({"spec": spec, "seed": 7, "samples": [d.sample(rng) for _ in range(12)],
                    "mean": d.mean, "sd": d.sd})
    return out


def run_vectors():
    out = []
    extra = [(t, 7) for t in E.load_templates() if t["id"] not in ("meeting", "dice")]
    extra += [(CHAIN, 8), (RAIN_DISCRETE, 9), (E.independent_version(RAIN), 10)]
    for sc, seed in [(MEETING, 20261117), (DICE, 99), (COMMUTE, 3), (MEETING_DISCRETE, 5)] + extra:
        m = E.compile_scenario(sc)
        cols, res, ev = E.run(m, RUN_N, seed)
        s = E.summarize(res, ev)
        sens = E.sensitivity(m, cols, SENS_ROWS, seed)
        out.append({
            "scenario": sc, "n": RUN_N, "seed": seed,
            "eventCount": s["event"]["count"] if s["event"] else None,
            "mean": s["mean"], "sd": s["sd"], "min": s["min"], "max": s["max"],
            "pct": {str(k): v for k, v in s["pct"].items()},
            "first": res[:10], "last": res[-1],
            "cols": [c[:5] for c in cols],
            "sens": {"rows": SENS_ROWS, "base": sens["base"], "items": sens["items"]},
            "exact": E.exact(m),
        })
    return out


def broken_scenarios():
    def broken(what, change):
        sc = copy.deepcopy(MEETING)
        change(sc)
        return {"what": what, "scenario": sc}

    return [
        broken("нет факторов", lambda sc: sc.update(factors=[])),
        broken("повтор имени", lambda sc: sc["factors"][1].update(name="иван")),
        broken("пробел в имени", lambda sc: sc["factors"][0].update(name="Иван Петров")),
        broken("имя = функция", lambda sc: sc["factors"][0].update(name="max")),
        broken("ссылка вперёд", lambda sc: sc["derived"][0].update(formula="Переговорка + 1")),
        broken("нет формулы итога", lambda sc: sc.update(result={"name": "Задержка"})),
        broken("опечатка в событии", lambda sc: sc["event"].update(formula="Задерджка <= 5")),
        broken("плохое распределение", lambda sc: sc["factors"][2]["dist"].update(p=2)),
    ]


def main():
    vectors = {
        "rng": rng_vectors(),
        "dists": dist_vectors(),
        "formulas": [{"src": s, "vars": v, "value": E.eval_formula(s, v)} for s, v, _ in FORMULAS],
        "badFormulas": BAD_FORMULAS,
        "broken": broken_scenarios(),
        "runs": run_vectors(),
        "independent": [{"scenario": sc, "independent": E.independent_version(sc)}
                        for sc in E.load_templates() + [CHAIN] if E.compile_scenario(sc).dependent],
        "runsNeeded": [{"p": p, "half": h, "n": E.runs_needed(p, h)}
                       for p, h in ((0.5, 0.001), (0.54, 0.001), (0.05, 0.002), (0.9, 0.01))],
    }
    # json пишет NaN / Infinity без кавычек — для JS-файла это корректные значения
    text = ("// Создано reference/make_vectors.py — руками не править.\n"
            "var MC_VECTORS = " + json.dumps(vectors, ensure_ascii=False, indent=1) + ";\n")
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(text, encoding="utf-8")
    print(f"Записано: {OUT} ({len(text) // 1024} КБ)")


if __name__ == "__main__":
    main()
