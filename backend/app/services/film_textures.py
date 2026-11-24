import io
import re
import uuid
import base64
import random
import urllib.request
import urllib.parse
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFilter
from app.models.dictionaries import MaterialSku

# Базовые цветовые профили (RGB) для гладких soft-touch пленок
PALETTE = {
    "белый": (250, 251, 252),
    "аляска": (252, 253, 254),
    "арктик": (246, 248, 250),
    "снеж": (248, 250, 252),
    "бьянко": (248, 249, 250),
    "светло-серый": (205, 209, 212),
    "дымчат": (196, 200, 203),
    "серый": (155, 160, 165),
    "манхэттен": (136, 141, 146),
    "темно-серый": (80, 85, 90),
    "графит": (68, 72, 76),
    "антрацит": (55, 58, 62),
    "бежевый": (226, 216, 200),
    "крем": (234, 226, 212),
    "песочн": (218, 205, 185),
    "слонов": (238, 233, 220),
    "капучино": (186, 169, 152),
    "латте": (195, 178, 160),
    "мокко": (150, 130, 115),
    "венге": (45, 36, 32),
    "шоколад": (65, 48, 40),
    "дуб": (185, 160, 125),
    "сонома": (195, 175, 140),
    "ясень": (222, 224, 225),
    "орех": (125, 95, 70),
    "черн": (35, 36, 38),
    "шагрень": (42, 44, 46),
    "синий": (45, 68, 92),
    "сапфир": (40, 58, 80),
    "фисташк": (130, 145, 120),
    "зелен": (90, 115, 85),
}

def detect_base_color(text: str) -> tuple[int, int, int]:
    lower = text.lower()
    for key, rgb in PALETTE.items():
        if key in lower:
            return rgb
    return (215, 215, 215)  # Нейтральный серый по умолчанию


def generate_soft_touch_swatch(base_rgb: tuple[int, int, int], shade_shift: float = 1.0, width: int = 400, height: int = 400) -> bytes:
    """Генерирует гладкую однотонную суперматовую текстуру soft-touch с легким студийным градиентом."""
    adj_r = int(min(255, max(0, base_rgb[0] * shade_shift)))
    adj_g = int(min(255, max(0, base_rgb[1] * shade_shift)))
    adj_b = int(min(255, max(0, base_rgb[2] * shade_shift)))
    
    img = Image.new("RGB", (width, height), (adj_r, adj_g, adj_b))
    draw = ImageDraw.Draw(img)
    
    # Мягкий рассеянный градиент освещения
    for y in range(height):
        factor = 1.02 - (y / height) * 0.04
        r = int(min(255, max(0, adj_r * factor)))
        g = int(min(255, max(0, adj_g * factor)))
        b = int(min(255, max(0, adj_b * factor)))
        draw.line([(0, y), (width, y)], fill=(r, g, b))
        
    pixels = img.load()
    for x in range(width):
        for y in range(height):
            delta = random.randint(-2, 2)
            r, g, b = pixels[x, y]
            pixels[x, y] = (
                min(255, max(0, r + delta)),
                min(255, max(0, g + delta)),
                min(255, max(0, b + delta))
            )
            
    img = img.filter(ImageFilter.GaussianBlur(radius=0.4))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=95)
    return buf.getvalue()


def search_texture_candidates(sku: MaterialSku, query: str | None = None, texture_type: str = "all") -> list[dict[str, Any]]:
    """Возвращает список подходящих образцов текстур (гладкие soft-touch и каталожные)."""
    color_name = sku.color.name if sku.color else ""
    mfg_name = sku.manufacturer.name if sku.manufacturer else ""
    mat_name = sku.material.name if sku.material else ""
    
    effective_query = (query or f"{mfg_name} {color_name}").strip()
    base_rgb = detect_base_color(color_name or effective_query)
    
    candidates: list[dict[str, Any]] = []
    
    # 1. Гладкие однотонные варианты (Soft-touch / ПЭТ / мат)
    if texture_type in ("all", "smooth"):
        # Вариант 1: Точный базовый тон
        b1 = generate_soft_touch_swatch(base_rgb, shade_shift=1.0)
        candidates.append({
            "id": "smooth_exact",
            "title": f"Гладкий Soft-touch (Базовый тон)",
            "subtitle": f"Чистый однотонный матовый {color_name}",
            "texture_type": "smooth",
            "source_label": "Калиброванный Soft-touch",
            "preview_url": f"data:image/jpeg;base64,{base64.b64encode(b1).decode('utf-8')}",
            "data_base64": base64.b64encode(b1).decode('utf-8'),
        })
        
        # Вариант 2: Чуть светлее / мягче
        b2 = generate_soft_touch_swatch(base_rgb, shade_shift=1.06)
        candidates.append({
            "id": "smooth_light",
            "title": f"Гладкий Soft-touch (Светлый нюанс)",
            "subtitle": "Осветленный шелковистый оттенок",
            "texture_type": "smooth",
            "source_label": "Калиброванный Soft-touch",
            "preview_url": f"data:image/jpeg;base64,{base64.b64encode(b2).decode('utf-8')}",
            "data_base64": base64.b64encode(b2).decode('utf-8'),
        })
        
        # Вариант 3: Чуть глубже / насыщеннее
        b3 = generate_soft_touch_swatch(base_rgb, shade_shift=0.92)
        candidates.append({
            "id": "smooth_deep",
            "title": f"Гладкий Soft-touch (Глубокий нюанс)",
            "subtitle": "Более насыщенный плотный оттенок",
            "texture_type": "smooth",
            "source_label": "Калиброванный Soft-touch",
            "preview_url": f"data:image/jpeg;base64,{base64.b64encode(b3).decode('utf-8')}",
            "data_base64": base64.b64encode(b3).decode('utf-8'),
        })

    # 2. Поиск в каталогах поставщиков (Greenwood / PVCStore)
    if texture_type in ("all", "catalog", "wood"):
        catalog_imgs = _lookup_online_catalog(effective_query)
        for idx, item in enumerate(catalog_imgs):
            candidates.append({
                "id": f"catalog_{idx}",
                "title": item["title"],
                "subtitle": item.get("vendor_code", ""),
                "texture_type": "catalog",
                "source_label": item["source"],
                "preview_url": item["url"],
                "image_url": item["url"]
            })
            
    return candidates


def _lookup_online_catalog(query: str) -> list[dict[str, str]]:
    """Ищет совпадения в открытых каталогах поставщиков мебельных декоров."""
    results = []
    # Быстрый поиск в DuckDuckGo HTML для каталогов
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
    encoded = urllib.parse.quote(f"пленка пвх {query} каталог фото")
    url = f"https://html.duckduckgo.com/html/?q={encoded}"
    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=3.0) as resp:
            html = resp.read().decode('utf-8', errors='ignore')
            links = re.findall(r'<a class="result__url" href="([^"]+)"', html)
            for l in links[:3]:
                if "uddg=" in l:
                    real_url = urllib.parse.unquote(l.split("uddg=")[1].split("&")[0])
                    if any(domain in real_url for domain in ["greenwood", "pvcstore", "alliance", "8stepen"]):
                        results.append({
                            "title": f"Каталог {query}",
                            "vendor_code": real_url.split("/")[-2] if "/" in real_url else query,
                            "source": urllib.parse.urlparse(real_url).netloc,
                            "url": real_url
                        })
    except Exception:
        pass
    return results


def apply_texture_to_sku(sku: MaterialSku, upload_dir: Path, image_base64: str | None = None, image_url: str | None = None) -> str:
    """Сохраняет выбранное изображение на диск и возвращает относительный путь."""
    upload_root = upload_dir / "skus"
    upload_root.mkdir(parents=True, exist_ok=True)
    
    # Удалить старое фото, если было
    if sku.photo_path:
        (upload_dir / sku.photo_path).unlink(missing_ok=True)
        
    filename = f"{sku.id}_{uuid.uuid4().hex[:12]}.jpg"
    target_path = upload_root / filename
    
    if image_base64:
        # Убрать префикс data:image/...;base64, если есть
        if "," in image_base64:
            image_base64 = image_base64.split(",")[1]
        data = base64.b64decode(image_base64)
        target_path.write_bytes(data)
    elif image_url:
        headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
        req = urllib.request.Request(image_url, headers=headers)
        with urllib.request.urlopen(req, timeout=8.0) as resp:
            data = resp.read()
            target_path.write_bytes(data)
    else:
        raise ValueError("Не передан источник изображения (image_base64 или image_url)")
        
    rel_path = f"skus/{filename}"
    sku.photo_path = rel_path
    return rel_path
