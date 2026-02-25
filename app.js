/* Takeoff Runway Monitor (PWA)
   GPS-based monitoring at ~2 Hz using watchPosition updates.
   Wind and runway headings treated as TRUE (per user dataset note).
*/
"use strict";

const el = (id) => document.getElementById(id);

const state = {
  data: null,
  airport: null,
  runway: null,
  takeoffEnd: null,   // selected end object
  oppositeEnd: null,  // other end object
  metar: null,
  computed: {
    da_ft: null,
    headwind_kt: null,
    vr_gs_kt: null,
    buffer_ft: null
  },
  watchId: null,
  samples: [],
  lastTickMs: null,
  updateCount: 0,
  startMs: null,
  audioCtx: null,
  alertTimer: null,
  alertFastTimer: null,
  lastStatus: "READY"
};

function fmtFt(x){
  if (x === null || x === undefined || Number.isNaN(x)) return "—";
  return Math.round(x).toLocaleString() + " ft";
}
function fmtKt(x){
  if (x === null || x === undefined || Number.isNaN(x)) return "—";
  return (Math.round(x*10)/10).toString() + " kt";
}
function clamp(x,a,b){ return Math.max(a, Math.min(b, x)); }
function rad(d){ return d*Math.PI/180; }

/* Equirectangular projection around a reference point */
function toXYMeters(lat, lon, refLat, refLon){
  const R = 6371000;
  const x = rad(lon-refLon) * Math.cos(rad(refLat)) * R;
  const y = rad(lat-refLat) * R;
  return {x, y};
}

function distanceMeters(a, b){
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx*dx + dy*dy);
}

/* Project point P onto line from A->B, return along-track distance from A, and cross-track distance */
function projectAlong(A, B, P){
  const vx = B.x - A.x, vy = B.y - A.y;
  const wx = P.x - A.x, wy = P.y - A.y;
  const v2 = vx*vx + vy*vy;
  if (v2 < 1e-9) return {s:0, xt:0};
  const t = (wx*vx + wy*vy) / v2;
  const projx = A.x + t*vx;
  const projy = A.y + t*vy;
  const xt = Math.sqrt((P.x-projx)**2 + (P.y-projy)**2);
  const s = t * Math.sqrt(v2); // meters from A along AB
  return {s, xt, t};
}

/* Service worker */
async function registerSW(){
  if (!("serviceWorker" in navigator)) return;
  try{
    await navigator.serviceWorker.register("./sw.js");
  }catch(e){
    console.warn("SW registration failed:", e);
  }
}

/* Load runway dataset */
async function loadData(){
  const resp = await fetch("./data/runways.json", {cache:"no-cache"});
  const data = await resp.json();
  state.data = data;
  el("dataVersion").textContent = "Runways loaded • " + (data.generated_utc || "dataset");
  el("airportHint").textContent = "Search by airport ID (FAA/ICAO) or city/state (e.g., 'TACOMA WA'). Select from results.";
}

function normalizeQuery(q){
  return (q||"").trim().toUpperCase();
}

function airportMatches(a, q){
  if (!q) return false;
  const id = (a.arpt_id||"").toUpperCase();
  const city = (a.city||"").toUpperCase();
  const st = (a.state||"").toUpperCase();
  if (id.startsWith(q)) return true;
  if ((city + " " + st).includes(q)) return true;
  return false;
}

function renderAirportResults(q){
  const box = el("airportResults");
  box.innerHTML = "";
  if (!state.data || !q || q.length < 2) return;

  // limit results
  const matches = [];
  for (const a of state.data.airports){
    if (airportMatches(a, q)) matches.push(a);
    if (matches.length >= 12) break;
  }
  if (matches.length === 0){
    box.innerHTML = '<div class="hint">No matches found.</div>';
    return;
  }
  for (const a of matches){
    const d = document.createElement("div");
    d.className = "resultItem";
    const label = `${a.arpt_id} — ${a.city || ""}${a.city ? ", " : ""}${a.state || ""}`.trim();
    d.textContent = label;
    d.addEventListener("click", () => selectAirport(a.arpt_id));
    box.appendChild(d);
  }
}

function selectAirport(arptId){
  const id = normalizeQuery(arptId);
  const a = state.data.airports.find(x => (x.arpt_id||"").toUpperCase() === id);
  if (!a) return;
  state.airport = a;
  el("airportInput").value = id;
  el("airportResults").innerHTML = "";
  populateRunways();
}

function populateRunways(){
  const sel = el("runwaySelect");
  sel.innerHTML = "";
  if (!state.airport){
    sel.disabled = true;
    sel.innerHTML = '<option value="">Select an airport first</option>';
    return;
  }
  const opt0 = document.createElement("option");
  opt0.value = "";
  opt0.textContent = "Select runway";
  sel.appendChild(opt0);

  // Sort by calculated length desc
  const runways = [...state.airport.runways].sort((a,b) => (b.length_ft_calc||0)-(a.length_ft_calc||0));
  for (const r of runways){
    const opt = document.createElement("option");
    opt.value = r.rwy_id;
    const len = r.length_ft_calc ? Math.round(r.length_ft_calc).toLocaleString() : "—";
    opt.textContent = `${r.rwy_id}  •  ${len} ft (calc)`;
    sel.appendChild(opt);
  }
  sel.disabled = false;
  el("runwayHint").textContent = `Field elev (est): ${state.airport.field_elev_ft_est ? Math.round(state.airport.field_elev_ft_est).toLocaleString() + " ft" : "—"}`;
  el("endSelect").disabled = true;
  el("endSelect").innerHTML = '<option value="">Select runway first</option>';
  el("fetchMetarBtn").disabled = true;
  el("refreshMetarBtn").disabled = true;
  el("armBtn").disabled = true;
}

function populateEnds(){
  const rwyId = el("runwaySelect").value;
  const r = state.airport.runways.find(x => x.rwy_id === rwyId);
  state.runway = r || null;
  state.takeoffEnd = null;
  state.oppositeEnd = null;

  const sel = el("endSelect");
  sel.innerHTML = "";
  if (!r){
    sel.disabled = true;
    sel.innerHTML = '<option value="">Select runway first</option>';
    return;
  }
  const opt0 = document.createElement("option");
  opt0.value = "";
  opt0.textContent = "Select takeoff end";
  sel.appendChild(opt0);

  for (const e of r.ends){
    const opt = document.createElement("option");
    opt.value = e.end_id;
    const hdg = (e.heading_true_deg !== null && e.heading_true_deg !== undefined) ? (Math.round(e.heading_true_deg*10)/10) + "°T" : "—";
    const elev = (e.elev_ft !== null && e.elev_ft !== undefined) ? Math.round(e.elev_ft).toLocaleString() + " ft" : "—";
    opt.textContent = `${e.end_id}  •  hdg ${hdg}  •  elev ${elev}`;
    sel.appendChild(opt);
  }
  sel.disabled = false;
  el("endHint").textContent = "Takeoff direction uses selected runway-end TRUE heading.";
  el("fetchMetarBtn").disabled = false;
  el("refreshMetarBtn").disabled = true;
  updateArmReady();
}

function selectEnd(){
  const endId = el("endSelect").value;
  if (!state.runway || !endId) return;
  const e = state.runway.ends.find(x => x.end_id === endId);
  const o = state.runway.ends.find(x => x.end_id !== endId);
  state.takeoffEnd = e || null;
  state.oppositeEnd = o || null;
  el("refreshMetarBtn").disabled = !state.takeoffEnd;
  updateComputed();
  updateArmReady();
}

/* METAR fetch and parse */
function parseMetarJson(item){
  // AWC Data API typically returns fields like: rawOb, altim, temp, dewp, wdir, wspd, gust, obsTime, icaoId/stationId
  const raw = item.rawOb || item.raw || item.raw_text || "";
  const altim = item.altim !== undefined ? parseFloat(item.altim) : null; // inHg
  const tempC = item.temp !== undefined ? parseFloat(item.temp) : null;
  const dewpC = item.dewp !== undefined ? parseFloat(item.dewp) : null;
  let wdir = item.wdir !== undefined ? parseFloat(item.wdir) : null;
  let wspd = item.wspd !== undefined ? parseFloat(item.wspd) : null;
  let gust = item.gust !== undefined ? parseFloat(item.gust) : null;

  const station = item.icaoId || item.station || item.stationId || item.id || null;
  const time = item.obsTime || item.time || item.reportTime || null;

  // If wind is VRB, some APIs set wdir to null. Keep null => component = 0.
  if (Number.isNaN(wdir)) wdir = null;
  if (Number.isNaN(wspd)) wspd = null;
  if (Number.isNaN(gust)) gust = null;

  return {raw, altim, tempC, dewpC, wdir, wspd, gust, station, time};
}

async function fetchMetar(){
  if (!state.airport) return;
  // Assume ARPT_ID is station identifier for METAR where applicable (e.g., KSEA). If not, the fetch may fail.
  // For FAA LID-only airports, user can enter a nearby station by prefixing 'K...' in the airport field.
  const id = normalizeQuery(state.airport.arpt_id);
  const url = `https://aviationweather.gov/api/data/metar?ids=${encodeURIComponent(id)}&format=json`;
  el("metarMeta").textContent = "Fetching METAR…";
  try{
    const resp = await fetch(url, {cache:"no-store"});
    if (!resp.ok) throw new Error("METAR fetch failed: " + resp.status);
    const arr = await resp.json();
    if (!Array.isArray(arr) || arr.length === 0) throw new Error("No METAR returned for " + id);
    const m = parseMetarJson(arr[0]);
    state.metar = m;
    el("metarRaw").textContent = "METAR: " + (m.raw || "(no raw METAR provided)");
    el("metarMeta").textContent = `Station: ${m.station || id} • Time: ${m.time || "—"} • Altim: ${m.altim ?? "—"} inHg • Temp: ${m.tempC ?? "—"}°C • Wind: ${(m.wdir ?? "VRB")} / ${(m.wspd ?? "—")} kt`;
    updateComputed();
    updateArmReady();
  }catch(e){
    console.error(e);
    state.metar = null;
    el("metarRaw").textContent = "METAR: —";
    el("metarMeta").textContent = "METAR error: " + e.message;
    updateComputed();
    updateArmReady();
  }
}

/* Atmosphere / performance */
function densityRatioFromDA(da_ft){
  // Approx density ratio rho/rho0 using standard atmosphere model vs density altitude (approx)
  // sigma ≈ (1 - 6.87535e-6 * h_ft) ^ 4.2561
  const x = 1 - 6.87535e-6 * da_ft;
  if (x <= 0) return 0.1;
  return Math.pow(x, 4.2561);
}

function computeDA(fieldElevFt, altimInHg, oatC){
  if (fieldElevFt === null || altimInHg === null || oatC === null) return null;
  const PA = fieldElevFt + (29.92 - altimInHg) * 1000.0;
  const isa = 15.0 - 2.0 * (PA/1000.0);
  const DA = PA + 120.0 * (oatC - isa);
  return DA;
}

function computeHeadwind(runwayHeadingTrueDeg, windDirTrueDeg, windSpdKt){
  if (runwayHeadingTrueDeg === null || windDirTrueDeg === null || windSpdKt === null) return 0;
  const theta = rad(windDirTrueDeg - runwayHeadingTrueDeg);
  // component along runway heading; positive = headwind
  return windSpdKt * Math.cos(theta);
}

function updateComputed(){
  // DA
  const fieldElev = state.airport?.field_elev_ft_est ?? null;
  const altim = state.metar?.altim ?? null;
  const oat = state.metar?.tempC ?? null;
  const da = computeDA(fieldElev, altim, oat);
  state.computed.da_ft = da;

  // headwind component (credit only steady wind, not gust)
  const rwyHdg = state.takeoffEnd?.heading_true_deg ?? null;
  const wdir = state.metar?.wdir ?? null;
  const wspd = state.metar?.wspd ?? null;
  const hw = computeHeadwind(rwyHdg, wdir, wspd);
  state.computed.headwind_kt = hw;

  // Vr GS
  const vrIas = parseFloat(el("vrInput").value);
  if (!Number.isFinite(vrIas) || vrIas <= 0 || da === null){
    state.computed.vr_gs_kt = null;
  } else {
    const sigma = densityRatioFromDA(da);
    const vrTas = vrIas / Math.sqrt(Math.max(0.1, sigma));
    // apply headwind component (tailwind increases GS)
    const vrGs = vrTas - hw;
    state.computed.vr_gs_kt = vrGs;
  }

  // Buffer (ft)
  const rwyLen = state.runway?.length_ft_calc ?? null;
  if (rwyLen){
    state.computed.buffer_ft = Math.max(200, 0.10 * rwyLen);
  } else {
    state.computed.buffer_ft = 300;
  }

  el("daValue").textContent = da === null ? "—" : Math.round(da).toLocaleString();
  el("hwValue").textContent = hw === null ? "—" : (Math.round(hw*10)/10).toString();
  el("vrGsValue").textContent = state.computed.vr_gs_kt === null ? "—" : (Math.round(state.computed.vr_gs_kt*10)/10).toString();
}

function updateArmReady(){
  const ok = !!(state.airport && state.runway && state.takeoffEnd && state.metar && state.computed.vr_gs_kt);
  el("armBtn").disabled = !ok;
  el("armBtn").classList.toggle("ready", ok);
}

/* Audio alert (WebAudio beep) */
function ensureAudio(){
  if (!state.audioCtx){
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    state.audioCtx = new AudioContext();
  }
  if (state.audioCtx.state === "suspended"){
    state.audioCtx.resume();
  }
}

function beep(durationMs=220, frequency=880){
  try{
    ensureAudio();
    const ctx = state.audioCtx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "square";
    o.frequency.value = frequency;
    g.gain.value = 0.08;
    o.connect(g);
    g.connect(ctx.destination);
    o.start();
    setTimeout(()=>{
      o.stop();
      o.disconnect();
      g.disconnect();
    }, durationMs);
  }catch(e){
    // no-op
  }
}

/* Monitoring loop */
function setStatus(level, text, sub){
  const bar = el("statusBar");
  bar.classList.remove("status-green","status-amber","status-red");
  if (level === "GREEN") bar.classList.add("status-green");
  if (level === "AMBER") bar.classList.add("status-amber");
  if (level === "RED") bar.classList.add("status-red");
  el("statusText").textContent = text;
  el("statusSub").textContent = sub;

  // alert scheduling
  if (level !== state.lastStatus){
    stopAlerts();
    if (level === "RED"){
      startAlerts();
    }
    state.lastStatus = level;
  }
}

function startAlerts(){
  // Every 5 seconds by default
  state.alertTimer = setInterval(()=>beep(240, 880), 5000);
}
function startFastAlerts(){
  if (state.alertFastTimer) return;
  state.alertFastTimer = setInterval(()=>beep(200, 990), 1000);
}
function stopAlerts(){
  if (state.alertTimer){ clearInterval(state.alertTimer); state.alertTimer = null; }
  if (state.alertFastTimer){ clearInterval(state.alertFastTimer); state.alertFastTimer = null; }
}

function resetSamples(){
  state.samples = [];
  state.lastTickMs = null;
  state.updateCount = 0;
  state.startMs = performance.now();
  el("gpsHz").textContent = "—";
  el("gpsStatus").textContent = "Waiting for GPS…";
}

/* Estimate speed (m/s) from successive positions if coords.speed unavailable */
function speedFromPositions(prev, cur){
  if (!prev) return null;
  const dt = (cur.t - prev.t)/1000;
  if (dt <= 0.05) return null;
  // Equirectangular distance around prev position
  const refLat = prev.lat;
  const refLon = prev.lon;
  const A = toXYMeters(prev.lat, prev.lon, refLat, refLon);
  const B = toXYMeters(cur.lat, cur.lon, refLat, refLon);
  const d = distanceMeters(A,B);
  return d/dt;
}

function computeRunwayRemainingFt(lat, lon){
  const Aend = state.takeoffEnd;
  const Bend = state.oppositeEnd;
  if (!Aend || !Bend) return null;

  // Reference point for projection: runway midpoint
  const refLat = (Aend.lat + Bend.lat)/2;
  const refLon = (Aend.lon + Bend.lon)/2;
  const A = toXYMeters(Aend.lat, Aend.lon, refLat, refLon);  // departure end
  const B = toXYMeters(Bend.lat, Bend.lon, refLat, refLon);  // far end
  const P = toXYMeters(lat, lon, refLat, refLon);

  // runway vector A->B
  const proj = projectAlong(A,B,P);
  const runwayLenM = distanceMeters(A,B);

  // along-track s from A; if before A, treat as 0; if beyond B, remaining negative
  const s = clamp(proj.s, 0, runwayLenM);
  const remainingM = runwayLenM - s;
  const remainingFt = remainingM * 3.280839895;
  return remainingFt;
}

function smoothSpeed(samples){
  // Weighted average of last few speed values (m/s)
  const recent = samples.slice(-6).filter(s => Number.isFinite(s.v));
  if (recent.length === 0) return null;
  let wsum = 0, vsum = 0;
  for (let i=0;i<recent.length;i++){
    const w = (i+1); // increasing weight
    wsum += w;
    vsum += w * recent[i].v;
  }
  return vsum/wsum;
}

function smoothAccel(samples){
  const recent = samples.slice(-8).filter(s => Number.isFinite(s.v));
  if (recent.length < 3) return null;
  // Use speed difference across ~2-3 seconds if available
  const a = recent[recent.length-1];
  // find a sample ~2 seconds ago
  let b = null;
  for (let i=recent.length-2;i>=0;i--){
    if ((a.t - recent[i].t)/1000 >= 2.0){ b = recent[i]; break; }
  }
  if (!b) b = recent[0];
  const dt = (a.t - b.t)/1000;
  if (dt <= 0) return null;
  return (a.v - b.v)/dt;
}

function updateMonitorUI(remainFt, gsKt, predFt, accelMps2){
  el("remainValue").textContent = remainFt !== null ? fmtFt(remainFt) : "—";
  el("gsValue").textContent = gsKt !== null ? fmtKt(gsKt) : "—";
  el("predValue").textContent = predFt !== null ? fmtFt(predFt) : "—";
  el("accelValue").textContent = accelMps2 !== null ? (Math.round(accelMps2*100)/100).toString() + " m/s²" : "—";
}

function decide(remainFt, gsKt, accelMps2){
  const vrGsKt = state.computed.vr_gs_kt;
  const bufferFt = state.computed.buffer_ft;
  if (!Number.isFinite(remainFt) || !Number.isFinite(gsKt) || !Number.isFinite(vrGsKt)){
    return {level:"AMBER", text:"GPS/inputs unstable", sub:"Hold; ensure good GPS and confirm runway selection.", predFt:null};
  }
  const V = gsKt * 0.514444;      // m/s
  const Vr = vrGsKt * 0.514444;   // m/s
  const a = accelMps2;

  if (!Number.isFinite(a) || a < 0.15){
    // cannot predict well at very low accel; show amber early in roll
    const sub = "Acceleration estimate low/unstable (GPS-limited). Continue monitoring.";
    return {level:"AMBER", text:"MONITOR", sub, predFt:null};
  }

  const t = (Vr - V) / a;
  if (t <= 0){
    return {level:"GREEN", text:"ON TRACK", sub:"Vr groundspeed reached or imminent.", predFt:0};
  }
  const d_m = V*t + 0.5*a*t*t;
  const d_ft = d_m * 3.280839895;

  const limit = remainFt - bufferFt;
  if (d_ft > limit){
    return {level:"RED", text:"ABORT", sub:`Predicted rotate point beyond runway end (buffer ${Math.round(bufferFt)} ft).`, predFt:d_ft};
  }
  const ratio = d_ft / Math.max(1, limit);
  if (ratio > 0.90){
    return {level:"AMBER", text:"MARGINAL", sub:"Trend is close to runway limit; be prepared to abort.", predFt:d_ft};
  }
  return {level:"GREEN", text:"ON TRACK", sub:"Predicted rotate point within remaining runway (with buffer).", predFt:d_ft};
}

function onPosition(pos){
  const now = performance.now();
  state.updateCount += 1;

  const lat = pos.coords.latitude;
  const lon = pos.coords.longitude;

  // prefer provided speed; else derive
  const prev = state.samples.length ? state.samples[state.samples.length-1] : null;
  let v = pos.coords.speed; // m/s, may be null
  if (!Number.isFinite(v)){
    const cur = {lat, lon, t: now};
    v = speedFromPositions(prev, cur);
  }

  const sample = {lat, lon, t: now, v: Number.isFinite(v) ? v : null};
  state.samples.push(sample);
  if (state.samples.length > 40) state.samples.shift();

  const vSmooth = smoothSpeed(state.samples);
  const aSmooth = smoothAccel(state.samples);

  const gsKt = (vSmooth !== null) ? (vSmooth / 0.514444) : null;
  const remainFt = computeRunwayRemainingFt(lat, lon);

  // Update GPS Hz estimate
  const elapsed = (now - state.startMs)/1000;
  if (elapsed > 1.5){
    const hz = state.updateCount / elapsed;
    el("gpsHz").textContent = (Math.round(hz*10)/10).toString() + " Hz";
  }
  el("gpsStatus").textContent = `OK • acc=${Math.round((pos.coords.accuracy||0))}m`;

  const decision = decide(remainFt, gsKt, aSmooth);
  updateMonitorUI(remainFt, gsKt, decision.predFt, aSmooth);
  setStatus(decision.level, decision.text, decision.sub);

  // Fast alerts when < 1000 ft remaining and RED
  if (decision.level === "RED" && Number.isFinite(remainFt) && remainFt < 1000){
    startFastAlerts();
  } else {
    if (state.alertFastTimer){ clearInterval(state.alertFastTimer); state.alertFastTimer = null; }
  }
}

function onPosError(err){
  el("gpsStatus").textContent = "GPS error: " + (err?.message || "unknown");
  setStatus("AMBER","GPS ERROR","Enable precise location, keep app in foreground, and try again.");
}

/* UI navigation */
function showMonitor(){
  el("setupCard").classList.add("hidden");
  el("monitorCard").classList.remove("hidden");
}
function showSetup(){
  el("monitorCard").classList.add("hidden");
  el("setupCard").classList.remove("hidden");
}

function arm(){
  // Save Vr locally
  const vr = el("vrInput").value;
  try{ localStorage.setItem("vr_ias_kt", vr); }catch(e){}

  // Populate monitor labels
  el("mAirport").textContent = `${state.airport.arpt_id} (${state.airport.city || ""} ${state.airport.state || ""})`.trim();
  el("mRunway").textContent = `${state.runway.rwy_id} • ${Math.round(state.runway.length_ft_calc).toLocaleString()} ft (calc)`;
  el("mEnd").textContent = `${state.takeoffEnd.end_id} • hdg ${Math.round(state.takeoffEnd.heading_true_deg*10)/10}°T`;
  el("mVrGs").textContent = fmtKt(state.computed.vr_gs_kt);
  el("mBuffer").textContent = fmtFt(state.computed.buffer_ft);
  el("mMetarTime").textContent = state.metar?.time || "—";
  el("mMetarStation").textContent = state.metar?.station || state.airport.arpt_id;

  showMonitor();
  resetSamples();
  stopAlerts();
  state.lastStatus = "READY";
  setStatus("AMBER","ARMED","Waiting for GPS updates…");

  // Start GPS watch
  if (!("geolocation" in navigator)){
    setStatus("RED","NO GPS","Geolocation is not available in this browser.");
    return;
  }

  // iOS requires user gesture to allow audio; arm click counts; initialize context
  ensureAudio();

  state.watchId = navigator.geolocation.watchPosition(onPosition, onPosError, {
    enableHighAccuracy: true,
    maximumAge: 0,
    timeout: 10000
  });

  el("stopBtn").disabled = false;
}

function stopMonitoring(){
  if (state.watchId !== null){
    navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
  }
  stopAlerts();
  el("stopBtn").disabled = true;
  setStatus("AMBER","STOPPED","Monitoring stopped.");
}

/* Startup */
window.addEventListener("load", async () => {
  await registerSW();
  await loadData();

  // restore Vr
  try{
    const vr = localStorage.getItem("vr_ias_kt");
    if (vr) el("vrInput").value = vr;
  }catch(e){}

  el("airportInput").addEventListener("input", (e)=>{
    const q = normalizeQuery(e.target.value);
    renderAirportResults(q);
  });
  el("airportInput").addEventListener("change", (e)=>{
    const q = normalizeQuery(e.target.value);
    // Try direct select if exact
    if (q){
      const a = state.data.airports.find(x => (x.arpt_id||"").toUpperCase() === q);
      if (a) selectAirport(q);
    }
  });

  el("runwaySelect").addEventListener("change", ()=>{
    populateEnds();
    updateComputed();
  });

  el("endSelect").addEventListener("change", ()=>{
    selectEnd();
  });

  el("vrInput").addEventListener("input", ()=>{
    updateComputed();
    updateArmReady();
  });

  el("fetchMetarBtn").addEventListener("click", async ()=>{
    await fetchMetar();
  });
  el("refreshMetarBtn").addEventListener("click", async ()=>{
    await fetchMetar();
  });

  el("armBtn").addEventListener("click", ()=>{
    arm();
  });
  el("stopBtn").addEventListener("click", ()=>{
    stopMonitoring();
  });
  el("backBtn").addEventListener("click", ()=>{
    stopMonitoring();
    showSetup();
  });
});
