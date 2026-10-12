// End-to-end check without a browser: loads the built mod with a stand-in for
// the mod loader, applies the mixins it registers to the game's real files the
// way the loader does, then runs the patched simulation worker in real time.
//
//   node test/integration.test.js <folder with the game's simulation_worker.bundle.js and main.bundle.js> [Kacky Lab sim folder]
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { execFileSync } = require("child_process");

const GAME = process.argv[2];
const LAB = process.argv[3] || "C:/Users/ottom/OneDrive/Documents/PT Mods/Kacky Lab/sim";
if (!GAME) { console.error("usage: node test/integration.test.js <game files folder> [sim folder]"); process.exit(2); }

let failed = 0;
function check(name, ok, detail) {
  console.log((ok ? "PASS " : "FAIL ") + name + (detail ? "  (" + detail + ")" : ""));
  if (!ok) failed++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MixinType = { INSERT: 3, REPLACEBETWEEN: 5 };

// The loader's own rules for text mixins (PolyModLoader.js, getSimURL).
function applyMixin(text, m) {
  if (m.type === MixinType.INSERT) {
    const at = text.indexOf(m.token);
    if (at < 0) throw new Error("token not found: " + m.token);
    return text.slice(0, at + m.token.length) + m.func + text.slice(at + m.token.length);
  }
  const a = text.indexOf(m.tokenStart), b = text.indexOf(m.tokenEnd);
  if (a < 0 || b < 0) throw new Error("token not found: " + m.tokenStart);
  return text.split(text.substring(a, b + m.tokenEnd.length)).join(m.func);
}

(async () => {
  const workerSource = fs.readFileSync(path.join(GAME, "simulation_worker.bundle.js"), "utf8");
  const mainSource = fs.readFileSync(path.join(GAME, "main.bundle.js"), "utf8");

  // ---- load the mod as the loader would -----------------------------------
  let modSource = fs.readFileSync(path.join(__dirname, "..", "dist", Object.values(require("../dist/manifest.json").latest)[0], "main.mod.js"), "utf8");
  modSource = modSource
    .replace('await import(new URL("PolyTypes.js", document.baseURI).href)', "__types")
    .replace("export let polyMod =", "globalThis.__polyMod =");
  class PolyMod { constructor() { this.init = () => {}; this.preInit = () => {}; this.postInit = () => {}; } }
  globalThis.__types = { PolyMod, MixinType };
  globalThis.document = { baseURI: "https://game.invalid/" };
  const frameCallbacks = [];
  globalThis.requestAnimationFrame = (cb) => frameCallbacks.push(cb);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("simulation_worker.bundle.js")) return new Response(workerSource);
    throw new Error("unexpected fetch " + url);
  };
  const posted = [];
  class FakeWorker {
    constructor(url) { this.url = url; this.listeners = []; }
    addEventListener(type, cb) { this.listeners.push(cb); }
    postMessage(m) { posted.push(m); }
    terminate() { this.dead = true; }
  }
  globalThis.Worker = FakeWorker;
  vm.runInThisContext("(async () => {" + modSource + "})()", { filename: "main.mod.js" });
  await sleep(0);
  const mod = globalThis.__polyMod;
  mod.modID = "ptcollisions"; mod.modVersion = "1.0.0"; mod.isLoaded = true;

  const classMixins = [], workerMixins = [];
  const state = { session: null, records: true, state: null };
  const game = {};
  const remoteCars = new Map([[5, { car: { getCarState: () => state.state } }]]);
  const sessions = new WeakMap();
  const other = { modID: "othermod", modVersion: "2.0.0", isLoaded: true, touchingPhysics: false };
  const pml = {
    polyVersion: "0.6.3",
    getSimURL: () => "blob:sim-1",
    getAllMods: () => [mod, other],
    registerClassMixin: (scope, name, m) => classMixins.push({ scope, name, m }),
    registerSimWorkerMixin: (m) => workerMixins.push(m),
    getFromPolyTrack: () => ({
      watchGames: (cb) => cb(sessions),
      session: (g) => sessions.get(g),
      remotes: () => remoteCars,
      peers: (connection) => connection.peers,
      recordsEnabled: () => state.records,
      disableRecords: () => { state.records = false; },
    }),
  };
  await mod.preInit(pml);
  await mod.init(pml);
  check("mod: marked as physics-changing", mod.touchingPhysics === true);
  check("mod: registers 2 join mixins and 4 worker mixins", classMixins.length === 2 && workerMixins.length === 4);

  // ---- join rules ---------------------------------------------------------
  check("join: same mod version accepted", mod.accepts(["pmlcore:1.3.8", "ptcollisions:1.0.0"]));
  check("join: player without the mod refused", !mod.accepts(["pmlcore:1.3.8", "polytrack-world-cup:0.3.2"]));
  check("join: other version refused", !mod.accepts(["ptcollisions:1.0.1"]));
  other.touchingPhysics = true;
  check("join: other physics mod must match too", !mod.accepts(["ptcollisions:1.0.0"]) && mod.accepts(["ptcollisions:1.0.0", "othermod:2.0.0"]));
  other.touchingPhysics = false;

  // ---- the join mixins hit the right spot of the right method -------------
  for (const { scope, name, m } of classMixins) {
    const count = mainSource.split(m.tokenStart).length - 1;
    const at = mainSource.indexOf(m.tokenStart);
    const before = mainSource.slice(0, at).split("\n").reverse();
    const header = before.find((line) => /^ {12}(async )?[\w$]+\([^)]*\) \{$/.test(line)) || "";
    check(`join mixin for ${scope}.${name}: token found once, inside ${name}`, count === 1 && header.includes(name + "("), header.trim());
    // rebuild the method the way the loader's registerClassMixin does, and parse it
    const from = mainSource.lastIndexOf(header, at), to = mainSource.indexOf("\n            }\n", at) + 14;
    const method = mainSource.slice(from, to).split(m.tokenStart).join(m.func);
    const parts = method.match(/^\s*(async\s+)?([\w$]+)\s*\(([^)]*)\)\s*{([\s\S]*)}$/);
    let parses = false;
    try { new Function(`return (${parts[1] || ""}function(${parts[3]}) {${parts[4]}})`); parses = true; } catch (e) { console.log(String(e)); }
    check(`join mixin for ${scope}.${name}: patched method still parses`, parses && method.includes(m.func), `${method.length} characters`);
  }
  for (const name of ["Za", "as", "ya"]) check(`game internals: ${name} is a per-game WeakMap`, mainSource.includes(`(${name} = new WeakMap()),`));
  // PolyCup and the loader patch the same two methods; their tokens must survive ours.
  for (const token of ["const h = [];", "const s = [];", "const e = t.reason;", "mods: [],", "isModsVanillaCompatible: !0,"]) {
    const clash = classMixins.some(({ m }) => m.tokenStart.includes(token) || token.includes(m.tokenStart));
    check(`no clash with PolyCup/loader token "${token}"`, !clash && mainSource.includes(token));
  }

  // ---- feeding the worker -------------------------------------------------
  const simWorker = new globalThis.Worker(pml.getSimURL());
  const otherWorker = new globalThis.Worker("blob:something-else");
  const frame = () => frameCallbacks.splice(0).forEach((cb) => cb(0));
  frame();
  check("singleplayer: nothing is sent, records untouched", posted.length === 0 && state.records === true);
  // we host; players 5 and 6 are connected to us
  const sent = { 5: [], 6: [] };
  const peer = (id) => ({ id, pc: { connectionState: "connected", createDataChannel: (name, options) => {
    const channel = { name, options, readyState: "open", send: (text) => sent[id].push(JSON.parse(text)), close() {} };
    peer.channels[id] = channel;
    return channel;
  } } });
  peer.channels = {};
  const connection = { peers: [peer(5), peer(6)], getPlayers: () => [{ id: 5, isSelf: false }, { id: 6, isSelf: false }, { id: 1, isSelf: true }] };
  sessions.set(game, { sessionId: 1, multiplayerConnection: connection });
  state.state = { frames: 1234, position: { x: 1, y: 2, z: 3 }, quaternion: { x: 0, y: 0, z: 0, w: 1 }, hasStarted: true, finishFrames: null };
  frame();
  const m0 = posted[0];
  check("multiplayer: other cars are sent to the simulation worker only",
    posted.length === 1 && m0.messageType === "ptc" && m0.cars.length === 1 && m0.cars[0].id === 5 && m0.cars[0].f === 1234 &&
    m0.cars[0].p.join() === "1,2,3" && m0.cars[0].s === true && m0.cars[0].e === false && typeof m0.t === "number");
  check("multiplayer: records and uploads switched off for the session", state.records === false);
  state.records = true; // e.g. PolyCup restoring its own default
  frame();
  check("multiplayer: stays off when another mod turns it back on", state.records === false);

  // ---- knocks between players ---------------------------------------------
  const ch = peer.channels[5];
  check("knocks: own data channel on each player's connection", !!ch && !!peer.channels[6] && ch.options.negotiated === true && ch.options.id === 77);
  simWorker.listeners.forEach((cb) => cb({ data: { messageType: "ptcHit", to: 6, dv: [1, 2, 3], r: [0, 0.5, 1] } }));
  check("knocks: our hit is sent to the player we hit, and only to them",
    sent[6].length === 1 && sent[5].length === 0 && sent[6][0].from === 1 && sent[6][0].dv.join() === "1,2,3");
  posted.length = 0;
  ch.onmessage({ data: JSON.stringify({ to: 1, from: 99, dv: [4, 0, 0], r: [0, 0, 1] }) });
  const knock = posted.find((m) => m.messageType === "ptcKnock");
  check("knocks: a hit on us reaches the simulation, sender taken from the connection", !!knock && knock.from === 5 && knock.dv.join() === "4,0,0");
  ch.onmessage({ data: JSON.stringify({ to: 6, dv: [0, 0, 7], r: [0, 0, 1] }) });
  check("knocks: the host passes on a hit between two other players", sent[6].length === 2 && sent[6][1].from === 5 && sent[6][1].dv.join() === "0,0,7");
  const before = posted.length + sent[6].length;
  for (const bad of ["nonsense", JSON.stringify({ to: 1, dv: [1, "2", 3], r: [0, 0, 0] }), JSON.stringify({ to: 1, dv: [1, 2, null], r: [0, 0, 0] }),
    JSON.stringify({ to: 1, dv: [1, 2, 3] }), JSON.stringify({ to: 1, dv: [1, 2, 3], r: [0, 0, 0], pad: "x".repeat(500) })]) ch.onmessage({ data: bad });
  check("knocks: malformed messages are dropped", posted.length + sent[6].length === before);
  sessions.set({}, undefined); // a new singleplayer game
  posted.length = 0;
  let closed = 0;
  for (const id of [5, 6]) peer.channels[id].close = () => closed++;
  frame(); frame();
  check("leaving multiplayer: one empty update, then silence, channels closed", posted.length === 1 && posted[0].cars.length === 0 && closed === 2);
  simWorker.terminate();
  void otherWorker;

  // ---- the patched worker, for real ---------------------------------------
  let patched = workerSource;
  for (const m of workerMixins) patched = applyMixin(patched, m);
  check("worker: every mixin applied", ["self.__ptc.attach(t);", "self.__ptc.afterStep(t, e, i); return new Uint8Array", 'r.messageType === "ptc"']
    .every((s) => patched.split(s).length === 2));

  const save = execFileSync(process.execPath, ["-e", `
    const path=require('path'),fs=require('fs');const LAB=${JSON.stringify(LAB)};
    const {boot}=require(path.join(LAB,'sim.js'));
    boot().then(pt=>{const t=pt.Ko.fromExportString(fs.readFileSync(path.join(LAB,'_tmp.code'),'utf8').trim()).trackData;
      fs.writeFileSync(${JSON.stringify(path.join(__dirname, ".track.tmp"))},t.toSaveString());process.exit(0)});`], { stdio: ["ignore", "ignore", "ignore"] });
  void save;
  const trackData = fs.readFileSync(path.join(__dirname, ".track.tmp"), "utf8");
  fs.unlinkSync(path.join(__dirname, ".track.tmp"));

  const out = [];
  globalThis.fetch = async (url) => new Response(fs.readFileSync(path.join(LAB, path.basename(String(url)))), { headers: { "content-type": "application/wasm" } });
  globalThis.self = globalThis;
  globalThis.location = { href: "file:///" + LAB.replace(/\\/g, "/") + "/" };
  globalThis.postMessage = (m) => out.push(m);
  globalThis.importScripts = (p) => vm.runInThisContext(fs.readFileSync(path.join(LAB, path.basename(p)), "utf8"), { filename: p });
  globalThis.addEventListener = () => {};
  globalThis.onmessage = null;
  globalThis.XMLHttpRequest = class {
    open(method, url) { this.url = url; }
    send() { const b = fs.readFileSync(path.join(LAB, path.basename(String(this.url)))); this.response = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }
  };
  delete globalThis.requestAnimationFrame;
  globalThis.window = { JS_SHA256_NO_NODE_JS: true };
  const quiet = console.error;
  console.error = () => {};
  vm.runInThisContext(patched, { filename: "simulation_worker.patched.js" });
  delete globalThis.window;
  const send = (data) => globalThis.onmessage({ data });
  const f32 = (v) => (v && v.__f32 ? new Float32Array(v.__f32) : Array.isArray(v) ? new Float32Array(v) : v);
  const init = JSON.parse(fs.readFileSync(path.join(LAB, "init.json"), "utf8"));
  send({ ...init, messageType: 0, isRealtime: true, trackParts: init.trackParts.map((p) => ({ ...p, vertices: f32(p.vertices) })),
    carCollisionShapeVertices: f32(init.carCollisionShapeVertices) });

  function positions() {
    const list = [];
    for (const m of out.splice(0)) {
      if (m.messageType === "ptcHit") { list.hits = (list.hits || 0) + 1; continue; }
      if (m.messageType !== 10) continue;
      for (const buf of m.carStateBuffers) {
        const d = new DataView(buf), u = new Uint8Array(buf);
        const off = 12 + (u[11] & 2 ? 3 : 0) + 2;
        list.push({ frames: u[4] | (u[5] << 8) | (u[6] << 16), speed: d.getFloat32(7, true),
          p: [d.getFloat32(off, true), d.getFloat32(off + 4, true), d.getFloat32(off + 8, true)],
          q: [d.getFloat32(off + 12, true), d.getFloat32(off + 16, true), d.getFloat32(off + 20, true), d.getFloat32(off + 24, true)] });
      }
    }
    return list;
  }
  async function run(carId, ms, remote) {
    send({ messageType: 3, trackData, carId, carRecording: null, mountainVertices: new Float32Array(9), mountainOffset: { x: 0, y: -100000, z: 0 } });
    send({ messageType: 5, carId, targetSimulationTimeFrames: null });
    send({ messageType: 6, carId, up: true, right: false, down: false, left: false, reset: false });
    const trace = [], end = Date.now() + ms;
    let hits = 0, n = 0;
    while (Date.now() < end) {
      await sleep(8);
      const got = positions();
      hits += got.hits || 0;
      trace.push(...got);
      if (remote) send({ messageType: "ptc", t: performance.timeOrigin + performance.now(), cars: remote(n++) });
    }
    send({ messageType: 4, carId });
    return { trace, hits };
  }
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

  for (let i = 0; i < 400 && !globalThis.__ptc; i++) await sleep(25);
  await sleep(500);
  const free = await run(1, 3500, null);
  console.error = quiet;
  check("worker: runs and steps in real time", free.trace.length > 2500, `${free.trace.length} steps in 3.5 s`);
  check("worker: knows it is the realtime simulation", globalThis.__ptc.realtime === true);
  const wall = free.trace.find((s) => s.frames >= 2600);
  const blocked = await run(2, 3500, (n) => [{ id: 9, f: 90000 + n * 8, p: wall.p, q: wall.q, s: true, e: false }]);
  const last = blocked.trace[blocked.trace.length - 1], freeLast = free.trace[free.trace.length - 1];
  const short = dist(free.trace[0].p, wall.p) - dist(blocked.trace[0].p, last.p);
  check("worker: car body located inside the worker", globalThis.__ptc._debug.byId.size === 0 && blocked.hits > 0, `${blocked.hits} hit(s) reported to the page`);
  check("worker: car is kept out of the other player's car", short > 2.5 && freeLast.speed > 100,
    `ends ${short.toFixed(2)} m short of its centre (free run: ${freeLast.speed.toFixed(1)} km/h)`);

  console.log(failed ? `${failed} check(s) failed` : "all checks passed");
  globalThis.fetch = realFetch;
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log("ERROR", e); process.exit(1); });
