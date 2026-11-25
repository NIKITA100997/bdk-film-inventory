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
    """Рендерит этикетку единицы материала в чёрно-белое изображение ("L", 203 DPI),
    повторяя эталонную раскладку _draw_label_page: полоса и QR слева, текст справа
    с автоподбором максимально крупного кегля без пустых полей."""
    w_px = max(8, int(width_mm * DOTS_PER_MM))
    h_px = max(8, int(height_mm * DOTS_PER_MM))
    canvas_w, canvas_h = (h_px, w_px) if vertical else (w_px, h_px)

    img = Image.new("L", (canvas_w, canvas_h), 255)
    draw = ImageDraw.Draw(img)

    pad = 12
    is_landscape = canvas_w >= canvas_h
    has_qr = any(f.get("key") == "qr" for f in fields)
    has_stripe = any(f.get("key") == "status_stripe" for f in fields)
    giant_field = next((f for f in fields if f.get("size") == "huge"), None)

    x_cursor = pad
    y_text_top = pad

    if is_landscape:
        if has_stripe:
            stripe_w = 24
            if data.is_strip:
                draw.rectangle([4, 4, 4 + stripe_w, canvas_h - 5], fill=0)
            else:
                draw.rectangle([4, 4, 4 + stripe_w, canvas_h - 5], outline=0, width=4)
            x_cursor = 4 + stripe_w + 12

        if has_qr:
            qr_box = min(canvas_h - 24, max(128, int(min(canvas_w, canvas_h) * 0.84)))
            qr = qrcode.QRCode(border=1, box_size=1)
            qr.add_data(str(data.unit_id))
            qr.make(fit=True)
            qr_img = qr.make_image(fill_color="black", back_color="white").convert("L")
            qr_img = qr_img.resize((qr_box, qr_box), Image.Resampling.NEAREST)
            qr_y = (canvas_h - qr_box) // 2
            img.paste(qr_img, (x_cursor, qr_y))
            x_cursor += qr_box + 16
    else:
        if has_stripe:
            stripe_h = 20
            if data.is_strip:
                draw.rectangle([4, 4, canvas_w - 5, 4 + stripe_h], fill=0)
            else:
                draw.rectangle([4, 4, canvas_w - 5, 4 + stripe_h], outline=0, width=4)
            y_text_top = 4 + stripe_h + 10
        if has_qr:
            qr_box = min(canvas_w - 24, max(128, int(canvas_w * 0.62)))
            qr = qrcode.QRCode(border=1, box_size=1)
            qr.add_data(str(data.unit_id))
            qr.make(fit=True)
            qr_img = qr.make_image(fill_color="black", back_color="white").convert("L")
            qr_img = qr_img.resize((qr_box, qr_box), Image.Resampling.NEAREST)
            qr_x = (canvas_w - qr_box) // 2
            img.paste(qr_img, (qr_x, y_text_top))
            y_text_top += qr_box + 12

    text_max_w = max(60, canvas_w - x_cursor - pad)
    avail_h = max(40, canvas_h - y_text_top - pad)

    if giant_field is not None:
        val = render_field_value(data, giant_field["key"], show_label=bool(giant_field.get("show_label", True))) or ""
        best_font = _load_font(48, bold=True, serif=True)
        for sz in range(140, 24, -4):
            fnt = _load_font(sz, bold=True, serif=True)
            lines = _wrap_text(draw, val, fnt, text_max_w)
            total_h = len(lines) * int(sz * 1.12)
            max_line_w = max(((draw.textbbox((0, 0), ln, font=fnt)[2]) for ln in lines), default=0)
            if total_h <= avail_h and max_line_w <= text_max_w:
                best_font = fnt
                y_start = y_text_top + max(0, (avail_h - total_h) // 2)
                for ln in lines:
                    draw.text((x_cursor, y_start), ln, fill=0, font=best_font)
                    y_start += int(sz * 1.12)
                break
    else:
        rendered: list[tuple[dict, str]] = []
        for f in fields:
            key = f.get("key")
            if key in ("qr", "status_stripe", None):
                continue
            val = render_field_value(data, key, show_label=bool(f.get("show_label", True)))
            if val:
                rendered.append((f, val))

        base_sizes = {"sm": 22, "md": 28, "lg": 42}
        chosen_layout: list[tuple[str, ImageFont.ImageFont, int]] = []
        chosen_h = 0

        for step in range(20, 6, -1):
            scale = step / 10.0
            layout: list[tuple[str, ImageFont.ImageFont, int]] = []
            total_h = 0
            for f, val in rendered:
                key = f.get("key")
                base_sz = base_sizes.get(str(f.get("size", "md")), 28)
                sz = max(16, int(base_sz * scale))
                bold = bool(f.get("bold", False)) or key == "unit_id"
                font = _load_font(sz, bold=bold, serif=(key == "unit_id"))
                wrapped = _wrap_text(draw, val, font, text_max_w)
                step_h = int(sz * 1.14)
                for ln in wrapped:
                    layout.append((ln, font, step_h))
                    total_h += step_h
            chosen_layout = layout
            chosen_h = total_h
            if total_h <= avail_h:
                break

        y_cursor = y_text_top + max(0, (avail_h - chosen_h) // 2)
        for ln, font, step_h in chosen_layout:
            if y_cursor + step_h > canvas_h - 4:
                break
            draw.text((x_cursor, y_cursor), ln, fill=0, font=font)
            y_cursor += step_h

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

    header = f"^L\r\nQ{x},{y},{width_bytes},{h}\r\n".encode("ascii")
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
        f"^C1\r\n"
        f"^R0\r\n"
        f"~Q+0\r\n"
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
