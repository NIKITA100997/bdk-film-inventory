"""Формулы и условия правил типа изделия (единая модель, пункт 3).

Пишутся через коды свойств позиции, по-русски:
    ширина + 10
    серия.толщина_каркаса              — параметр выбранного варианта списка
    кромка == "abs" and not стекло     — условие
    "Каркас {ширина+10}х{высота+10}х{серия.толщина_каркаса}"  — шаблон названия

Это НЕ eval: выражение разбирается модулем ast и считается по белому
списку узлов — числа, строки, арифметика, сравнения, and/or/not, if-else,
несколько функций. Ни имён Python, ни вызовов чего-то ещё."""

import ast
import math
import re
from dataclasses import dataclass, field

_FUNCS = {
    "round": round,
    "min": min,
    "max": max,
    "abs": abs,
    "int": int,
    "ceil": math.ceil,
    "floor": math.floor,
}
_BIN = {
    ast.Add: lambda a, b: a + b,
    ast.Sub: lambda a, b: a - b,
    ast.Mult: lambda a, b: a * b,
    ast.Div: lambda a, b: a / b,
    ast.FloorDiv: lambda a, b: a // b,
    ast.Mod: lambda a, b: a % b,
}
_CMP = {
    ast.Eq: lambda a, b: a == b,
    ast.NotEq: lambda a, b: a != b,
    ast.Lt: lambda a, b: a < b,
    ast.LtE: lambda a, b: a <= b,
    ast.Gt: lambda a, b: a > b,
    ast.GtE: lambda a, b: a >= b,
    ast.In: lambda a, b: a in b,
    ast.NotIn: lambda a, b: a not in b,
}


class ExpressionError(ValueError):
    pass


@dataclass(frozen=True)
class OptionRef:
    """Выбранный вариант свойства-списка: сравнивается как строка
    (серия == "В-10"), параметры — через точку (серия.толщина_каркаса)."""

    value: str
    params: dict = field(default_factory=dict)

    def __eq__(self, other: object) -> bool:
        if isinstance(other, OptionRef):
            return self.value == other.value
        return isinstance(other, str) and self.value.strip().lower() == other.strip().lower()

    def __hash__(self) -> int:
        return hash(self.value)

    def __str__(self) -> str:
        return self.value


def _parse(expr: str) -> ast.Expression:
    try:
        return ast.parse(expr.strip(), mode="eval")
    except SyntaxError as e:
        raise ExpressionError(f"Не разобрать формулу «{expr}»") from e


def _eval(node: ast.AST, ctx: dict):
    if isinstance(node, ast.Expression):
        return _eval(node.body, ctx)
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float, str, bool)):
        return node.value
    if isinstance(node, ast.Name):
        if node.id in ("да", "True"):
            return True
        if node.id in ("нет", "False"):
            return False
        if node.id not in ctx:
            raise ExpressionError(f"Неизвестное свойство «{node.id}»")
        value = ctx[node.id]
        if value is None:
            raise ExpressionError(f"Не заполнено свойство «{node.id}»")
        return value
    if isinstance(node, ast.Attribute):
        base = _eval(node.value, ctx)
        if not isinstance(base, OptionRef):
            raise ExpressionError(f"«.{node.attr}» — только у свойства-списка")
        if node.attr not in base.params or base.params[node.attr] in (None, ""):
            raise ExpressionError(f"У варианта «{base.value}» не задан параметр «{node.attr}»")
        return base.params[node.attr]
    if isinstance(node, ast.BinOp) and type(node.op) in _BIN:
        left, right = _eval(node.left, ctx), _eval(node.right, ctx)
        if isinstance(left, str) or isinstance(right, str):
            if isinstance(node.op, ast.Add) and isinstance(left, str) and isinstance(right, str):
                return left + right
            raise ExpressionError("Арифметика — только над числами")
        try:
            return _BIN[type(node.op)](left, right)
        except ZeroDivisionError as e:
            raise ExpressionError("Деление на ноль") from e
    if isinstance(node, ast.UnaryOp):
        v = _eval(node.operand, ctx)
        if isinstance(node.op, ast.USub):
            return -v
        if isinstance(node.op, ast.UAdd):
            return +v
        if isinstance(node.op, ast.Not):
            return not v
    if isinstance(node, ast.BoolOp):
        if isinstance(node.op, ast.And):
            return all(_eval(v, ctx) for v in node.values)
        return any(_eval(v, ctx) for v in node.values)
    if isinstance(node, ast.Compare):
        left = _eval(node.left, ctx)
        for op, comp in zip(node.ops, node.comparators):
            if type(op) not in _CMP:
                break
            right = _eval(comp, ctx)
            if isinstance(left, OptionRef) and isinstance(op, (ast.In, ast.NotIn)):
                left_cmp = left.value.strip().lower()
                right = [str(x).strip().lower() for x in right]
            else:
                left_cmp = left
            if not _CMP[type(op)](left_cmp, right):
                return False
            left = right
        else:
            return True
    if isinstance(node, ast.IfExp):
        return _eval(node.body, ctx) if _eval(node.test, ctx) else _eval(node.orelse, ctx)
    if isinstance(node, (ast.Tuple, ast.List)):
        return [_eval(e, ctx) for e in node.elts]
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in _FUNCS and not node.keywords:
        return _FUNCS[node.func.id](*[_eval(a, ctx) for a in node.args])
    raise ExpressionError("В формуле что-то недопустимое — только свойства, числа, арифметика и сравнения")


def evaluate(expr: str, ctx: dict):
    """Значение формулы на свойствах позиции."""
    return _eval(_parse(expr), ctx)


def evaluate_number(expr: str, ctx: dict) -> float:
    v = evaluate(expr, ctx)
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise ExpressionError(f"Формула «{expr}» должна давать число")
    return float(v)


def evaluate_condition(expr: str | None, ctx: dict) -> bool:
    """Пустое условие — всегда да."""
    if not expr or not expr.strip():
        return True
    return bool(evaluate(expr, ctx))


_PLACEHOLDER = re.compile(r"\{([^{}]+)\}")


def _fmt(v) -> str:
    if isinstance(v, bool):
        return "да" if v else "нет"
    if isinstance(v, float):
        return f"{v:g}" if v != int(v) else str(int(v))
    return str(v)


def render_template(template: str, ctx: dict) -> str:
    """Шаблон с формулами в фигурных скобках → строка."""
    return " ".join(_PLACEHOLDER.sub(lambda m: _fmt(evaluate(m.group(1), ctx)), template).split())


def names_in(expr: str) -> set[str]:
    """Коды свойств, на которые ссылается формула (для проверки при сохранении)."""
    tree = _parse(expr)
    out = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and node.id not in _FUNCS and node.id not in ("да", "нет", "True", "False"):
            out.add(node.id)
    return out


def names_in_template(template: str) -> set[str]:
    out: set[str] = set()
    for m in _PLACEHOLDER.finditer(template):
        out |= names_in(m.group(1))
    return out
