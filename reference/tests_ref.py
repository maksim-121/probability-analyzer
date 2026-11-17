"""
Тесты эталона. Запуск из папки reference:  python -m unittest tests_ref -v

Логика та же, что при проверке Snow Boom:
  * где ответ известен точно (формула или перебор) — Монте-Карло обязан попасть в ± 4 стандартные ошибки;
  * формулы и ошибки проверяются на заранее посчитанных вручную примерах.
4 SE выбраны, чтобы честный движок почти никогда не «падал» случайно (шанс ~1 из 16 000 на проверку),
а ошибка в логике — падал всегда.
"""
import copy
import math
import unittest

import engine_ref as E
from cases import (ATTEMPTS, BAD_FORMULAS, CHAIN, COMMUTE, DICE, FORMULAS, GYM, JOB, JOB_FIXED, MEETING,
                   MEETING_DISCRETE, RAIN, RAIN_DISCRETE, TEMPLATES)


def close_mc(test, est, exact, se, k=4.0, what=""):
    test.assertLessEqual(abs(est - exact), k * se + 1e-12,
                         f"{what}: MC {est:.6f}, точно {exact:.6f}, допуск ±{k * se:.6f}")


class TestRng(unittest.TestCase):
    def test_same_seed_same_numbers(self):
        a, b = E.Rng(42), E.Rng(42)
        self.assertEqual([a.next_u32() for _ in range(10)], [b.next_u32() for _ in range(10)])

    def test_different_seeds_differ(self):
        self.assertNotEqual(E.Rng(1).next_u32(), E.Rng(2).next_u32())

    def test_uniform_range_and_mean(self):
        rng = E.Rng(123)
        n = 200_000
        xs = [rng.uniform() for _ in range(n)]
        self.assertTrue(all(0 <= x < 1 for x in xs))
        close_mc(self, sum(xs) / n, 0.5, math.sqrt(1 / 12 / n), what="среднее uniform")
        # равномерность по 10 корзинам: в каждой ~10%
        for k in range(10):
            share = sum(1 for x in xs if k / 10 <= x < (k + 1) / 10) / n
            close_mc(self, share, 0.1, math.sqrt(0.09 / n), what=f"корзина {k}")

    def test_bad_seed(self):
        for s in (-1, 2 ** 32, 1.5):
            with self.assertRaises(E.MCError):
                E.Rng(s)


class TestDistributions(unittest.TestCase):
    N = 100_000

    def sample(self, spec, seed=7):
        d = E.prepare_dist(spec, "тест")
        rng = E.Rng(seed)
        return d, [d.sample(rng) for _ in range(self.N)]

    def check_mean(self, spec, exact_mean):
        d, xs = self.sample(spec)
        self.assertAlmostEqual(d.mean, exact_mean, places=12)
        close_mc(self, sum(xs) / self.N, exact_mean, d.sd / math.sqrt(self.N), what=spec["type"])
        return xs

    def test_table(self):
        xs = self.check_mean({"type": "table", "values": [0, 5, 10, 20], "weights": [50, 30, 15, 5]},
                             0 * .5 + 5 * .3 + 10 * .15 + 20 * .05)
        for v, p in [(0, .5), (5, .3), (10, .15), (20, .05)]:
            close_mc(self, xs.count(v) / self.N, p, math.sqrt(p * (1 - p) / self.N), what=f"доля {v}")

    def test_table_zero_weight_never_drops(self):
        _, xs = self.sample({"type": "table", "values": [1, 2, 3], "weights": [1, 0, 1]})
        self.assertNotIn(2, xs)

    def test_yesno(self):
        self.check_mean({"type": "yesno", "p": 0.25}, 0.25)
        _, xs = self.sample({"type": "yesno", "p": 0})
        self.assertEqual(sum(xs), 0)
        _, xs = self.sample({"type": "yesno", "p": 1})
        self.assertEqual(sum(xs), self.N)

    def test_uniform(self):
        xs = self.check_mean({"type": "uniform", "min": 5, "max": 15}, 10)
        self.assertTrue(all(5 <= x < 15 for x in xs))

    def test_triangular(self):
        xs = self.check_mean({"type": "triangular", "min": 20, "mode": 25, "max": 50}, 95 / 3)
        self.assertTrue(all(20 <= x <= 50 for x in xs))
        p = 5 / 30                     # P(X < «обычно») = (обычно − мин) / (макс − мин)
        close_mc(self, sum(1 for x in xs if x < 25) / self.N, p, math.sqrt(p * (1 - p) / self.N),
                 what="доля левее моды")

    def test_normal(self):
        xs = self.check_mean({"type": "normal", "mean": 40, "sd": 8}, 40)
        for z, p in [(1, 0.841345), (1.96, 0.975002), (-1, 0.158655)]:
            share = sum(1 for x in xs if x <= 40 + z * 8) / self.N
            close_mc(self, share, p, math.sqrt(p * (1 - p) / self.N), what=f"P(Z<={z})")
        m = sum(xs) / self.N
        sd = math.sqrt(sum((x - m) ** 2 for x in xs) / (self.N - 1))
        self.assertAlmostEqual(sd, 8, delta=0.08)

    def test_data(self):
        vals = [0, 0, 5, 10, 0, 15, 0, 5]
        xs = self.check_mean({"type": "data", "values": vals}, sum(vals) / len(vals))
        self.assertEqual(set(xs), set(vals))
        close_mc(self, xs.count(0) / self.N, 0.5, math.sqrt(.25 / self.N), what="доля нулей")

    def test_bad_params(self):
        bad = [
            None, {"type": "что-то"},
            {"type": "table", "values": [1, 2], "weights": [1]},
            {"type": "table", "values": [1, 2], "weights": [1, -1]},
            {"type": "table", "values": [1, 2], "weights": [0, 0]},
            {"type": "table", "values": [], "weights": []},
            {"type": "table", "values": [1, "a"], "weights": [1, 1]},
            {"type": "yesno", "p": 1.5}, {"type": "yesno"},
            {"type": "uniform", "min": 5, "max": 1},
            {"type": "triangular", "min": 1, "mode": 0, "max": 5},
            {"type": "triangular", "min": 1, "mode": 1, "max": 1},
            {"type": "normal", "mean": 0, "sd": 0},
            {"type": "data", "values": []},
        ]
        for spec in bad:
            with self.assertRaises(E.MCError, msg=str(spec)):
                E.prepare_dist(spec, "тест")


class TestFormulas(unittest.TestCase):
    def test_cases(self):
        for src, vars_, expected in FORMULAS:
            got = E.eval_formula(src, vars_)
            if expected != expected:
                self.assertTrue(got != got, f"{src}: ожидался NaN, получено {got}")
            else:
                self.assertEqual(got, expected, src)

    def test_errors(self):
        for src in BAD_FORMULAS:
            with self.assertRaises(E.MCError, msg=f"«{src}» должна давать ошибку"):
                E.eval_formula(src, {"a": 1, "b": 2, "c": 3})


class TestScenario(unittest.TestCase):
    def test_meeting_compiles(self):
        m = E.compile_scenario(MEETING)
        self.assertEqual(len(m.factors), 4)
        self.assertEqual(m.width, 4 + 2 + 1)

    def test_scenario_errors(self):
        def broken(change):
            sc = copy.deepcopy(MEETING)
            change(sc)
            return sc

        cases = {
            "нет факторов": lambda sc: sc.update(factors=[]),
            "повтор имени": lambda sc: sc["factors"][1].update(name="иван"),
            "пробел в имени": lambda sc: sc["factors"][0].update(name="Иван Петров"),
            "имя = функция": lambda sc: sc["factors"][0].update(name="max"),
            "ссылка вперёд": lambda sc: sc["derived"][0].update(formula="Переговорка + 1"),
            "нет формулы итога": lambda sc: sc.update(result={"name": "Задержка"}),
            "опечатка в событии": lambda sc: sc["event"].update(formula="Задерджка <= 5"),
            "плохое распределение": lambda sc: sc["factors"][2]["dist"].update(p=2),
        }
        for what, change in cases.items():
            with self.assertRaises(E.MCError, msg=what):
                E.compile_scenario(broken(change))

    def test_error_message_is_readable(self):
        sc = copy.deepcopy(MEETING)
        sc["event"]["formula"] = "Задерджка <= 5"
        with self.assertRaises(E.MCError) as ctx:
            E.compile_scenario(sc)
        self.assertIn("неизвестное имя «Задерджка»", str(ctx.exception))

    def test_event_optional(self):
        sc = copy.deepcopy(MEETING)
        sc["event"] = None
        m = E.compile_scenario(sc)
        _, res, ev = E.run(m, 100, 1)
        self.assertIsNone(ev)


class TestExact(unittest.TestCase):
    def test_dice(self):
        ex = E.exact(E.compile_scenario(DICE))
        self.assertEqual(ex["combos"], 36)
        self.assertAlmostEqual(ex["p"], 6 / 36, places=14)
        self.assertAlmostEqual(ex["mean"], 7, places=12)
        self.assertAlmostEqual(ex["sd"], math.sqrt(35 / 6), places=12)

    def test_meeting_discrete(self):
        ex = E.exact(E.compile_scenario(MEETING_DISCRETE))
        self.assertEqual(ex["combos"], 4 * 3 * 2 * 3)
        self.assertAlmostEqual(ex["p"], 0.80 * 0.90 * 0.75, places=14)

    def test_continuous_not_enumerable(self):
        self.assertIsNone(E.exact(E.compile_scenario(MEETING)))


class TestMonteCarlo(unittest.TestCase):
    def mc(self, sc, n, seed):
        m = E.compile_scenario(sc)
        cols, res, ev = E.run(m, n, seed)
        return m, cols, E.summarize(res, ev)

    def test_meeting_vs_formula(self):
        _, _, s = self.mc(MEETING, 100_000, 20261117)
        close_mc(self, s["event"]["p"], 0.54, math.sqrt(.54 * .46 / s["n"]), what="P(вовремя)")

    def test_meeting_other_event(self):
        # P(задержка > 10) = 1 − P(Иван ≤ 10)·P(Мария ≤ 10)·P(переговорка ≤ 10) = 1 − 0.95·1·0.875
        sc = copy.deepcopy(MEETING)
        sc["event"]["formula"] = "Задержка > 10"
        _, _, s = self.mc(sc, 100_000, 5)
        p = 1 - 0.95 * 0.875
        close_mc(self, s["event"]["p"], p, math.sqrt(p * (1 - p) / s["n"]), what="P(задержка > 10)")

    def test_dice_vs_exact(self):
        _, _, s = self.mc(DICE, 100_000, 99)
        p = 6 / 36
        close_mc(self, s["event"]["p"], p, math.sqrt(p * (1 - p) / s["n"]), what="P(сумма ≥ 10)")
        close_mc(self, s["mean"], 7, math.sqrt(35 / 6 / s["n"]), what="средняя сумма")
        self.assertEqual(s["pct"][50], 7)

    def test_commute_mean(self):
        # Среднее суммы = сумма средних (это верно всегда, даже без независимости)
        _, _, s = self.mc(COMMUTE, 50_000, 3)
        exact_mean = 95 / 3 + 10 + 35 / 8 + 0.3 * 10 + 1.5 + (3 * 3 + 8 * 2) / 10
        close_mc(self, s["mean"], exact_mean, s["sd"] / math.sqrt(s["n"]), what="среднее время")

    def test_confidence_interval_coverage(self):
        """95% интервал должен накрывать точный ответ примерно в 95% независимых запусков."""
        m = E.compile_scenario(DICE)
        hits, runs = 0, 300
        for seed in range(runs):
            _, _, ev = E.run(m, 1000, 1000 + seed)
            pr = E.proportion(sum(ev), 1000)
            hits += pr["lo"] <= 6 / 36 <= pr["hi"]
        self.assertTrue(0.90 <= hits / runs <= 0.99, f"покрытие {hits / runs:.1%}")

    def test_sensitivity_meeting(self):
        # Переговорка свободна (Занята = 0): P = 0.8 · 0.9 · 1 = 0.72; занята (1): почти 0
        m, cols, _ = self.mc(MEETING, 50_000, 11)
        sens = E.sensitivity(m, cols, 50_000, 11)
        busy = next(it for it in sens["items"] if it["name"] == "Занята")
        self.assertEqual((busy["low"]["value"], busy["high"]["value"]), (0, 1))
        close_mc(self, busy["low"]["p"], 0.72, math.sqrt(.72 * .28 / 50_000), what="переговорка свободна")
        self.assertLess(busy["high"]["p"], 0.001)

    def test_same_seed_same_answer(self):
        a = self.mc(MEETING, 2000, 77)[2]
        b = self.mc(MEETING, 2000, 77)[2]
        self.assertEqual(a, b)

    def test_runs_needed(self):
        # p = 50%, погрешность ±0.1% -> 960 400 прогонов (та же формула, что для RTP)
        self.assertEqual(E.runs_needed(0.5, 0.001), 960_400)


class TestTemplates(unittest.TestCase):
    """Все шаблоны из engine/templates.js должны собираться и считаться."""

    def test_all_compile_and_run(self):
        for t in E.load_templates():
            with self.subTest(t["id"]):
                m = E.compile_scenario(t)
                _, res, ev = E.run(m, 2000, 1)
                s = E.summarize(res, ev)
                self.assertEqual(s["nan"], 0)
                self.assertTrue(0 < s["event"]["p"] < 1)

    def test_meeting_data_exact(self):
        # по 60 дням: P(автобус ≤ 5) = 39/60, P(Мария ≤ 5) = 48/60, P(переговорка ≤ 5) = 49/60
        t = next(t for t in E.load_templates() if t["id"] == "meeting_data")
        bus, lunch, room = (f["dist"]["values"] for f in t["factors"])
        p_bus = sum(v <= 5 for v in bus) / 60
        p_maria = sum(max(v - 10, 0) <= 5 for v in lunch) / 60
        p_room = sum(v <= 5 for v in room) / 60
        self.assertEqual((p_bus * 60, p_maria * 60, p_room * 60), (39, 48, 49))
        ex = E.exact(E.compile_scenario(t))
        self.assertAlmostEqual(ex["p"], p_bus * p_maria * p_room, places=12)

    def test_project_plan_by_mode_is_optimistic(self):
        # «по обычно» план 25 дней; среднее треугольного = (мин + обычно + макс) / 3 больше «обычно»
        t = next(t for t in E.load_templates() if t["id"] == "project")
        m = E.compile_scenario(t)
        _, res, ev = E.run(m, 20000, 2)
        s = E.summarize(res, ev)
        self.assertLess(sum(1 for r in res if r <= 25) / len(res), 0.15)
        self.assertGreater(s["mean"], 30)


class TestDependent(unittest.TestCase):
    """Этап 4: «зависит от», «строки таблицы», версия без связей."""

    def mc(self, sc, n, seed):
        m = E.compile_scenario(sc)
        cols, res, ev = E.run(m, n, seed)
        return m, cols, res, E.summarize(res, ev)

    def p_close(self, got, p, n, what):
        close_mc(self, got, p, math.sqrt(p * (1 - p) / n), what=what)

    def test_rain_exact_with_and_without_link(self):
        self.assertAlmostEqual(E.exact(E.compile_scenario(RAIN_DISCRETE))["p"], 0.527625, places=12)
        ind = E.independent_version(RAIN_DISCRETE)
        self.assertAlmostEqual(E.exact(E.compile_scenario(ind))["p"], 0.511875, places=12)

    def test_rain_mc(self):
        _, _, _, s = self.mc(RAIN, 100_000, 3)
        self.p_close(s["event"]["p"], 0.527625, 100_000, "дождь, со связью")
        _, _, _, s = self.mc(E.independent_version(RAIN), 100_000, 3)
        self.p_close(s["event"]["p"], 0.511875, 100_000, "дождь, без связи")

    def test_rain_sensitivity_resamples_dependents(self):
        # «Дождь» зафиксирован -> «Иван» и «Обед» перевыбираются по его значению
        m, cols, _, _ = self.mc(RAIN, 50_000, 4)
        t = E.sensitivity(m, cols, 50_000, 4)
        rain = next(i for i in t["items"] if i["name"] == "Дождь")
        self.p_close(rain["low"]["p"], 0.75 * 0.90 * 0.95, 50_000, "сухо")
        self.p_close(rain["high"]["p"], 0.75 * 0.50 * 0.70, 50_000, "дождь")

    def test_chain(self):
        m, cols, _, s = self.mc(CHAIN, 50_000, 5)
        self.p_close(s["event"]["p"], 0.5, 50_000, "цепочка")
        t = E.sensitivity(m, cols, 50_000, 5)
        a = next(i for i in t["items"] if i["name"] == "A")
        self.p_close(a["high"]["p"], 0.8, 50_000, "A = 1 -> B и C перевыбраны")
        self.p_close(a["low"]["p"], 0.2, 50_000, "A = 0")
        self.assertEqual([f.name for f in E.dependents_of(m, 0)], ["B", "C"])

    def test_days_exact(self):
        days = TEMPLATES["meeting_days"]
        ex = E.exact(E.compile_scenario(days))
        self.assertEqual(ex["combos"], 60)
        self.assertAlmostEqual(ex["p"], 25 / 60, places=12)
        ind = E.exact(E.compile_scenario(E.independent_version(days)))
        self.assertAlmostEqual(ind["p"], 39 / 60 * 48 / 60 * 49 / 60, places=12)

    def test_days_keep_rows_together(self):
        # в каждом прогоне все столбцы взяты из одной и той же строки
        days = TEMPLATES["meeting_days"]
        rows = days["factors"][0]["dist"]["rows"]
        m, cols, _, _ = self.mc(days, 2000, 6)
        for i in range(2000):
            j = int(cols[0][i]) - 1
            self.assertEqual([cols[k][i] for k in range(1, 5)], [float(x) for x in rows[j]])

    def test_project_risk_naive_is_optimistic(self):
        sc = TEMPLATES["project_risk"]
        _, _, _, dep = self.mc(sc, 60_000, 7)
        _, _, _, ind = self.mc(E.independent_version(sc), 60_000, 7)
        self.assertGreater(ind["event"]["p"] - dep["event"]["p"], 0.03)      # наивный расчёт обещает больше
        self.assertGreater(dep["pct"][90], ind["pct"][90] + 1)               # хвост со связью тяжелее
        close_mc(self, dep["mean"], ind["mean"], 2 * dep["sd"] / math.sqrt(60_000), what="средние равны")

    def test_mixture(self):
        d = E.prepare_dist({"type": "mixture", "parts": [
            {"p": 1, "dist": {"type": "uniform", "min": 0, "max": 10}},
            {"p": 1, "dist": {"type": "normal", "mean": 100, "sd": 1}}]}, "тест")
        self.assertAlmostEqual(d.mean, 52.5)
        rng = E.Rng(1)
        xs = [d.sample(rng) for _ in range(50_000)]
        close_mc(self, sum(xs) / len(xs), 52.5, d.sd / math.sqrt(len(xs)), what="смесь")

    def test_errors(self):
        def broken(change, base=RAIN):
            sc = copy.deepcopy(base)
            change(sc)
            return sc

        def continuous_parent(sc):
            sc["factors"].insert(0, {"name": "Т", "dist": {"type": "uniform", "min": 0, "max": 1}})
            sc["factors"][2]["dist"]["on"] = "Т"

        cases = {
            "зависит от фактора ниже": lambda sc: sc["factors"][1]["dist"].update(on="Занята"),
            "зависит от неизвестного": lambda sc: sc["factors"][1]["dist"].update(on="Град"),
            "зависит от непрерывного": continuous_parent,
            "нет ветки": lambda sc: sc["factors"][1]["dist"]["cases"].pop(),
            "ветка дважды": lambda sc: sc["factors"][1]["dist"]["cases"][1].update(value=1),
            "ветка внутри ветки": lambda sc: sc["factors"][1]["dist"]["cases"][0].update(dist={"type": "conditional"}),
            "слишком много значений": lambda sc: sc["factors"][0].update(dist={"type": "data", "values": list(range(13))}),
        }
        for what, change in cases.items():
            with self.assertRaises(E.MCError, msg=what):
                E.compile_scenario(broken(change))
        days = TEMPLATES["meeting_days"]
        rows_cases = {
            "строка короче": lambda sc: sc["factors"][0]["dist"]["rows"][3].pop(),
            "не число": lambda sc: sc["factors"][0]["dist"]["rows"][0].__setitem__(1, "abc"),
            "имя столбца занято": lambda sc: sc["factors"][0]["dist"]["columns"].__setitem__(1, "Мария"),
            "нет строк": lambda sc: sc["factors"][0]["dist"].update(rows=[]),
        }
        for what, change in rows_cases.items():
            with self.assertRaises(E.MCError, msg=what):
                E.compile_scenario(broken(change, days))

    def test_unused_hidden_from_tornado(self):
        m, cols, _, _ = self.mc(TEMPLATES["meeting_days"], 3000, 1)
        names = [i["name"] for i in E.sensitivity(m, cols, 3000, 1)["items"]]
        self.assertEqual(sorted(names), sorted(["Автобус", "Обед", "Переговорка"]))   # «Дождь» и «День» скрыты


class TestComposite(unittest.TestCase):
    """Повтор N раз (попытки) и «сколько шагов до цели» (спорт, накопления)."""

    def sample(self, spec, n, seed=3):
        d = E.prepare_dist(spec, "тест")
        rng = E.Rng(seed)
        return d, [d.sample(rng) for _ in range(n)]

    def test_walk_constant_step(self):
        _, xs = self.sample({"type": "walk", "start": 0, "goal": 10, "step": {"type": "uniform", "min": 1, "max": 1}}, 50)
        self.assertEqual(set(xs), {10.0})
        _, xs = self.sample({"type": "walk", "start": 10, "goal": 0, "step": {"type": "uniform", "min": -1, "max": -1}}, 50)
        self.assertEqual(set(xs), {10.0}, "вниз (похудение) тоже считается")
        _, xs = self.sample({"type": "walk", "start": 5, "goal": 5, "step": {"type": "yesno", "p": 0.5}}, 10)
        self.assertEqual(set(xs), {0.0}, "уже на цели — 0 шагов")

    def test_walk_negative_binomial(self):
        # шаг +1 с шансом 0,25, иначе 0; цель 5 -> число шагов ~ отрицательное биномиальное: среднее 20, дисперсия 60
        n = 40_000
        _, xs = self.sample({"type": "walk", "start": 0, "goal": 5, "step": {"type": "yesno", "p": 0.25}}, n)
        close_mc(self, sum(xs) / n, 20, math.sqrt(60 / n), what="среднее число шагов")

    def test_walk_unreachable(self):
        _, xs = self.sample({"type": "walk", "start": 0, "goal": 1, "maxSteps": 50, "step": {"type": "uniform", "min": 0, "max": 0}}, 20)
        self.assertEqual(set(xs), {51.0}, "не дошли — предел + 1")

    def test_repeat_binomial(self):
        n = 60_000
        d, xs = self.sample({"type": "repeat", "times": 10, "dist": {"type": "yesno", "p": 0.3}}, n)
        self.assertAlmostEqual(d.mean, 3)
        close_mc(self, sum(xs) / n, 3, math.sqrt(2.1 / n), what="среднее число удач")
        p5 = 1 - sum(math.comb(10, k) * 0.3 ** k * 0.7 ** (10 - k) for k in range(5))
        close_mc(self, sum(1 for x in xs if x >= 5) / n, p5, math.sqrt(p5 * (1 - p5) / n), what="P(хотя бы 5)")

    def test_repeat_sum(self):
        d, _ = self.sample({"type": "repeat", "times": 4, "dist": {"type": "triangular", "min": 0, "mode": 3, "max": 6}}, 10)
        self.assertAlmostEqual(d.mean, 12)

    def test_scenarios(self):
        m = E.compile_scenario(ATTEMPTS)
        _, res, ev = E.run(m, 30_000, 1)
        p5 = 1 - sum(math.comb(10, k) * 0.3 ** k * 0.7 ** (10 - k) for k in range(5))
        close_mc(self, sum(ev) / 30_000, p5, math.sqrt(p5 * (1 - p5) / 30_000), what="сценарий попыток")
        self.assertIsNone(E.exact(m))
        m = E.compile_scenario(GYM)
        _, res, ev = E.run(m, 3000, 1)
        self.assertTrue(all(1 <= r <= 521 for r in res))

    def test_bad(self):
        bad = [
            {"type": "repeat", "times": 0, "dist": {"type": "yesno", "p": 0.5}},
            {"type": "repeat", "times": 2.5, "dist": {"type": "yesno", "p": 0.5}},
            {"type": "repeat", "times": 10},
            {"type": "walk", "start": 0, "goal": 10},
            {"type": "walk", "start": 0, "goal": 10, "maxSteps": 0, "step": {"type": "yesno", "p": 0.5}},
            {"type": "walk", "goal": 10, "step": {"type": "yesno", "p": 0.5}},
        ]
        for spec in bad:
            with self.assertRaises(E.MCError, msg=str(spec)):
                E.prepare_dist(spec, "тест")


class TestUntil(unittest.TestCase):
    """«Получится ли до срока»: число попыток за период случайное (repeat с timesDist) + шаги до цели."""

    def test_times_dist_constant_equals_times(self):
        a = E.prepare_dist({"type": "repeat", "timesDist": {"type": "uniform", "min": 3, "max": 3},
                            "dist": {"type": "yesno", "p": 0.4}}, "тест")
        b = E.prepare_dist({"type": "repeat", "times": 3, "dist": {"type": "yesno", "p": 0.4}}, "тест")
        r1, r2 = E.Rng(5), E.Rng(5)
        # uniform(3,3) тратит одно случайное число, поэтому сравниваем распределения, а не потоки
        n = 40_000
        xs = [a.sample(r1) for _ in range(n)]
        close_mc(self, sum(1 for x in xs if x == 0) / n, 0.6 ** 3, math.sqrt(0.216 * 0.784 / n), what="P(0 удач из 3)")
        self.assertAlmostEqual(a.mean, b.mean)

    def test_times_dist_rounding(self):
        # «обычно 2, от 1 до 4» -> целые 1…4; среднее число попыток ≈ (1 + 2 + 4) / 3 (округление почти не сдвигает)
        d = E.prepare_dist({"type": "repeat", "timesDist": {"type": "triangular", "min": 1, "mode": 2, "max": 4},
                            "dist": {"type": "uniform", "min": 1, "max": 1}}, "тест")
        rng = E.Rng(2)
        xs = [d.sample(rng) for _ in range(20_000)]
        self.assertTrue(set(xs) <= {1.0, 2.0, 3.0, 4.0})
        self.assertAlmostEqual(sum(xs) / len(xs), 7 / 3, delta=0.03)

    def test_job_fixed_closed_form(self):
        m = E.compile_scenario(JOB_FIXED)
        _, res, ev = E.run(m, 40_000, 3)
        p = 1 - 0.9 ** 12
        close_mc(self, sum(ev) / 40_000, p, math.sqrt(p * (1 - p) / 40_000), what="оффер за 6 недель")
        # среднее число недель до первого оффера: шанс за неделю q = 1 − 0,9² = 0,19 -> 1 / 0,19
        close_mc(self, sum(res) / len(res), 1 / 0.19, math.sqrt((1 - 0.19) / 0.19 ** 2 / 40_000), what="недель в среднем")

    def test_job_random_rate(self):
        m = E.compile_scenario(JOB)
        _, res, ev = E.run(m, 20_000, 4)
        self.assertTrue(0.6 < sum(ev) / 20_000 < 0.9)

    def test_bad_times_dist(self):
        with self.assertRaises(E.MCError):
            E.prepare_dist({"type": "repeat", "timesDist": {"type": "uniform", "min": 3, "max": 1},
                            "dist": {"type": "yesno", "p": 0.4}}, "тест")


if __name__ == "__main__":
    unittest.main()
