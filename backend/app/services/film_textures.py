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

# Базовые цветовые профили (RGB) для гладких soft-touch пленок (калиброваны по замечаниям производства)
PALETTE = {
    # Монохром / Софт-тач / ПЭТ
    "бел": (250, 251, 252),
    "бланко": (252, 252, 253),
    "ваит": (250, 251, 252),
    "аляска": (254, 255, 255),
    "арктик": (246, 248, 250),
    "снеж": (248, 250, 252),
    "бьянко": (248, 249, 250),
    "инвизибол": (246, 246, 246),
    "магнолия": (244, 240, 230),
    "светло-сер": (214, 217, 220),
    "дымчат": (196, 200, 203),
    "сер": (160, 165, 170),
    "грей": (175, 178, 180),
    "grey": (175, 178, 180),
    "gray": (175, 178, 180),
    "кварц": (165, 168, 170),
    "манхэттен": (142, 147, 152),
    "темно-сер": (105, 110, 115),
    "тёмно-сер": (105, 110, 115),
    "графит": (72, 76, 80),
    "антрацит": (55, 58, 62),
    "бежев": (228, 220, 208),
    "крем": (236, 228, 216),
    "песок": (218, 205, 185),
    "песочн": (218, 205, 185),
    "карамель": (215, 195, 168),
    "слонов": (238, 233, 220),
    "капучино": (188, 172, 156),
    "латте": (195, 178, 160),
    "мокко": (150, 130, 115),
    "блэк": (36, 38, 40),
    "черн": (35, 36, 38),
    "чёрн": (35, 36, 38),
    "карбон": (38, 40, 42),
    "шагрень": (42, 44, 46),
    "син": (45, 68, 92),
    "сапфир": (40, 58, 80),
    "фисташк": (130, 145, 120),
    "зелен": (90, 115, 85),

    # Бетон / Камень
    "бетон светлый": (205, 208, 206),
    "бетон графит": (92, 95, 98),
    "бетон": (180, 183, 182),
    "слейтер": (118, 122, 125),
    "слей": (118, 122, 125),

    # Металл
    "алюминий": (198, 202, 206),

    # Древесные
    "роял вуд": (246, 244, 240),
    "сандал": (242, 239, 232),
    "ривьера": (186, 188, 185),
    "венге": (45, 36, 32),
    "шоколад": (65, 48, 40),
    "дуб": (185, 160, 125),
    "сонома": (195, 175, 140),
    "ясень": (222, 224, 225),
    "орех": (125, 95, 70),
    "грецкий орех": (118, 85, 58),
    "седой": (195, 192, 185),
    "экрю": (222, 215, 200),
    "нордик": (205, 195, 178),
    "секвойя": (192, 175, 158),
    "каштан": (112, 75, 52),
    "шале": (135, 138, 140),
    "палисандр": (58, 42, 38),
    "мадейра": (180, 130, 75),
}

def is_smooth_film(text: str) -> bool:
    """Определяет, относится ли декор к гладким матовым плёнкам (ПЭТ / soft-touch / монохром)."""
    lower = text.lower()
    return any(k in lower for k in [
        "пэт", "pet", "soft", "софт", "шелк", "шелковист", "мат", "гладк", "монохром",
        "аляска", "бьянко", "манхэттен", "капучино", "инвизибол", "магнолия"
    ]) and not any(w in lower for w in ["дерево", "вуд", "wood", "дуб", "ясень", "орех", "венге", "ривьера", "сандал"])


def is_wood_film(text: str) -> bool:
    """Определяет, относится ли декор к древесным фактурам."""
    lower = text.lower()
    return any(k in lower for k in [
        "дерево", "вуд", "wood", "дуб", "ясень", "орех", "венге", "сонома", "ривьера",
        "сандал", "клен", "палисандр", "секвойя", "каштан", "мадейра", "шале", "филадельфия"
    ])


def is_concrete_film(text: str) -> bool:
    """Определяет, относится ли декор к бетону/камню."""
    lower = text.lower()
    return any(k in lower for k in ["бетон", "камень", "цемент", "лофт", "слей"])


def is_metal_film(text: str) -> bool:
    """Определяет, относится ли декор к металлу/шлифовке."""
    lower = text.lower()
    return any(k in lower for k in ["алюминий", "металл", "браш", "сталь"])


def detect_base_color(text: str) -> tuple[int, int, int]:
    lower = text.lower()
    for key, rgb in sorted(PALETTE.items(), key=lambda x: -len(x[0])):
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
        factor = 1.015 - (y / height) * 0.03
        r = int(min(255, max(0, adj_r * factor)))
        g = int(min(255, max(0, adj_g * factor)))
        b = int(min(255, max(0, adj_b * factor)))
        draw.line([(0, y), (width, y)], fill=(r, g, b))
        
    pixels = img.load()
    for x in range(width):
        for y in range(height):
            delta = random.randint(-1, 1)
            r, g, b = pixels[x, y]
            pixels[x, y] = (
                min(255, max(0, r + delta)),
                min(255, max(0, g + delta)),
                min(255, max(0, b + delta))
            )
        
    img = img.filter(ImageFilter.GaussianBlur(radius=0.35))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=95)
    return buf.getvalue()


def generate_wood_grain_swatch(base_rgb: tuple[int, int, int], width: int = 400, height: int = 400) -> bytes:
    """Генерирует текстуру древесных волокон с продольными порами."""
    img = Image.new("RGB", (width, height), base_rgb)
    draw = ImageDraw.Draw(img)
    
    # Продольные волокна древесины
    for y in range(height):
        # Волнистое отклонение волокна
        band = int(30 * (1 + 0.3 * (random.random() - 0.5)))
        dark_factor = 0.88 + 0.24 * (random.random())
        r = int(min(255, max(0, base_rgb[0] * dark_factor)))
        g = int(min(255, max(0, base_rgb[1] * dark_factor)))
        b = int(min(255, max(0, base_rgb[2] * dark_factor)))
        draw.line([(0, y), (width, y)], fill=(r, g, b))
        
    img = img.filter(ImageFilter.GaussianBlur(radius=1.2))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=92)
    return buf.getvalue()


def generate_concrete_swatch(base_rgb: tuple[int, int, int], width: int = 400, height: int = 400) -> bytes:
    """Генерирует минеральную текстуру бетона или камня с тонкой зернистостью и облачностью."""
    img = Image.new("RGB", (width, height), base_rgb)
    pixels = img.load()
    for x in range(width):
        for y in range(height):
            noise_coarse = int(12 * (random.random() - 0.5))
            noise_fine = int(7 * (random.random() - 0.5))
            delta = noise_coarse + noise_fine
            r, g, b = base_rgb
            pixels[x, y] = (
                min(255, max(0, r + delta)),
                min(255, max(0, g + delta)),
                min(255, max(0, b + delta)),
            )
    img = img.filter(ImageFilter.GaussianBlur(radius=0.9))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=92)
    return buf.getvalue()


def generate_brushed_metal_swatch(base_rgb: tuple[int, int, int], width: int = 400, height: int = 400) -> bytes:
    """Генерирует текстуру шлифованного металла (brush) с тонкими параллельными линиями."""
    img = Image.new("RGB", (width, height), base_rgb)
    draw = ImageDraw.Draw(img)
    for y in range(height):
        line_intensity = 0.94 + 0.12 * random.random()
        r = int(min(255, max(0, base_rgb[0] * line_intensity)))
        g = int(min(255, max(0, base_rgb[1] * line_intensity)))
        b = int(min(255, max(0, base_rgb[2] * line_intensity)))
        draw.line([(0, y), (width, y)], fill=(r, g, b))
    img = img.filter(ImageFilter.GaussianBlur(radius=0.5))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=95)
    return buf.getvalue()


def search_texture_candidates(sku: MaterialSku, query: str | None = None, texture_type: str = "all") -> list[dict[str, Any]]:
    """Возвращает список подходящих образцов текстур (гладкие soft-touch, древесные, бетон, металл и каталожные)."""
    color_name = sku.color.name if sku.color else ""
    mfg_name = sku.manufacturer.name if sku.manufacturer else ""
    mat_name = sku.material.name if sku.material else ""
    
    combined_name = f"{mfg_name} {color_name} {mat_name}".strip()
    effective_query = (query or f"{mfg_name} {color_name}").strip()
    base_rgb = detect_base_color(color_name or effective_query)
    
    is_smooth = is_smooth_film(effective_query or combined_name)
    is_wood = is_wood_film(effective_query or combined_name)
    is_concrete = is_concrete_film(effective_query or combined_name)
    is_metal = is_metal_film(effective_query or combined_name)
    
    candidates: list[dict[str, Any]] = []
    
    # 1. Гладкие однотонные варианты (Soft-touch / ПЭТ / мат)
    if texture_type in ("all", "smooth") or (is_smooth and not is_wood and not is_concrete and not is_metal):
        b1 = generate_soft_touch_swatch(base_rgb, shade_shift=1.0)
        candidates.append({
            "id": "smooth_exact",
            "title": f"Гладкий Soft-touch (Базовый тон)",
            "subtitle": f"Чистый матовый {color_name} (без текстуры)",
            "texture_type": "smooth",
            "source_label": "Гладкий ПЭТ / Soft-touch",
            "preview_url": f"data:image/jpeg;base64,{base64.b64encode(b1).decode('utf-8')}",
            "data_base64": base64.b64encode(b1).decode('utf-8'),
        })
        
        b2 = generate_soft_touch_swatch(base_rgb, shade_shift=1.06)
        candidates.append({
            "id": "smooth_light",
            "title": f"Гладкий Soft-touch (Светлый нюанс)",
            "subtitle": "Осветленный шелковистый оттенок",
            "texture_type": "smooth",
            "source_label": "Гладкий ПЭТ / Soft-touch",
            "preview_url": f"data:image/jpeg;base64,{base64.b64encode(b2).decode('utf-8')}",
            "data_base64": base64.b64encode(b2).decode('utf-8'),
        })
        
        b3 = generate_soft_touch_swatch(base_rgb, shade_shift=0.93)
        candidates.append({
            "id": "smooth_deep",
            "title": f"Гладкий Soft-touch (Плотный тон)",
            "subtitle": "Насыщенный глубокий матовый оттенок",
            "texture_type": "smooth",
            "source_label": "Гладкий ПЭТ / Soft-touch",
            "preview_url": f"data:image/jpeg;base64,{base64.b64encode(b3).decode('utf-8')}",
            "data_base64": base64.b64encode(b3).decode('utf-8'),
        })

    # 2. Древесные текстуры для древесных декоров
    if texture_type in ("all", "wood") or is_wood:
        w1 = generate_wood_grain_swatch(base_rgb)
        candidates.append({
            "id": "wood_grain",
            "title": f"Древесная текстура ({color_name})",
            "subtitle": "Продольные поры и волокна древесины",
            "texture_type": "wood",
            "source_label": "Древесная текстура",
            "preview_url": f"data:image/jpeg;base64,{base64.b64encode(w1).decode('utf-8')}",
            "data_base64": base64.b64encode(w1).decode('utf-8'),
        })

    # 3. Бетон / камень / слейт
    if texture_type in ("all", "concrete") or is_concrete:
        c1 = generate_concrete_swatch(base_rgb)
        candidates.append({
            "id": "concrete_swatch",
            "title": f"Бетон / Камень ({color_name})",
            "subtitle": "Минеральная зернистость и облачность",
            "texture_type": "concrete",
            "source_label": "Фактура камня/бетона",
            "preview_url": f"data:image/jpeg;base64,{base64.b64encode(c1).decode('utf-8')}",
            "data_base64": base64.b64encode(c1).decode('utf-8'),
        })

    # 4. Шлифованный металл (алюминий браш)
    if texture_type in ("all", "metal") or is_metal:
        m1 = generate_brushed_metal_swatch(base_rgb)
        candidates.append({
            "id": "brushed_metal",
            "title": f"Шлифованный металл ({color_name})",
            "subtitle": "Продольная шлифовка (brush)",
            "texture_type": "metal",
            "source_label": "Фактура шлифовки",
            "preview_url": f"data:image/jpeg;base64,{base64.b64encode(m1).decode('utf-8')}",
            "data_base64": base64.b64encode(m1).decode('utf-8'),
        })

    # 3. Поиск в каталогах поставщиков
    if texture_type in ("all", "catalog"):
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
