
    const DATA_URL = "gdebenz_unified_status_realcount_districts.json";
    const KRASNOGORSK = [55.8311, 37.3302];
    const state = { rows: [], filtered: [], map: null, cluster: null };
    const fields = ["search", "statusFilter", "fuelFilter", "brandFilter", "districtFilter"];

    function statusClass(code) {
      return ({ yes: "yes", no: "no", queue: "queue", low: "low" }[code] || "unknown");
    }

    function statusText(row) {
      return row.status || ({ yes: "есть бензин", no: "нет бензина", queue: "есть бензин но очередь", low: "мало бензина" }[row.status_code] || "нет данных");
    }

    function fuels(row) {
      return ["92", "95", "98", "100", "ДТ"].filter(f => String(row[f] || "").trim()).join(", ") || row.fuels_now || "";
    }

    function normalizeRows(data) {
      const rows = Array.isArray(data) ? data : (data.rows || data.stations || []);
      return rows.map(row => ({ ...row, brand: row.station_name || row.brand || "" }));
    }

    function parseCsv(text) {
      const rows = [];
      let row = [], cell = "", quoted = false;
      for (let i = 0; i < text.length; i++) {
        const ch = text[i], next = text[i + 1];
        if (ch === '"' && quoted && next === '"') { cell += '"'; i++; continue; }
        if (ch === '"') { quoted = !quoted; continue; }
        if (ch === "," && !quoted) { row.push(cell); cell = ""; continue; }
        if ((ch === "\n" || ch === "\r") && !quoted) {
          if (ch === "\r" && next === "\n") i++;
          row.push(cell); rows.push(row); row = []; cell = ""; continue;
        }
        cell += ch;
      }
      if (cell || row.length) { row.push(cell); rows.push(row); }
      const header = rows.shift().map(h => h.replace(/^\uFEFF/, ""));
      return rows.filter(r => r.length > 1).map(r => Object.fromEntries(header.map((h, i) => [h, r[i] || ""])));
    }

    function setData(rows, source) {
      state.rows = normalizeRows(rows).filter(row => row.region === "Московская область" && row.lat && row.lon);
      document.getElementById("source").textContent = `Источник: ${source}`;
      const exported = state.rows.find(r => r.exported_at)?.exported_at || "";
      const latest = state.rows.map(r => r.last_at).filter(Boolean).sort().pop() || "";
      document.getElementById("updated").textContent = `Обновлено: ${exported || latest || "нет данных"}`;
      document.getElementById("notice").style.display = state.rows.length ? "none" : "block";
      fillFilters();
      render();
    }

    function fillSelect(id, values) {
      const select = document.getElementById(id);
      const current = select.value;
      const first = select.options[0].textContent;
      select.innerHTML = `<option value="">${first}</option>` + values.map(v => `<option>${v}</option>`).join("");
      select.value = values.includes(current) ? current : "";
    }

    function fillFilters() {
      fillSelect("statusFilter", [...new Set(state.rows.map(statusText))].filter(Boolean).sort());
      fillSelect("brandFilter", [...new Set(state.rows.map(r => r.brand))].filter(Boolean).sort((a,b) => a.localeCompare(b, "ru")));
      fillSelect("districtFilter", [...new Set(state.rows.map(r => r.district))].filter(Boolean).sort((a,b) => a.localeCompare(b, "ru")));
    }

    function applyFilters() {
      const q = document.getElementById("search").value.trim().toLowerCase();
      const status = document.getElementById("statusFilter").value;
      const fuel = document.getElementById("fuelFilter").value;
      const brand = document.getElementById("brandFilter").value;
      const district = document.getElementById("districtFilter").value;
      state.filtered = state.rows.filter(row => {
        if (q && !`${row.station_name} ${row.brand}`.toLowerCase().includes(q)) return false;
        if (status && statusText(row) !== status) return false;
        if (fuel && !String(row[fuel] || "").trim()) return false;
        if (brand && row.brand !== brand) return false;
        if (district && row.district !== district) return false;
        return true;
      });
    }

    function renderCards() {
      const total = state.filtered.length;
      const by = key => state.filtered.filter(r => r.status_code === key).length;
      const real = state.filtered.reduce((sum, r) => sum + Number(r.realCount || 0), 0);
      const confirmations = state.filtered.reduce((sum, r) => sum + Number(r.confirmations || 0), 0);
      const items = [
        ["Всего АЗС", total], ["Есть бензин", by("yes")], ["Очередь", by("queue")],
        ["Мало бензина", by("low")], ["Нет бензина", by("no")], ["Отметок за 24 часа", real], ["Подтверждений", confirmations]
      ];
      document.getElementById("cards").innerHTML = items.map(([label, value]) => `<div class="card"><div class="metric">${value}</div><div class="label">${label}</div></div>`).join("");
    }

    function renderTable() {
      document.getElementById("tableBody").innerHTML = state.filtered.slice(0, 1200).map(row => `
        <tr><td><b>${row.station_name || ""}</b><div class="muted">${row.brand || ""}</div></td><td>${row.district || ""}</td>
        <td><span class="pill ${statusClass(row.status_code)}">${statusText(row)}</span></td><td>${fuels(row)}</td>
        <td>${row.confirmations || 0}</td><td>${row.realCount || 0}</td><td>${Number(row.lat).toFixed(5)}, ${Number(row.lon).toFixed(5)}</td></tr>
      `).join("");
    }

    function renderDistricts() {
      const map = new Map();
      state.filtered.forEach(row => {
        const name = row.district || "Не указан";
        const item = map.get(name) || { total: 0, yes: 0, queue: 0, low: 0, no: 0, real: 0 };
        item.total++; if (item[row.status_code] !== undefined) item[row.status_code]++;
        item.real += Number(row.realCount || 0); map.set(name, item);
      });
      document.getElementById("districtBody").innerHTML = [...map.entries()].sort((a,b) => b[1].total - a[1].total).map(([name, item]) => `
        <tr><td>${name}</td><td>${item.total}</td><td>${item.yes}</td><td>${item.queue}</td><td>${item.low}</td><td>${item.no}</td><td>${item.real}</td></tr>
      `).join("");
    }

    function initMap() {
      if (state.map || !window.ymaps) return;
      ymaps.ready(() => {
        state.map = new ymaps.Map("map", { center: KRASNOGORSK, zoom: 11, controls: ["zoomControl", "fullscreenControl"] });
        renderMap();
      });
    }

    function renderMap() {
      if (!state.map) return;
      state.map.geoObjects.removeAll();
      const points = state.filtered.map(row => {
        const body = `<b>${row.station_name || ""}</b><br>${row.district || ""}<br>${statusText(row)}<br>Топливо: ${fuels(row) || "нет данных"}<br>Отметок 24ч: ${row.realCount || 0}`;
        return new ymaps.Placemark([Number(row.lat), Number(row.lon)], { balloonContent: body }, { preset: "islands#circleDotIcon", iconColor: row.status_code === "yes" ? "#18804b" : row.status_code === "queue" ? "#b86a00" : row.status_code === "low" ? "#7a5a00" : "#c93b32" });
      });
      points.forEach(point => state.map.geoObjects.add(point));
      if (points.length && hasActiveFilters()) state.map.setBounds(state.map.geoObjects.getBounds(), { checkZoomRange: true, zoomMargin: 36 });
      if (!hasActiveFilters()) state.map.setCenter(KRASNOGORSK, 11);
    }

    function hasActiveFilters() {
      return fields.some(id => document.getElementById(id).value);
    }

    function render() {
      applyFilters();
      document.getElementById("visibleCount").textContent = `Показано: ${state.filtered.length}`;
      renderCards(); renderTable(); renderDistricts(); renderMap();
    }

    document.querySelectorAll(".tab").forEach(button => button.addEventListener("click", () => {
      document.querySelectorAll(".tab, .view").forEach(el => el.classList.remove("active"));
      button.classList.add("active");
      document.getElementById(button.dataset.view).classList.add("active");
      if (button.dataset.view === "mapView") initMap();
    }));
    fields.forEach(id => document.getElementById(id).addEventListener("input", render));
    document.getElementById("fileInput").addEventListener("change", async event => {
      const file = event.target.files[0]; if (!file) return;
      const text = await file.text();
      setData(file.name.endsWith(".json") ? JSON.parse(text) : parseCsv(text), file.name);
    });
    fetch(DATA_URL, { cache: "no-store" }).then(r => r.ok ? r.json() : Promise.reject()).then(data => setData(data, DATA_URL)).catch(() => {});
  