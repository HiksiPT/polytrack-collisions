// Car Collisions for PolyTrack 0.6.3 (PolyModLoader).
// Makes the cars of the other players in a multiplayer session solid.
//
// Every client simulates only its own car, so this is done per client: the
// simulation worker (see worker-runtime.js) pushes the player's car off the
// other cars as they are drawn here. This file feeds the worker those cars,
// keeps the session to players who run the same version of the mod, and keeps
// collision runs out of the records.

const { PolyMod, MixinType } = await import(new URL("PolyTypes.js", document.baseURI).href);

const WORKER_RUNTIME = "// Car Collisions: simulation-worker side.\n// Injected into PolyTrack's simulation worker by the mod loader. The physics\n// WASM is left untouched; after each 1 ms physics step this reads the player's\n// rigid body straight from the WASM heap, tests it against the other players'\n// cars (as they are drawn on this client) and writes the resulting velocity\n// change back into the body.\n(function () {\n  \"use strict\";\n  if (self.__ptc) return;\n\n  // Collision box of a car, in the frame of the position/quaternion the game\n  // reports for it. Derived from the game's own collision hull (x +-0.753,\n  // y -0.346..0.378, z -1.976..1.670, drawn 0.6 above the body origin),\n  // widened to cover the wheels.\n  var H = [0.85, 0.44, 1.823];\n  var C = [0, 0.54, -0.153];\n  // The worker swaps Math for its own deterministic one, which throws until\n  // its WASM has compiled: nothing here may call Math while the script loads.\n  var REACH = 2 * (H[0] * H[0] + H[1] * H[1] + H[2] * H[2]) ** 0.5;\n\n  var RESTITUTION = 0.25; // bounce on impacts faster than 1 m/s\n  var FRICTION = 0.3;\n  var SLOP = 0.01; // penetration tolerated without push-out, m\n  var BIAS_GAIN = 20; // push-out speed per metre of penetration, 1/s\n  var BIAS_MAX = 2; // m/s\n  var LEVER = 0.3; // how much of the vertical lever arm is kept (less rolling)\n  var MAX_DV = 40; // largest velocity change from one step, m/s\n  var CLEAR_GAP = 0.15; // m\n  var CLEAR_STEPS = 150; // steps (ms) apart before a car becomes solid\n  var DEEP = 1.0; // deeper than this means a teleport, not a crash\n  var STALE_MS = 300;\n\n  var ptc = {\n    realtime: null, // set from the worker's Init message\n    now: function () { return performance.timeOrigin + performance.now(); },\n    hits: 0,\n  };\n  self.__ptc = ptc;\n\n  var remotes = new Map(); // player id -> record\n  var lastMessage = -1e12;\n  var byId = new Map(); // car id -> float index of the body origin\n  var bodies = []; // float indices of every dynamic body found by the last scan\n  var stepsSinceScan = 0;\n\n  var lastFrames = -1, lastPos = null, lastCar = -1;\n  var dMin = null;\n  var pendingHits = 0, pendingMax = 0, lastReport = 0;\n\n  var f4 = new Float32Array(3), u4 = new Uint8Array(f4.buffer);\n\n  // ---- finding car bodies in the heap -------------------------------------\n  // Offsets are those of Bullet's btRigidBody, relative to the origin of its\n  // world transform (float index i):\n  //   i-12..i-2  rotation rows\n  //   i+28..30   anisotropic friction i+53..63  inverse inertia (world) rows\n  //   i+65..67   linear velocity      i+69..71  angular velocity\n  //   i+73       inverse mass         i+74..76  linear factor\n  //   i+78..80   gravity force        i+82..84  gravity acceleration\n  function isBody(f, i) {\n    if (f[i + 28] !== 1 || f[i + 29] !== 1 || f[i + 30] !== 1) return false;\n    if (f[i + 74] !== 1 || f[i + 75] !== 1 || f[i + 76] !== 1) return false;\n    var im = f[i + 73];\n    if (!(im > 0 && im < 10)) return false;\n    var g = f[i + 83];\n    if (!(g < 0) || Math.abs(f[i + 79] * im - g) > 1e-3) return false;\n    var n = f[i - 12] * f[i - 12] + f[i - 11] * f[i - 11] + f[i - 10] * f[i - 10];\n    var m = f[i - 8] * f[i - 8] + f[i - 7] * f[i - 7] + f[i - 6] * f[i - 6];\n    return Math.abs(n - 1) < 1e-3 && Math.abs(m - 1) < 1e-3;\n  }\n\n  function scan(M) {\n    var f = M.HEAPF32, end = f.length - 90, out = [];\n    for (var i = 12; i < end; i++) {\n      if (f[i + 28] === 1 && isBody(f, i)) out.push(i);\n    }\n    bodies = out;\n    stepsSinceScan = 0;\n    byId.forEach(function (i, id) { if (out.indexOf(i) < 0) byId.delete(id); });\n    return out;\n  }\n\n  function unassigned() {\n    var taken = [];\n    byId.forEach(function (i) { taken.push(i); });\n    return bodies.filter(function (i) { return taken.indexOf(i) < 0; });\n  }\n\n  ptc.attach = function (M) {\n    if (M.__ptcAttached) return;\n    M.__ptcAttached = true;\n    var create = M._createCarModel, destroy = M._deleteCarModel;\n    M._createCarModel = function (id) {\n      var r = create.apply(this, arguments);\n      try {\n        if (ptc.realtime !== false) {\n          byId.delete(id);\n          scan(M);\n          var fresh = unassigned();\n          if (fresh.length === 1) byId.set(id, fresh[0]);\n        }\n      } catch (e) { console.error(\"[Car Collisions]\", e); }\n      return r;\n    };\n    M._deleteCarModel = function (id) {\n      byId.delete(id);\n      return destroy.apply(this, arguments);\n    };\n  };\n\n  function locate(M, id, px, py, pz) {\n    var f = M.HEAPF32, i = byId.get(id);\n    if (i !== undefined && f[i] === px && f[i + 1] === py && f[i + 2] === pz && isBody(f, i)) return i;\n    byId.delete(id);\n    if (stepsSinceScan > 2000 || !bodies.length) scan(M);\n    var match = unassigned().filter(function (k) {\n      return f[k] === px && f[k + 1] === py && f[k + 2] === pz && isBody(f, k);\n    });\n    if (match.length !== 1) return -1;\n    byId.set(id, match[0]);\n    return match[0];\n  }\n\n  // ---- other players ------------------------------------------------------\n  function unsolid(r) { r.solid = false; r.clear = 0; r.touching = false; }\n\n  ptc.remote = function (msg) {\n    lastMessage = msg.t;\n    var seen = new Set();\n    for (var k = 0; k < msg.cars.length; k++) {\n      var c = msg.cars[k], r = remotes.get(c.id);\n      seen.add(c.id);\n      if (!r) {\n        r = { id: c.id, t: msg.t, changed: msg.t, frames: c.f, p: c.p, q: c.q, v: [0, 0, 0], w: [0, 0, 0],\n          ok: false, solid: false, clear: 0, touching: false };\n        remotes.set(c.id, r);\n      } else if (c.f > r.frames) {\n        var dt = (c.f - r.frames) / 1000;\n        var dx = c.p[0] - r.p[0], dy = c.p[1] - r.p[1], dz = c.p[2] - r.p[2];\n        var speed = Math.sqrt(r.v[0] * r.v[0] + r.v[1] * r.v[1] + r.v[2] * r.v[2]);\n        if (Math.sqrt(dx * dx + dy * dy + dz * dz) > 3 + 3 * speed * dt) {\n          r.v = [0, 0, 0]; r.w = [0, 0, 0]; unsolid(r); // respawned\n        } else {\n          r.v = [dx / dt, dy / dt, dz / dt];\n          // angular velocity from the rotation between the two samples\n          var a = c.q, b = r.q;\n          var qw = a[3] * b[3] + a[0] * b[0] + a[1] * b[1] + a[2] * b[2];\n          var qx = a[0] * b[3] - a[3] * b[0] - a[1] * b[2] + a[2] * b[1];\n          var qy = a[1] * b[3] - a[3] * b[1] - a[2] * b[0] + a[0] * b[2];\n          var qz = a[2] * b[3] - a[3] * b[2] - a[0] * b[1] + a[1] * b[0];\n          var s = (qw < 0 ? -2 : 2) / dt;\n          r.w = [qx * s, qy * s, qz * s];\n        }\n        r.p = c.p; r.q = c.q; r.frames = c.f; r.t = msg.t; r.changed = msg.t;\n      } else if (c.f < r.frames) {\n        r.p = c.p; r.q = c.q; r.frames = c.f; r.t = msg.t; r.changed = msg.t;\n        r.v = [0, 0, 0]; r.w = [0, 0, 0]; unsolid(r); // restarted\n      } else {\n        r.p = c.p; r.q = c.q; r.t = msg.t;\n        if (msg.t - r.changed > 60) { r.v = [0, 0, 0]; r.w = [0, 0, 0]; }\n      }\n      r.ok = !!c.s && !c.e && msg.t - r.changed <= STALE_MS;\n      if (!r.ok) unsolid(r);\n    }\n    remotes.forEach(function (r, id) { if (!seen.has(id)) remotes.delete(id); });\n  };\n\n  // ---- geometry -----------------------------------------------------------\n  function makeBox() { return { c: [0, 0, 0], a: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] }; }\n  var boxA = makeBox(), boxB = makeBox();\n\n  // m: rotation, row-major 3x3\n  function setBox(box, px, py, pz, m) {\n    box.c[0] = px + m[0] * C[0] + m[1] * C[1] + m[2] * C[2];\n    box.c[1] = py + m[3] * C[0] + m[4] * C[1] + m[5] * C[2];\n    box.c[2] = pz + m[6] * C[0] + m[7] * C[1] + m[8] * C[2];\n    for (var k = 0; k < 3; k++) { box.a[k][0] = m[k]; box.a[k][1] = m[3 + k]; box.a[k][2] = m[6 + k]; }\n  }\n\n  function quatToMat(q, m) {\n    var x = q[0], y = q[1], z = q[2], w = q[3];\n    m[0] = 1 - 2 * (y * y + z * z); m[1] = 2 * (x * y - w * z); m[2] = 2 * (x * z + w * y);\n    m[3] = 2 * (x * y + w * z); m[4] = 1 - 2 * (x * x + z * z); m[5] = 2 * (y * z - w * x);\n    m[6] = 2 * (x * z - w * y); m[7] = 2 * (y * z + w * x); m[8] = 1 - 2 * (x * x + y * y);\n  }\n\n  function radius(box, lx, ly, lz) {\n    var a = box.a;\n    return H[0] * Math.abs(a[0][0] * lx + a[0][1] * ly + a[0][2] * lz) +\n      H[1] * Math.abs(a[1][0] * lx + a[1][1] * ly + a[1][2] * lz) +\n      H[2] * Math.abs(a[2][0] * lx + a[2][1] * ly + a[2][2] * lz);\n  }\n\n  var sat = { gap: 0, depth: 0, n: [0, 0, 0] };\n\n  // Separating-axis test. Returns true when the boxes overlap; sat.n then\n  // points from B towards A. Otherwise sat.gap is a lower bound on the gap.\n  function overlap(A, B) {\n    var dx = B.c[0] - A.c[0], dy = B.c[1] - A.c[1], dz = B.c[2] - A.c[2];\n    var best = Infinity, gap = 0, hit = true;\n    function axis(lx, ly, lz, edge) {\n      var len = Math.sqrt(lx * lx + ly * ly + lz * lz);\n      if (len < 1e-6) return;\n      lx /= len; ly /= len; lz /= len;\n      var dist = dx * lx + dy * ly + dz * lz;\n      var ov = radius(A, lx, ly, lz) + radius(B, lx, ly, lz) - Math.abs(dist);\n      if (ov < 0) { hit = false; if (-ov > gap) gap = -ov; return; }\n      var score = edge ? ov * 1.05 + 0.002 : ov;\n      if (score < best) {\n        best = score; sat.depth = ov;\n        var s = dist > 0 ? -1 : 1;\n        sat.n[0] = lx * s; sat.n[1] = ly * s; sat.n[2] = lz * s;\n      }\n    }\n    var i, j;\n    for (i = 0; i < 3; i++) axis(A.a[i][0], A.a[i][1], A.a[i][2], false);\n    for (i = 0; i < 3; i++) axis(B.a[i][0], B.a[i][1], B.a[i][2], false);\n    for (i = 0; i < 3; i++) for (j = 0; j < 3; j++) {\n      var p = A.a[i], q = B.a[j];\n      axis(p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0], true);\n    }\n    sat.gap = gap;\n    return hit;\n  }\n\n  var cp = [0, 0, 0];\n\n  function addCornersInside(P, Q) {\n    var n = 0;\n    for (var m = 0; m < 8; m++) {\n      var sx = m & 1 ? H[0] : -H[0], sy = m & 2 ? H[1] : -H[1], sz = m & 4 ? H[2] : -H[2];\n      var x = P.c[0] + P.a[0][0] * sx + P.a[1][0] * sy + P.a[2][0] * sz;\n      var y = P.c[1] + P.a[0][1] * sx + P.a[1][1] * sy + P.a[2][1] * sz;\n      var z = P.c[2] + P.a[0][2] * sx + P.a[1][2] * sy + P.a[2][2] * sz;\n      var ex = x - Q.c[0], ey = y - Q.c[1], ez = z - Q.c[2], inside = true;\n      for (var k = 0; k < 3; k++) {\n        if (Math.abs(ex * Q.a[k][0] + ey * Q.a[k][1] + ez * Q.a[k][2]) > H[k] + 0.02) { inside = false; break; }\n      }\n      if (inside) { cp[0] += x; cp[1] += y; cp[2] += z; n++; }\n    }\n    return n;\n  }\n\n  function support(box, dx, dy, dz, out) {\n    out[0] = box.c[0]; out[1] = box.c[1]; out[2] = box.c[2];\n    for (var k = 0; k < 3; k++) {\n      var a = box.a[k], s = (a[0] * dx + a[1] * dy + a[2] * dz) >= 0 ? H[k] : -H[k];\n      out[0] += a[0] * s; out[1] += a[1] * s; out[2] += a[2] * s;\n    }\n  }\n\n  var sA = [0, 0, 0], sB = [0, 0, 0];\n\n  function contactPoint(A, B) {\n    cp[0] = cp[1] = cp[2] = 0;\n    var n = addCornersInside(A, B) + addCornersInside(B, A);\n    if (n) { cp[0] /= n; cp[1] /= n; cp[2] /= n; return; }\n    support(A, -sat.n[0], -sat.n[1], -sat.n[2], sA);\n    support(B, sat.n[0], sat.n[1], sat.n[2], sB);\n    cp[0] = (sA[0] + sB[0]) / 2; cp[1] = (sA[1] + sB[1]) / 2; cp[2] = (sA[2] + sB[2]) / 2;\n  }\n\n  // ---- response -----------------------------------------------------------\n  var mA = new Float64Array(9), mB = new Float64Array(9), qB = [0, 0, 0, 1];\n\n  // Treats the other car as an obstacle moving with its own velocity: on this\n  // client only the player's own car can be pushed.\n  function resolve(f, i, r, bx, by, bz) {\n    var n = sat.n, vx = f[i + 65], vy = f[i + 66], vz = f[i + 67];\n    var wx = f[i + 69], wy = f[i + 70], wz = f[i + 71], im = f[i + 73];\n    var I0 = f[i + 53], I1 = f[i + 54], I2 = f[i + 55], I3 = f[i + 57], I4 = f[i + 58], I5 = f[i + 59],\n      I6 = f[i + 61], I7 = f[i + 62], I8 = f[i + 63];\n\n    var rx = cp[0] - f[i], ry = cp[1] - f[i + 1], rz = cp[2] - f[i + 2];\n    var ux = mA[1], uy = mA[4], uz = mA[7];\n    var h = (rx * ux + ry * uy + rz * uz) * (1 - LEVER);\n    rx -= ux * h; ry -= uy * h; rz -= uz * h;\n    var sx = cp[0] - bx, sy = cp[1] - by, sz = cp[2] - bz;\n\n    function relative(out) {\n      out[0] = vx + wy * rz - wz * ry - (r.v[0] + r.w[1] * sz - r.w[2] * sy);\n      out[1] = vy + wz * rx - wx * rz - (r.v[1] + r.w[2] * sx - r.w[0] * sz);\n      out[2] = vz + wx * ry - wy * rx - (r.v[2] + r.w[0] * sy - r.w[1] * sx);\n    }\n    // effective inverse mass along d, and the angular change per unit impulse\n    var ang = [0, 0, 0];\n    function kAlong(dx, dy, dz) {\n      var cx = ry * dz - rz * dy, cy = rz * dx - rx * dz, cz = rx * dy - ry * dx;\n      ang[0] = I0 * cx + I1 * cy + I2 * cz; ang[1] = I3 * cx + I4 * cy + I5 * cz; ang[2] = I6 * cx + I7 * cy + I8 * cz;\n      return im + dx * (ang[1] * rz - ang[2] * ry) + dy * (ang[2] * rx - ang[0] * rz) + dz * (ang[0] * ry - ang[1] * rx);\n    }\n\n    var rel = [0, 0, 0];\n    relative(rel);\n    var vn = rel[0] * n[0] + rel[1] * n[1] + rel[2] * n[2];\n    var target = vn < -1 ? -RESTITUTION * vn : 0;\n    var bias = Math.min(BIAS_MAX, BIAS_GAIN * Math.max(0, sat.depth - SLOP));\n    if (bias > target) target = bias;\n    var dv = target - vn;\n    if (!(dv > 0)) return 0;\n    if (dv > MAX_DV) dv = MAX_DV;\n\n    var K = kAlong(n[0], n[1], n[2]);\n    if (!(K > 1e-9)) return 0;\n    var jn = dv / K;\n    vx += n[0] * jn * im; vy += n[1] * jn * im; vz += n[2] * jn * im;\n    wx += ang[0] * jn; wy += ang[1] * jn; wz += ang[2] * jn;\n\n    relative(rel);\n    var d = rel[0] * n[0] + rel[1] * n[1] + rel[2] * n[2];\n    var tx = rel[0] - n[0] * d, ty = rel[1] - n[1] * d, tz = rel[2] - n[2] * d;\n    var vt = Math.sqrt(tx * tx + ty * ty + tz * tz);\n    if (vt > 1e-3) {\n      tx /= vt; ty /= vt; tz /= vt;\n      var Kt = kAlong(tx, ty, tz);\n      if (Kt > 1e-9) {\n        var jt = Math.min(FRICTION * jn, vt / Kt);\n        vx -= tx * jt * im; vy -= ty * jt * im; vz -= tz * jt * im;\n        wx -= ang[0] * jt; wy -= ang[1] * jt; wz -= ang[2] * jt;\n      }\n    }\n    if (!(isFinite(vx) && isFinite(vy) && isFinite(vz) && isFinite(wx) && isFinite(wy) && isFinite(wz))) return 0;\n    f[i + 65] = vx; f[i + 66] = vy; f[i + 67] = vz;\n    f[i + 69] = wx; f[i + 70] = wy; f[i + 71] = wz;\n    return dv;\n  }\n\n  // Called after every physics step of every car; `car` is the worker's own\n  // record of it and `ptr` the state buffer the step has just filled.\n  ptc.afterStep = function (M, car, ptr) {\n    if (!car || car.userControls == null) return;\n    if (!remotes.size) { lastPos = null; return; }\n\n    var u8 = M.HEAPU8;\n    var frames = u8[ptr + 4] | (u8[ptr + 5] << 8) | (u8[ptr + 6] << 16);\n    var flags = u8[ptr + 11];\n    var off = ptr + 12 + (flags & 2 ? 3 : 0) + 2;\n    u4[0] = u8[off]; u4[1] = u8[off + 1]; u4[2] = u8[off + 2]; u4[3] = u8[off + 3];\n    u4[4] = u8[off + 4]; u4[5] = u8[off + 5]; u4[6] = u8[off + 6]; u4[7] = u8[off + 7];\n    u4[8] = u8[off + 8]; u4[9] = u8[off + 9]; u4[10] = u8[off + 10]; u4[11] = u8[off + 11];\n    var px = f4[0], py = f4[1], pz = f4[2];\n    stepsSinceScan++;\n\n    // Steps run in batches that catch up with the clock, so the wall time a\n    // step stands for is taken from the most caught-up step seen recently.\n    var now = ptc.now(), d = now - frames;\n    if (dMin === null || d < dMin || d - dMin > 100) dMin = d; else dMin += 0.002;\n    var T = frames + dMin;\n\n    var jumped = lastPos === null || car.id !== lastCar || frames < lastFrames ||\n      Math.abs(px - lastPos[0]) + Math.abs(py - lastPos[1]) + Math.abs(pz - lastPos[2]) > 1.5;\n    lastFrames = frames; lastCar = car.id;\n    if (lastPos === null) lastPos = [px, py, pz]; else { lastPos[0] = px; lastPos[1] = py; lastPos[2] = pz; }\n    if (jumped) remotes.forEach(unsolid);\n\n    if (!(flags & 1) || (flags & 2)) return; // not started, or finished\n    if (now - lastMessage > STALE_MS) { remotes.forEach(unsolid); return; }\n\n    var i = -1, f = null, boxReady = false;\n    remotes.forEach(function (r) {\n      if (!r.ok) return;\n      var age = (T - r.t) / 1000;\n      if (age > STALE_MS / 1000) { unsolid(r); return; }\n      if (age < -0.02) age = -0.02; else if (age > 0.05) age = 0.05;\n      var bx = r.p[0] + r.v[0] * age, by = r.p[1] + r.v[1] * age, bz = r.p[2] + r.v[2] * age;\n      var dx = bx - px, dy = by - py, dz = bz - pz;\n      var dist = Math.sqrt(dx * dx + dy * dy + dz * dz);\n      if (dist > REACH + 0.5) {\n        r.touching = false;\n        if (!r.solid && ++r.clear >= CLEAR_STEPS) r.solid = true;\n        return;\n      }\n      if (i < 0) {\n        i = locate(M, car.id, px, py, pz);\n        if (i < 0) return;\n        f = M.HEAPF32;\n      }\n      if (!boxReady) {\n        mA[0] = f[i - 12]; mA[1] = f[i - 11]; mA[2] = f[i - 10];\n        mA[3] = f[i - 8]; mA[4] = f[i - 7]; mA[5] = f[i - 6];\n        mA[6] = f[i - 4]; mA[7] = f[i - 3]; mA[8] = f[i - 2];\n        setBox(boxA, px, py, pz, mA);\n        boxReady = true;\n      }\n      // turn the other car by its angular velocity over the same interval\n      var q = r.q, hx = r.w[0] * age / 2, hy = r.w[1] * age / 2, hz = r.w[2] * age / 2;\n      qB[0] = q[0] + hx * q[3] + hy * q[2] - hz * q[1];\n      qB[1] = q[1] + hy * q[3] + hz * q[0] - hx * q[2];\n      qB[2] = q[2] + hz * q[3] + hx * q[1] - hy * q[0];\n      qB[3] = q[3] - hx * q[0] - hy * q[1] - hz * q[2];\n      var ql = Math.sqrt(qB[0] * qB[0] + qB[1] * qB[1] + qB[2] * qB[2] + qB[3] * qB[3]) || 1;\n      qB[0] /= ql; qB[1] /= ql; qB[2] /= ql; qB[3] /= ql;\n      quatToMat(qB, mB);\n      setBox(boxB, bx, by, bz, mB);\n\n      if (!overlap(boxA, boxB)) {\n        r.touching = false;\n        if (r.solid) return;\n        if (sat.gap > CLEAR_GAP) { if (++r.clear >= CLEAR_STEPS) r.solid = true; } else r.clear = 0;\n        return;\n      }\n      if (!r.solid) { r.clear = 0; return; }\n      if (sat.depth > DEEP) { unsolid(r); return; } // appeared inside us\n      contactPoint(boxA, boxB);\n      var dv = resolve(f, i, r, bx, by, bz);\n      if (dv > 0) {\n        if (!r.touching) { ptc.hits++; pendingHits++; }\n        if (dv > pendingMax) pendingMax = dv;\n      }\n      r.touching = true;\n    });\n\n    if (pendingHits && now - lastReport > 100) {\n      try { self.postMessage({ messageType: \"ptcHit\", count: pendingHits, speed: pendingMax }); } catch (e) { /* not in a worker */ }\n      pendingHits = 0; pendingMax = 0; lastReport = now;\n    }\n  };\n\n  // for tests\n  ptc._debug = { remotes: remotes, byId: byId, scan: scan, box: { H: H, C: C } };\n})();\n";

const STEP_RETURN = "return new Uint8Array(t.HEAPU8.buffer, i, 227).slice().buffer;";
const WORKER_MIXINS = [
  { type: MixinType.INSERT, token: "const $o = [];", func: WORKER_RUNTIME },
  {
    type: MixinType.INSERT,
    token: "const r = i.data;",
    func: `if (r && r.messageType === "ptc") { self.__ptc.remote(r); return; }
      if (r && "isRealtime" in r) self.__ptc.realtime = !!r.isRealtime;`,
  },
  { type: MixinType.INSERT, token: "PolyTrackPhysics().then(async (t) => {", func: "self.__ptc.attach(t);" },
  {
    type: MixinType.REPLACEBETWEEN,
    tokenStart: STEP_RETURN,
    tokenEnd: STEP_RETURN,
    func: "self.__ptc.afterStep(t, e, i); " + STEP_RETURN,
  },
];

const HOST_CHECK = "if (!o.isModsVanillaCompatible)";
const CLIENT_CHECK = "if (!t.isModsVanillaCompatible)";

class CarCollisions extends PolyMod {
  // Reported by the loader as "not vanilla compatible": unmodded hosts turn
  // players with this mod away, and the other way round.
  touchingPhysics = true;

  #pml;
  #native = null;
  #game = null;
  #workers = new Set();
  #simUrls = new Set();
  #sending = false;
  #failed = false;
  stats = { hits: 0, lastSpeed: 0 };

  constructor() {
    super();
    // PolyMod assigns its hooks as own properties, so they are set the same way.
    this.preInit = (pml) => this.#preInit(pml);
    this.init = (pml) => this.#init(pml);
  }

  get tag() {
    return `${this.modID}:${this.modVersion}`;
  }

  // Both sides of a join must run this mod in the same version, plus any
  // other physics-changing mod this side runs.
  accepts(mods) {
    if (!Array.isArray(mods) || !mods.includes(this.tag)) return false;
    for (const mod of this.#pml.getAllMods()) {
      if (mod !== this && mod.isLoaded && mod.touchingPhysics === true && !mods.includes(`${mod.modID}:${mod.modVersion}`))
        return false;
    }
    return true;
  }

  #preInit(pml) {
    this.#pml = pml;
    const getSimURL = pml.getSimURL, urls = this.#simUrls;
    pml.getSimURL = function (...args) {
      const url = getSimURL.apply(this, args);
      urls.add(String(url));
      return url;
    };
    const NativeWorker = globalThis.Worker, mod = this;
    function CollisionAwareWorker(url, options) {
      const worker = new NativeWorker(url, options);
      try {
        mod.#adopt(worker, String(url));
      } catch (error) {
        console.error("[Car Collisions]", error);
      }
      return worker;
    }
    CollisionAwareWorker.prototype = NativeWorker.prototype;
    globalThis.Worker = CollisionAwareWorker;
  }

  #adopt(worker, url) {
    if (!this.#simUrls.has(url) && !url.includes("simulation_worker")) return;
    this.#workers.add(worker);
    worker.addEventListener("message", (event) => {
      const data = event.data;
      if (data && data.messageType === "ptcHit") {
        this.stats.hits += data.count;
        this.stats.lastSpeed = data.speed;
      }
    });
    const terminate = worker.terminate, workers = this.#workers;
    worker.terminate = function () {
      workers.delete(this);
      return terminate.call(this);
    };
  }

  async #init(pml) {
    this.#pml = pml;
    if (pml.polyVersion !== "0.6.3") throw new Error("Car Collisions requires PolyTrack 0.6.3.");

    // A missing token would break the simulation for everyone, so the worker
    // is checked before anything is registered.
    const source = await fetch(new URL("simulation_worker.bundle.js", document.baseURI)).then((r) => r.text());
    for (const mixin of WORKER_MIXINS) {
      const token = mixin.token ?? mixin.tokenStart;
      if (source.split(token).length !== 2) throw new Error(`Unsupported game build: "${token}" not found once in the simulation worker.`);
    }

    globalThis.__ptCollisions = this;
    pml.registerClassMixin("ii.prototype", "renewInvite", {
      type: MixinType.REPLACEBETWEEN,
      tokenStart: HOST_CHECK,
      tokenEnd: HOST_CHECK,
      func: "if (!globalThis.__ptCollisions.accepts(o.mods))",
    });
    pml.registerClassMixin("vc.prototype", "joinInvite", {
      type: MixinType.REPLACEBETWEEN,
      tokenStart: CLIENT_CHECK,
      tokenEnd: CLIENT_CHECK,
      func: "if (!globalThis.__ptCollisions.accepts(t.mods))",
    });
    for (const mixin of WORKER_MIXINS) pml.registerSimWorkerMixin(mixin);

    // Za: game -> multiplayer session, as: game -> remote cars,
    // ya: game -> whether finished runs are stored and uploaded.
    this.#native = pml.getFromPolyTrack(`({
      watchGames: callback => callback(Za),
      session: game => Za.get(game),
      remotes: game => as.get(game),
      recordsEnabled: game => ya.get(game),
      disableRecords: game => ya.set(game, false)
    })`);
    this.#native.watchGames((sessions) => {
      const set = sessions.set, mod = this;
      sessions.set = function (game, session) {
        mod.#game = game; // the game's constructor registers itself here first
        return set.call(this, game, session);
      };
    });

    const tick = () => {
      requestAnimationFrame(tick);
      if (this.#failed) return;
      try {
        this.#update();
      } catch (error) {
        this.#failed = true;
        console.error("[Car Collisions] stopped:", error);
      }
    };
    requestAnimationFrame(tick);
    console.log(`[Car Collisions] ${this.tag} ready`);
  }

  #update() {
    const native = this.#native, game = this.#game, cars = [];
    if (game && native.session(game)) {
      // A run that was pushed around cannot be replayed from its inputs.
      if (native.recordsEnabled(game)) native.disableRecords(game);
      const remotes = native.remotes(game);
      if (remotes) {
        for (const [id, remote] of remotes) {
          const state = remote.car.getCarState();
          cars.push({
            id,
            f: state.frames,
            p: [state.position.x, state.position.y, state.position.z],
            q: [state.quaternion.x, state.quaternion.y, state.quaternion.z, state.quaternion.w],
            s: state.hasStarted,
            e: state.finishFrames != null,
          });
        }
      }
    }
    if (!cars.length && !this.#sending) return;
    this.#sending = cars.length > 0;
    const message = { messageType: "ptc", t: performance.timeOrigin + performance.now(), cars };
    for (const worker of this.#workers) worker.postMessage(message);
  }
}

export let polyMod = new CarCollisions();
