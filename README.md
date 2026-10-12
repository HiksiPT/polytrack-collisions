# Car Collisions (PolyTrack 0.6.3, PolyModLoader)

Makes the other players' cars solid in multiplayer sessions. Works alongside PolyCup.

## Installing

The loader imports a mod from a URL, so `dist/` has to be reachable on the web:

1. Create a public GitHub repository, double-click `Upload to GitHub.cmd` and paste the
   repository address when asked. Turn on GitHub Pages for the repository (Settings, Pages,
   branch `main`, folder `/ (root)`). Later uploads are just the double-click; a changed mod
   gets a new version number by itself.
2. In the loader (https://w.polymodloader.com), import
   `https://<user>.github.io/<repo>/dist`.

Any static host works as long as it sends `Access-Control-Allow-Origin`. PolyCup itself is
imported as `https://cdn.polymodloader.com/gh/<user>/<repo>/<branch>/dist`; that form
should work for this repository too, but it has not been tried.

Every player in the session needs the mod, in the same version.

## What it does

- Your car bounces off the other cars as you see them on your screen, and your game tells
  the player you hit, whose car is knocked away in turn. The knock arrives a moment later,
  after the network delay. Collisions are tuned to be lively, not realistic: strong bounce,
  spin, and a small hop on hard hits (constants at the top of `src/worker-runtime.js`).
- A car is not solid while it has not started, after it has finished, when its data stops
  arriving, or while it overlaps yours after a start, restart or checkpoint respawn. It
  becomes solid once the two cars have been apart for 0.15 s.
- In a multiplayer session, finished runs are not saved as records and not uploaded: a run
  that was pushed around cannot be replayed from its inputs. Singleplayer is unchanged.
- The mod reports itself as physics-changing. An unmodded host refuses players who have
  it, a host with it refuses players who do not, and versions must match.
- The physics file is not modified, so PolyCup's physics check still reports stock physics.

## Limits

- Other cars are drawn about 0.15 s plus network delay behind where they really are, and
  that drawn car is what you hit. Two players therefore do not see the same crash: the car
  behind hits the one in front earlier than the one in front sees it coming, and the car
  in front is knocked forward without having seen a touch.
- Cars are boxes (1.7 x 0.88 x 3.65 m).
- A car hidden with PolyCup's "toggle ghosts" key is still solid.
- No crash sound.

## Building and testing

```
node build.js                                   # src/ -> dist/
node test/physics.test.js                       # collision code against the real physics
node test/integration.test.js <game files dir>  # mod + patched simulation worker, end to end
```

Both tests need the Kacky Lab headless simulator (`PT Mods/Kacky Lab/sim`); the second also
needs a folder holding the loader's `simulation_worker.bundle.js` and `main.bundle.js`.
The loader caches mods by version; `Upload to GitHub.cmd` raises the version when `src/` changed.

`node serve.js` serves `dist/` on http://localhost:8123 for trying it in a normal browser.

## How it works

`src/worker-runtime.js` is injected into the game's simulation worker. After each 1 ms
physics step it finds the player's rigid body in the physics heap (Bullet's `btRigidBody`
layout), tests its box against the other cars' boxes and writes the new linear and angular
velocity back. `src/main.js` sends the worker the other cars' drawn positions every frame,
patches the two join checks, switches records off for the session, and carries the knocks
between players on its own WebRTC data channel (through the host).
