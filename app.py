"""Интерактивная карта метро Москвы.

Сайт статический — работает на GitHub Pages: маршрут ищет сам браузер (static/map.js).
Этот скрипт готовит для него данные: из data/stations.json и data/cars.json собирает
граф метро в data/site.json, а потом запускает сайт на этом компьютере.

Запуск:  venv/bin/python app.py   ->   http://localhost:8000
После правок в data/ запустите заново и закоммитьте data/site.json — его и читает сайт.
"""

import json
import math
from pathlib import Path

from flask import Flask, send_from_directory

ROOT = Path(__file__).parent
DATA = json.loads((ROOT / "data" / "stations.json").read_text(encoding="utf-8"))
LINES = DATA["lines"]
STATIONS = {st["id"]: st for st in DATA["stations"]}

# Подсказки «в какой вагон садиться» — заполняются вручную, станции по названиям:
# {"line": "1", "from": "Чистые пруды", "to": "Лубянка", "transfer_to": "7", "car": "первый", "note": "..."}
CARS = json.loads((ROOT / "data" / "cars.json").read_text(encoding="utf-8"))
def _norm(name):
    """Как norm() в map.js: регистр и «ё»/«е» не важны («Кузнецкий Мост» = «Кузнецкий мост»)"""
    return str(name).lower().replace("ё", "е")


_names = {_norm(st["name"]) for st in STATIONS.values()}
_numbers = {line["number"] for line in LINES.values()}
for i, hint in enumerate(CARS, 1):
    # Проверяем при запуске: опечатку в названии станции или номере линии лучше увидеть сразу
    for key in ("from", "to"):
        if _norm(hint.get(key)) not in _names:
            print(f"cars.json, подсказка {i}: нет станции «{hint.get(key)}» ({key})")
    for key in ("line", "transfer_to"):
        if key in hint and hint[key] not in _numbers and not (key == "transfer_to" and hint[key] == "выход"):
            print(f"cars.json, подсказка {i}: нет линии «{hint[key]}» ({key})")

TRAIN_SPEED_KMH = 40   # средняя скорость поезда
STOP_MIN = 0.5         # стоянка на станции, минут
TRANSFER_MIN = 4       # пересадка, минут


def distance_km(a, b):
    """Расстояние между двумя станциями по прямой (формула гаверсинусов)."""
    lat1, lon1, lat2, lon2 = map(math.radians, (a["lat"], a["lon"], b["lat"], b["lon"]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(h))


def common_line(a, b):
    """Линия, по которой едут от станции a к соседней b."""
    for n in a["neighbors"]:
        if n["id"] == b["id"] and n["line"] in b["lines"]:
            return n["line"]
    shared = [l for l in a["lines"] if l in b["lines"]]
    return shared[0] if shared else a["lines"][0]


def build_graph():
    """Граф метро. Узел — платформа: пара (станция, линия).
    Например, «Каширская» — это две платформы: Замоскворецкой линии и БКЛ.
    Для каждой платформы храним список (соседняя платформа, минуты, линия или None для пересадки)."""
    graph = {}
    edges = []  # перегоны и переходы между станциями — для рисования на карте

    def add(a, b, minutes, line):
        graph.setdefault(a, [])
        graph.setdefault(b, [])
        if all(x != b for x, _, _ in graph[a]):
            graph[a].append((b, minutes, line))
            graph[b].append((a, minutes, line))

    # Перегоны: едем по линии от платформы к платформе
    for st in STATIONS.values():
        for n in st["neighbors"]:
            other = STATIONS[n["id"]]
            line = common_line(st, other)
            minutes = distance_km(st, other) / TRAIN_SPEED_KMH * 60 + STOP_MIN
            add((st["id"], line), (other["id"], line), minutes, line)
            if st["id"] < other["id"]:
                edges.append({"a": st["id"], "b": other["id"], "line": line})

    def platforms(sid):
        return [node for node in graph if node[0] == sid]

    # Оставляем станции только те линии, по которым к ней правда идут поезда
    for st in STATIONS.values():
        st["lines"] = [l for l in st["lines"] if (st["id"], l) in graph] or st["lines"]

    # Пересадки внутри одной станции (Каширская: Замоскворецкая <-> БКЛ)
    for st in STATIONS.values():
        own = platforms(st["id"])
        for i, a in enumerate(own):
            for b in own[i + 1:]:
                add(a, b, TRANSFER_MIN, None)

    # Пересадки между разными станциями (Тверская <-> Пушкинская).
    # В данных переход бывает записан только у одной из двух станций (Каховская -> Севастопольская),
    # поэтому запоминаем уже добавленные пары, а не полагаемся на порядок id
    seen = set()
    for st in STATIONS.values():
        for t in st["transfers"]:
            for a in platforms(st["id"]):
                for b in platforms(t):
                    add(a, b, TRANSFER_MIN, None)
            pair = frozenset((st["id"], t))
            if pair not in seen:
                seen.add(pair)
                edges.append({"a": st["id"], "b": t, "line": None})
    return graph, edges


def build_site():
    """Собирает data/site.json — всё, что нужно сайту: линии, станции, отрезки для рисования,
    подсказки про вагоны и граф для поиска маршрута.
    Узел графа в JSON — строка "станция|линия" (в JSON ключом может быть только строка)."""
    graph, edges = build_graph()
    site = {
        "lines": LINES,
        "stations": DATA["stations"],
        "edges": edges,
        "cars": CARS,
        "transfer_min": TRANSFER_MIN,
        "graph": {
            f"{sid}|{line}": [[f"{n[0]}|{n[1]}", minutes, via] for n, minutes, via in links]
            for (sid, line), links in graph.items()
        },
    }
    out = ROOT / "data" / "site.json"
    out.write_text(json.dumps(site, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Собран {out.relative_to(ROOT)}: {len(site['stations'])} станций, {len(site['graph'])} платформ")


# Локальный сервер: просто отдаёт файлы проекта, как GitHub Pages
app = Flask(__name__, static_folder=None)


@app.route("/")
def index():
    return send_from_directory(ROOT, "index.html")


@app.route("/<path:path>")
def files(path):
    return send_from_directory(ROOT, path)


if __name__ == "__main__":
    build_site()
    app.run(port=8000, debug=True)
