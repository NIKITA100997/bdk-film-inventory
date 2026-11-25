"""Прямая сетевая печать этикеток на термопринтеры Godex G500 (протокол EZPL, порт 9100).

Этикетка рендерится в монохромный растр 203 DPI (8 px/мм) через Pillow
с системными шрифтами Windows (Calibri/Cambria с откатом на Arial/DejaVu)
и отправляется командой `GW` (Graphic Write) по TCP-сокету на `IP:9100`.
Растровый путь гарантирует корректную кириллицу и полное совпадение с PDF-макетом
независимо от загруженных в память принтера кодовых страниц и шрифтов.
"""

from __future__ import annotations

import os
import socket
from typing import Iterable

import qrcode
from PIL import Image, ImageDraw, ImageFont

from app.services.labels import (
    DEFAULT_HEIGHT_MM,
    DEFAULT_WIDTH_MM,
    LabelData,
    render_field_value,
)

# 203 DPI для Godex G500 = 8 точек на миллиметр.
DOTS_PER_MM = 8

DEFAULT_NETWORK_PRINTERS: list[dict] = [
    {"id": "film_warehouse", "name": "Godex G500 — Склад плёнки", "ip": "192.168.1.49", "port": 9100},
    {"id": "factory", "name": "Godex G500 — Фабрика", "ip": "192.168.1.37", "port": 9100},
]


def list_network_printers() -> list[dict]:
    """Возвращает список доступных сетевых принтеров."""
    return [dict(p) for p in DEFAULT_NETWORK_PRINTERS]


def is_allowed_printer_ip(ip: str) -> bool:
    """Проверяет, что IP входит в белый список настроенных принтеров (защита от SSRF)."""
    return any(p["ip"] == ip for p in DEFAULT_NETWORK_PRINTERS)


def _load_font(size_px: int, *, bold: bool = False, serif: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    fonts_dir = r"C:\Windows\Fonts"
    candidates: list[str] = []
    if serif and bold:
        candidates.extend(["cambriab.ttf", "timesbd.ttf"])
    if bold:
        candidates.extend(["calibrib.ttf", "arialbd.ttf", "seguisb.ttf"])
    else:
        candidates.extend(["calibri.ttf", "arial.ttf", "segoeui.ttf"])
    for fname in candidates:
        path = os.path.join(fonts_dir, fname)
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size=size_px)
            except Exception:
                continue
    return ImageFont.load_default()


def _wrap_text(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.ImageFont, max_width_px: int) -> list[str]:
    words = text.split()
    if not words:
        return []
    lines: list[str] = []
    current = words[0]
    for word in words[1:]:
        candidate = f"{current} {word}"
        bbox = draw.textbbox((0, 0), candidate, font=font)
        if (bbox[2] - bbox[0]) <= max_width_px:
            current = candidate
        else:
            lines.append(current)
            current = word
    lines.append(current)
    return lines


def _render_unit_bitmap(
    data: LabelData,
    *,
    fields: list[dict],
    width_mm: int = DEFAULT_WIDTH_MM,
    height_mm: int = DEFAULT_HEIGHT_MM,
    vertical: bool = False,
) -> Image.Image:
    """Рендерит этикетку единицы материала в чёрно-белое изображение ("L", 203 DPI)."""
    w_px = max(8, int(width_mm * DOTS_PER_MM))
    h_px = max(8, int(height_mm * DOTS_PER_MM))
    # Если включена повёрнутая печать — рисуем на повёрнутом холсте и крутим обратно
    # (или наоборот: рисуем в целевой ориентации и при vertical=True поворачиваем на 90°).
    canvas_w, canvas_h = (h_px, w_px) if vertical else (w_px, h_px)

    img = Image.new("L", (canvas_w, canvas_h), 255)
    draw = ImageDraw.Draw(img)

    pad = 12
    has_qr = any(f.get("key") == "qr" for f in fields)
    has_stripe = any(f.get("key") == "status_stripe" for f in fields)

    x_left = pad
    if has_stripe:
        # На термопринтере вместо цветной полосы рисуем штриховую/тонкую метку
        stripe_w = 14
        if data.is_strip:
            draw.rectangle([x_left, pad, x_left + stripe_w, canvas_h - pad], fill=0)
        else:
            draw.rectangle([x_left, pad, x_left + stripe_w, canvas_h - pad], outline=0, width=3)
        x_left += stripe_w + 10

    x_right = canvas_w - pad
    if has_qr:
        qr_box = min(canvas_h - pad * 2, max(120, int(min(canvas_w, canvas_h) * 0.68)))
        qr = qrcode.QRCode(border=1, box_size=1)
        qr.add_data(str(data.unit_id))
        qr.make(fit=True)
        qr_img = qr.make_image(fill_color="black", back_color="white").convert("L")
        qr_img = qr_img.resize((qr_box, qr_box), Image.Resampling.NEAREST)
        qr_x = x_right - qr_box
        qr_y = (canvas_h - qr_box) // 2
        img.paste(qr_img, (qr_x, qr_y))
        x_right = qr_x - 12

    text_max_w = max(40, x_right - x_left)
    y_cursor = pad

    size_map = {"sm": 22, "md": 26, "lg": 38, "huge": 56}
    for f in fields:
        key = f.get("key")
        if key in ("qr", "status_stripe", None):
            continue
        val = render_field_value(data, key, show_label=bool(f.get("show_label", True)))
        if not val:
            continue
        sz = size_map.get(str(f.get("size", "md")), 26)
        bold = bool(f.get("bold", False))
        font = _load_font(sz, bold=bold, serif=(key == "unit_id"))
        wrapped = _wrap_text(draw, val, font, text_max_w)
        for line in wrapped:
            if y_cursor + sz > canvas_h - pad:
                break
            draw.text((x_left, y_cursor), line, fill=0, font=font)
            y_cursor += int(sz * 1.18)

    if vertical:
        img = img.rotate(90, expand=True)
    return img


def render_test_bitmap(*, index: int, total: int, width_mm: int = DEFAULT_WIDTH_MM, height_mm: int = DEFAULT_HEIGHT_MM) -> Image.Image:
    """Рендерит калибровочную тестовую этикетку с рамкой по периметру (для проверки смещения)."""
    w_px = max(8, int(width_mm * DOTS_PER_MM))
    h_px = max(8, int(height_mm * DOTS_PER_MM))
    img = Image.new("L", (w_px, h_px), 255)
    draw = ImageDraw.Draw(img)

    # Рамка по краю для контроля обрезки и зазора
    draw.rectangle([4, 4, w_px - 5, h_px - 5], outline=0, width=3)

    qr = qrcode.QRCode(border=1, box_size=1)
    qr.add_data(f"TEST-{index}/{total}")
    qr.make(fit=True)
    qr_box = max(96, h_px - 36)
    qr_img = qr.make_image(fill_color="black", back_color="white").convert("L").resize((qr_box, qr_box), Image.Resampling.NEAREST)
    img.paste(qr_img, (w_px - qr_box - 18, (h_px - qr_box) // 2))

    f_title = _load_font(42, bold=True, serif=True)
    f_sub = _load_font(26, bold=True)
    f_small = _load_font(22, bold=False)

    draw.text((22, 20), f"ТЕСТ GODEX #{index}/{total}", fill=0, font=f_title)
    draw.text((22, 78), f"Размер: {width_mm}x{height_mm} мм (203 DPI)", fill=0, font=f_sub)
    draw.text((22, 118), "Проверка зазора и кириллицы", fill=0, font=f_small)
    draw.text((22, h_px - 42), "БДК — Учёт плёнки (LAN 9100)", fill=0, font=f_small)
    return img


def image_to_ezpl_block(img: Image.Image, *, x: int = 0, y: int = 0) -> bytes:
    """Конвертирует изображение в EZPL-блок `^L ... GW ... E`."""
    gray = img.convert("L")
    # Выравниваем ширину до кратности 8 пикселей
    w, h = gray.size
    aligned_w = ((w + 7) // 8) * 8
    if aligned_w != w:
        padded = Image.new("L", (aligned_w, h), 255)
        padded.paste(gray, (0, 0))
        gray = padded
        w = aligned_w

    # Пороговая бинаризация и инверсия: в EZPL GW бит 1 = чёрная точка, 0 = белая.
    bw = gray.point(lambda p: 255 if p < 128 else 0, mode="1")
    width_bytes = w // 8
    raw = bw.tobytes()

    header = f"^L\r\nGW{x},{y},{width_bytes},{h},".encode("ascii")
    return header + raw + b"\r\nE\r\n"


def build_ezpl_job(
    images: Iterable[Image.Image],
    *,
    width_mm: int = DEFAULT_WIDTH_MM,
    height_mm: int = DEFAULT_HEIGHT_MM,
    gap_mm: int = 3,
    darkness: int = 10,
    speed: int = 4,
) -> bytes:
    """Собирает полное EZPL-задание для Godex G500 с заголовком геометрии этикетки."""
    setup = (
        f"^Q{height_mm},{gap_mm}\r\n"
        f"^W{width_mm}\r\n"
        f"^H{darkness}\r\n"
        f"^P1\r\n"
        f"^S{speed}\r\n"
        f"^AT\r\n"
        f"^C1\r\n"
        f"^R0\r\n"
        f"~Q+0\r\n"
        f"^O0\r\n"
        f"^D0\r\n"
        f"^E12\r\n"
        f"~R200\r\n"
    ).encode("ascii")
    blocks = [image_to_ezpl_block(im) for im in images]
    if not blocks:
        return b""
    return setup + b"".join(blocks)


def build_units_ezpl_job(
    items: list[LabelData],
    *,
    fields: list[dict],
    width_mm: int = DEFAULT_WIDTH_MM,
    height_mm: int = DEFAULT_HEIGHT_MM,
    vertical: bool = False,
) -> bytes:
    """Генерирует EZPL-задание для одной или нескольких единиц материала."""
    imgs = [
        _render_unit_bitmap(d, fields=fields, width_mm=width_mm, height_mm=height_mm, vertical=vertical)
        for d in items
    ]
    return build_ezpl_job(imgs, width_mm=width_mm, height_mm=height_mm)


def send_ezpl_to_printer(ip: str, payload: bytes, *, port: int = 9100, timeout: float = 5.0) -> None:
    """Отправляет байты EZPL напрямую на сетевой термопринтер по TCP."""
    if not payload:
        return
    try:
        with socket.create_connection((ip, port), timeout=timeout) as sock:
            sock.settimeout(timeout)
            sock.sendall(payload)
    except OSError as exc:
        raise RuntimeError(f"Не удалось отправить на принтер {ip}:{port} ({exc})") from exc
