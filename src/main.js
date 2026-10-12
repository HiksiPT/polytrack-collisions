// Car Collisions for PolyTrack 0.6.3 (PolyModLoader).
// Makes the cars of the other players in a multiplayer session solid.
//
// Every client simulates only its own car, so this is done per client: the
// simulation worker (see worker-runtime.js) pushes the player's car off the
// other cars as they are drawn here. This file feeds the worker those cars,
// tells the player whose car was hit so that it is knocked away as well, keeps
// the session to players who run the same version of the mod, and keeps
// collision runs out of the records.

const { PolyMod, MixinType } = await import(new URL("PolyTypes.js", document.baseURI).href);

const WORKER_RUNTIME = __WORKER_RUNTIME__;

const STEP_RETURN = "return new Uint8Array(t.HEAPU8.buffer, i, 227).slice().buffer;";
const WORKER_MIXINS = [
  { type: MixinType.INSERT, token: "const $o = [];", func: WORKER_RUNTIME },
  {
    type: MixinType.INSERT,
    token: "const r = i.data;",
    func: `if (r && r.messageType === "ptc") { self.__ptc.remote(r); return; }
      if (r && r.messageType === "ptcKnock") { self.__ptc.knock(r); return; }
      if (r && r.messageType === "ptcImpulse") { self.__ptc.impulse(r); return; }
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

// Knocks travel on a data channel of their own, next to the game's (ids 0 and
// 1) and PolyCup's (42 and 43). Losing one only costs a knock, so no resends.
const CHANNEL = { negotiated: true, id: 77, ordered: false, maxRetransmits: 0 };

const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number" && Number.isFinite(x));

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
  #channels = new Map(); // RTCPeerConnection -> { id, channel }
  stats = { hits: 0, knocksSent: 0, knocksReceived: 0 };

  // ---- for other mods (reached through globalThis.__ptCollisions) ----------
  // Players whose cars are not solid on this machine, and a switch for all.
  ghostIds = new Set();
  ghostAll = false;

  // Changes the velocity (m/s) and angular velocity (rad/s) of the player's car.
  impulse(dv, dw = [0, 0, 0]) {
    this.postToSim({ messageType: "ptcImpulse", dv, dw });
  }

  // Sends a message to the simulation workers; they ignore types they do not know.
  postToSim(message) {
    for (const worker of this.#workers) worker.postMessage(message);
  }

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
        this.stats.hits++;
        this.#sendKnock(data.to, data.dv, data.r);
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
      peers: connection => connection instanceof ii
        ? _n.get(connection).map(peer => ({ id: peer.id, pc: peer.peerConnection }))
        : (Vl.get(connection) ? [{ id: null, pc: Vl.get(connection) }] : []),
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

  // The host is connected to every player, the others only to the host, which
  // passes their knocks on.
  #syncChannels(connection) {
    const peers = connection ? this.#native.peers(connection) : [];
    for (const [pc, entry] of this.#channels) {
      if (!peers.some((peer) => peer.pc === pc)) {
        try { entry.channel.close(); } catch {}
        this.#channels.delete(pc);
      }
    }
    for (const { id, pc } of peers) {
      if (this.#channels.has(pc) || pc.connectionState === "closed") continue;
      const entry = { id, channel: null };
      this.#channels.set(pc, entry); // also when it fails, so it is not retried every frame
      try {
        entry.channel = pc.createDataChannel("ptcollisions", CHANNEL);
        entry.channel.onmessage = (event) => this.#onKnock(entry, event.data);
      } catch (error) {
        console.error("[Car Collisions] no knock channel:", error);
      }
    }
  }

  #selfId() {
    const connection = this.#game && this.#native.session(this.#game)?.multiplayerConnection;
    return connection?.getPlayers().find((player) => player.isSelf)?.id ?? null;
  }

  #post(entry, message) {
    if (entry?.channel?.readyState !== "open") return;
    try { entry.channel.send(JSON.stringify(message)); } catch {}
  }

  #sendKnock(to, dv, r) {
    const entries = [...this.#channels.values()];
    const host = entries.find((entry) => entry.id === null); // set when we are not the host
    if (host) this.#post(host, { to, dv, r });
    else this.#post(entries.find((entry) => entry.id === to), { from: this.#selfId(), dv, r });
    this.stats.knocksSent++;
  }

  // Everything in here was written by another player's game.
  #onKnock(entry, text) {
    let message;
    try { message = JSON.parse(text); } catch { return; }
    if (typeof text !== "string" || text.length > 400 || !message || !isVec3(message.dv) || !isVec3(message.r)) return;
    let from = message.from;
    if (entry.id !== null) {
      // we are the host and know who sent it; pass it on unless it is for us
      from = entry.id;
      if (message.to !== this.#selfId()) {
        const target = [...this.#channels.values()].find((other) => other.id === message.to && other !== entry);
        this.#post(target, { from, dv: message.dv, r: message.r });
        return;
      }
    }
    if (!Number.isSafeInteger(from)) return;
    this.stats.knocksReceived++;
    for (const worker of this.#workers) worker.postMessage({ messageType: "ptcKnock", from, dv: message.dv, r: message.r });
  }

  #update() {
    const native = this.#native, game = this.#game, cars = [];
    const session = game ? native.session(game) : null;
    this.#syncChannels(session ? session.multiplayerConnection : null);
    if (session) {
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
            e: state.finishFrames != null || this.ghostAll || this.ghostIds.has(id),
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
