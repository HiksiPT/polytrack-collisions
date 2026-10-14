// Car Collisions: simulation-worker side.
// Injected into PolyTrack's simulation worker by the mod loader. The physics
// WASM is left untouched; after each 1 ms physics step this reads the player's
// rigid body straight from the WASM heap, tests it against the other players'
// cars (as they are drawn on this client) and writes the resulting velocity
// change back into the body.
(function () {
  "use strict";
  if (self.__ptc) return;

  // Collision box of a car, in the frame of the position/quaternion the game
  // reports for it. Derived from the game's own collision hull (x +-0.753,
  // y -0.346..0.378, z -1.976..1.670, drawn 0.6 above the body origin),
  // widened to cover the wheels.
  var H = [0.85, 0.44, 1.823];
  var C = [0, 0.54, -0.153];
  // The worker swaps Math for its own deterministic one, which throws until
  // its WASM has compiled: nothing here may call Math while the script loads.
  var REACH = 2 * (H[0] * H[0] + H[1] * H[1] + H[2] * H[2]) ** 0.5;

  // Tuned to be lively rather than realistic: cars bounce off each other,
  // spin, and hop a little on a hard hit.
  var RESTITUTION = 0.8; // bounce on impacts faster than 1 m/s
  var MIN_KICK = 2.5; // every real impact separates the cars at least this fast, m/s
  var FRICTION = 0.15;
  var POP = 0.2, POP_MAX = 4; // share of an impact that also goes upwards, and its cap in m/s
  var KNOCK = 0.5; // how much of our own bounce the car we hit receives
  var KNOCK_MAX = 30; // largest knock accepted from another player, m/s
  var PAIR_MS = 250; // one crash is settled once per pair of cars within this time

  // A pinched car (landed on while on the ground, or squeezed between two cars) is
  // flung out sideways, like a pinch in Rocket League.
  var PINCH_SPEED = 35; // m/s, plus the speed of the squeeze
  var PINCH_GAIN = 20; // m/s: a car already going fast still gets at least this much faster
  var PINCH_MAX = 80; // m/s
  var PINCH_UP = 6; // m/s upwards on top of that
  var PINCH_SPIN = 4; // rad/s about the vertical
  var PINCH_PRESS = 2; // m/s: slower contacts are not a pinch
  var PINCH_DOWN = 0.6; // how vertical a push from above must be (1 = straight down)
  var PINCH_OPPOSED = -0.5; // how opposed two pushes must be (-1 = head on)
  var PINCH_MS = 500; // a car is flung at most this often
  var SLOP = 0.01; // penetration tolerated without push-out, m
  var BIAS_GAIN = 20; // push-out speed per metre of penetration, 1/s
  var BIAS_MAX = 2; // m/s
  var LEVER = 0.7; // how much of the vertical lever arm is kept (lower = less rolling)
  var MAX_DV = 40; // largest velocity change from one step, m/s
  var CLEAR_GAP = 0.15; // m
  var CLEAR_STEPS = 150; // steps (ms) apart before a car becomes solid
  var DEEP = 1.0; // deeper than this means a teleport, not a crash
  var STALE_MS = 300;

  var ptc = {
    realtime: null, // set from the worker's Init message
    now: function () { return performance.timeOrigin + performance.now(); },
    hits: 0, // contacts of our car with another car
    knocked: 0, // knocks received from other players
    pinches: 0, // times our car was flung out of a pinch
  };
  self.__ptc = ptc;

  var remotes = new Map(); // player id -> record
  var lastMessage = -1e12;
  var byId = new Map(); // car id -> float index of the body origin
  var bodies = []; // float indices of every dynamic body found by the last scan
  var stepsSinceScan = 0;

  var lastFrames = -1, lastPos = null, lastCar = -1;
  var dMin = null;
  var knocks = []; // knocks from other players, applied on the next step
  var pushes = []; // velocity changes asked for by other mods on this machine
  var kick = 0; // velocity change of our car's centre from the last resolve()
  var pressed = 0; // how fast the other car was closing in, from the last resolve()
  var pinchUntil = 0;
  var recentKnocks = []; // { from, dv, at } of the last moments, to spot a squeeze

  var f4 = new Float32Array(3), u4 = new Uint8Array(f4.buffer);

  // ---- finding car bodies in the heap -------------------------------------
  // Offsets are those of Bullet's btRigidBody, relative to the origin of its
  // world transform (float index i):
  //   i-12..i-2  rotation rows
  //   i+28..30   anisotropic friction i+53..63  inverse inertia (world) rows
  //   i+65..67   linear velocity      i+69..71  angular velocity
  //   i+73       inverse mass         i+74..76  linear factor
  //   i+78..80   gravity force        i+82..84  gravity acceleration
  function isBody(f, i) {
    if (f[i + 28] !== 1 || f[i + 29] !== 1 || f[i + 30] !== 1) return false;
    if (f[i + 74] !== 1 || f[i + 75] !== 1 || f[i + 76] !== 1) return false;
    var im = f[i + 73];
    if (!(im > 0 && im < 10)) return false;
    var g = f[i + 83];
    if (!(g < 0) || Math.abs(f[i + 79] * im - g) > 1e-3) return false;
    var n = f[i - 12] * f[i - 12] + f[i - 11] * f[i - 11] + f[i - 10] * f[i - 10];
    var m = f[i - 8] * f[i - 8] + f[i - 7] * f[i - 7] + f[i - 6] * f[i - 6];
    return Math.abs(n - 1) < 1e-3 && Math.abs(m - 1) < 1e-3;
  }

  function scan(M) {
    var f = M.HEAPF32, end = f.length - 90, out = [];
    for (var i = 12; i < end; i++) {
      if (f[i + 28] === 1 && isBody(f, i)) out.push(i);
    }
    bodies = out;
    stepsSinceScan = 0;
    byId.forEach(function (i, id) { if (out.indexOf(i) < 0) byId.delete(id); });
    return out;
  }

  function unassigned() {
    var taken = [];
    byId.forEach(function (i) { taken.push(i); });
    return bodies.filter(function (i) { return taken.indexOf(i) < 0; });
  }

  ptc.attach = function (M) {
    if (M.__ptcAttached) return;
    M.__ptcAttached = true;
    var create = M._createCarModel, destroy = M._deleteCarModel;
    M._createCarModel = function (id) {
      var r = create.apply(this, arguments);
      try {
        if (ptc.realtime !== false) {
          byId.delete(id);
          scan(M);
          var fresh = unassigned();
          if (fresh.length === 1) byId.set(id, fresh[0]);
        }
      } catch (e) { console.error("[Car Collisions]", e); }
      return r;
    };
    M._deleteCarModel = function (id) {
      byId.delete(id);
      return destroy.apply(this, arguments);
    };
  };

  function locate(M, id, px, py, pz) {
    var f = M.HEAPF32, i = byId.get(id);
    if (i !== undefined && f[i] === px && f[i + 1] === py && f[i + 2] === pz && isBody(f, i)) return i;
    byId.delete(id);
    if (stepsSinceScan > 2000 || !bodies.length) scan(M);
    var match = unassigned().filter(function (k) {
      return f[k] === px && f[k + 1] === py && f[k + 2] === pz && isBody(f, k);
    });
    if (match.length !== 1) return -1;
    byId.set(id, match[0]);
    return match[0];
  }

  // ---- other players ------------------------------------------------------
  function unsolid(r) { r.solid = false; r.clear = 0; r.touching = false; }

  ptc.remote = function (msg) {
    lastMessage = msg.t;
    var seen = new Set();
    for (var k = 0; k < msg.cars.length; k++) {
      var c = msg.cars[k], r = remotes.get(c.id);
      seen.add(c.id);
      if (!r) {
        r = { id: c.id, t: msg.t, changed: msg.t, frames: c.f, p: c.p, q: c.q, v: [0, 0, 0], w: [0, 0, 0],
          ok: false, solid: false, clear: 0, touching: false, mute: 0, quiet: 0, knocked: -1e12 };
        remotes.set(c.id, r);
      } else if (c.f > r.frames) {
        var dt = (c.f - r.frames) / 1000;
        var dx = c.p[0] - r.p[0], dy = c.p[1] - r.p[1], dz = c.p[2] - r.p[2];
        var speed = Math.sqrt(r.v[0] * r.v[0] + r.v[1] * r.v[1] + r.v[2] * r.v[2]);
        if (Math.sqrt(dx * dx + dy * dy + dz * dz) > 3 + 3 * speed * dt) {
          r.v = [0, 0, 0]; r.w = [0, 0, 0]; unsolid(r); // respawned
        } else {
          r.v = [dx / dt, dy / dt, dz / dt];
          // angular velocity from the rotation between the two samples
          var a = c.q, b = r.q;
          var qw = a[3] * b[3] + a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
          var qx = a[0] * b[3] - a[3] * b[0] - a[1] * b[2] + a[2] * b[1];
          var qy = a[1] * b[3] - a[3] * b[1] - a[2] * b[0] + a[0] * b[2];
          var qz = a[2] * b[3] - a[3] * b[2] - a[0] * b[1] + a[1] * b[0];
          var s = (qw < 0 ? -2 : 2) / dt;
          r.w = [qx * s, qy * s, qz * s];
        }
        r.p = c.p; r.q = c.q; r.frames = c.f; r.t = msg.t; r.changed = msg.t;
      } else if (c.f < r.frames) {
        r.p = c.p; r.q = c.q; r.frames = c.f; r.t = msg.t; r.changed = msg.t;
        r.v = [0, 0, 0]; r.w = [0, 0, 0]; unsolid(r); // restarted
      } else {
        r.p = c.p; r.q = c.q; r.t = msg.t;
        if (msg.t - r.changed > 60) { r.v = [0, 0, 0]; r.w = [0, 0, 0]; }
      }
      r.ok = !!c.s && !c.e && msg.t - r.changed <= STALE_MS;
      if (!r.ok) unsolid(r);
    }
    remotes.forEach(function (r, id) { if (!seen.has(id)) remotes.delete(id); });
  };

  function vec3(v, max) {
    if (!Array.isArray(v) || v.length !== 3) return null;
    var x = +v[0], y = +v[1], z = +v[2];
    if (!(isFinite(x) && isFinite(y) && isFinite(z))) return null;
    var len = Math.sqrt(x * x + y * y + z * z);
    if (len > max) { x *= max / len; y *= max / len; z *= max / len; }
    return [x, y, z];
  }

  // Another player's game reports that it hit our car: `dv` is the velocity
  // change for our car, `r` the contact point relative to our car's position.
  // The data comes from another machine, so it is checked and limited here.
  ptc.knock = function (msg) {
    var r = remotes.get(msg.from), now = ptc.now();
    if (!r || !r.ok || now < r.mute || now - r.knocked < 100) return;
    var dv = vec3(msg.dv, KNOCK_MAX), at = vec3(msg.r, 3);
    if (!dv || !at) return;
    r.knocked = now;
    r.quiet = now + PAIR_MS;
    if (knocks.length < 8) knocks.push({ dv: dv, r: at, from: msg.from, pinch: msg.pinch === true, at: now });
  };

  // From another mod on this machine (not from the network): change the
  // player's car's velocity by `dv` and its angular velocity by `dw`.
  ptc.impulse = function (msg) {
    var dv = vec3(msg.dv, 60), dw = vec3(msg.dw, 30);
    if (dv && dw && pushes.length < 8) pushes.push({ dv: dv, dw: dw });
  };

  function applyKnocks(f, i, grounded, now) {
    var im = f[i + 73], ux = f[i - 11], uy = f[i - 7], uz = f[i - 3];
    var pinch = null;
    recentKnocks = recentKnocks.filter(function (old) { return now - old.at < 150; });
    for (var k = 0; k < knocks.length; k++) {
      var dv = knocks[k].dv, r = knocks[k].r;
      var size0 = Math.sqrt(dv[0] * dv[0] + dv[1] * dv[1] + dv[2] * dv[2]) || 1;
      // landed on: the other game saw its car come down on ours
      if (knocks[k].pinch && grounded) pinch = { x: -r[0], z: -r[2], speed: size0 };
      // squeezed: knocks from two players at once, from opposite sides
      for (var m = 0; m < recentKnocks.length; m++) {
        var o = recentKnocks[m], size1 = Math.sqrt(o.dv[0] * o.dv[0] + o.dv[1] * o.dv[1] + o.dv[2] * o.dv[2]) || 1;
        if (o.from !== knocks[k].from && (o.dv[0] * dv[0] + o.dv[1] * dv[1] + o.dv[2] * dv[2]) / (size0 * size1) < PINCH_OPPOSED)
          pinch = { axis: [dv[0] / size0, dv[1] / size0, dv[2] / size0], speed: (size0 + size1) / 2 };
      }
      recentKnocks.push(knocks[k]);
      var h = (r[0] * ux + r[1] * uy + r[2] * uz) * (1 - LEVER);
      var rx = r[0] - ux * h, ry = r[1] - uy * h, rz = r[2] - uz * h;
      // torque of the same impulse, per unit of mass
      var cx = (ry * dv[2] - rz * dv[1]) / im, cy = (rz * dv[0] - rx * dv[2]) / im, cz = (rx * dv[1] - ry * dv[0]) / im;
      var size = Math.sqrt(dv[0] * dv[0] + dv[1] * dv[1] + dv[2] * dv[2]);
      f[i + 65] += dv[0]; f[i + 66] += dv[1] + Math.min(POP_MAX, POP * size); f[i + 67] += dv[2];
      f[i + 69] += f[i + 53] * cx + f[i + 54] * cy + f[i + 55] * cz;
      f[i + 70] += f[i + 57] * cx + f[i + 58] * cy + f[i + 59] * cz;
      f[i + 71] += f[i + 61] * cx + f[i + 62] * cy + f[i + 63] * cz;
      ptc.knocked++;
    }
    knocks.length = 0;
    if (pinch) fling(f, i, pinch, now);
  }

  // Throws the player's car out of a pinch. `how` gives either the way out
  // ({ x, z }) or the axis it was squeezed along ({ axis }), and the speed of the squeeze.
  function fling(f, i, how, now) {
    if (now < pinchUntil) return;
    var vx = f[i + 65], vz = f[i + 67], ex, ez;
    if (how.axis) {
      // out sideways from the squeeze, whichever side we were already heading
      ex = -how.axis[2]; ez = how.axis[0];
      if (ex * vx + ez * vz < 0) { ex = -ex; ez = -ez; }
    } else { ex = how.x; ez = how.z; }
    var len = Math.sqrt(ex * ex + ez * ez);
    if (len < 0.2) { ex = vx; ez = vz; len = Math.sqrt(ex * ex + ez * ez); }
    if (len < 0.2) { ex = f[i - 10]; ez = f[i - 2]; len = Math.sqrt(ex * ex + ez * ez) || 1; } // the car's nose
    var speed = Math.min(PINCH_MAX, Math.max(PINCH_SPEED + how.speed, Math.sqrt(vx * vx + vz * vz) + PINCH_GAIN));
    f[i + 65] = ex / len * speed;
    f[i + 66] = Math.max(f[i + 66], 0) + PINCH_UP;
    f[i + 67] = ez / len * speed;
    f[i + 70] += (ex * vz - ez * vx >= 0 ? 1 : -1) * PINCH_SPIN;
    pinchUntil = now + PINCH_MS;
    ptc.pinches++;
  }

  // ---- geometry -----------------------------------------------------------
  function makeBox() { return { c: [0, 0, 0], a: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] }; }
  var boxA = makeBox(), boxB = makeBox();

  // m: rotation, row-major 3x3
  function setBox(box, px, py, pz, m) {
    box.c[0] = px + m[0] * C[0] + m[1] * C[1] + m[2] * C[2];
    box.c[1] = py + m[3] * C[0] + m[4] * C[1] + m[5] * C[2];
    box.c[2] = pz + m[6] * C[0] + m[7] * C[1] + m[8] * C[2];
    for (var k = 0; k < 3; k++) { box.a[k][0] = m[k]; box.a[k][1] = m[3 + k]; box.a[k][2] = m[6 + k]; }
  }

  function quatToMat(q, m) {
    var x = q[0], y = q[1], z = q[2], w = q[3];
    m[0] = 1 - 2 * (y * y + z * z); m[1] = 2 * (x * y - w * z); m[2] = 2 * (x * z + w * y);
    m[3] = 2 * (x * y + w * z); m[4] = 1 - 2 * (x * x + z * z); m[5] = 2 * (y * z - w * x);
    m[6] = 2 * (x * z - w * y); m[7] = 2 * (y * z + w * x); m[8] = 1 - 2 * (x * x + y * y);
  }

  function radius(box, lx, ly, lz) {
    var a = box.a;
    return H[0] * Math.abs(a[0][0] * lx + a[0][1] * ly + a[0][2] * lz) +
      H[1] * Math.abs(a[1][0] * lx + a[1][1] * ly + a[1][2] * lz) +
      H[2] * Math.abs(a[2][0] * lx + a[2][1] * ly + a[2][2] * lz);
  }

  var sat = { gap: 0, depth: 0, n: [0, 0, 0] };

  // Separating-axis test. Returns true when the boxes overlap; sat.n then
  // points from B towards A. Otherwise sat.gap is a lower bound on the gap.
  function overlap(A, B) {
    var dx = B.c[0] - A.c[0], dy = B.c[1] - A.c[1], dz = B.c[2] - A.c[2];
    var best = Infinity, gap = 0, hit = true;
    function axis(lx, ly, lz, edge) {
      var len = Math.sqrt(lx * lx + ly * ly + lz * lz);
      if (len < 1e-6) return;
      lx /= len; ly /= len; lz /= len;
      var dist = dx * lx + dy * ly + dz * lz;
      var ov = radius(A, lx, ly, lz) + radius(B, lx, ly, lz) - Math.abs(dist);
      if (ov < 0) { hit = false; if (-ov > gap) gap = -ov; return; }
      var score = edge ? ov * 1.05 + 0.002 : ov;
      if (score < best) {
        best = score; sat.depth = ov;
        var s = dist > 0 ? -1 : 1;
        sat.n[0] = lx * s; sat.n[1] = ly * s; sat.n[2] = lz * s;
      }
    }
    var i, j;
    for (i = 0; i < 3; i++) axis(A.a[i][0], A.a[i][1], A.a[i][2], false);
    for (i = 0; i < 3; i++) axis(B.a[i][0], B.a[i][1], B.a[i][2], false);
    for (i = 0; i < 3; i++) for (j = 0; j < 3; j++) {
      var p = A.a[i], q = B.a[j];
      axis(p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0], true);
    }
    sat.gap = gap;
    return hit;
  }

  var cp = [0, 0, 0];

  function addCornersInside(P, Q) {
    var n = 0;
    for (var m = 0; m < 8; m++) {
      var sx = m & 1 ? H[0] : -H[0], sy = m & 2 ? H[1] : -H[1], sz = m & 4 ? H[2] : -H[2];
      var x = P.c[0] + P.a[0][0] * sx + P.a[1][0] * sy + P.a[2][0] * sz;
      var y = P.c[1] + P.a[0][1] * sx + P.a[1][1] * sy + P.a[2][1] * sz;
      var z = P.c[2] + P.a[0][2] * sx + P.a[1][2] * sy + P.a[2][2] * sz;
      var ex = x - Q.c[0], ey = y - Q.c[1], ez = z - Q.c[2], inside = true;
      for (var k = 0; k < 3; k++) {
        if (Math.abs(ex * Q.a[k][0] + ey * Q.a[k][1] + ez * Q.a[k][2]) > H[k] + 0.02) { inside = false; break; }
      }
      if (inside) { cp[0] += x; cp[1] += y; cp[2] += z; n++; }
    }
    return n;
  }

  function support(box, dx, dy, dz, out) {
    out[0] = box.c[0]; out[1] = box.c[1]; out[2] = box.c[2];
    for (var k = 0; k < 3; k++) {
      var a = box.a[k], s = (a[0] * dx + a[1] * dy + a[2] * dz) >= 0 ? H[k] : -H[k];
      out[0] += a[0] * s; out[1] += a[1] * s; out[2] += a[2] * s;
    }
  }

  var sA = [0, 0, 0], sB = [0, 0, 0];

  function contactPoint(A, B) {
    cp[0] = cp[1] = cp[2] = 0;
    var n = addCornersInside(A, B) + addCornersInside(B, A);
    if (n) { cp[0] /= n; cp[1] /= n; cp[2] /= n; return; }
    support(A, -sat.n[0], -sat.n[1], -sat.n[2], sA);
    support(B, sat.n[0], sat.n[1], sat.n[2], sB);
    cp[0] = (sA[0] + sB[0]) / 2; cp[1] = (sA[1] + sB[1]) / 2; cp[2] = (sA[2] + sB[2]) / 2;
  }

  // ---- response -----------------------------------------------------------
  var mA = new Float64Array(9), mB = new Float64Array(9), qB = [0, 0, 0, 1];

  // Treats the other car as an obstacle moving with its own velocity: on this
  // client only the player's own car can be pushed. `impact` is true on the
  // first step of a contact, which is when the bounce and the hop are given.
  function resolve(f, i, r, bx, by, bz, restitution, impact) {
    kick = 0;
    var n = sat.n, vx = f[i + 65], vy = f[i + 66], vz = f[i + 67];
    var wx = f[i + 69], wy = f[i + 70], wz = f[i + 71], im = f[i + 73];
    var I0 = f[i + 53], I1 = f[i + 54], I2 = f[i + 55], I3 = f[i + 57], I4 = f[i + 58], I5 = f[i + 59],
      I6 = f[i + 61], I7 = f[i + 62], I8 = f[i + 63];

    var rx = cp[0] - f[i], ry = cp[1] - f[i + 1], rz = cp[2] - f[i + 2];
    var ux = mA[1], uy = mA[4], uz = mA[7];
    var h = (rx * ux + ry * uy + rz * uz) * (1 - LEVER);
    rx -= ux * h; ry -= uy * h; rz -= uz * h;
    var sx = cp[0] - bx, sy = cp[1] - by, sz = cp[2] - bz;

    function relative(out) {
      out[0] = vx + wy * rz - wz * ry - (r.v[0] + r.w[1] * sz - r.w[2] * sy);
      out[1] = vy + wz * rx - wx * rz - (r.v[1] + r.w[2] * sx - r.w[0] * sz);
      out[2] = vz + wx * ry - wy * rx - (r.v[2] + r.w[0] * sy - r.w[1] * sx);
    }
    // effective inverse mass along d, and the angular change per unit impulse
    var ang = [0, 0, 0];
    function kAlong(dx, dy, dz) {
      var cx = ry * dz - rz * dy, cy = rz * dx - rx * dz, cz = rx * dy - ry * dx;
      ang[0] = I0 * cx + I1 * cy + I2 * cz; ang[1] = I3 * cx + I4 * cy + I5 * cz; ang[2] = I6 * cx + I7 * cy + I8 * cz;
      return im + dx * (ang[1] * rz - ang[2] * ry) + dy * (ang[2] * rx - ang[0] * rz) + dz * (ang[0] * ry - ang[1] * rx);
    }

    var rel = [0, 0, 0];
    relative(rel);
    var vn = rel[0] * n[0] + rel[1] * n[1] + rel[2] * n[2];
    pressed = -vn;
    var hard = vn < -1;
    var target = hard ? -restitution * vn : 0;
    if (hard && impact && target < MIN_KICK) target = MIN_KICK;
    var bias = Math.min(BIAS_MAX, BIAS_GAIN * Math.max(0, sat.depth - SLOP));
    if (bias > target) target = bias;
    var dv = target - vn;
    if (!(dv > 0)) return 0;
    if (dv > MAX_DV) dv = MAX_DV;

    var K = kAlong(n[0], n[1], n[2]);
    if (!(K > 1e-9)) return 0;
    var jn = dv / K;
    vx += n[0] * jn * im; vy += n[1] * jn * im; vz += n[2] * jn * im;
    if (hard && impact) vy += Math.min(POP_MAX, POP * jn * im);
    wx += ang[0] * jn; wy += ang[1] * jn; wz += ang[2] * jn;

    relative(rel);
    var d = rel[0] * n[0] + rel[1] * n[1] + rel[2] * n[2];
    var tx = rel[0] - n[0] * d, ty = rel[1] - n[1] * d, tz = rel[2] - n[2] * d;
    var vt = Math.sqrt(tx * tx + ty * ty + tz * tz);
    if (vt > 1e-3) {
      tx /= vt; ty /= vt; tz /= vt;
      var Kt = kAlong(tx, ty, tz);
      if (Kt > 1e-9) {
        var jt = Math.min(FRICTION * jn, vt / Kt);
        vx -= tx * jt * im; vy -= ty * jt * im; vz -= tz * jt * im;
        wx -= ang[0] * jt; wy -= ang[1] * jt; wz -= ang[2] * jt;
      }
    }
    if (!(isFinite(vx) && isFinite(vy) && isFinite(vz) && isFinite(wx) && isFinite(wy) && isFinite(wz))) return 0;
    f[i + 65] = vx; f[i + 66] = vy; f[i + 67] = vz;
    f[i + 69] = wx; f[i + 70] = wy; f[i + 71] = wz;
    kick = jn * im;
    return dv;
  }

  // Called after every physics step of every car; `car` is the worker's own
  // record of it and `ptr` the state buffer the step has just filled.
  ptc.afterStep = function (M, car, ptr) {
    if (!car || car.userControls == null) return;
    if (!remotes.size && !pushes.length) { lastPos = null; return; }

    var u8 = M.HEAPU8;
    var frames = u8[ptr + 4] | (u8[ptr + 5] << 8) | (u8[ptr + 6] << 16);
    var flags = u8[ptr + 11];
    var off = ptr + 12 + (flags & 2 ? 3 : 0) + 2;
    u4[0] = u8[off]; u4[1] = u8[off + 1]; u4[2] = u8[off + 2]; u4[3] = u8[off + 3];
    u4[4] = u8[off + 4]; u4[5] = u8[off + 5]; u4[6] = u8[off + 6]; u4[7] = u8[off + 7];
    u4[8] = u8[off + 8]; u4[9] = u8[off + 9]; u4[10] = u8[off + 10]; u4[11] = u8[off + 11];
    var px = f4[0], py = f4[1], pz = f4[2];
    stepsSinceScan++;

    // Steps run in batches that catch up with the clock, so the wall time a
    // step stands for is taken from the most caught-up step seen recently.
    var now = ptc.now(), d = now - frames;
    if (dMin === null || d < dMin || d - dMin > 100) dMin = d; else dMin += 0.002;
    var T = frames + dMin;

    var jumped = lastPos === null || car.id !== lastCar || frames < lastFrames ||
      Math.abs(px - lastPos[0]) + Math.abs(py - lastPos[1]) + Math.abs(pz - lastPos[2]) > 1.5;
    lastFrames = frames; lastCar = car.id;
    if (lastPos === null) lastPos = [px, py, pz]; else { lastPos[0] = px; lastPos[1] = py; lastPos[2] = pz; }
    if (jumped) remotes.forEach(unsolid);

    if (!(flags & 1) || (flags & 2)) { pushes.length = 0; return; } // not started, or finished
    if (pushes.length) {
      var b = locate(M, car.id, px, py, pz);
      if (b >= 0) {
        var h = M.HEAPF32;
        for (var k = 0; k < pushes.length; k++) {
          var push = pushes[k];
          h[b + 65] += push.dv[0]; h[b + 66] += push.dv[1]; h[b + 67] += push.dv[2];
          h[b + 69] += push.dw[0]; h[b + 70] += push.dw[1]; h[b + 71] += push.dw[2];
        }
      }
      pushes.length = 0;
    }
    if (now - lastMessage > STALE_MS) { remotes.forEach(unsolid); knocks.length = 0; return; }

    var i = -1, f = null, boxReady = false;
    var grounded = (flags & 120) !== 0; // any wheel touching the track
    var contacts = [];
    if (knocks.length) {
      i = locate(M, car.id, px, py, pz);
      if (i >= 0) { f = M.HEAPF32; applyKnocks(f, i, grounded, now); } else knocks.length = 0;
    }
    remotes.forEach(function (r) {
      if (!r.ok) return;
      var age = (T - r.t) / 1000;
      if (age > STALE_MS / 1000) { unsolid(r); return; }
      if (age < -0.02) age = -0.02; else if (age > 0.05) age = 0.05;
      var bx = r.p[0] + r.v[0] * age, by = r.p[1] + r.v[1] * age, bz = r.p[2] + r.v[2] * age;
      var dx = bx - px, dy = by - py, dz = bz - pz;
      var dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist > REACH + 0.5) {
        r.touching = false;
        if (!r.solid && ++r.clear >= CLEAR_STEPS) r.solid = true;
        return;
      }
      if (i < 0) {
        i = locate(M, car.id, px, py, pz);
        if (i < 0) return;
        f = M.HEAPF32;
      }
      if (!boxReady) {
        mA[0] = f[i - 12]; mA[1] = f[i - 11]; mA[2] = f[i - 10];
        mA[3] = f[i - 8]; mA[4] = f[i - 7]; mA[5] = f[i - 6];
        mA[6] = f[i - 4]; mA[7] = f[i - 3]; mA[8] = f[i - 2];
        setBox(boxA, px, py, pz, mA);
        boxReady = true;
      }
      // turn the other car by its angular velocity over the same interval
      var q = r.q, hx = r.w[0] * age / 2, hy = r.w[1] * age / 2, hz = r.w[2] * age / 2;
      qB[0] = q[0] + hx * q[3] + hy * q[2] - hz * q[1];
      qB[1] = q[1] + hy * q[3] + hz * q[0] - hx * q[2];
      qB[2] = q[2] + hz * q[3] + hx * q[1] - hy * q[0];
      qB[3] = q[3] - hx * q[0] - hy * q[1] - hz * q[2];
      var ql = Math.sqrt(qB[0] * qB[0] + qB[1] * qB[1] + qB[2] * qB[2] + qB[3] * qB[3]) || 1;
      qB[0] /= ql; qB[1] /= ql; qB[2] /= ql; qB[3] /= ql;
      quatToMat(qB, mB);
      setBox(boxB, bx, by, bz, mB);

      if (!overlap(boxA, boxB)) {
        r.touching = false;
        if (r.solid) return;
        if (sat.gap > CLEAR_GAP) { if (++r.clear >= CLEAR_STEPS) r.solid = true; } else r.clear = 0;
        return;
      }
      if (!r.solid) { r.clear = 0; return; }
      if (sat.depth > DEEP) { unsolid(r); return; } // appeared inside us
      contactPoint(boxA, boxB);
      // If this car has just knocked us, that knock was the crash: only keep
      // the cars apart, without a second bounce and without knocking it back.
      var impact = !r.touching, quiet = now < r.quiet;
      var dv = resolve(f, i, r, bx, by, bz, quiet ? 0 : RESTITUTION, impact && !quiet);
      r.touching = true;
      var n = sat.n;
      contacts.push({ n: [n[0], n[1], n[2]], pressed: pressed, bx: bx, bz: bz });
      if (!(dv > 0) || !impact) return;
      ptc.hits++;
      if (quiet || kick < 1) return;
      r.mute = now + PAIR_MS; // its own report of this crash is ignored
      var g = -kick * KNOCK;
      try {
        self.postMessage({ messageType: "ptcHit", to: r.id, dv: [n[0] * g, n[1] * g, n[2] * g], r: [cp[0] - bx, cp[1] - by, cp[2] - bz],
          pinch: n[1] > PINCH_DOWN }); // we came down on top of it
      } catch (e) { /* not in a worker */ }
    });

    // pinched on this screen: a car pressing down on us while we are on the
    // track, or two cars pressing from opposite sides
    if (!contacts.length || now < pinchUntil) return;
    for (var a = 0; a < contacts.length; a++) {
      var c = contacts[a];
      if (grounded && c.n[1] < -PINCH_DOWN && c.pressed > PINCH_PRESS) {
        fling(f, i, { x: px - c.bx, z: pz - c.bz, speed: c.pressed }, now);
        return;
      }
      for (var b2 = a + 1; b2 < contacts.length; b2++) {
        var e = contacts[b2];
        if (c.n[0] * e.n[0] + c.n[1] * e.n[1] + c.n[2] * e.n[2] < PINCH_OPPOSED && Math.max(c.pressed, e.pressed) > PINCH_PRESS) {
          fling(f, i, { axis: c.n, speed: Math.max(c.pressed, e.pressed) }, now);
          return;
        }
      }
    }
  };

  // for tests
  ptc._debug = { remotes: remotes, byId: byId, scan: scan, box: { H: H, C: C } };
})();
