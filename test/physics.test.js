// Runs the collision code against the game's real physics, headless.
// Needs the Kacky Lab simulator: node test/physics.test.js [path to its sim folder]
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const LAB = process.argv[2] || "C:/Users/ottom/OneDrive/Documents/PT Mods/Kacky Lab/sim";
const { boot } = require(path.join(LAB, "sim.js"));

function parse(buf) {
  const n = new DataView(buf, 4), e = new Uint8Array(buf, 4);
  let i = 7;
  const flags = e[i];
  i += 1 + (flags & 2 ? 3 : 0) + 2;
  const p = [n.getFloat32(i, true), n.getFloat32(i + 4, true), n.getFloat32(i + 8, true)];
  i += 12;
  const q = [n.getFloat32(i, true), n.getFloat32(i + 4, true), n.getFloat32(i + 8, true), n.getFloat32(i + 12, true)];
  return { p, q, speed: n.getFloat32(3, true), frames: e[0] | (e[1] << 8) | (e[2] << 16), started: !!(flags & 1) };
}
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
let failed = 0;
function check(name, ok, detail) {
  console.log((ok ? "PASS " : "FAIL ") + name + (detail ? "  (" + detail + ")" : ""));
  if (!ok) failed++;
}

(async () => {
  const pt = await boot();
  const M = pt.M;
  vm.runInThisContext(fs.readFileSync(path.join(__dirname, "..", "src", "worker-runtime.js"), "utf8"));
  const ptc = globalThis.__ptc;
  ptc.realtime = true;
  let clock = 1e9;
  ptc.now = () => clock;
  ptc.attach(M);
  let bufPtr = 0;
  const update = M._updateCarModel;
  M._updateCarModel = function (...args) { bufPtr = args[6]; return update.apply(this, args); };

  const code = fs.readFileSync(path.join(LAB, "_tmp.code"), "utf8").trim();
  const track = pt.Ko.fromExportString(code).trackData;
  const start = track.getStartTransform();
  const up = { up: true, right: false, down: false, left: false, reset: false };
  let nextId = 7000;

  // Drives one car straight for `frames` steps. `remote(frame)` returns the
  // other cars to report at that frame (as the main thread would), or null.
  function drive(frames, remote, collide = true) {
    const id = nextId++;
    pt.createCar(id, new Float32Array(9), { x: 0, y: -100000, z: 0 }, track, start);
    const ghost = nextId++; // a second car in the same worker, like a replay ghost
    pt.createCar(ghost, new Float32Array(9), { x: 0, y: -100000, z: 0 }, track, start);
    const car = { id, userControls: {} }, ghostCar = { id: ghost, userControls: null };
    const trace = [];
    const hitsBefore = ptc.hits;
    for (let f = 0; f < frames; f++) {
      clock += 1;
      if (remote && f % 8 === 0) {
        const cars = remote(f, trace);
        if (cars) ptc.remote({ messageType: "ptc", t: clock, cars });
      }
      const state = parse(pt.step(car, up));
      if (collide) ptc.afterStep(M, car, bufPtr);
      pt.step(ghostCar, up);
      if (collide) ptc.afterStep(M, ghostCar, bufPtr);
      trace.push(state);
    }
    const body = ptc._debug.byId.get(id), ghostBody = ptc._debug.byId.get(ghost);
    M._deleteCarModel(id);
    M._deleteCarModel(ghost);
    return { trace, hits: ptc.hits - hitsBefore, body, ghostBody };
  }

  const N = 4000;
  const free = drive(N, null);
  const last = free.trace[N - 1];
  check("bodies of both cars found and told apart", free.body > 0 && free.ghostBody > 0 && free.body !== free.ghostBody,
    `${free.body}, ${free.ghostBody}`);
  check("no remote cars: run is untouched", free.hits === 0);
  const again = drive(N, null, false);
  check("no remote cars: identical to unmodded physics", dist(again.trace[N - 1].p, last.p) === 0);
  console.log(`  free run: ${dist(free.trace[0].p, last.p).toFixed(1)} m in ${N} ms, ${last.speed.toFixed(1)} km/h at the end`);

  // 1. a parked car on the driving line
  const at = 3000, wall = free.trace[at];
  const parked = (f) => [{ id: 1, f: 50000 + f, p: wall.p, q: wall.q, s: true, e: false }];
  const blocked = drive(N, parked);
  const end = blocked.trace[N - 1];
  const reach = dist(free.trace[0].p, wall.p), got = dist(blocked.trace[0].p, end.p);
  check("parked car: collision registered", blocked.hits > 0, `${blocked.hits} hit(s)`);
  check("parked car: the car does not pass through", got < reach - 2.5, `stopped ${(reach - got).toFixed(2)} m short of its centre`);
  const hitAt = blocked.trace.findIndex((s2, k) => k > 0 && s2.speed < blocked.trace[k - 1].speed - 20);
  const fwd = (a, b) => { const d = free.trace[at].p.map((v, k) => v - free.trace[at - 50].p[k]); return (b.p[0] - a.p[0]) * d[0] + (b.p[1] - a.p[1]) * d[1] + (b.p[2] - a.p[2]) * d[2]; };
  check("parked car: the car bounces back off it", hitAt > 0 && fwd(blocked.trace[hitAt], blocked.trace[hitAt + 60]) < -0.5,
    `hit at ${hitAt} ms, ${fwd(blocked.trace[hitAt], blocked.trace[hitAt + 60]).toFixed(2)} m in the next 60 ms`);
  let minGap = Infinity;
  for (const s of blocked.trace) minGap = Math.min(minGap, dist(s.p, wall.p));
  check("parked car: boxes never sink deep into each other", minGap > 3.0, `closest centre distance ${minGap.toFixed(2)} m`);
  const rise = Math.max(...blocked.trace.map((s2) => s2.p[1])) - wall.p[1];
  check("parked car: nothing blew up", blocked.trace.every((s2) => s2.p.every(Number.isFinite)) && rise < 6 && Math.max(...blocked.trace.map((s2) => s2.speed)) <= last.speed * 1.05,
    `highest point ${rise.toFixed(2)} m above the crash`);

  // 2. the same parked car, but not started / finished / spawned on top of us
  const idle = drive(N, (f) => [{ id: 1, f: 0, p: wall.p, q: wall.q, s: false, e: false }]);
  check("car that has not started is not solid", idle.hits === 0 && dist(idle.trace[N - 1].p, last.p) === 0);
  const done = drive(N, (f) => [{ id: 1, f: 50000 + f, p: wall.p, q: wall.q, s: true, e: true }]);
  check("finished car is not solid", done.hits === 0 && dist(done.trace[N - 1].p, last.p) === 0);
  const onTop = drive(N, (f, trace) => {
    const s = trace[Math.max(0, f - 1)] || free.trace[0];
    return [{ id: 1, f: 50000 + f, p: s.p, q: s.q, s: true, e: false }];
  });
  check("car overlapping since the start stays a ghost", onTop.hits === 0 && dist(onTop.trace[N - 1].p, last.p) === 0);
  const popIn = drive(N, (f) => (f < 2990 ? [{ id: 1, f: 50000 + f, p: [wall.p[0], wall.p[1] + 500, wall.p[2]], q: wall.q, s: true, e: false }]
    : [{ id: 1, f: 50000 + f, p: free.trace[f].p, q: free.trace[f].q, s: true, e: false }]));
  check("car that respawns inside us stays a ghost", popIn.hits === 0 && dist(popIn.trace[N - 1].p, last.p) === 0);

  // 3. a slower car ahead on the same line: we should end up following it
  const lead = (f) => {
    const k = Math.min(N - 1, 1500 + Math.floor(f * 0.6)); // 60 % of our pace, starting ahead
    return [{ id: 2, f: 50000 + f, p: free.trace[k].p, q: free.trace[k].q, s: true, e: false }];
  };
  const follow = drive(N, lead);
  const leadEnd = free.trace[Math.min(N - 1, 1500 + Math.floor((N - 1) * 0.6))];
  const behind = dist(free.trace[0].p, leadEnd.p) - dist(follow.trace[0].p, follow.trace[N - 1].p);
  check("slower car ahead: caught and hit", follow.hits > 0, `${follow.hits} hit(s)`);
  check("slower car ahead: we stay behind it", behind > 2.5 && behind < 40, `${behind.toFixed(2)} m behind its centre`);

  // 4. stale data (tab in the background): cars stop being solid
  const stale = drive(N, (f) => (f < 1000 ? parked(f) : null));
  check("no updates for a while: cars are not solid", stale.hits === 0 && dist(stale.trace[N - 1].p, last.p) === 0);

  // 5. glancing hit: a parked car half a car's width off the line
  const right = [1 - 2 * (wall.q[1] ** 2 + wall.q[2] ** 2), 2 * (wall.q[0] * wall.q[1] + wall.q[3] * wall.q[2]), 2 * (wall.q[0] * wall.q[2] - wall.q[3] * wall.q[1])];
  const side = wall.p.map((v, k) => v + right[k] * 1.1);
  const glance = drive(N, (f) => [{ id: 3, f: 50000 + f, p: side, q: wall.q, s: true, e: false }]);
  const top = Math.max(...glance.trace.map((s) => s.speed)), lift = Math.max(...glance.trace.map((s, k) => s.p[1] - free.trace[k].p[1]));
  check("glancing hit: registered", glance.hits > 0, `${glance.hits} hit(s)`);
  check("glancing hit: no energy gained, car not launched", top <= last.speed * 1.05 && lift < 6 && glance.trace.every((s) => s.p.every(Number.isFinite)),
    `top ${top.toFixed(1)} km/h, max lift ${lift.toFixed(2)} m, ends ${dist(glance.trace[N - 1].p, side).toFixed(1)} m from it at ${glance.trace[N - 1].speed.toFixed(1)} km/h`);

  // 6. knocks reported by other players
  const far = (f) => [{ id: 4, f: 50000 + f, p: [wall.p[0], wall.p[1] + 300, wall.p[2]], q: wall.q, s: true, e: false }];
  const side2 = right.map((v) => v * 6);
  let sentAt = -1;
  const knocked = drive(N, (f) => {
    if (f >= 2000 && sentAt < 0) { sentAt = f; ptc.knock({ from: 4, dv: side2, r: [0, 0.5, 0] }); ptc.knock({ from: 4, dv: side2, r: [0, 0.5, 0] }); }
    if (f === 2400) { ptc.knock({ from: 4, dv: [NaN, 0, 0], r: [0, 0, 0] }); ptc.knock({ from: 99, dv: side2, r: [0, 0, 0] }); ptc.knock({ from: 4, dv: [1, 2], r: [0, 0, 0] }); }
    return far(f);
  });
  const sideways = (s2, k) => (s2.p[0] - free.trace[k].p[0]) * right[0] + (s2.p[1] - free.trace[k].p[1]) * right[1] + (s2.p[2] - free.trace[k].p[2]) * right[2];
  const drift = sideways(knocked.trace[sentAt + 150], sentAt + 150);
  check("knock from another player: our car is pushed that way, once", ptc.knocked === 1 && drift > 0.3 && drift < 1.5, `${drift.toFixed(2)} m sideways after 150 ms, ${ptc.knocked} applied`);
  check("knock: bad or unknown-sender messages change nothing", ptc.knocked === 1 && knocked.trace.every((s2) => s2.p.every(Number.isFinite)));
  const huge = drive(2500, (f) => { if (f === 2000) ptc.knock({ from: 4, dv: [0, 0, 5000], r: [0, 0, 0] }); return far(f); });
  const jump = Math.max(...huge.trace.slice(2000, 2020).map((s2, k) => Math.abs(s2.speed - huge.trace[1999 + k].speed)));
  check("knock: an absurd one is capped", ptc.knocked === 2 && jump < 31 * 3.6, `largest 1 ms speed change ${jump.toFixed(1)} km/h`);

  // 7. the crash is reported for the other car, and settled once per pair
  const reports = [];
  globalThis.self = globalThis; const post = globalThis.postMessage;
  globalThis.postMessage = (m) => { if (m && m.messageType === "ptcHit") reports.push(m); };
  drive(N, parked);
  const first = reports[0];
  check("crash: the car we hit is told, pushed along our direction of travel", !!first && first.to === 1 && fwd({ p: [0, 0, 0] }, { p: first.dv }) > 0,
    first ? `knock of ${Math.hypot(...first.dv).toFixed(1)} m/s` : "no report");
  reports.length = 0;
  drive(N, (f) => { if (f % 40 === 0) ptc.knock({ from: 1, dv: [0, 0, 0], r: [0, 0, 0] }); return parked(f); });
  check("crash: no knock back to a car that has just knocked us", reports.length === 0, `${reports.length} report(s)`);
  globalThis.postMessage = post;

  console.log(failed ? `${failed} check(s) failed` : "all checks passed");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
