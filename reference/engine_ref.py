"""
Анализатор вероятностей — эталон движка на Python.

Повторяет engine/engine.js бит в бит: тот же генератор (xoshiro128** + splitmix32), тот же порядок
случайных чисел, тот же язык формул, те же правила. Нужен, чтобы проверять браузерный движок
(как в Snow Boom / Gravity Drop: две независимые реализации должны дать одинаковые числа).

Написан намеренно просто (чистый Python, без numpy) — чтобы каждую строку можно было
сравнить с JavaScript. Поэтому он медленный: ~100–200 тыс. прогонов в секунду не ждите,
для тестов хватает десятков тысяч.

Любое изменение правил — в ОБОИХ файлах, затем make_vectors.py и tests/selftest.html.
"""
import copy
import json
import math
import re
from pathlib import Path

M32 = 0xFFFFFFFF
ROOT = Path(__file__).resolve().parent.parent


class MCError(Exception):
    pass


# =====================================================================================
# Генератор
# =====================================================================================
def splitmix32(seed):
    a = seed & M32

    def nxt():
        nonlocal a
        a = (a + 0x9E3779B9) & M32
        t = a ^ (a >> 16)
        t = (t * 0x21F0AAAD) & M32
        t ^= t >> 15
        t = (t * 0x735A2D97) & M32
        return (t ^ (t >> 15)) & M32

    return nxt


def rotl(x, k):
    return ((x << k) | (x >> (32 - k))) & M32


class Rng:
    def __init__(self, seed):
        if not isinstance(seed, int) or seed < 0 or seed > M32:
            raise MCError("Сид должен быть целым числом от 0 до 4294967295")
        sm = splitmix32(seed)
        self.s = [sm(), sm(), sm(), sm()]

    def next_u32(self):
        s = self.s
        result = (rotl((s[1] * 5) & M32, 7) * 9) & M32
        t = (s[1] << 9) & M32
        s[2] ^= s[0]
        s[3] ^= s[1]
        s[1] ^= s[2]
        s[0] ^= s[3]
        s[2] ^= t
        s[3] = rotl(s[3], 11)
        return result

    def uniform(self):
        a = self.next_u32() >> 5
        b = self.next_u32() >> 6
        return (a * 67108864 + b) / 9007199254740992


# =====================================================================================
# Распределения
# =====================================================================================
def _is_num(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def _num_array(arr, what, who):
    if not isinstance(arr, list) or not arr:
        raise MCError(f"{who}: список «{what}» пуст")
    for i, x in enumerate(arr):
        if not _is_num(x):
            raise MCError(f"{who}: в списке «{what}» позиция {i + 1} — не число")
    return [float(x) for x in arr]


def _need(d, key, who):
    if not _is_num(d.get(key)):
        raise MCError(f"{who}: параметр «{key}» должен быть числом")
    return float(d[key])


def _merge_support(values, weights, total):
    m = {}
    for v, w in zip(values, weights):
        if w > 0:
            m[v] = m.get(v, 0.0) + w
    return [(v, w / total) for v, w in m.items()]


class Dist:
    def __init__(self, type_, sample, support, mean=None, sd=None):
        self.type, self.sample, self.support = type_, sample, support
        if support is not None:
            m = m2 = 0.0
            for v, p in support:
                m += v * p
                m2 += v * v * p
            mean, sd = m, math.sqrt(max(0.0, m2 - m * m))
        self.mean, self.sd = mean, sd


def prepare_dist(d, who):
    if not isinstance(d, dict):
        raise MCError(f"{who}: не задано распределение")
    t = d.get("type")
    if t == "table":
        values = _num_array(d.get("values"), "значения", who)
        weights = _num_array(d.get("weights"), "веса", who)
        if len(values) != len(weights):
            raise MCError(f"{who}: значений {len(values)}, а весов {len(weights)}")
        if any(w < 0 for w in weights):
            raise MCError(f"{who}: вес не может быть отрицательным")
        cum, total = [], 0.0
        for w in weights:
            total += w
            cum.append(total)
        if not total > 0:
            raise MCError(f"{who}: сумма весов должна быть больше нуля")
        last = len(values) - 1

        def sample(rng):
            u = rng.uniform() * total
            lo, hi = 0, last
            while lo < hi:
                mid = (lo + hi) >> 1
                if u < cum[mid]:
                    hi = mid
                else:
                    lo = mid + 1
            return values[lo]

        return Dist("table", sample, _merge_support(values, weights, total))
    if t == "yesno":
        p = _need(d, "p", who)
        if p < 0 or p > 1:
            raise MCError(f"{who}: вероятность должна быть от 0 до 1")
        return Dist("yesno", lambda rng: 1.0 if rng.uniform() < p else 0.0,
                    _merge_support([1.0, 0.0], [p, 1 - p], 1.0))
    if t == "uniform":
        a, b = _need(d, "min", who), _need(d, "max", who)
        if a > b:
            raise MCError(f"{who}: минимум больше максимума")
        return Dist("uniform", lambda rng: a + (b - a) * rng.uniform(), None, (a + b) / 2, (b - a) / math.sqrt(12))
    if t == "triangular":
        a, c, b = _need(d, "min", who), _need(d, "mode", who), _need(d, "max", who)
        if not a < b:
            raise MCError(f"{who}: минимум должен быть меньше максимума")
        if c < a or c > b:
            raise MCError(f"{who}: «обычно» должно быть между минимумом и максимумом")
        fc = (c - a) / (b - a)

        def sample(rng):
            u = rng.uniform()
            if u < fc:
                return a + math.sqrt(u * (b - a) * (c - a))
            return b - math.sqrt((1 - u) * (b - a) * (b - c))

        v = (a * a + b * b + c * c - a * b - a * c - b * c) / 18
        return Dist("triangular", sample, None, (a + b + c) / 3, math.sqrt(v))
    if t == "normal":
        mu, sd = _need(d, "mean", who), _need(d, "sd", who)
        if not sd > 0:
            raise MCError(f"{who}: разброс (sd) должен быть больше нуля")

        def sample(rng):
            u1 = rng.uniform()
            u2 = rng.uniform()
            return mu + sd * math.sqrt(-2 * math.log(1 - u1)) * math.cos(2 * math.pi * u2)

        return Dist("normal", sample, None, mu, sd)
    if t == "data":
        values = _num_array(d.get("values"), "данные", who)
        n = len(values)
        return Dist("data", lambda rng: values[math.floor(rng.uniform() * n)],
                    _merge_support(values, [1.0] * n, float(n)))
    if t == "mixture":   # служебный тип: смесь распределений (для «версии без связей»)
        parts_spec = d.get("parts")
        if not isinstance(parts_spec, list) or not parts_spec:
            raise MCError(f"{who}: смесь без частей")
        parts = [prepare_dist(pt.get("dist") if isinstance(pt, dict) else None, f"{who}, часть {j + 1}")
                 for j, pt in enumerate(parts_spec)]
        w = [pt.get("p") for pt in parts_spec]
        if any(not _is_num(x) or x < 0 for x in w):
            raise MCError(f"{who}: вес части смеси должен быть числом ≥ 0")
        cum, total = [], 0.0
        for x in w:
            total += x
            cum.append(total)
        if not total > 0:
            raise MCError(f"{who}: сумма весов смеси должна быть больше нуля")
        last = len(w) - 1

        def sample(rng):
            u = rng.uniform() * total
            lo, hi = 0, last
            while lo < hi:
                mid = (lo + hi) >> 1
                if u < cum[mid]:
                    hi = mid
                else:
                    lo = mid + 1
            return parts[lo].sample(rng)

        if all(pt.support is not None for pt in parts):
            return Dist("mixture", sample, merge_weighted([(w[j] / total, pt.support) for j, pt in enumerate(parts)]))
        m = m2 = 0.0
        for j, pt in enumerate(parts):
            q = w[j] / total
            m += q * pt.mean
            m2 += q * (pt.sd * pt.sd + pt.mean * pt.mean)
        return Dist("mixture", sample, None, m, math.sqrt(max(0.0, m2 - m * m)))
    if t in ("conditional", "rows"):
        raise MCError(f"{who}: этот тип нельзя использовать внутри ветки")
    raise MCError(f"{who}: неизвестный тип распределения «{t}»")


# =====================================================================================
# Язык формул (см. описание в engine.js)
# =====================================================================================
ID_START = re.compile(r"[A-Za-zА-Яа-яЁё_]")
ID_PART = re.compile(r"[A-Za-zА-Яа-яЁё_0-9]")
NUM_RE = re.compile(r"\d+(\.\d+)?([eE][+-]?\d+)?")
OPS = ["<=", ">=", "==", "!=", "<>", "&&", "||", "<", ">", "=", "+", "-", "*", "/", "^", "!", "(", ")", ",", ";"]
KEYWORDS = {"и": "and", "and": "and", "или": "or", "or": "or", "не": "not", "not": "not"}
CONSTS = {"да": 1.0, "true": 1.0, "нет": 0.0, "false": 0.0}
FUNC_ALIASES = {
    "max": "max", "макс": "max", "min": "min", "мин": "min", "abs": "abs", "модуль": "abs",
    "round": "round", "округл": "round", "floor": "floor", "вниз": "floor", "ceil": "ceil", "вверх": "ceil",
    "sqrt": "sqrt", "корень": "sqrt", "if": "if", "если": "if",
}
FUNC_ARITY = {"max": (1, math.inf), "min": (1, math.inf), "abs": (1, 1), "round": (1, 1), "floor": (1, 1),
              "ceil": (1, 1), "sqrt": (1, 1), "if": (3, 3)}
RESERVED = set(KEYWORDS) | set(CONSTS) | set(FUNC_ALIASES)
CMP_OPS = ("<", "<=", ">", ">=", "=", "==", "!=", "<>")


def truth(x):
    return x != 0 and x == x


def tokenize(src):
    toks, i = [], 0
    while i < len(src):
        ch = src[i]
        if ch.isspace():
            i += 1
            continue
        if ch.isdigit() and ch.isascii():
            m = NUM_RE.match(src, i)
            toks.append(("num", float(m.group(0)), i))
            i = m.end()
            if i < len(src) and ID_START.match(src[i]):
                raise MCError(f"после числа сразу идут буквы (позиция {i + 1}); поставьте знак, например «*»")
            continue
        if ID_START.match(ch):
            j = i + 1
            while j < len(src) and ID_PART.match(src[j]):
                j += 1
            toks.append(("id", src[i:j], i))
            i = j
            continue
        op = next((o for o in OPS if src.startswith(o, i)), None)
        if op is None:
            raise MCError(f"непонятный символ «{ch}» (позиция {i + 1})")
        toks.append(("op", op, i))
        i += len(op)
    toks.append(("end", "", len(src)))
    return toks


def parse(src):
    if not isinstance(src, str) or not src.strip():
        raise MCError("формула пустая")
    t = tokenize(src)
    p = 0

    def peek():
        return t[p]

    def kw(tok):
        return KEYWORDS.get(tok[1].lower()) if tok[0] == "id" else None

    def is_op(tok, *ops):
        return tok[0] == "op" and tok[1] in ops

    def expect(v):
        nonlocal p
        if not is_op(peek(), v):
            raise MCError(f"ожидалось «{v}» (позиция {peek()[2] + 1})")
        p += 1

    def or_expr():
        nonlocal p
        a = and_expr()
        while kw(peek()) == "or" or is_op(peek(), "||"):
            p += 1
            a = ("or", a, and_expr())
        return a

    def and_expr():
        nonlocal p
        a = not_expr()
        while kw(peek()) == "and" or is_op(peek(), "&&"):
            p += 1
            a = ("and", a, not_expr())
        return a

    def not_expr():
        nonlocal p
        if kw(peek()) == "not" or is_op(peek(), "!"):
            p += 1
            return ("not", not_expr())
        return cmp_expr()

    def cmp_expr():
        nonlocal p
        a = add_expr()
        if is_op(peek(), *CMP_OPS):
            op = t[p][1]
            p += 1
            op = {"=": "==", "<>": "!="}.get(op, op)
            b = add_expr()
            if is_op(peek(), *CMP_OPS):
                raise MCError("два сравнения подряд: вместо «a < b < c» пишите «a < b и b < c»")
            return ("cmp", op, a, b)
        return a

    def add_expr():
        nonlocal p
        a = mul_expr()
        while is_op(peek(), "+", "-"):
            op = t[p][1]
            p += 1
            a = ("bin", op, a, mul_expr())
        return a

    def mul_expr():
        nonlocal p
        a = unary()
        while is_op(peek(), "*", "/"):
            op = t[p][1]
            p += 1
            a = ("bin", op, a, unary())
        return a

    def unary():
        nonlocal p
        if is_op(peek(), "-"):
            p += 1
            return ("neg", unary())
        if is_op(peek(), "+"):
            p += 1
            return unary()
        return power()

    def power():
        nonlocal p
        a = atom()
        if is_op(peek(), "^"):
            p += 1
            return ("bin", "^", a, unary())
        return a

    def atom():
        nonlocal p
        tok = peek()
        if tok[0] == "num":
            p += 1
            return ("num", tok[1])
        if is_op(tok, "("):
            p += 1
            e = or_expr()
            expect(")")
            return e
        if tok[0] == "id":
            low = tok[1].lower()
            if low in KEYWORDS:
                raise MCError(f"лишнее «{tok[1]}» (позиция {tok[2] + 1})")
            p += 1
            if is_op(peek(), "("):
                fn = FUNC_ALIASES.get(low)
                if not fn:
                    raise MCError(f"неизвестная функция «{tok[1]}»")
                p += 1
                args = []
                if not is_op(peek(), ")"):
                    args.append(or_expr())
                    while is_op(peek(), ",", ";"):
                        p += 1
                        args.append(or_expr())
                expect(")")
                lo, hi = FUNC_ARITY[fn]
                if len(args) < lo or len(args) > hi:
                    raise MCError(f"функция «{tok[1]}»: неверное число аргументов ({len(args)})")
                return ("call", fn, args)
            if low in CONSTS:
                return ("num", CONSTS[low])
            if low in FUNC_ALIASES:
                raise MCError(f"после «{tok[1]}» нужны скобки: {tok[1]}(…)")
            return ("var", low, tok[1])
        if tok[0] == "end":
            raise MCError("формула оборвалась")
        raise MCError(f"неожиданное «{tok[1]}» (позиция {tok[2] + 1})")

    tree = or_expr()
    if peek()[0] != "end":
        raise MCError(f"лишнее «{peek()[1]}» (позиция {peek()[2] + 1})")
    return tree


def collect_vars(node, out=None):
    out = set() if out is None else out
    kind = node[0]
    if kind == "var":
        out.add(node[1])
    elif kind in ("neg", "not"):
        collect_vars(node[1], out)
    elif kind in ("and", "or"):
        collect_vars(node[1], out)
        collect_vars(node[2], out)
    elif kind in ("cmp", "bin"):
        collect_vars(node[2], out)
        collect_vars(node[3], out)
    elif kind == "call":
        for a in node[2]:
            collect_vars(a, out)
    return out


# Арифметика как в JavaScript: деление на 0 -> ±Infinity / NaN, корень из отрицательного -> NaN
def _div(a, b):
    if b == 0:
        if a == 0 or a != a:
            return math.nan
        return math.copysign(math.inf, a) * math.copysign(1.0, b)
    return a / b


def _pow(a, b):
    try:
        return math.pow(a, b)
    except ValueError:
        return math.nan
    except OverflowError:
        return math.inf


def _sqrt(x):
    return math.sqrt(x) if x >= 0 else math.nan


def _js_max(args):
    if any(a != a for a in args):
        return math.nan
    return max(args)


def _js_min(args):
    if any(a != a for a in args):
        return math.nan
    return min(args)


FN = {
    "max": _js_max, "min": _js_min, "abs": lambda a: abs(a[0]),
    "round": lambda a: float(math.floor(a[0] + 0.5)) if math.isfinite(a[0]) else a[0],
    "floor": lambda a: float(math.floor(a[0])) if math.isfinite(a[0]) else a[0],
    "ceil": lambda a: float(math.ceil(a[0])) if math.isfinite(a[0]) else a[0],
    "sqrt": lambda a: _sqrt(a[0]),
}


def compile_tree(node, index):
    c = lambda n: compile_tree(n, index)  # noqa: E731
    kind = node[0]
    if kind == "num":
        v = node[1]
        return lambda row: v
    if kind == "var":
        if node[1] not in index:
            raise MCError(f"неизвестное имя «{node[2]}»")
        k = index[node[1]]
        return lambda row: row[k]
    if kind == "neg":
        a = c(node[1])
        return lambda row: -a(row)
    if kind == "not":
        a = c(node[1])
        return lambda row: 0.0 if truth(a(row)) else 1.0
    if kind == "and":
        a, b = c(node[1]), c(node[2])
        return lambda row: 1.0 if truth(a(row)) and truth(b(row)) else 0.0
    if kind == "or":
        a, b = c(node[1]), c(node[2])
        return lambda row: 1.0 if truth(a(row)) or truth(b(row)) else 0.0
    if kind == "cmp":
        op, a, b = node[1], c(node[2]), c(node[3])
        f = {"<": lambda x, y: x < y, "<=": lambda x, y: x <= y, ">": lambda x, y: x > y,
             ">=": lambda x, y: x >= y, "==": lambda x, y: x == y, "!=": lambda x, y: x != y}[op]
        return lambda row: 1.0 if f(a(row), b(row)) else 0.0
    if kind == "bin":
        op, a, b = node[1], c(node[2]), c(node[3])
        if op == "+":
            return lambda row: a(row) + b(row)
        if op == "-":
            return lambda row: a(row) - b(row)
        if op == "*":
            return lambda row: a(row) * b(row)
        if op == "/":
            return lambda row: _div(a(row), b(row))
        if op == "^":
            return lambda row: _pow(a(row), b(row))
    if kind == "call":
        fn, args = node[1], [c(x) for x in node[2]]
        if fn == "if":
            cond, yes, no = args
            return lambda row: yes(row) if truth(cond(row)) else no(row)
        f = FN[fn]
        return lambda row: f([a(row) for a in args])
    raise MCError("внутренняя ошибка разбора")


def eval_formula(src, vars_=None):
    vars_ = vars_ or {}
    names = list(vars_)
    index = {n.lower(): i for i, n in enumerate(names)}
    f = compile_tree(parse(src), index)
    return f([float(vars_[n]) for n in names])


# =====================================================================================
# Сценарий
# =====================================================================================
def _check_name(name, seen, who):
    if not isinstance(name, str) or not name:
        raise MCError(f"{who}: не задано имя")
    if not ID_START.match(name[0]) or not all(ID_PART.match(ch) for ch in name):
        raise MCError(f"Имя «{name}»: можно только буквы, цифры и «_», без пробелов, первая — буква")
    low = name.lower()
    if low in RESERVED:
        raise MCError(f"Имя «{name}» занято (это слово языка формул)")
    if low in seen:
        raise MCError(f"Имя «{name}» встречается дважды")
    seen.add(low)
    return low


def _compile_formula(src, index, who):
    try:
        tree = parse(src)
        return compile_tree(tree, index), sorted(collect_vars(tree))
    except MCError as e:
        raise MCError(f"{who}, формула «{src}»: {e}") from None


class Model:
    pass


# =====================================================================================
# Факторы: обычный / «зависит от» (conditional) / «строки таблицы» (rows) — как в engine.js
# =====================================================================================
MAX_BRANCHES = 12


def merge_weighted(lst):
    m = {}
    for w, sup in lst:
        for v, p in sup:
            m[v] = m.get(v, 0.0) + w * p
    return list(m.items())


class Factor:
    pass


def _build_factor(f, i, ctx):
    name = f.get("name") if isinstance(f, dict) else None
    who = f"Фактор «{name}»"
    d = f.get("dist") if isinstance(f, dict) else None
    if isinstance(d, dict) and d.get("type") == "rows":
        return _build_rows(f, i, ctx)
    low = _check_name(name, ctx["seen"], f"Фактор №{i + 1}")
    slot = len(ctx["index"])
    fac = Factor()
    fac.name, fac.label, fac.spec, fac.slots = name, f.get("label") or name, d, [slot]
    fac.vars = [{"name": name, "label": fac.label, "slot": slot, "index": False}]
    if isinstance(d, dict) and d.get("type") == "conditional":
        on = d.get("on")
        pname = on.lower() if isinstance(on, str) else ""
        if pname not in ctx["index"]:
            raise MCError(f"{who} зависит от «{on}», но такого фактора выше нет "
                          f"(зависеть можно только от факторов, стоящих выше)")
        ps = ctx["index"][pname]
        pm = ctx["marginal"][ps]
        if pm is None:
            raise MCError(f"{who}: «{on}» должен принимать отдельные значения (таблица, да/нет, данные), а не любые числа")
        if len(pm) > MAX_BRANCHES:
            raise MCError(f"{who}: у «{on}» слишком много разных значений ({len(pm)}, можно до {MAX_BRANCHES})")
        cases = d.get("cases")
        if not isinstance(cases, list) or not cases:
            raise MCError(f"{who}: нет ни одной ветки")
        branches = {}
        for j, c in enumerate(cases):
            if not isinstance(c, dict) or not _is_num(c.get("value")):
                raise MCError(f"{who}: у ветки {j + 1} не задано значение «{on}»")
            v = float(c["value"])
            if v in branches:
                raise MCError(f"{who}: ветка для «{on}» = {c['value']} задана дважды")
            branches[v] = prepare_dist(c.get("dist"), f"{who}, ветка «{on} = {c['value']}»")
        for v, _ in pm:
            if v not in branches:
                raise MCError(f"{who}: «{on}» бывает равен {v}, а ветки для этого значения нет")
        discrete = all(b.support is not None for b in branches.values())
        ctx["marginal"][slot] = merge_weighted([(p, branches[v].support) for v, p in pm]) if discrete else None
        fac.kind, fac.parent_slot, fac.branches = "conditional", ps, branches

        def sample(rng, row):
            row[slot] = branches[row[ps]].sample(rng)

        fac.sample = sample
        fac.enumerate = (lambda row: [([v], p) for v, p in branches[row[ps]].support]) if discrete else None
        fac.max_options = max(len(b.support) if b.support is not None else math.inf for b in branches.values())
    else:
        dist = prepare_dist(d, who)
        ctx["marginal"][slot] = dist.support
        fac.kind, fac.dist = "plain", dist

        def sample(rng, row):
            row[slot] = dist.sample(rng)

        fac.sample = sample
        fac.enumerate = (lambda row: [([v], p) for v, p in dist.support]) if dist.support is not None else None
        fac.max_options = len(dist.support) if dist.support is not None else math.inf
    ctx["index"][low] = slot
    return fac


def _build_rows(f, i, ctx):
    name = f["name"]
    who = f"Фактор «{name}»"
    d = f["dist"]
    low = _check_name(name, ctx["seen"], f"Фактор №{i + 1}")
    cols, rows = d.get("columns"), d.get("rows")
    if not isinstance(cols, list) or not cols:
        raise MCError(f"{who}: нет ни одного столбца")
    if not isinstance(rows, list) or not rows:
        raise MCError(f"{who}: нет ни одной строки")
    W, base = len(cols), len(ctx["index"])
    ctx["index"][low] = base
    for k, c in enumerate(cols):
        ctx["index"][_check_name(c, ctx["seen"], f"{who}, столбец №{k + 1}")] = base + 1 + k
    for j, r in enumerate(rows):
        if not isinstance(r, list) or len(r) != W:
            raise MCError(f"{who}: в строке {j + 1} {len(r) if isinstance(r, list) else 0} знач., а столбцов {W}")
        for k, x in enumerate(r):
            if not _is_num(x):
                raise MCError(f"{who}: строка {j + 1}, столбец «{cols[k]}» — не число")
    rows = [[float(x) for x in r] for r in rows]
    n = len(rows)
    ones = [1.0] * n
    ctx["marginal"][base] = _merge_support([float(j + 1) for j in range(n)], ones, float(n))
    for k in range(W):
        ctx["marginal"][base + 1 + k] = _merge_support([r[k] for r in rows], ones, float(n))
    fac = Factor()
    fac.name, fac.label, fac.spec, fac.kind = name, f.get("label") or name, d, "rows"
    fac.slots = [base + k for k in range(W + 1)]
    fac.vars = [{"name": name, "label": f"{fac.label}: номер строки", "slot": base, "index": True}] + \
               [{"name": c, "label": c, "slot": base + 1 + k, "index": False} for k, c in enumerate(cols)]

    def sample(rng, row):
        j = math.floor(rng.uniform() * n)
        r = rows[j]
        row[base] = float(j + 1)
        for k in range(W):
            row[base + 1 + k] = r[k]

    fac.sample = sample
    fac.enumerate = lambda row: [([float(j + 1)] + r, 1 / n) for j, r in enumerate(rows)]
    fac.max_options = n
    return fac


def compile_scenario(sc):
    if not isinstance(sc, dict):
        raise MCError("Сценарий не задан")
    if not isinstance(sc.get("factors"), list) or not sc["factors"]:
        raise MCError("Нужен хотя бы один случайный фактор")
    if not isinstance(sc.get("result"), dict) or not isinstance(sc["result"].get("formula"), str):
        raise MCError("Не задана формула итога")
    ctx = {"seen": set(), "index": {}, "marginal": {}}
    m = Model()
    m.name = sc.get("name") or "Сценарий"
    m.factors = [_build_factor(f, i, ctx) for i, f in enumerate(sc["factors"])]
    m.vars = [v for f in m.factors for v in f.vars]
    m.n_vars = len(ctx["index"])
    m.marginal = ctx["marginal"]
    m.dependent = any(f.kind != "plain" for f in m.factors)
    index, seen = ctx["index"], ctx["seen"]
    m.derived = []
    for d in sc.get("derived") or []:
        low = _check_name(d.get("name"), seen, "Расчётная величина")
        fn, uses = _compile_formula(d.get("formula"), index, f"Величина «{d['name']}»")
        index[low] = len(index)
        m.derived.append({"name": d["name"], "fn": fn, "uses": uses})
    res_name = sc["result"].get("name") or "Итог"
    rlow = _check_name(res_name, seen, "Итог")
    m.result_fn, used = _compile_formula(sc["result"]["formula"], index, f"Итог «{res_name}»")
    m.used = set(used) | {u for d in m.derived for u in d["uses"]}
    index[rlow] = len(index)
    m.event_fn = None
    ev = sc.get("event")
    if ev and (ev.get("formula") or "").strip():
        m.event_fn, ev_used = _compile_formula(ev["formula"], index, f"Событие «{ev.get('name') or 'Событие'}»")
        m.used |= set(ev_used)
    m.width = len(index)
    m.result_slot = m.width - 1
    return m


def finish_row(m, row):
    V = m.n_vars
    for j, d in enumerate(m.derived):
        row[V + j] = d["fn"](row)
    r = m.result_fn(row)
    row[m.result_slot] = r
    ev = (1 if truth(m.event_fn(row)) else 0) if m.event_fn else 0
    return r, ev


def independent_version(sc):
    """Тот же сценарий без связей между факторами (см. independentVersion в engine.js)."""
    m = compile_scenario(sc)
    out = copy.deepcopy(sc)
    out["factors"] = []
    for f, spec in zip(m.factors, sc["factors"]):
        if f.kind == "plain":
            out["factors"].append(copy.deepcopy(spec))
        elif f.kind == "conditional":
            pm = m.marginal[f.parent_slot]
            parts = [{"p": p, "dist": copy.deepcopy(next(c for c in spec["dist"]["cases"] if c["value"] == v)["dist"])}
                     for v, p in pm]
            out["factors"].append({"name": spec["name"], "label": spec.get("label") or spec["name"],
                                   "dist": {"type": "mixture", "parts": parts}})
        else:
            rows = spec["dist"]["rows"]
            out["factors"].append({"name": spec["name"], "label": spec.get("label") or spec["name"],
                                   "dist": {"type": "data", "values": [j + 1 for j in range(len(rows))]}})
            for k, c in enumerate(spec["dist"]["columns"]):
                out["factors"].append({"name": c, "label": c, "dist": {"type": "data", "values": [r[k] for r in rows]}})
    return out


def dependents_of(m, slot):
    s, out = {slot}, []
    for f in m.factors:
        if f.kind == "conditional" and f.parent_slot in s:
            out.append(f)
            s.update(f.slots)
    return out


# =====================================================================================
# Прогон и статистика
# =====================================================================================
def run(m, n, seed):
    """Возвращает (столбцы случайных величин, итоги, события) — порядок случайных чисел как в engine.js."""
    if not isinstance(n, int) or n < 1:
        raise MCError("Число прогонов должно быть целым и больше нуля")
    rng = Rng(seed)
    V = m.n_vars
    cols = [[0.0] * n for _ in range(V)]
    result, event = [0.0] * n, ([0] * n if m.event_fn else None)
    row = [0.0] * m.width
    for i in range(n):
        for f in m.factors:
            f.sample(rng, row)
        for v in range(V):
            cols[v][i] = row[v]
        r, ev = finish_row(m, row)
        result[i] = r
        if event is not None:
            event[i] = ev
    return cols, result, event


def quantile(sorted_vals, q):
    m = len(sorted_vals)
    if not m:
        return math.nan
    pos = (m - 1) * q
    lo = math.floor(pos)
    frac = pos - lo
    if lo + 1 < m:
        return sorted_vals[lo] + (sorted_vals[lo + 1] - sorted_vals[lo]) * frac
    return sorted_vals[lo]


PCTS = [1, 5, 10, 25, 50, 75, 90, 95, 99]


def proportion(count, n):
    p = count / n
    se = math.sqrt(p * (1 - p) / n)
    lo, hi = p - 1.96 * se, p + 1.96 * se
    if count == 0:
        hi = 3 / n
    if count == n:
        lo = 1 - 3 / n
    return {"count": count, "n": n, "p": p, "se": se, "lo": max(0.0, lo), "hi": min(1.0, hi)}


def summarize(result, event):
    vals = [v for v in result if v == v]
    m = len(vals)
    s = 0.0
    for v in vals:            # обычный цикл, а не sum(): так порядок сложения как в JS
        s += v
    mean = s / m
    ss = 0.0
    for v in vals:
        d = v - mean
        ss += d * d
    sd = math.sqrt(ss / (m - 1)) if m > 1 else 0.0
    srt = sorted(vals)
    return {
        "n": len(result), "nan": len(result) - m,
        "event": proportion(sum(event), len(result)) if event is not None else None,
        "mean": mean, "sd": sd, "min": srt[0], "max": srt[-1],
        "pct": {q: quantile(srt, q / 100) for q in PCTS},
    }


def sensitivity(m, cols, n_rows, seed):
    """Как MC.sensitivity: фиксируем величину на 10-м и 90-м перцентиле её выборки;
    зависящие от неё факторы перевыбираются генератором с сидом seed + 1000003·(номер + 1)."""
    V = m.n_vars
    row = [0.0] * m.width

    def eval_with(fix, value):
        deps = dependents_of(m, fix) if fix >= 0 else []
        rng = Rng((seed + 1000003 * (fix + 1)) % 4294967296) if deps else None
        ev = 0
        s = 0.0
        for i in range(n_rows):
            for v in range(V):
                row[v] = cols[v][i]
            if fix >= 0:
                row[fix] = value
            for f in deps:
                f.sample(rng, row)
            r, e = finish_row(m, row)
            s += r
            ev += e
        return {"p": ev / n_rows if m.event_fn else None, "mean": s / n_rows}

    out = {"base": eval_with(-1, 0.0), "items": []}
    for var in m.vars:
        if var["index"] or (var["name"].lower() not in m.used and not dependents_of(m, var["slot"])):
            continue      # неиспользуемая величина ни на что не влияет — в «торнадо» не показываем
        k = var["slot"]
        srt = sorted(cols[k][:n_rows])
        low_v = srt[math.floor(0.1 * (n_rows - 1))]
        high_v = srt[math.ceil(0.9 * (n_rows - 1))]
        out["items"].append({"name": var["name"], "low": {"value": low_v, **eval_with(k, low_v)},
                             "high": {"value": high_v, **eval_with(k, high_v)}})
    return out


def exact(m, max_combos=2_000_000):
    """Точный перебор «деревом» (у зависимого фактора — варианты выбранной ветки)."""
    if any(f.enumerate is None for f in m.factors):
        return None
    bound = 1
    for f in m.factors:
        bound *= f.max_options
    if bound > max_combos:
        return None
    F = len(m.factors)
    row = [0.0] * m.width
    acc = {"p": 0.0, "m1": 0.0, "m2": 0.0, "combos": 0}

    def rec(fi, prob):
        if fi == F:
            r, ev = finish_row(m, row)
            acc["combos"] += 1
            if ev:
                acc["p"] += prob
            acc["m1"] += prob * r
            acc["m2"] += prob * r * r
            return
        f = m.factors[fi]
        for vals, p in f.enumerate(row):
            for k, v in enumerate(vals):
                row[f.slots[k]] = v
            rec(fi + 1, prob * p)

    rec(0, 1.0)
    m1 = acc["m1"]
    return {"combos": acc["combos"], "p": acc["p"] if m.event_fn else None, "mean": m1,
            "sd": math.sqrt(max(0.0, acc["m2"] - m1 * m1))}


def runs_needed(p, half):
    return math.ceil(1.96 * 1.96 * p * (1 - p) / (half * half))


def load_templates():
    """Читает engine/templates.js (после «var MC_TEMPLATES =» лежит строгий JSON)."""
    text = (ROOT / "engine" / "templates.js").read_text(encoding="utf-8")
    start = text.index("var MC_TEMPLATES =") + len("var MC_TEMPLATES =")
    end = text.index("\n];", start) + 2
    return json.loads(text[start:end])
