"""Собирает данные о станциях московского метро в файл data/stations.json.

Источники:
  1. Викиданные (wikidata.org) — список станций, линии, координаты, дата открытия,
     глубина, фото, соседние станции и пересадки.
  2. Русская Википедия — тип конструкции, старые названия, глубина (если в Викиданных нет).
  3. Wikimedia Commons — автор и лицензия каждой фотографии.

Запуск (из папки проекта):  python3 tools/fetch_data.py
"""

import json
import re
import time
from pathlib import Path

import requests

HEADERS = {"User-Agent": "metro-study/0.1 (https://github.com/toctep-official; learning project)"}
SPARQL_URL = "https://query.wikidata.org/sparql"
WIKI_API = "https://ru.wikipedia.org/w/api.php"
COMMONS_API = "https://commons.wikimedia.org/w/api.php"
OUT_FILE = Path(__file__).resolve().parent.parent / "data" / "stations.json"
MANUAL_FILE = OUT_FILE.parent / "manual.json"  # ручные правки — важнее данных из интернета

# Действующие станции Московского метрополитена:
# сеть (P16) = Московский метрополитен, статус (P5817) = используется.
# P31/P279* — «станция метро» или любая её разновидность («колонная станция мелкого заложения» и т.п.)
STATIONS_FILTER = """
  ?s wdt:P16 wd:Q5499;
     wdt:P31/wdt:P279* wd:Q928830;
     wdt:P5817 wd:Q55654238;
     wdt:P1619 ?open.
"""


def sparql(query):
    """Отправляет запрос к Викиданным и возвращает список строк-словарей."""
    r = requests.get(SPARQL_URL, params={"query": query, "format": "json"},
                     headers=HEADERS, timeout=60)
    r.raise_for_status()
    rows = []
    for b in r.json()["results"]["bindings"]:
        rows.append({k: v["value"] for k, v in b.items()})
    return rows


def post(url, data):
    """POST-запрос к API Википедии. Если сервер просит подождать (429) — ждём и пробуем снова."""
    for attempt in range(5):
        r = requests.post(url, headers=HEADERS, timeout=60, data=data)
        if r.status_code != 429:
            r.raise_for_status()
            return r.json()
        wait = int(r.headers.get("Retry-After", 10))
        print(f"    сервер просит подождать {wait} с...")
        time.sleep(wait)
    r.raise_for_status()


def qid(url):
    """http://www.wikidata.org/entity/Q123 -> Q123"""
    return url.rsplit("/", 1)[-1]


# ---------- 1. Викиданные ----------

def fetch_wikidata():
    stations = {}
    rows = sparql(f"""
    SELECT ?s ?name ?line ?coord ?open ?depth ?image ?article WHERE {{
      {STATIONS_FILTER}
      ?s rdfs:label ?name. FILTER(LANG(?name) = "ru")
      OPTIONAL {{ ?s wdt:P81 ?line }}
      OPTIONAL {{ ?s wdt:P625 ?coord }}
      OPTIONAL {{ ?s wdt:P4511 ?depth }}
      OPTIONAL {{ ?s wdt:P18 ?image }}
      OPTIONAL {{ ?article schema:about ?s; schema:isPartOf <https://ru.wikipedia.org/> }}
    }}""")
    for row in rows:
        sid = qid(row["s"])
        st = stations.setdefault(sid, {
            "id": sid,
            "name": re.sub(r"\s*\(.*\)$", "", row["name"]),  # «Арбатская (станция метро)» -> «Арбатская»
            "lines": [],
            "opened": row["open"][:10],
            "depth": None,
            "type": None,
            "old_names": [],
            "photo": None,
            "neighbors": [],
            "transfers": [],
            "wiki": None,
        })
        if row.get("line") and qid(row["line"]) not in st["lines"]:
            st["lines"].append(qid(row["line"]))
        if row.get("coord"):
            # Формат: Point(37.61 55.75) — сначала долгота, потом широта
            lon, lat = row["coord"][6:-1].split()
            st["lat"], st["lon"] = float(lat), float(lon)
        if row.get("depth"):
            st["depth"] = float(row["depth"])
        if row.get("image") and not st["photo"]:
            st["photo"] = {"file": requests.utils.unquote(row["image"].rsplit("/", 1)[-1])}
        if row.get("article"):
            st["wiki"] = requests.utils.unquote(row["article"].rsplit("/", 1)[-1]).replace("_", " ")

    # Соседние станции (P197) — из них получится граф для маршрутов
    for row in sparql(f"""
    SELECT ?s ?n ?line WHERE {{
      {STATIONS_FILTER}
      ?s p:P197 ?st. ?st ps:P197 ?n.
      OPTIONAL {{ ?st pq:P81 ?line }}
    }}"""):
        a, b = qid(row["s"]), qid(row["n"])
        if b in stations:
            stations[a]["neighbors"].append({"id": b, "line": qid(row["line"]) if row.get("line") else None})

    # Записи без соседей — не станции метро на линии (например, «Окружная» МЦК) — убираем
    for sid in [sid for sid, st in stations.items() if not st["neighbors"]]:
        del stations[sid]

    # Пересадки (P833)
    for row in sparql(f"""
    SELECT ?s ?t WHERE {{ {STATIONS_FILTER} ?s wdt:P833 ?t. }}"""):
        a, b = qid(row["s"]), qid(row["t"])
        if a in stations and b in stations and b not in stations[a]["transfers"]:
            stations[a]["transfers"].append(b)

    # Линии: название, номер, цвет
    lines = {}
    line_ids = " ".join(f"wd:{l}" for st in stations.values() for l in st["lines"])
    for row in sparql(f"""
    SELECT ?l ?name ?num ?color WHERE {{
      VALUES ?l {{ {line_ids} }}
      ?l rdfs:label ?name. FILTER(LANG(?name) = "ru")
      OPTIONAL {{ ?l wdt:P1671 ?num }}
      OPTIONAL {{ ?l wdt:P465 ?color }}
    }}"""):
        lines[qid(row["l"])] = {
            "id": qid(row["l"]),
            "name": row["name"],
            "number": row.get("num"),
            "color": "#" + row["color"] if row.get("color") else "#888888",
        }
    return stations, lines


# ---------- 2. Википедия ----------

def clean_wiki(text):
    """Убирает вики-разметку: ссылки, сноски, шаблоны."""
    text = re.sub(r"<ref[^>]*/>", "", text)
    text = re.sub(r"<ref.*?</ref>", "", text, flags=re.S)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\[\[(?:[^|\]]*\|)?([^\]]*)\]\]", r"\1", text)  # [[ссылка|текст]] -> текст
    for _ in range(3):
        text = re.sub(r"\{\{[^{}]*\}\}", "", text)                   # {{шаблон}} -> ничего
    return re.sub(r"\s+", " ", text).strip(" ,;")


def infobox_field(wikitext, name):
    """Достаёт значение поля «| Имя = ...» из карточки статьи."""
    m = re.search(r"^\|\s*" + name + r"\s*=(.*?)(?=^\||^\}\})", wikitext, flags=re.M | re.S)
    return m.group(1).strip() if m else ""


def parse_old_names(raw):
    """{{НП-ПН|1955|«Охотный Ряд»|1957|«Имени Кагановича»}} ->
    [{"name": "Охотный Ряд", "until": "1955"}, {"name": "Имени Кагановича", "until": "1957"}]"""
    m = re.search(r"\{\{НП-ПН\|(.*?)\}\}", raw, flags=re.S)
    if m:
        parts = [clean_wiki(p).strip("«»\" ") for p in m.group(1).split("|")]
        return [{"name": parts[i + 1], "until": parts[i]}
                for i in range(0, len(parts) - 1, 2) if parts[i + 1]]
    text = clean_wiki(raw)
    return [{"name": text, "until": None}] if text else []


def fetch_wikipedia(stations):
    by_title = {st["wiki"]: st for st in stations.values() if st["wiki"]}
    titles = list(by_title)
    for i in range(0, len(titles), 50):  # API отдаёт не больше 50 статей за раз
        data = post(WIKI_API, {
            "action": "query", "prop": "revisions", "rvprop": "content", "rvslots": "main",
            "format": "json", "formatversion": 2, "titles": "|".join(titles[i:i + 50]),
        })
        for page in data["query"]["pages"]:
            st = by_title.get(page["title"])
            if not st or "revisions" not in page:
                continue
            text = page["revisions"][0]["slots"]["main"]["content"]
            kind = clean_wiki(infobox_field(text, "Тип конструкции"))
            st["type"] = kind[:1].upper() + kind[1:] if kind else None  # «колонная…» -> «Колонная…»
            st["old_names"] = parse_old_names(infobox_field(text, "Старые названия"))
            if st["depth"] is None:
                m = re.match(r"\s*(\d+(?:[.,]\d+)?)", clean_wiki(infobox_field(text, "Глубина заложения")))
                if m:
                    st["depth"] = float(m.group(1).replace(",", "."))
        time.sleep(1)  # не нагружаем Википедию


# ---------- 3. Wikimedia Commons ----------

def fetch_photo_credits(stations):
    by_file = {st["photo"]["file"]: st for st in stations.values() if st["photo"]}
    files = list(by_file)
    for i in range(0, len(files), 20):
        data = post(COMMONS_API, {
            "action": "query", "prop": "imageinfo", "iiprop": "url|extmetadata",
            "iiurlwidth": 800, "format": "json", "formatversion": 2,
            "titles": "|".join("File:" + f for f in files[i:i + 20]),
        })
        data = data["query"]
        # API может переименовать заголовок (пробелы, регистр) — учитываем это
        renamed = {n["to"]: n["from"] for n in data.get("normalized", [])}
        for page in data["pages"]:
            title = renamed.get(page["title"], page["title"])
            st = by_file.get(title.removeprefix("File:"))
            if not st or "imageinfo" not in page:
                continue
            info = page["imageinfo"][0]
            meta = info.get("extmetadata", {})
            st["photo"].update({
                "url": info.get("thumburl") or info["url"],
                "page": info["descriptionurl"],
                "author": clean_wiki(meta.get("Artist", {}).get("value", "")) or "неизвестен",
                "license": meta.get("LicenseShortName", {}).get("value", ""),
            })
        time.sleep(3)


def apply_manual(stations):
    """Применяет ручные правки из data/manual.json.
    Ключ — id станции в Викиданных, "name" — только для удобства чтения.
    "photo" — имя файла на Wikimedia Commons; остальные поля (depth, type...) заменяются как есть."""
    if not MANUAL_FILE.exists():
        return
    for sid, fixes in json.loads(MANUAL_FILE.read_text(encoding="utf-8")).items():
        st = stations.get(sid)
        if not st:
            print(f"    в manual.json неизвестная станция {sid} ({fixes.get('name')})")
            continue
        for key, value in fixes.items():
            if key == "photo":
                st["photo"] = {"file": value}
            elif key != "name":
                st[key] = value


def main():
    print("1/3 Викиданные...")
    stations, lines = fetch_wikidata()
    print(f"    станций: {len(stations)}, линий: {len(lines)}")
    print("2/3 Википедия...")
    fetch_wikipedia(stations)
    apply_manual(stations)
    print("3/3 Фото с Wikimedia Commons...")
    fetch_photo_credits(stations)

    OUT_FILE.parent.mkdir(exist_ok=True)
    OUT_FILE.write_text(json.dumps(
        {"lines": lines, "stations": sorted(stations.values(), key=lambda s: s["name"])},
        ensure_ascii=False, indent=1), encoding="utf-8")

    # Короткий отчёт: чего не хватает
    sts = stations.values()
    print(f"Готово: {OUT_FILE}")
    print(f"  без глубины: {sum(s['depth'] is None for s in sts)}")
    print(f"  без типа:    {sum(s['type'] is None for s in sts)}")
    print(f"  без фото:    {sum(not (s['photo'] and s['photo'].get('url')) for s in sts)}")
    print(f"  без соседей: {sum(not s['neighbors'] for s in sts)}")


if __name__ == "__main__":
    main()
