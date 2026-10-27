// Интерактивная карта метро.
// Порядок работы: загружаем данные с сервера -> рисуем линии и станции -> ждём кликов.

// Рамка вокруг Москвы и Московской области (юго-западный и северо-восточный углы).
// maxBoundsViscosity: 1 — за рамку карту не утащить совсем, даже «с пружинкой»
const REGION = L.latLngBounds([54.2, 35.1], [57.0, 40.25]);
const map = L.map("map", { zoomControl: false, maxBounds: REGION, maxBoundsViscosity: 1 }).setView([55.75, 37.62], 11);
L.control.zoom({ position: "topright" }).addTo(map);

// Самый дальний масштаб — пока экран целиком помещается в рамку.
// На телефоне и ноутбуке экран разный, поэтому считаем заново, когда меняется размер окна
function updateMinZoom() {
  map.setMinZoom(map.getBoundsZoom(REGION, true));
}
updateMinZoom();
map.on("resize", updateMinZoom);

// Карта города OpenStreetMap (в style.css делаем её серой, чтобы линии метро были заметнее).
// Карта собрана из квадратиков-плиток, и на каждом масштабе плитки свои.
const TILES_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

// Запасная подложка: всегда плитки масштаба 10 (просто растянутые). При полёте с масштаба на масштаб
// они не меняются, поэтому всегда на месте: пока основная карта догружается, вместо серых дыр
// на мгновение видна чуть размытая карта
L.tileLayer(TILES_URL, { maxZoom: 18, maxNativeZoom: 10, keepBuffer: 4, zIndex: 0 }).addTo(map);

// Основная карта — поверх подложки. keepBuffer: 4 — держать загруженными плитки вокруг экрана
L.tileLayer(TILES_URL, {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  maxZoom: 18,
  keepBuffer: 4,
  zIndex: 1,
}).addTo(map);

let LINES = {};      // линии по id
let CARS = [];       // подсказки «в какой вагон садиться» (data/cars.json)
let GRAPH = {};      // граф для поиска маршрута: "станция|линия" -> [[соседняя платформа, минуты, линия или null], ...]
let TRANSFER_MIN = 4;
let STATIONS = {};   // станции по id
const markers = {};  // кружки станций на карте по id
let edgeLayers = []; // все отрезки линий (чтобы приглушать их при показе маршрута)
let routeLayer = null;
let selected = null; // выбранная станция
const TRANSFERS = {}; // пересадки: id станции -> список id станций, куда можно перейти

const $ = (id) => document.getElementById(id);

// ---------- Помощники ----------

function lineColor(lineId) {
  return LINES[lineId] ? LINES[lineId].color : "#888";
}

// Линии, у которых номер пишется чёрным: на жёлтом белые цифры плохо видно (как на настоящей схеме)
const DARK_NUMBER_LINES = ["8", "8A"];

// Круглый значок линии с номером, как на схеме метро
function lineBadge(lineId) {
  const number = LINES[lineId].number ?? "";
  const textColor = DARK_NUMBER_LINES.includes(number) ? "#1b1d22" : "#fff";
  return `<span class="badge__num" style="background:${lineColor(lineId)};color:${textColor}">${number}</span>`;
}

// «30 декабря 1979» — без « г.» на конце, которое браузер добавляет сам
function formatDate(iso) {
  return new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" }).replace(" г.", "");
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return `${n} ${one}`;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return `${n} ${few}`;
  return `${n} ${many}`;
}

// ---------- Рисуем карту ----------

function drawMap(data) {
  LINES = data.lines;
  CARS = data.cars;
  GRAPH = data.graph;
  TRANSFER_MIN = data.transfer_min;
  data.stations.forEach((st) => (STATIONS[st.id] = st));
  $("count").textContent = data.stations.length;

  // Отрезки между станциями: цветные — перегоны, пунктир — пересадки
  data.edges.forEach((e) => {
    const a = STATIONS[e.a], b = STATIONS[e.b];
    const style = e.line
      ? { color: lineColor(e.line), weight: 5, opacity: 0.9 }
      : { color: "#8a8d94", weight: 2, dashArray: "3 5" };
    // Классы — для цветов тёмной темы в style.css: metro-transfer — пунктир, line-17 — номер линии
    const className = "metro-edge " + (e.line ? `line-${LINES[e.line].number}` : "metro-transfer");
    const layer = L.polyline([[a.lat, a.lon], [b.lat, b.lon]], { ...style, interactive: false, className }).addTo(map);
    layer.baseOpacity = style.opacity ?? 1;
    layer.baseWeight = style.weight;   // толщина при обычном масштабе (см. updateSizes)
    edgeLayers.push(layer);

    // Переход (без линии) записываем обеим станциям: из А в Б и из Б в А
    if (!e.line) {
      (TRANSFERS[e.a] ??= []).push(e.b);
      (TRANSFERS[e.b] ??= []).push(e.a);
    }
  });

  // Станции — белые кружки с обводкой цвета линии
  data.stations.forEach((st) => {
    const marker = L.circleMarker([st.lat, st.lon], {
      radius: 5, weight: 3, color: lineColor(st.lines[0]), fillColor: "#fff", fillOpacity: 1, className: `metro-station line-${LINES[st.lines[0]].number}`,
    }).addTo(map);
    marker.bindTooltip(st.name, { className: "station-label", direction: "top", offset: [0, -6] });
    marker.on("click", () => showStation(st.id));
    markers[st.id] = marker;
  });

  updateSizes(0);
}

// ---------- Размеры станций и линий ----------

// Чем дальше карта, тем мельче станции и тоньше линии: 1 — обычный размер (масштаб 11),
// на самом дальнем масштабе (9) — вдвое меньше, вблизи — чуть крупнее
function zoomScale(zoom) {
  return Math.min(1.3, Math.max(0.5, 1 + (zoom - 11) * 0.25));
}

// Плавно подгоняем размеры всех кружков и линий под текущий масштаб (и под выбранную станцию).
// duration — за сколько миллисекунд; 0 — сразу, без анимации
let sizesFrame = null;
let zooming = false;  // карта сейчас меняет масштаб
function updateSizes(duration = 300) {
  // Пока карта меняет масштаб, кружки не трогаем: перерисованные посреди движения, они встают не на своё место.
  // Когда масштаб поменяется, updateSizes вызовется сама (zoomend ниже)
  if (zooming) return;
  const s = zoomScale(map.getZoom());

  // Для каждого слоя: какой размер сейчас (from) и каким должен стать (to)
  const changes = [];
  edgeLayers.forEach((layer) => {
    changes.push({ layer, from: { weight: layer.options.weight }, to: { weight: layer.baseWeight * s } });
  });
  Object.entries(markers).forEach(([id, m]) => {
    changes.push({
      layer: m,
      from: { radius: m.getRadius(), weight: m.options.weight },
      to: { radius: (id === selected ? 9 : 5) * s, weight: 3 * s },
    });
  });

  cancelAnimationFrame(sizesFrame);  // если прошлая анимация ещё идёт — начинаем новую с текущих размеров
  const start = performance.now();
  function frame(now) {
    const t = duration ? Math.min(1, (now - start) / duration) : 1;
    const k = 1 - (1 - t) ** 3;      // быстро в начале, плавно замедляемся к концу
    changes.forEach(({ layer, from, to }) => {
      const style = {};
      for (const key in to) style[key] = from[key] + (to[key] - from[key]) * k;
      layer.setStyle(style);
    });
    if (t < 1) sizesFrame = requestAnimationFrame(frame);
  }
  frame(start);
}

map.on("zoomstart", () => {
  zooming = true;
  cancelAnimationFrame(sizesFrame);  // останавливаем анимацию размеров на том, до чего успела дойти
});
map.on("zoomend", () => {
  zooming = false;
  updateSizes();
});

// ---------- Карточка станции ----------

function showStation(id, { fly = true } = {}) {
  const st = STATIONS[id];
  if (selected) markers[selected].setStyle({ fillColor: "#fff" });
  selected = id;
  markers[id].setStyle({ fillColor: lineColor(st.lines[0]) }).bringToFront();
  updateSizes();  // новая выбранная станция плавно увеличится, прежняя — уменьшится
  if (fly) {
    // Чем дальше лететь, тем дольше полёт (0,6–1,4 с): через полгорода — не рывком, а плавно
    const distance = map.latLngToContainerPoint([st.lat, st.lon]).distanceTo(map.getSize().divideBy(2));
    const duration = Math.min(1.4, Math.max(0.6, 0.5 + distance / 2500));
    map.flyTo([st.lat, st.lon], Math.max(map.getZoom(), 13), { duration });
  }

  // Карточка плавно проявляется (анимация card-in в style.css).
  // Убираем класс и сразу возвращаем, чтобы анимация запускалась заново на каждой станции
  const card = $("card");
  card.hidden = false;
  card.classList.remove("is-appearing");
  void card.offsetWidth;  // браузер «замечает», что класса не было
  card.classList.add("is-appearing");
  $("card-name").textContent = st.name;

  // Линии — цветные значки с номером
  $("card-lines").innerHTML = st.lines.map((l) => `
    <span class="badge">${lineBadge(l)} ${LINES[l].name}</span>`).join("");

  // Фото и подпись автора (обязательно по лицензии).
  // Пока новое фото грузится, старое прячем (класс is-loading), иначе мелькнёт фото прошлой станции
  const img = $("card-img");
  const hasPhoto = Boolean(st.photo && st.photo.url);
  img.closest(".card__photo").hidden = !hasPhoto;
  if (hasPhoto && img.getAttribute("src") !== st.photo.url) {
    img.classList.add("is-loading");
    img.src = st.photo.url;
    img.alt = `Станция «${st.name}»`;
    $("card-credit").innerHTML =
      `Фото: ${st.photo.author}, <a href="${st.photo.page}" target="_blank" rel="noopener">${st.photo.license || "Wikimedia Commons"}</a>`;
  }

  // Дата открытия, в скобках — линия, если у станции их несколько: «7 марта 1991 (СТЛ)»
  const withNote = (date, note) => formatDate(date) + (note ? ` <span class="facts__note">(${note})</span>` : "");
  // opened_later — позже открылись платформы ещё одной линии (Петровско-Разумовская, ЛДЛ): второй такой же строкой
  $("card-opened").innerHTML = withNote(st.opened, st.opened_note) +
    (st.opened_later ? `<br>${withNote(st.opened_later, st.opened_later_note)}` : "");
  // reopened — открыта после реконструкции (Каховская): мелкой серой строкой ниже
  $("card-reopened").hidden = !st.reopened;
  if (st.reopened) $("card-reopened").innerHTML = `после реконструкции — ${withNote(st.reopened, st.reopened_note)}`;
  // С двумя датами плашка «Открыта» во всю ширину (иначе текст не влезет), и «Глубина» тоже — чтобы не висела одна половинка
  const twoDates = !!(st.reopened || st.opened_later);
  $("card-opened-box").classList.toggle("facts__wide", twoDates);
  $("card-depth-box").classList.toggle("facts__wide", twoDates);
  $("card-depth").textContent = st.depth != null ? `${st.depth.toLocaleString("ru-RU")} м` : "нет данных";
  $("card-type").textContent = st.type || "нет данных";

  // Пересадки: значок линии + станция, нажатие открывает её карточку
  const transfers = (TRANSFERS[id] || []).map((t) => STATIONS[t]);
  $("card-transfers").hidden = transfers.length === 0;
  $("card-transfers-list").innerHTML = transfers.map((t) => `
    <li class="transfer" data-id="${t.id}">
      <span class="transfer__badges">${t.lines.map(lineBadge).join("")}</span>
      <span class="transfer__name">${t.name}</span>
      <span class="transfer__line">${t.lines.map((l) => LINES[l].name).join(", ")}</span>
    </li>`).join("");

  // История названий: «Кировская 1935–1990», «Чистые пруды с 1990».
  // Если годы неизвестны (Новокузнецкая — «Ново-Кузнецкая»): у старого названия «раньше», у нынешнего «сейчас»
  const names = st.old_names;
  $("card-names").hidden = names.length === 0;
  if (names.length) {
    let from = st.opened.slice(0, 4);
    const items = names.map((n) => {
      const period = n.until ? `${from}–${n.until}` : "раньше";
      from = n.until || from;
      return `<li><span>${n.name}</span><span>${period}</span></li>`;
    });
    const nowPeriod = names[names.length - 1].until ? `с ${from}` : "сейчас";
    items.push(`<li class="is-now"><span>${st.name}</span><span>${nowPeriod}</span></li>`);
    $("card-names-list").innerHTML = items.join("");
  }

  const wiki = $("card-wiki");
  wiki.hidden = !st.wiki;
  if (st.wiki) wiki.href = `https://ru.wikipedia.org/wiki/${encodeURIComponent(st.wiki)}`;

  $("panel").scrollTo({ top: $("card").offsetTop - 8, behavior: "smooth" });
}

// ---------- Маршрут ----------

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let routeRun = 0;  // номер текущего построения: новое построение отменяет анимацию старого

function clearRoute() {
  routeRun++;
  if (routeLayer) map.removeLayer(routeLayer);
  routeLayer = null;
  edgeLayers.forEach((l) => l.setStyle({ opacity: l.baseOpacity }));
  Object.values(markers).forEach((m) => m.setStyle({ opacity: 1, fillOpacity: 1 }));
}

// Самый быстрый путь от станции start до станции finish — алгоритм Дейкстры.
// Узел графа — платформа "станция|линия": на «Каширской» их две (Замоскворецкая и БКЛ).
// Стартовать можно с любой платформы start, приехать — на любую платформу finish
function findRoute(start, finish) {
  const station = (node) => node.split("|")[0];
  const best = {};      // лучшее известное время до платформы
  const cameFrom = {};  // откуда пришли на платформу (чтобы восстановить путь)
  const done = new Set();
  Object.keys(GRAPH).forEach((node) => {
    if (station(node) === start) best[node] = 0;
  });

  let end = null;
  while (true) {
    // Берём самую «близкую» ещё не проверенную платформу.
    // Платформ всего около 300 — простой перебор тут не медленнее, чем очередь с приоритетом
    let node = null;
    for (const n in best) {
      if (!done.has(n) && (node === null || best[n] < best[node])) node = n;
    }
    if (node === null) break;            // проверили всё, до финиша не добрались
    if (station(node) === finish) { end = node; break; }
    done.add(node);
    for (const [next, minutes, line] of GRAPH[node]) {
      const time = best[node] + minutes;
      if (time < (best[next] ?? Infinity)) {
        best[next] = time;
        cameFrom[next] = [node, line];
      }
    }
  }
  if (!end) return null;

  // Идём от финиша назад к старту и собираем путь
  const steps = [];
  for (let node = end; cameFrom[node]; node = cameFrom[node][0]) {
    const [prev, line] = cameFrom[node];
    steps.unshift({ from: station(prev), to: station(node), line, to_line: node.split("|")[1] });
  }

  // Пересадка в самом начале или конце не нужна: «Сокольники» — это одна станция для пассажира
  let minutes = best[end];
  while (steps.length && steps[0].line === null) { steps.shift(); minutes -= TRANSFER_MIN; }
  while (steps.length && steps[steps.length - 1].line === null) { steps.pop(); minutes -= TRANSFER_MIN; }
  return { minutes: Math.round(minutes), steps };
}

async function buildRoute(fromId, toId) {
  const box = $("route-result");
  box.hidden = false;
  clearRoute();
  const run = routeRun;

  const route = findRoute(fromId, toId);
  if (!route) {
    box.innerHTML = `<p class="error">Не получилось построить маршрут</p>`;
    return;
  }
  if (route.steps.length === 0) {
    box.innerHTML = STATIONS[fromId].name === STATIONS[toId].name
      ? `<p class="error">Это одна и та же станция</p>`
      : `<p>«${STATIONS[fromId].name}» и «${STATIONS[toId].name}» соединены переходом — дойдёте пешком за ~4 минуты</p>`;
    return;
  }
  // findRoute мог убрать пересадку в начале/конце — берём концы маршрута из него
  fromId = route.steps[0].from;
  toId = route.steps[route.steps.length - 1].to;

  // Склеиваем шаги в «отрезки»: едем по одной линии или пересаживаемся
  // start — номер первого шага отрезка: по нему поймём, когда показать строку в списке
  const legs = [];
  route.steps.forEach((s, i) => {
    const last = legs[legs.length - 1];
    if (last && last.line === s.line && s.line !== null) last.to = s.to, last.count++;
    else legs.push({ line: s.line, toLine: s.to_line, from: s.from, to: s.to, count: 1, start: i });
  });
  const transfers = legs.filter((l) => l.line === null).length;

  // Список шагов. Строки пока прозрачные (leg--pending) — появятся, когда до них дорисуется линия
  const rows = legs.map((leg, j) => {
    const st = STATIONS[leg.from];
    if (leg.line === null) {
      return `<li class="leg leg--transfer leg--pending" style="--leg-color:var(--transfer)">
        <div class="leg__station" data-id="${st.id}">${st.name}</div>
        <div class="leg__info">Пересадка на ${LINES[leg.toLine].name}, ~4 мин</div></li>`;
    }
    const car = findCar(leg, legs[j + 1], route.steps);
    return `<li class="leg leg--pending" style="--leg-color:${lineColor(leg.line)}">
      <div class="leg__station" data-id="${st.id}">${st.name}</div>
      <div class="leg__info">${LINES[leg.line].name} · ${plural(leg.count, "перегон", "перегона", "перегонов")}</div>
      ${car ? `<div class="leg__car">Удобный вагон: <b>${car.car}</b>${car.note ? ` — ${car.note}` : ""}</div>` : ""}</li>`;
  });
  const end = STATIONS[toId];
  rows.push(`<li class="leg leg--end leg--pending" style="--leg-color:${lineColor(end.lines[0])}">
    <div class="leg__station" data-id="${end.id}">${end.name}</div></li>`);

  box.innerHTML = `
    <div class="route-result__total">
      <strong>~${plural(route.minutes, "минута", "минуты", "минут")}</strong>
      <span class="muted">${transfers ? plural(transfers, "пересадка", "пересадки", "пересадок") : "без пересадок"}</span>
    </div>
    <ol class="legs">${rows.join("")}</ol>`;
  const legRows = [...box.querySelectorAll(".leg")];
  const showLeg = (i) => legRows[i] && legRows[i].classList.remove("leg--pending");

  // 1. Плавно приглушаем всю схему (плавность — transition у .metro-edge и .metro-station в style.css)
  edgeLayers.forEach((l) => l.setStyle({ opacity: 0.15 }));
  Object.values(markers).forEach((m) => m.setStyle({ opacity: 0.25, fillOpacity: 0.25 }));

  // 2. Летим к маршруту — пока ещё ничего не нарисовано
  const points = [fromId, ...route.steps.map((s) => s.to)].map((id) => [STATIONS[id].lat, STATIONS[id].lon]);
  const flown = new Promise((resolve) => map.once("moveend", resolve));
  map.flyToBounds(points, { paddingTopLeft: window.innerWidth > 700 ? [420, 40] : [30, 30], paddingBottomRight: [40, window.innerWidth > 700 ? 40 : window.innerHeight * 0.6], duration: 0.8 });
  await Promise.race([flown, wait(1500)]);  // 1500 — на всякий случай, если карта не сообщит, что долетела
  if (run !== routeRun) return;

  // 3. Рисуем линию от начала к концу. Каждый перегон — отрезок, который «растёт» от станции к станции
  const lightUp = (id) => markers[id].setStyle({ opacity: 1, fillOpacity: 1 }).bringToFront();
  routeLayer = L.layerGroup().addTo(map);
  const parts = route.steps.map((s) => {
    const a = L.latLng(STATIONS[s.from].lat, STATIONS[s.from].lon);
    const b = L.latLng(STATIONS[s.to].lat, STATIONS[s.to].lon);
    const style = s.line
      ? { color: lineColor(s.line), weight: 8, interactive: false, className: `line-${LINES[s.line].number}` }
      : { color: "#55585f", weight: 3, dashArray: "4 6", interactive: false, className: "route-transfer" };
    // Длина на экране (в пикселях): по ней делим время — длинный перегон рисуется дольше короткого
    const len = Math.max(12, map.latLngToLayerPoint(a).distanceTo(map.latLngToLayerPoint(b)));
    return { a, b, len, line: L.polyline([a, a], style).addTo(routeLayer), drawn: -1 };
  });
  lightUp(fromId);
  showLeg(0);

  const total = parts.reduce((sum, p) => sum + p.len, 0);
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const duration = reduceMotion ? 0 : Math.min(2500, Math.max(800, total * 2));  // от 0,8 до 2,5 секунды

  await new Promise((resolve) => {
    const start = performance.now();
    function frame(now) {
      if (run !== routeRun) return resolve();  // начали строить другой маршрут
      const t = duration ? Math.min(1, (now - start) / duration) : 1;
      const k = t < 0.5 ? 2 * t * t : 1 - (2 - 2 * t) ** 2 / 2;  // плавный разгон и плавное торможение
      let left = k * total;  // сколько пикселей линии уже должно быть нарисовано
      parts.forEach((p, i) => {
        // Какая доля этого перегона готова (0…1). В последнем кадре — точно 1: дробные числа считаются
        // с крошечной погрешностью, и без этого последний перегон мог остаться «готов на 0,99999»
        const f = t === 1 ? 1 : Math.max(0, Math.min(1, left / p.len));
        left -= p.len;
        // Пока карта меняет масштаб, линию не трогаем (иначе она встанет не на место) — дорисуем после
        if (f !== p.drawn && !zooming) {
          p.drawn = f;
          p.line.setLatLngs([p.a, L.latLng(p.a.lat + (p.b.lat - p.a.lat) * f, p.a.lng + (p.b.lng - p.a.lng) * f)]);
        }
        if (f === 1 && !p.done) {  // линия дошла до станции: зажигаем её и показываем строку списка
          p.done = true;
          lightUp(route.steps[i].to);
          legs.forEach((leg, j) => leg.start === i + 1 && showLeg(j));
          if (i === parts.length - 1) showLeg(legRows.length - 1);
        }
      });
      if (t < 1) requestAnimationFrame(frame);
      else resolve();
    }
    requestAnimationFrame(frame);
  });
}

// Подсказка про вагон для отрезка маршрута (из data/cars.json).
// Удобный вагон зависит от направления, поэтому сверяем: линию, предпоследнюю станцию отрезка (from),
// станцию, где выходим (to), и куда дальше — на какую линию пересадка или «выход» (если указано в подсказке)
function findCar(leg, nextLeg, steps) {
  const lastStep = steps[leg.start + leg.count - 1];
  const next = nextLeg ? LINES[nextLeg.toLine].number : "выход";
  return CARS.find((h) =>
    h.line === LINES[leg.line].number
    && norm(h.from) === norm(STATIONS[lastStep.from].name)
    && norm(h.to) === norm(STATIONS[leg.to].name)
    && (!h.transfer_to || h.transfer_to === next));
}

// ---------- Подсказки в полях «Откуда/Куда» ----------

// Для поиска: маленькие буквы и «ё» = «е» (чтобы «Филевский» нашёл «Филёвский»)
const norm = (text) => text.toLowerCase().replaceAll("ё", "е");

// Станции, в названии которых есть запрос (или в старом названии — «Выставочная» найдёт «Деловой центр»).
// Порядок: сначала название начинается с запроса, потом просто содержит его, потом совпало старое название
function findStations(query) {
  const q = norm(query.trim());
  if (!q) return [];
  const found = [];
  Object.values(STATIONS).forEach((st) => {
    const name = norm(st.name);
    if (name.startsWith(q)) found.push({ st, score: 0 });
    else if (name.includes(q)) found.push({ st, score: 1 });
    else {
      const old = st.old_names.find((n) => norm(n.name).includes(q));
      if (old) found.push({ st, score: 2, oldName: old.name });
    }
  });
  return found
    .sort((a, b) => a.score - b.score || a.st.name.localeCompare(b.st.name, "ru"))
    .slice(0, 8)
    .map((f) => ({ ...f.st, oldName: f.oldName }));
}

// Выделяем жирным совпавшую часть названия: «Арбат» -> <b>Арбат</b>ская
function highlight(name, query) {
  const i = norm(name).indexOf(norm(query.trim()));
  if (i < 0) return name;
  const end = i + query.trim().length;
  return `${name.slice(0, i)}<b>${name.slice(i, end)}</b>${name.slice(end)}`;
}

// Записать станцию в поле: название в поле, значок линии слева, id — «в кармане» у поля
function fillField(input, id, text = "") {
  const badge = input.parentElement.querySelector(".field__badge");
  if (id) {
    input.value = STATIONS[id].name;
    input.dataset.id = id;
    badge.innerHTML = lineBadge(STATIONS[id].lines[0]);
  } else {
    input.value = text;
    delete input.dataset.id;
    badge.innerHTML = "";
  }
}

function setupSuggest(input) {
  const list = input.parentElement.querySelector(".suggest");
  let items = [];   // найденные станции
  let active = 0;   // какая строка подсвечена (для стрелок на клавиатуре)

  // Какие станции уже видны в списке: плавно появляются только новые, а не весь список на каждую букву
  let shown = new Set();

  function render() {
    const opening = list.hidden && items.length > 0;  // список только что открылся
    list.hidden = items.length === 0;
    // style="--i:номер" — для «лесенки»: каждая следующая строка появляется чуть позже (см. style.css)
    list.innerHTML = items.map((st, i) => `
      <li class="suggest__item${i === active ? " is-active" : ""}${shown.has(st.id) ? "" : " is-new"}" data-i="${i}" style="--i:${i}">
        <span class="suggest__badges">${st.lines.map(lineBadge).join("")}</span>
        <span class="suggest__name">${highlight(st.name, input.value)}</span>
        <span class="suggest__line">${st.oldName ? `раньше «${highlight(st.oldName, input.value)}» · ` : ""}${LINES[st.lines[0]].name}</span>
      </li>`).join("");
    shown = new Set(items.map((st) => st.id));

    // Сам список (белая подложка с тенью) плавно проявляется при открытии — как карточка станции
    if (opening) {
      list.classList.remove("is-opening");
      void list.offsetWidth;
      list.classList.add("is-opening");
    }
  }

  function choose(i) {
    fillField(input, items[i].id);
    items = [];
    render();
  }

  // Печатаем — ищем заново
  input.addEventListener("input", () => {
    fillField(input, null, input.value);
    items = findStations(input.value);
    active = 0;
    render();
  });

  // Стрелки ↑↓ — выбор строки, Enter — взять её, Esc — закрыть список
  input.addEventListener("keydown", (e) => {
    if (list.hidden) return;
    if (e.key === "ArrowDown") active = (active + 1) % items.length;
    else if (e.key === "ArrowUp") active = (active - 1 + items.length) % items.length;
    else if (e.key === "Enter") { e.preventDefault(); choose(active); return; }
    else if (e.key === "Escape") items = [];
    else return;
    e.preventDefault();
    render();
  });

  // mousedown, а не click: иначе поле успеет потерять фокус и список закроется раньше
  list.addEventListener("mousedown", (e) => {
    const li = e.target.closest(".suggest__item");
    if (!li) return;
    e.preventDefault();
    choose(+li.dataset.i);
  });

  input.addEventListener("blur", () => { items = []; render(); });
}

setupSuggest($("from"));
setupSuggest($("to"));

// Какая станция в поле? Если из списка не выбрали — ищем точное совпадение названия
function fieldStation(input) {
  if (input.dataset.id) return input.dataset.id;
  const exact = findStations(input.value).filter((st) => norm(st.name) === norm(input.value.trim()));
  return exact.length ? exact[0].id : null;
}

// ---------- Кнопки ----------

$("route-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const fromId = fieldStation($("from")), toId = fieldStation($("to"));
  if (!fromId || !toId) {
    $("route-result").hidden = false;
    $("route-result").innerHTML = `<p class="error">Выберите станции из списка</p>`;
    return;
  }
  buildRoute(fromId, toId);
});

$("swap").addEventListener("click", () => {
  const from = [$("from").dataset.id, $("from").value];
  fillField($("from"), $("to").dataset.id, $("to").value);
  fillField($("to"), ...from);
});

$("set-from").addEventListener("click", () => fillField($("from"), selected));
$("set-to").addEventListener("click", () => {
  fillField($("to"), selected);
  if ($("from").dataset.id) $("route-form").requestSubmit();
});

// Фото загрузилось — показываем (плавно, см. .card__photo img в style.css)
$("card-img").addEventListener("load", (e) => e.target.classList.remove("is-loading"));

// Клик по пересадке в карточке — открыть карточку той станции
$("card-transfers-list").addEventListener("click", (e) => {
  const li = e.target.closest(".transfer");
  if (li) showStation(li.dataset.id);
});

// Клик по станции в списке маршрута — открыть её карточку
$("route-result").addEventListener("click", (e) => {
  const el = e.target.closest(".leg__station");
  if (el) showStation(el.dataset.id, { fly: false });
});

// ---------- Старт ----------

// Путь без «/» в начале — чтобы работало и на localhost, и на GitHub Pages (там сайт лежит в папке /metro/)
fetch("data/site.json").then((r) => r.json()).then(drawMap);

// ---------- Светлая и тёмная тема ----------

// Какая тема сейчас: выбранная кнопкой (data-theme у <html>) или как на компьютере
function currentTheme() {
  return document.documentElement.dataset.theme
    || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
}

// На кнопке — значок темы, на которую переключимся: data-next="light" -> солнце, "dark" -> луна (см. style.css)
function updateThemeButton() {
  const dark = currentTheme() === "dark";
  $("theme").dataset.next = dark ? "light" : "dark";
  $("theme").title = dark ? "Светлая тема" : "Тёмная тема";
  $("theme").setAttribute("aria-label", $("theme").title);
}

$("theme").addEventListener("click", () => {
  const next = currentTheme() === "dark" ? "light" : "dark";
  function apply() {
    document.documentElement.dataset.theme = next;
    // Запоминаем выбор (в браузере, только для этого компьютера). try — в приватном окне может не получиться
    try { localStorage.setItem("theme", next); } catch (e) {}
    updateThemeButton();
  }

  // Старый браузер или в системе включено «уменьшить движение» — просто переключаем, без анимации
  if (!document.startViewTransition || matchMedia("(prefers-reduced-motion: reduce)").matches) {
    apply();
    return;
  }

  // Как в Telegram: новая тема расходится кругом от кнопки.
  // Браузер делает снимок страницы в старой теме, применяет новую (apply), а мы показываем новую
  // сквозь круг, который растёт от центра кнопки, пока не закроет весь экран
  const btn = $("theme").getBoundingClientRect();
  const x = btn.left + btn.width / 2, y = btn.top + btn.height / 2;
  const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));  // до самого дальнего угла
  const transition = document.startViewTransition(apply);
  transition.ready.then(() => {
    document.documentElement.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
      { duration: 600, easing: "cubic-bezier(.4, 0, .2, 1)", pseudoElement: "::view-transition-new(root)" },
    );
  });
});

// Если тема компьютера поменялась (например, вечером Мак сам переключился на тёмную) — обновляем значок
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", updateThemeButton);
updateThemeButton();
