import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/* =====================================================================
   DUNGEON DELVE — a tiny Three.js dungeon crawler.
   Assets: ONLY local files from this repo (Kenney modular dungeon kit
   + Kenney characters pack). three.js itself comes from a CDN importmap.
   Serve with:  npx serve .
   ===================================================================== */

// ---------------- Asset locations ----------------
const DUNGEON_BASE = 'kenney_modular-dungeon-kit_1.0/Models/GLB format/';
const CHAR_BASE = 'characters./Models/GLB format/';
const CHARACTERS = 'abcdefghijklmnopqr'.split(''); // 18 characters: a..r

// ---------------- Dungeon layout (EDIT ME) ----------------
// One character per TILE. Row = +z (south), col = +x (east).
//   S start room 3x3 | L large room 5x5 | W wide room 5x3 | F finish room 5x5
//   - corridor (auto-picks straight/corner/end/junction/intersection + rotation)
//   G locked gate (in a 1-wide corridor, opens via floor switch P)
//   T stairs, 2x1 tiles (decorative, placed against a wall inside room L)
//   P floor switch (treated as part of room W for room detection)
//   . empty
//
// Route: S -up-> junction (-west-> dead end) -east-> L -east-> corner -south->
//        W (switch P) -east-> gate G -east-> F (flag). All room connections go
//        through real doorways measured from the room GLBs (see ROOM_DEFS).
const LAYOUT = [
  ".........................",
  ".........................",
  ".........................",
  ".......LLLTL.............",
  ".......LLLTL.............",
  ".------LLLLL--...........",
  "...-...LLLLL.-...........",
  "...-...LLLLL.-.....FFFFF.",
  "..SSS......WWWWW...FFFFF.",
  "..SSS......WWPWW-G-FFFFF.",
  "..SSS......WWWWW...FFFFF.",
  "...................FFFFF.",
  ".........................",
];
// Doorway tile indices per side, measured from the actual room GLBs by
// raycasting each face (see /tmp/gametest/measure.js): every room piece has
// one centered doorway (~3 units wide) on each side, sitting fully inside the
// middle tile of that side. Dirs: 0=E(+x) 1=W(-x) 2=S(+z) 3=N(-z).
const ROOM_DEFS = {
  S: { piece: 'room-small', w: 3, h: 3, doors: { 0: [1], 1: [1], 2: [1], 3: [1] } },
  L: { piece: 'room-large', w: 5, h: 5, doors: { 0: [2], 1: [2], 2: [2], 3: [2] } },
  W: { piece: 'room-wide',  w: 5, h: 3, doors: { 0: [1], 1: [1], 2: [2], 3: [2] } },
  F: { piece: 'room-large', w: 5, h: 5, doors: { 0: [2], 1: [2], 2: [2], 3: [2] } },
};
const PIECE_FILES = {
  'room-small': 'room-small.glb', 'room-large': 'room-large.glb', 'room-wide': 'room-wide.glb',
  'corridor': 'corridor.glb', 'corridor-corner': 'corridor-corner.glb',
  'corridor-end': 'corridor-end.glb', 'corridor-junction': 'corridor-junction.glb',
  'corridor-intersection': 'corridor-intersection.glb',
  'gate-metal-bars': 'gate-metal-bars.glb', 'stairs': 'stairs.glb',
};
// Measured default openings (rotation.y = 0) of corridor pieces:
//   corridor: E+W | corridor-end: E | corridor-corner: N+W
//   corridor-junction: N+E+W (wall S) | corridor-intersection: all four

// ---------------- Tunables ----------------
const WALK_SPEED = 4.2, SPRINT_SPEED = 7.5, PLAYER_RADIUS = 0.45;
const CAM_DIST = 9, CAM_PITCH = 0.6, CAM_MIN = 4, CAM_MAX = 14;
const STEP_LENGTH = 0.8; // world units per counted step
const WIN_DIST = 1.2;

// ---------------- Globals ----------------
let renderer, clock;
let selectScene, selectCamera, gameScene, gameCamera, activeScene, activeCamera;
let TILE = 4;                       // measured at boot from corridor.glb
let MAP_W, MAP_H, OFF_X, OFF_Z;     // dungeon extents / centering offsets
let pieceTemplates = {};            // piece key -> Object3D template
let charCache = {};                 // 'a'..'r' -> { gltf, height }
let state = 'loading';              // loading | select | playing | won
let selectedChar = null;            // chosen letter
let selectChars = [];               // {letter, group, mixer, ring, baseX, baseZ}
let selectRaycaster = new THREE.Raycaster();
let selectPointer = new THREE.Vector2();
let selCamGoal = null;              // camera tween target on select screen
let selDrag = null;

// game state
let player = null;                  // {group, mixer, actions, yaw}
let cellKind = [];                  // [z][x] -> 'room'|'corr'|'gate'|'stairs'|null
let cellRoom = [];                  // [z][x] -> room index or -1
let rooms = [];                     // {letter,x0,z0,w,h,doors}
let openE = [];                     // [z][x] -> bitmask of open edges (bit d: DIRS[d])
let visited = [];                   // [z][x] -> fog-of-war on minimap
let gateTile = null, gateGroup = null, gateOpen = false, gateAnim = 0, gateOpenBits = 0;
let switchPos = null, switchCell = null, switchGroup = null, switchTop = null, switchOn = false;
let startPos = null, startCell = null, flagPos = null, flagCell = null;
let flagMesh = null, flagBase = null, flagLight = null;
let torches = [];                   // {light, flame, base, phase}
let dungeonGroup = null, occluderMeshes = [];
let camYaw = 0, camPitch = CAM_PITCH, camDist = CAM_DIST, lastDragT = -10;
let keys = {};
let clickPath = null, clickIdx = 0, clickPoint = null; // A* click-to-move state
let clickMarker = null, pathLine = null;
let startTime = 0, elapsed = 0, totalDist = 0, stepCount = 0;
let winTimer = 0, won = false;
let debugOrbit = null, debugOn = false, debugOverlay = null;
let animState = 'idle';
let toastTimer = 0, hintTimer = 0, hintDir = null;

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]]; // 0=E(+x) 1=W(-x) 2=S(+z) 3=N(-z)
const OPP = [1, 0, 3, 2];

const $ = id => document.getElementById(id);
const loader = new GLTFLoader();

/* ================= BOOT ================= */
init();

async function init() {
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.domElement.className = 'game';
  document.body.appendChild(renderer.domElement);
  clock = new THREE.Clock();

  addEventListener('resize', () => {
    renderer.setSize(innerWidth, innerHeight);
    for (const c of [selectCamera, gameCamera]) if (c) { c.aspect = innerWidth / innerHeight; c.updateProjectionMatrix(); }
  });

  try {
    await loadAll();
  } catch (e) {
    $('loadtext').textContent = 'FAILED TO LOAD ASSETS: ' + e.message;
    console.error(e);
    return;
  }
  buildSelectScreen();
  state = 'select';
  $('loading').classList.add('hidden');
  $('select').classList.remove('hidden');
  $('fader').style.opacity = '0';
  activeScene = selectScene; activeCamera = selectCamera;
  wireUI();
  renderer.setAnimationLoop(tick);
}

/* ================= ASSET LOADING ================= */
function loadGLB(url) {
  return new Promise((res, rej) => loader.load(url, res, undefined, rej));
}

async function loadAll() {
  const jobs = [];
  const pieceKeys = Object.keys(PIECE_FILES);
  for (const k of pieceKeys) jobs.push({ kind: 'piece', key: k, url: DUNGEON_BASE + PIECE_FILES[k] });
  for (const l of CHARACTERS) jobs.push({ kind: 'char', key: l, url: `${CHAR_BASE}character-${l}.glb` });
  let done = 0;
  const partial = [];
  for (const j of jobs) {
    partial.push(loadGLB(j.url).then(gltf => {
      if (j.kind === 'piece') pieceTemplates[j.key] = gltf.scene;
      else {
        const box = new THREE.Box3().setFromObject(gltf.scene);
        charCache[j.key] = { gltf, height: box.max.y - box.min.y };
      }
      done++;
      $('loadfill').style.width = (done / jobs.length * 100).toFixed(1) + '%';
      $('loadtext').textContent = `SUMMONING ASSETS… ${done}/${jobs.length}`;
    }));
    if (partial.length % 4 === 0) await Promise.all(partial.splice(0));
  }
  await Promise.all(partial);

  const corBox = new THREE.Box3().setFromObject(pieceTemplates['corridor']);
  TILE = corBox.max.x - corBox.min.x; // 4 -> 1 tile
  console.log(`tile=${TILE}`);

  MAP_W = LAYOUT[0].length; MAP_H = LAYOUT.length;
  OFF_X = MAP_W * TILE / 2; OFF_Z = MAP_H * TILE / 2;
}

// tile <-> world helpers (dungeon centered on origin)
function tileToWorld(tx, tz, out) {
  out = out || new THREE.Vector3();
  return out.set((tx + 0.5) * TILE - OFF_X, 0, (tz + 0.5) * TILE - OFF_Z);
}
function worldToTile(x, z) {
  return [Math.floor((x + OFF_X) / TILE), Math.floor((z + OFF_Z) / TILE)];
}
function inBounds(tx, tz) { return tx >= 0 && tz >= 0 && tx < MAP_W && tz < MAP_H; }
function isWalkable(tx, tz) {
  if (!inBounds(tx, tz)) return false;
  const k = cellKind[tz][tx];
  return k === 'room' || k === 'corr' || k === 'gate';
}
// Edge-based crossing test: may the player step from cell a to adjacent cell b?
function edgeOpenBetween(ax, az, bx, bz) {
  if (!inBounds(bx, bz)) return false;
  const dx = bx - ax, dz = bz - az;
  const d = dx === 1 ? 0 : dx === -1 ? 1 : dz === 1 ? 2 : 3;
  return ((openE[az][ax] >> d) & 1) === 1 && ((openE[bz][bx] >> OPP[d]) & 1) === 1;
}

// Normalize a character so it stands ~1.7 units tall, feet at y=0, centered.
function normalizeCharacter(obj, targetH = 1.7) {
  const box = new THREE.Box3().setFromObject(obj);
  const h = box.max.y - box.min.y || 1;
  obj.scale.setScalar(targetH / h);
  const b2 = new THREE.Box3().setFromObject(obj);
  obj.position.x -= (b2.min.x + b2.max.x) / 2;
  obj.position.z -= (b2.min.z + b2.max.z) / 2;
  obj.position.y -= b2.min.y;
  const wrap = new THREE.Group();
  wrap.add(obj);
  return wrap;
}

function clipByName(gltf, names) {
  const lower = gltf.animations.map(a => a.name.toLowerCase());
  for (const n of names) {
    const i = lower.indexOf(n.toLowerCase());
    if (i >= 0) return gltf.animations[i];
  }
  return null;
}

/* ================= CHARACTER SELECT SCREEN ================= */
function buildSelectScreen() {
  selectScene = new THREE.Scene();
  selectScene.background = new THREE.Color(0x060608);
  selectScene.fog = new THREE.FogExp2(0x060608, 0.02);
  selectCamera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.1, 200);

  selectScene.add(new THREE.AmbientLight(0x8a7a5a, 0.55));
  const key = new THREE.DirectionalLight(0xffe0b0, 1.1);
  key.position.set(6, 12, 8);
  selectScene.add(key);
  const rim = new THREE.DirectionalLight(0x5a6aff, 0.5);
  rim.position.set(-8, 6, -6);
  selectScene.add(rim);

  const cols = 6, spacing = 3.4;
  const ox = -(cols - 1) * spacing / 2, oz = -1 * spacing; // 3 rows
  const platGeo = new THREE.CylinderGeometry(1.15, 1.3, 0.3, 24);
  const platMat = new THREE.MeshStandardMaterial({ color: 0x2a2438, roughness: 0.8, metalness: 0.2 });
  const ringGeo = new THREE.TorusGeometry(1.45, 0.07, 10, 40);
  CHARACTERS.forEach((letter, i) => {
    const cx = ox + (i % cols) * spacing, cz = oz + Math.floor(i / cols) * spacing;
    const platform = new THREE.Mesh(platGeo, platMat);
    platform.position.set(cx, 0.15, cz);
    selectScene.add(platform);
    const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xd8a93f, transparent: true, opacity: 0 }));
    ring.rotation.x = -Math.PI / 2; ring.position.set(cx, 0.32, cz);
    selectScene.add(ring);
    const src = charCache[letter].gltf.scene;
    const group = normalizeCharacter(src.clone(true));
    group.position.set(cx, 0.3, cz);
    selectScene.add(group);
    const mixer = new THREE.AnimationMixer(group);
    const idle = clipByName(charCache[letter].gltf, ['idle']);
    if (idle) mixer.clipAction(idle).play();
    group.traverse(o => { o.userData.charLetter = letter; });
    selectChars.push({ letter, group, mixer, ring, baseX: cx, baseZ: cz });
  });

  selectCamera.position.set(0, 9.5, 15.5);
  selectCamera.lookAt(0, 1.2, 0.6);

  const el = renderer.domElement;
  el.addEventListener('pointerdown', e => {
    if (state !== 'select') return;
    selDrag = { x: e.clientX, y: e.clientY, moved: false, az: selAzimuth, el: selElev };
  });
  el.addEventListener('pointermove', e => {
    if (state !== 'select' || !selDrag) return;
    const dx = e.clientX - selDrag.x, dy = e.clientY - selDrag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) selDrag.moved = true;
    selAzimuth = selDrag.az - dx * 0.005;
    selElev = THREE.MathUtils.clamp(selDrag.el + dy * 0.004, 0.12, 1.1);
  });
  el.addEventListener('pointerup', e => {
    if (state !== 'select') return;
    const wasDrag = selDrag && selDrag.moved;
    selDrag = null;
    if (wasDrag) return;
    selectPointer.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    selectRaycaster.setFromCamera(selectPointer, selectCamera);
    const hits = selectRaycaster.intersectObjects(selectChars.map(c => c.group), true);
    if (hits.length) {
      let o = hits[0].object;
      while (o && !o.userData.charLetter) o = o.parent;
      if (o) chooseCharacter(o.userData.charLetter);
    }
  });
}
let selAzimuth = 0, selElev = 0.62, selDist = 18.5, selTarget = new THREE.Vector3(0, 1.2, 0.6);

function chooseCharacter(letter) {
  selectedChar = letter;
  for (const c of selectChars) c.ring.material.opacity = (c.letter === letter ? 0.95 : 0);
  const c = selectChars.find(c => c.letter === letter);
  $('charname').textContent = 'CHARACTER ' + letter.toUpperCase();
  $('startBtn').disabled = false;
  selCamGoal = { dist: 6.2, elev: 0.32 };
  selTargetGoal.set(c.baseX, 1.3, c.baseZ);
}
const selTargetGoal = new THREE.Vector3(0, 1.2, 0.6);

function updateSelect(dt) {
  for (const c of selectChars) {
    c.mixer.update(dt);
    if (c.letter !== selectedChar) c.group.rotation.y += dt * 0.55;
  }
  selTarget.lerp(selTargetGoal, 1 - Math.pow(0.001, dt));
  const dGoal = selCamGoal ? selCamGoal.dist : 18.5;
  const eGoal = selCamGoal ? selCamGoal.elev : 0.62;
  selDist += (dGoal - selDist) * (1 - Math.pow(0.001, dt));
  selElev += (eGoal - selElev) * (1 - Math.pow(0.001, dt));
  if (!selDrag) selAzimuth += dt * 0.06;
  selectCamera.position.set(
    selTarget.x + Math.sin(selAzimuth) * Math.cos(selElev) * selDist,
    selTarget.y + Math.sin(selElev) * selDist,
    selTarget.z + Math.cos(selAzimuth) * Math.cos(selElev) * selDist
  );
  selectCamera.lookAt(selTarget);
}

/* ================= DUNGEON BUILD ================= */
// Parse LAYOUT once per room block (top-left anchor only). 'P' counts as 'W'.
function parseLayout() {
  cellKind = Array.from({ length: MAP_H }, () => new Array(MAP_W).fill(null));
  cellRoom = Array.from({ length: MAP_H }, () => new Array(MAP_W).fill(-1));
  visited = Array.from({ length: MAP_H }, () => new Array(MAP_W).fill(false));
  rooms = [];
  const claimed = Array.from({ length: MAP_H }, () => new Array(MAP_W).fill(false));
  const roomCharAt = (x, z) => {
    const ch = LAYOUT[z][x];
    return ch === 'P' ? 'W' : ch;
  };
  // a layout cell belongs to room `ch` if it carries that letter, is the
  // switch inside a W room, or is a (decorative) stairs tile inside the room
  const matchesRoom = (x, z, ch) => {
    const c = LAYOUT[z][x];
    return c === ch || (c === 'P' && ch === 'W') || c === 'T';
  };
  for (let z = 0; z < MAP_H; z++) for (let x = 0; x < MAP_W; x++) {
    if (claimed[z][x]) continue;
    const ch = roomCharAt(x, z);
    const def = ROOM_DEFS[ch];
    if (!def) continue;
    // validate the block is exactly w x h
    let ok = true;
    for (let dz = 0; dz < def.h && ok; dz++) for (let dx = 0; dx < def.w && ok; dx++) {
      if (!inBounds(x + dx, z + dz) || !matchesRoom(x + dx, z + dz, ch)) ok = false;
    }
    if (!ok) {
      console.error(`ROOM BLOCK MISMATCH: '${ch}' at (${x},${z}) is not exactly ${def.w}x${def.h} (cell char='${LAYOUT[z][x]}')`);
      continue;
    }
    const idx = rooms.length;
    rooms.push({ letter: ch, x0: x, z0: z, w: def.w, h: def.h, doors: def.doors });
    for (let dz = 0; dz < def.h; dz++) for (let dx = 0; dx < def.w; dx++) {
      claimed[z + dz][x + dx] = true;
      cellKind[z + dz][x + dx] = 'room';
      cellRoom[z + dz][x + dx] = idx;
    }
    if (ch === 'S') { startCell = [x + 1, z + 1]; startPos = tileToWorld(x + 1, z + 1); }
    if (ch === 'F') { flagCell = [x + 2, z + 2]; flagPos = tileToWorld(x + 2, z + 2); }
  }
  if (!startPos) console.error('LAYOUT has no S room');
  if (!flagPos) console.error('LAYOUT has no F room');

  for (let z = 0; z < MAP_H; z++) for (let x = 0; x < MAP_W; x++) {
    const ch = LAYOUT[z][x];
    if (ch === 'P') { switchCell = [x, z]; switchPos = tileToWorld(x, z); }
    else if (ch === 'G') { gateTile = [x, z]; cellKind[z][x] = 'gate'; }
    else if (ch === 'T') cellKind[z][x] = 'stairs'; // one blocked cell per T tile
    else if (ch === '-' || ch === 'J' || ch === 'X') cellKind[z][x] = 'corr';
  }
  if (!switchPos) console.error('LAYOUT has no P switch');
  if (!gateTile) console.error('LAYOUT has no G gate');
}

// Build the per-cell edge bitmask. An edge is open only at real doorways
// (room sides) or between connected corridor cells. Both sides of an edge
// must be open for crossing (see edgeOpenBetween).
function computeEdges() {
  openE = Array.from({ length: MAP_H }, () => new Array(MAP_W).fill(0));
  const roomSideTile = (R, side, x, z) => {
    const onSide =
      (side === 0 && x === R.x0 + R.w - 1) || (side === 1 && x === R.x0) ||
      (side === 2 && z === R.z0 + R.h - 1) || (side === 3 && z === R.z0);
    if (!onSide) return -1;
    return (side === 0 || side === 1) ? z - R.z0 : x - R.x0;
  };
  for (let z = 0; z < MAP_H; z++) for (let x = 0; x < MAP_W; x++) {
    const kind = cellKind[z][x];
    if (!kind || kind === 'stairs') continue;
    let bits = 0;
    for (let d = 0; d < 4; d++) {
      const nx = x + DIRS[d][0], nz = z + DIRS[d][1];
      if (!inBounds(nx, nz)) continue;
      const nk = cellKind[nz][nx];
      if (!nk || nk === 'stairs') continue;
      if (kind === 'room') {
        if (cellRoom[nz][nx] === cellRoom[z][x]) bits |= (1 << d); // interior
        else if (nk === 'corr' || nk === 'gate') {
          const R = rooms[cellRoom[z][x]];
          const ti = roomSideTile(R, d, x, z);
          if (ti >= 0 && R.doors[d].includes(ti)) bits |= (1 << d);
        }
      } else { // corr or gate
        if (nk === 'corr' || nk === 'gate') bits |= (1 << d);
        else if (nk === 'room') {
          const R = rooms[cellRoom[nz][nx]];
          const ti = roomSideTile(R, OPP[d], nx, nz);
          if (ti >= 0 && R.doors[OPP[d]].includes(ti)) bits |= (1 << d);
        }
      }
    }
    openE[z][x] = bits;
  }
  // the gate starts closed: remember its open bits, zero them for now
  if (gateTile) {
    gateOpenBits = openE[gateTile[1]][gateTile[0]];
    openE[gateTile[1]][gateTile[0]] = 0;
  }
}

function buildDungeon() {
  gameScene = new THREE.Scene();
  gameScene.background = new THREE.Color(0x05060a);
  gameScene.fog = new THREE.FogExp2(0x05060a, 0.02);
  gameCamera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 300);
  dungeonGroup = new THREE.Group();
  gameScene.add(dungeonGroup);
  occluderMeshes = [];

  gameScene.add(new THREE.AmbientLight(0x2a2438, 0.5));
  gameScene.add(new THREE.HemisphereLight(0x3a3f5a, 0x0a0805, 0.35));

  parseLayout();
  computeEdges();

  const placements = []; // {piece, cx, cz (center tile coords), rotY}
  const roomPlaced = new Set();
  for (let z = 0; z < MAP_H; z++) for (let x = 0; x < MAP_W; x++) {
    const kind = cellKind[z][x];
    if (kind === 'room') {
      const ri = cellRoom[z][x];
      if (roomPlaced.has(ri)) continue;
      roomPlaced.add(ri);
      const R = rooms[ri];
      placements.push({
        piece: ROOM_DEFS[R.letter].piece,
        cx: R.x0 + R.w / 2, cz: R.z0 + R.h / 2, rotY: 0,
      });
    } else if (kind === 'corr' || kind === 'gate') {
      if (kind === 'gate') {
        placements.push({ piece: 'gate-metal-bars', cx: x + 0.5, cz: z + 0.5, rotY: Math.PI / 2, gate: true });
        continue;
      }
      // resolve corridor piece + rotation from open-edge mask
      const bits = openE[z][x];
      const n = bits & (1 << 3), e = bits & (1 << 0), s = bits & (1 << 2), w = bits & (1 << 1);
      const count = [n, e, s, w].filter(Boolean).length;
      let piece = 'corridor', rotY = 0;
      if (count >= 4) piece = 'corridor-intersection';
      else if (count === 3) {
        piece = 'corridor-junction'; // default openings N+E+W (wall S)
        if (!s) rotY = 0; else if (!n) rotY = Math.PI;
        else if (!e) rotY = Math.PI / 2; else rotY = -Math.PI / 2;
      } else if (count <= 1) {
        piece = 'corridor-end'; // default opening faces E
        if (e) rotY = 0; else if (w) rotY = Math.PI;
        else if (s) rotY = -Math.PI / 2; else rotY = Math.PI / 2;
      } else if ((n && s) || (e && w)) {
        piece = 'corridor'; // default runs E-W
        rotY = (n && s) ? Math.PI / 2 : 0;
      } else {
        piece = 'corridor-corner'; // default openings N+W (measured)
        if (n && w) rotY = 0; else if (w && s) rotY = Math.PI / 2;
        else if (s && e) rotY = Math.PI; else rotY = -Math.PI / 2;
      }
      placements.push({ piece, cx: x + 0.5, cz: z + 0.5, rotY });
    } else if (kind === 'stairs' && LAYOUT[z][x] === 'T') {
      if (z > 0 && LAYOUT[z - 1][x] === 'T') continue; // only the northernmost T anchors the model
      let depth = 1;
      while (z + depth < MAP_H && LAYOUT[z + depth][x] === 'T') depth++;
      // decorative stairs: 1 tile wide (x), `depth` tiles deep (z), low end north
      placements.push({ piece: 'stairs', cx: x + 0.5, cz: z + depth / 2, rotY: 0 });
    }
  }

  for (const p of placements) {
    const tpl = pieceTemplates[p.piece];
    if (!tpl) { console.warn('missing piece', p.piece); continue; }
    const g = new THREE.Group();
    const model = tpl.clone(true);
    model.rotation.y = p.rotY;
    model.traverse(o => { if (o.isMesh) { o.receiveShadow = true; occluderMeshes.push(o); } });
    g.add(model);
    g.position.set(p.cx * TILE - OFF_X, 0, p.cz * TILE - OFF_Z);
    if (p.gate) gateGroup = g;
    dungeonGroup.add(g);
  }

  buildTorches();
  buildStartRing();
  buildFlag();
  buildSwitch();
  buildPlayerLight();
  buildDebugOverlay();
  startupPathCheck(false);

  // size the minimap canvas to the map
  $('minimap').width = MAP_W * 6;
  $('minimap').height = MAP_H * 6;
}

function torchPositions() {
  return [[3, 9], [3, 5], [9, 5], [13, 9], [21, 9]]; // S, junction, L, W, F
}

function buildTorches() {
  const flameGeo = new THREE.SphereGeometry(0.16, 10, 10);
  const stickGeo = new THREE.CylinderGeometry(0.06, 0.08, 1.4, 8);
  const stickMat = new THREE.MeshStandardMaterial({ color: 0x3a2a18, roughness: 0.9 });
  for (const [tx, tz] of torchPositions()) {
    const p = tileToWorld(tx, tz);
    const stick = new THREE.Mesh(stickGeo, stickMat);
    stick.position.set(p.x + 1.2, 1.9, p.z + 1.2);
    dungeonGroup.add(stick);
    const flame = new THREE.Mesh(flameGeo, new THREE.MeshBasicMaterial({ color: 0xffb347 }));
    flame.position.set(p.x + 1.2, 2.75, p.z + 1.2);
    dungeonGroup.add(flame);
    const light = new THREE.PointLight(0xff8c3a, 13, 15, 2);
    light.position.copy(flame.position);
    dungeonGroup.add(light);
    torches.push({ light, flame, base: 13, phase: Math.random() * 10 });
  }
}

function buildStartRing() {
  const geo = new THREE.RingGeometry(0.9, 1.25, 40);
  const mat = new THREE.MeshBasicMaterial({ color: 0x53e9ff, transparent: true, opacity: 0.85, side: THREE.DoubleSide });
  const ring = new THREE.Mesh(geo, mat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(startPos.x, 0.06, startPos.z);
  dungeonGroup.add(ring);
  dungeonGroup.userData.startRing = ring;
}

function buildFlag() {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 3.4, 10),
    new THREE.MeshStandardMaterial({ color: 0x5a3a1a, roughness: 0.7 }));
  pole.position.y = 1.7;
  g.add(pole);
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 12),
    new THREE.MeshStandardMaterial({ color: 0xd8a93f, metalness: 0.9, roughness: 0.25, emissive: 0x664411, emissiveIntensity: 0.4 }));
  knob.position.y = 3.5;
  g.add(knob);
  const fgeo = new THREE.PlaneGeometry(1.9, 1.05, 16, 6);
  fgeo.translate(0.95, 0, 0);
  const flag = new THREE.Mesh(fgeo, new THREE.MeshStandardMaterial({
    color: 0xc22730, side: THREE.DoubleSide, roughness: 0.6, emissive: 0x550000, emissiveIntensity: 0.35,
  }));
  flag.position.set(0.08, 2.85, 0);
  g.add(flag);
  flagBase = fgeo.attributes.position.array.slice();
  flagMesh = flag;
  flagLight = new THREE.PointLight(0xffc46b, 14, 12, 2);
  flagLight.position.set(0, 3.2, 0);
  g.add(flagLight);
  g.position.set(flagPos.x, 0, flagPos.z);
  dungeonGroup.add(g);
}

function buildSwitch() {
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.1, 0.14, 24),
    new THREE.MeshStandardMaterial({ color: 0x3a3f4a, roughness: 0.6, metalness: 0.5 }));
  base.position.y = 0.07;
  g.add(base);
  switchTop = new THREE.Mesh(new THREE.CylinderGeometry(0.68, 0.68, 0.14, 24),
    new THREE.MeshStandardMaterial({
      color: 0xcc7722, roughness: 0.4, metalness: 0.3,
      emissive: 0xff6a00, emissiveIntensity: 0.9,
    }));
  switchTop.position.y = 0.2;
  g.add(switchTop);
  g.position.set(switchPos.x, 0, switchPos.z);
  switchGroup = g;
  dungeonGroup.add(g);
}

let playerLight = null;
function buildPlayerLight() {
  playerLight = new THREE.DirectionalLight(0xfff2dd, 1.0);
  playerLight.castShadow = true;
  playerLight.shadow.mapSize.set(1024, 1024);
  playerLight.shadow.camera.left = -9; playerLight.shadow.camera.right = 9;
  playerLight.shadow.camera.top = 9; playerLight.shadow.camera.bottom = -9;
  playerLight.shadow.camera.near = 1; playerLight.shadow.camera.far = 40;
  playerLight.shadow.bias = -0.002;
  gameScene.add(playerLight);
  gameScene.add(playerLight.target);
}

// Debug overlay (toggle 'O'): green = walkable cells, red = blocked edges.
function mergeGeos(geos) {
  let vTotal = 0, iTotal = 0;
  for (const g of geos) { vTotal += g.attributes.position.count; iTotal += g.index.count; }
  const pos = new Float32Array(vTotal * 3), nor = new Float32Array(vTotal * 3), uv = new Float32Array(vTotal * 2);
  const idx = new Uint16Array(iTotal);
  let vo = 0, io = 0;
  for (const g of geos) {
    const n = g.attributes.position.count;
    pos.set(g.attributes.position.array, vo * 3);
    nor.set(g.attributes.normal.array, vo * 3);
    uv.set(g.attributes.uv.array, vo * 2);
    const gi = g.index.array;
    for (let i = 0; i < gi.length; i++) idx[io + i] = gi[i] + vo;
    vo += n; io += gi.length;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

function buildDebugOverlay() {
  debugOverlay = new THREE.Group();
  debugOverlay.visible = false;
  const greenGeos = [], redGeos = [];
  for (let z = 0; z < MAP_H; z++) for (let x = 0; x < MAP_W; x++) {
    if (!isWalkable(x, z)) continue;
    const p = tileToWorld(x, z);
    const g = new THREE.PlaneGeometry(TILE - 0.15, TILE - 0.15);
    g.rotateX(-Math.PI / 2);
    g.translate(p.x, 0.1, p.z);
    greenGeos.push(g);
    const x0 = x * TILE - OFF_X, z0 = z * TILE - OFF_Z;
    const strip = (cx, cz, w, d) => {
      const sg = new THREE.PlaneGeometry(w, d);
      sg.rotateX(-Math.PI / 2);
      sg.translate(cx, 0.14, cz);
      redGeos.push(sg);
    };
    const bits = [[1 << 0, x0 + TILE - 0.08, z0 + TILE / 2, 0.16, TILE - 0.15],
                  [1 << 1, x0 + 0.08, z0 + TILE / 2, 0.16, TILE - 0.15],
                  [1 << 2, x0 + TILE / 2, z0 + TILE - 0.08, TILE - 0.15, 0.16],
                  [1 << 3, x0 + TILE / 2, z0 + 0.08, TILE - 0.15, 0.16]];
    for (const [bit, cx, cz, w, d] of bits) {
      if (!(openE[z][x] & bit)) strip(cx, cz, w, d);
    }
  }
  if (greenGeos.length) {
    const m = new THREE.Mesh(mergeGeos(greenGeos),
      new THREE.MeshBasicMaterial({ color: 0x2aff5a, transparent: true, opacity: 0.32, depthWrite: false }));
    debugOverlay.add(m);
  }
  if (redGeos.length) {
    const m = new THREE.Mesh(mergeGeos(redGeos),
      new THREE.MeshBasicMaterial({ color: 0xff3344, transparent: true, opacity: 0.9, depthWrite: false }));
    debugOverlay.add(m);
  }
  dungeonGroup.add(debugOverlay);
}

// Breadth-first search over the edge-based grid. With the gate forced open
// there must be a path from start to flag, or the layout is broken.
function startupPathCheck(verbose) {
  if (!startCell || !flagCell) { console.error('STARTUP PATH CHECK FAILED: missing start/flag'); return null; }
  const saved = openE[gateTile[1]][gateTile[0]];
  openE[gateTile[1]][gateTile[0]] = gateOpenBits; // treat gate as open
  const path = findPathCells(startCell[0], startCell[1], flagCell[0], flagCell[1]);
  openE[gateTile[1]][gateTile[0]] = saved;
  if (!path) console.error('STARTUP PATH CHECK FAILED: no walkable path from start to flag (gate open)');
  else if (verbose || true) console.log(`STARTUP PATH CHECK OK: start->flag ${path.length} cells`);
  return path;
}

/* ================= PLAYER ================= */
const FACE_OFFSET = 0;
function spawnPlayer() {
  if (player) gameScene.remove(player.group);
  const src = charCache[selectedChar].gltf;
  const group = normalizeCharacter(src.scene.clone(true));
  group.traverse(o => { if (o.isMesh) o.castShadow = true; });
  const mixer = new THREE.AnimationMixer(group);
  const actions = {};
  for (const n of ['idle', 'walk', 'sprint', 'emote-yes', 'die']) {
    const clip = clipByName(src, [n]);
    if (clip) actions[n] = mixer.clipAction(clip);
  }
  player = { group, mixer, actions, yaw: Math.PI }; // face north, toward the corridor
  group.position.copy(startPos);
  group.rotation.y = player.yaw + FACE_OFFSET;
  gameScene.add(group);
  if (actions.idle) actions.idle.play();
  animState = 'idle';
}

function setAnim(name) {
  if (animState === name || !player) return;
  const prev = player.actions[animState], next = player.actions[name];
  animState = name;
  if (next) { next.reset().fadeIn(0.2).play(); }
  if (prev && prev !== next) prev.fadeOut(0.2);
}

/* ================= A* PATHFINDING (edge-based grid) ================= */
function findPathCells(sx, sz, tx, tz) {
  if (!isWalkable(tx, tz) || !isWalkable(sx, sz)) return null;
  if (sx === tx && sz === tz) return [[sx, sz]];
  const W = MAP_W, H = MAP_H;
  const g = new Float64Array(W * H).fill(Infinity);
  const came = new Int32Array(W * H).fill(-1);
  const closed = new Uint8Array(W * H);
  const idx = (x, z) => z * W + x;
  const h = (x, z) => Math.abs(x - tx) + Math.abs(z - tz);
  const open = [[h(sx, sz), idx(sx, sz)]];
  g[idx(sx, sz)] = 0;
  while (open.length) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i][0] < open[bi][0]) bi = i;
    const [, cur] = open.splice(bi, 1)[0];
    if (closed[cur]) continue;
    closed[cur] = 1;
    const cx = cur % W, cz = (cur / W) | 0;
    if (cx === tx && cz === tz) {
      const path = [];
      let c = cur;
      while (c !== -1) { path.push([c % W, (c / W) | 0]); c = came[c]; }
      return path.reverse();
    }
    for (let d = 0; d < 4; d++) {
      const nx = cx + DIRS[d][0], nz = cz + DIRS[d][1];
      if (!isWalkable(nx, nz) || !edgeOpenBetween(cx, cz, nx, nz)) continue;
      const ni = idx(nx, nz);
      if (closed[ni]) continue;
      const ng = g[cur] + 1;
      if (ng < g[ni]) { g[ni] = ng; came[ni] = cur; open.push([ng + h(nx, nz), ni]); }
    }
  }
  return null;
}

// Is the straight segment between two cell centers crossable (point test;
// the follower's collision resolves the player radius)?
function segmentClear(ax, az, bx, bz) {
  const x0 = (ax + 0.5) * TILE - OFF_X, z0 = (az + 0.5) * TILE - OFF_Z;
  const x1 = (bx + 0.5) * TILE - OFF_X, z1 = (bz + 0.5) * TILE - OFF_Z;
  const dist = Math.hypot(x1 - x0, z1 - z0);
  const n = Math.max(1, Math.ceil(dist / (TILE * 0.25)));
  let px = ax, pz = az;
  for (let i = 1; i <= n; i++) {
    const x = x0 + (x1 - x0) * i / n, z = z0 + (z1 - z0) * i / n;
    const [cx, cz] = worldToTile(x, z);
    if (cx !== px || cz !== pz) {
      if (!edgeOpenBetween(px, pz, cx, cz)) return false;
      px = cx; pz = cz;
    }
  }
  return true;
}

function smoothPathCells(path) {
  if (!path || path.length < 3) return path;
  const out = [path[0]];
  let i = 0;
  while (i < path.length - 1) {
    let j = path.length - 1;
    while (j > i + 1 && !segmentClear(path[i][0], path[i][1], path[j][0], path[j][1])) j--;
    out.push(path[j]);
    i = j;
  }
  return out;
}

/* ================= CLICK-TO-MOVE ================= */
function startClickMove(worldPoint) {
  clearClickMove();
  let [tx, tz] = worldToTile(worldPoint.x, worldPoint.z);
  if (!isWalkable(tx, tz)) {
    // nearest walkable cell within 3
    let best = null, bd = 1e9;
    for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) {
      const nx = tx + dx, nz = tz + dz;
      if (!isWalkable(nx, nz)) continue;
      const d = dx * dx + dz * dz;
      if (d < bd) { bd = d; best = [nx, nz]; }
    }
    if (!best) { toast('NO PATH THERE'); return; }
    [tx, tz] = best;
  }
  const [sx, sz] = worldToTile(player.group.position.x, player.group.position.z);
  const raw = findPathCells(sx, sz, tx, tz);
  if (!raw) { toast('NO PATH THERE'); return; }
  const cells = smoothPathCells(raw);
  clickPath = cells.map(([cx, cz]) => tileToWorld(cx, cz));
  // aim the final waypoint at the actual clicked point, clamped into its cell
  const last = clickPath[clickPath.length - 1];
  last.x = THREE.MathUtils.clamp(worldPoint.x, last.x - TILE / 2 + 0.4, last.x + TILE / 2 - 0.4);
  last.z = THREE.MathUtils.clamp(worldPoint.z, last.z - TILE / 2 + 0.4, last.z + TILE / 2 - 0.4);
  clickIdx = 0;
  clickPoint = last.clone();
  showClickMarker(clickPoint, clickPath);
}

function clearClickMove() {
  clickPath = null; clickIdx = 0; clickPoint = null;
  if (clickMarker) clickMarker.visible = false;
  if (pathLine) pathLine.visible = false;
}

function showClickMarker(point, waypoints) {
  if (!clickMarker) {
    const m = new THREE.Mesh(
      new THREE.RingGeometry(0.35, 0.55, 32),
      new THREE.MeshBasicMaterial({ color: 0x7CFC00, transparent: true, opacity: 0.9, side: THREE.DoubleSide })
    );
    m.rotation.x = -Math.PI / 2;
    clickMarker = m;
    gameScene.add(m);
  }
  clickMarker.position.set(point.x, 0.12, point.z);
  clickMarker.visible = true;
  if (!pathLine) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
    pathLine = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0x7CFC00, transparent: true, opacity: 0.35 }));
    pathLine.frustumCulled = false;
    gameScene.add(pathLine);
  }
  const p = player.group.position;
  const pts = [p.x, 0.15, p.z];
  for (const w of waypoints) pts.push(w.x, 0.15, w.z);
  pathLine.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  pathLine.visible = true;
}

/* ================= COLLISION (edge-based, axis-separated) ================= */
const EPS = 1e-4;
// Move along one axis; clamp the player circle at blocked edges so it slides.
// The swept circle (radius R) is tested against every grid line it can reach;
// a blocked edge stops the circle R short of the line.
function collideAxis(axis, delta) {
  const p = player.group.position;
  if (!delta) return;
  const horiz = axis === 'x';
  const offM = horiz ? OFF_X : OFF_Z; // moving axis
  const offF = horiz ? OFF_Z : OFF_X; // fixed axis
  const from = horiz ? p.x : p.z;
  let target = from + delta;
  const fixed = horiz ? p.z : p.x;
  const dir = Math.sign(delta);
  const R = PLAYER_RADIUS;
  const lo = dir > 0 ? from - R : target - R;
  const hi = dir > 0 ? target + R : from + R;
  const kMin = Math.ceil((lo + offM) / TILE - 1e-9);
  const kMax = Math.floor((hi + offM) / TILE + 1e-9);
  const c0 = Math.floor((fixed - R + offF) / TILE), c1 = Math.floor((fixed + R + offF) / TILE);
  for (let k = kMin; k <= kMax; k++) {
    const L = k * TILE - offM; // world coord of the grid line
    if (dir > 0 && L < from - R + 1e-4) continue; // behind us
    if (dir < 0 && L > from + R - 1e-4) continue; // behind us
    for (let c = c0; c <= c1; c++) {
      let ax, az, bx, bz;
      if (horiz) { ax = dir > 0 ? k - 1 : k; az = c; bx = dir > 0 ? k : k - 1; bz = c; }
      else { ax = c; az = dir > 0 ? k - 1 : k; bx = c; bz = dir > 0 ? k : k - 1; }
      if (!edgeOpenBetween(ax, az, bx, bz)) {
        if (dir > 0) target = Math.min(target, L - R - EPS);
        else target = Math.max(target, L + R + EPS);
      }
    }
  }
  if (horiz) p.x = target; else p.z = target;
}

/* ================= INPUT ================= */
const _rc = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
function wireGameInput() {
  const el = renderer.domElement;
  addEventListener('keydown', e => {
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
    if (state !== 'playing' || won) return;
    keys[e.code] = true;
    if (/^(KeyW|KeyA|KeyS|KeyD|Arrow)/.test(e.code)) clearClickMove();
    if (e.code === 'KeyO') toggleDebugOrbit();
  });
  addEventListener('keyup', e => { keys[e.code] = false; });
  let downPos = null;
  el.addEventListener('pointerdown', e => {
    if (state !== 'playing' || won) return;
    downPos = [e.clientX, e.clientY];
  });
  el.addEventListener('pointermove', e => {
    if (state !== 'playing' || won || !downPos || !e.buttons) return;
    camYaw -= e.movementX * 0.0052;
    camPitch = THREE.MathUtils.clamp(camPitch + e.movementY * 0.004, 0.08, 1.25);
    lastDragT = performance.now() / 1000;
  });
  el.addEventListener('pointerup', e => {
    if (state !== 'playing' || won || !downPos) return;
    const dx = e.clientX - downPos[0], dy = e.clientY - downPos[1];
    downPos = null;
    if (dx * dx + dy * dy > 36) return; // it was a drag
    // click-to-move: raycast against dungeon meshes, accept upward faces (floors)
    _ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    _rc.setFromCamera(_ndc, gameCamera);
    const hits = _rc.intersectObjects(dungeonGroup.children, true);
    const n = new THREE.Vector3();
    for (const h of hits) {
      if (!h.face) continue;
      n.copy(h.face.normal).transformDirection(h.object.matrixWorld);
      if (n.y > 0.55) { startClickMove(h.point); break; }
    }
  });
  el.addEventListener('wheel', e => {
    if (state !== 'playing') return;
    camDist = THREE.MathUtils.clamp(camDist + Math.sign(e.deltaY) * 0.8, CAM_MIN, CAM_MAX);
  }, { passive: true });
}

function toggleDebugOrbit() {
  debugOn = !debugOn;
  if (debugOn && !debugOrbit) {
    debugOrbit = new OrbitControls(gameCamera, renderer.domElement);
    debugOrbit.enableDamping = true;
  }
  if (debugOrbit) debugOrbit.enabled = debugOn;
  if (debugOverlay) debugOverlay.visible = debugOn;
  toast(debugOn ? 'DEBUG VIEW ON (O TO EXIT)' : 'DEBUG VIEW OFF');
}

/* ================= GAME UPDATE ================= */
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _ocDir = new THREE.Vector3(), _n = new THREE.Vector3();

function updateGame(dt, t) {
  const p = player.group.position;

  // --- movement: keys (camera-relative) or A* click path ---
  let mvx = 0, mvz = 0, keyMoving = false;
  const sprinting = !!(keys.ShiftLeft || keys.ShiftRight);
  if (state === 'playing' && !won) {
    const fx = -Math.sin(camYaw), fz = -Math.cos(camYaw);
    const rx = -fz, rz = fx;
    const fwd = (keys.KeyW || keys.ArrowUp ? 1 : 0) - (keys.KeyS || keys.ArrowDown ? 1 : 0);
    const str = (keys.KeyD || keys.ArrowRight ? 1 : 0) - (keys.KeyA || keys.ArrowLeft ? 1 : 0);
    if (fwd || str) {
      mvx = fx * fwd + rx * str; mvz = fz * fwd + rz * str;
      keyMoving = true;
    } else if (clickPath) {
      const wp = clickPath[clickIdx];
      const dx = wp.x - p.x, dz = wp.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.45) {
        clickIdx++;
        if (clickIdx >= clickPath.length) clearClickMove();
      } else { mvx = dx / d; mvz = dz / d; }
    }
    const mlen = Math.hypot(mvx, mvz);
    if (mlen > 0.01) {
      const sp = sprinting ? SPRINT_SPEED : WALK_SPEED;
      const nx = mvx / mlen, nz = mvz / mlen;
      _v1.set(p.x, 0, p.z);
      collideAxis('x', nx * sp * dt); // axis-separated: slides along walls
      collideAxis('z', nz * sp * dt);
      const moved = Math.hypot(p.x - _v1.x, p.z - _v1.z);
      totalDist += moved;
      stepCount = Math.floor(totalDist / STEP_LENGTH);
      const targetYaw = Math.atan2(nx, nz);
      let dy = targetYaw - player.yaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      player.yaw += dy * Math.min(1, dt * 11);
      player.group.rotation.y = player.yaw + FACE_OFFSET;
      setAnim(sprinting ? 'sprint' : 'walk');
      // camera slowly follows the player's facing when the mouse isn't driving
      const now = performance.now() / 1000;
      if (keyMoving && now - lastDragT > 1.5) {
        const want = player.yaw + Math.PI; // behind the player
        let dd = want - camYaw;
        dd = Math.atan2(Math.sin(dd), Math.cos(dd));
        camYaw += THREE.MathUtils.clamp(dd, -1.4 * dt, 1.4 * dt);
      }
    } else setAnim('idle');
  }
  player.mixer.update(dt);

  // --- fog of war: mark nearby cells visited ---
  {
    const [pcx, pcz] = worldToTile(p.x, p.z);
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      if (inBounds(pcx + dx, pcz + dz)) visited[pcz + dz][pcx + dx] = true;
    }
  }

  // --- switch + gate ---
  if (!switchOn && state === 'playing') {
    const d = Math.hypot(p.x - switchPos.x, p.z - switchPos.z);
    if (d < 1.5) {
      switchOn = true;
      switchTop.position.y = 0.13;
      switchTop.material.emissive.setHex(0x00cc44);
      toast('SOMETHING RUMBLES DEEP IN THE DUNGEON…');
    }
  }
  if (switchOn && gateAnim < 1) {
    gateAnim = Math.min(1, gateAnim + dt / 1.4);
    gateGroup.position.y = -4.4 * gateAnim * gateAnim;
    if (gateAnim >= 1) {
      openE[gateTile[1]][gateTile[0]] = gateOpenBits;
      gateOpen = true;
      toast('THE GATE IS OPEN');
    }
  }

  // --- torch flicker ---
  for (const tc of torches) {
    const n = Math.sin(t * 13 + tc.phase) * 0.5 + Math.sin(t * 31 + tc.phase * 2) * 0.3 + Math.sin(t * 7 + tc.phase) * 0.2;
    tc.light.intensity = tc.base * (1 + n * 0.22);
    const s = 1 + n * 0.12;
    tc.flame.scale.set(s, 1 + n * 0.2, s);
  }
  // --- flag wave ---
  if (flagMesh) {
    const pos = flagMesh.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = flagBase[i * 3];
      pos.setZ(i, Math.sin(x * 2.4 + t * 5.5) * 0.17 * (x / 1.9));
    }
    pos.needsUpdate = true;
    flagMesh.geometry.computeVertexNormals();
  }
  const ring = dungeonGroup.userData.startRing;
  if (ring) ring.material.opacity = 0.55 + Math.sin(t * 3) * 0.3;

  // --- player-following shadow light ---
  playerLight.position.set(p.x + 6, 12, p.z + 4);
  playerLight.target.position.set(p.x, 0, p.z);

  updateCamera(dt);

  // --- HUD ---
  if (state === 'playing' && !won) {
    elapsed = (performance.now() - startTime) / 1000;
    $('timer').textContent = fmtTime(elapsed);
    $('steps').textContent = stepCount + ' STEPS';
  }
  drawMinimap();
  updateHintArrow(dt);
  if (toastTimer > 0) { toastTimer -= dt; if (toastTimer <= 0) $('toast').style.opacity = '0'; }

  // --- win check: must actually reach the flag ---
  if (state === 'playing' && !won) {
    const d = Math.hypot(p.x - flagPos.x, p.z - flagPos.z);
    if (d < WIN_DIST) {
      won = true; winTimer = 1.6;
      clearClickMove();
      const em = player.actions['emote-yes'];
      if (em) {
        const prev = player.actions[animState];
        if (prev) prev.fadeOut(0.25);
        em.reset(); em.setLoop(THREE.LoopOnce, 1); em.clampWhenFinished = true;
        em.fadeIn(0.25).play();
        animState = 'emote-yes';
      }
    }
  } else if (won && state === 'playing') {
    winTimer -= dt;
    if (winTimer <= 0) showWin();
  }
}

// Camera: 3/4 top-down follow view. Walls between camera and player fade out
// instead of snapping the camera forward. Floor faces are skipped by the check.
const fadedMats = new Map(); // mesh -> {orig, faded}
let occludeTick = 0, occlSpheres = null;
// Only raycast meshes near the head->camera segment (perf: pieces are big).
function occlusionCandidates(head, desired) {
  if (!occlSpheres) {
    occlSpheres = occluderMeshes.map(m => {
      const s = new THREE.Sphere();
      new THREE.Box3().setFromObject(m).getBoundingSphere(s);
      return s;
    });
  }
  const near = [];
  const r2 = (camDist + 7) * (camDist + 7);
  for (let i = 0; i < occluderMeshes.length; i++) {
    const c = occlSpheres[i].center;
    if (c.distanceToSquared(head) < r2 || c.distanceToSquared(desired) < 49) near.push(occluderMeshes[i]);
  }
  return near;
}
function updateCamera(dt) {
  if (debugOn && debugOrbit) {
    debugOrbit.target.copy(player.group.position); debugOrbit.target.y += 1.2;
    debugOrbit.update();
    return;
  }
  const p = player.group.position;
  _v1.set(p.x, p.y + 1.7, p.z); // head
  const cp = Math.cos(camPitch), sp = Math.sin(camPitch);
  _v2.set(Math.sin(camYaw) * cp, sp, Math.cos(camYaw) * cp); // head -> camera
  _v3.copy(_v2).multiplyScalar(camDist).add(_v1); // desired camera pos

  if ((occludeTick++ % 6) === 0) {
    _ocDir.copy(_v3).sub(_v1);
    const dist = _ocDir.length();
    _ocDir.normalize();
    _rc.set(_v1, _ocDir);
    _rc.far = dist;
    const hits = _rc.intersectObjects(occlusionCandidates(_v1, _v3), false);
    const want = new Set();
    for (const h of hits) {
      if (!h.face) continue;
      _n.copy(h.face.normal).transformDirection(h.object.matrixWorld);
      if (_n.y <= 0.5) want.add(h.object); // skip floors
    }
    for (const m of want) {
      if (!fadedMats.has(m)) {
        const orig = m.material;
        const fm = orig.clone();
        fm.transparent = true; fm.opacity = 0.15; fm.depthWrite = false;
        fadedMats.set(m, { orig, faded: fm });
        m.material = fm;
      }
    }
    for (const [m, rec] of fadedMats) {
      if (!want.has(m)) { m.material = rec.orig; fadedMats.delete(m); }
    }
    _rc.far = Infinity;
  }
  gameCamera.position.lerp(_v3, 1 - Math.pow(0.0001, dt));
  gameCamera.lookAt(_v1);
}

function restoreFaded() {
  for (const [m, rec] of fadedMats) m.material = rec.orig;
  fadedMats.clear();
}

/* ================= HUD ================= */
function fmtTime(s) {
  const m = Math.floor(s / 60), ss = Math.floor(s % 60);
  return String(m).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
}
function toast(msg, dur = 2.6) {
  const el = $('toast');
  el.textContent = msg; el.style.opacity = '1';
  toastTimer = dur;
}
const mm = $('minimap').getContext('2d');
function drawMinimap() {
  const s = 6, W = MAP_W * s, H = MAP_H * s;
  mm.clearRect(0, 0, W, H);
  for (let z = 0; z < MAP_H; z++) for (let x = 0; x < MAP_W; x++) {
    const k = cellKind[z][x];
    if (k !== 'room' && k !== 'corr' && k !== 'gate') continue;
    const v = visited[z][x];
    mm.globalAlpha = v ? 1 : 0; // hide unvisited areas
    if (!v) continue;
    mm.fillStyle = k === 'room' ? '#5a4f7a' : '#4d465e';
    mm.fillRect(x * s, z * s, s - 0.5, s - 0.5);
  }
  mm.globalAlpha = 1;
  // doorways: gold ticks on room borders
  mm.fillStyle = '#ffd94d';
  for (const R of rooms) {
    for (let d = 0; d < 4; d++) for (const ti of R.doors[d]) {
      let x, z, horiz;
      if (d === 0) { x = R.x0 + R.w - 1; z = R.z0 + ti; horiz = false; }
      else if (d === 1) { x = R.x0; z = R.z0 + ti; horiz = false; }
      else if (d === 2) { x = R.x0 + ti; z = R.z0 + R.h - 1; horiz = true; }
      else { x = R.x0 + ti; z = R.z0; horiz = true; }
      if (!visited[z][x]) continue;
      if (horiz) mm.fillRect(x * s + 1, (d === 2 ? z + 1 : z) * s - 1, s - 2, 2);
      else mm.fillRect((d === 0 ? x + 1 : x) * s - 1, z * s + 1, 2, s - 2);
    }
  }
  // gate
  if (gateTile) {
    const v = visited[gateTile[1]][gateTile[0]];
    mm.globalAlpha = v ? 1 : 0.3;
    mm.fillStyle = gateOpen ? '#3fd06a' : '#d04848';
    mm.fillRect(gateTile[0] * s + 1, gateTile[1] * s + 1, s - 2, s - 2);
    mm.globalAlpha = 1;
  }
  // switch
  if (switchCell && !switchOn) {
    const v = visited[switchCell[1]][switchCell[0]];
    mm.globalAlpha = v ? 1 : 0.3;
    mm.fillStyle = '#ff9a2a';
    mm.fillRect(switchCell[0] * s + 1.5, switchCell[1] * s + 1.5, s - 3, s - 3);
    mm.globalAlpha = 1;
  }
  // flag
  if (flagCell) {
    const v = visited[flagCell[1]][flagCell[0]];
    mm.globalAlpha = v ? 1 : 0.3;
    mm.fillStyle = '#ffd94d';
    mm.beginPath();
    mm.moveTo(flagCell[0] * s + 3, flagCell[1] * s + 0.5);
    mm.lineTo(flagCell[0] * s + 3, flagCell[1] * s + 5.5);
    mm.lineTo(flagCell[0] * s + 6, flagCell[1] * s + 3);
    mm.closePath(); mm.fill();
    mm.globalAlpha = 1;
  }
  // player + facing
  const p = player.group.position;
  const px = (p.x + OFF_X) / TILE * s, pz = (p.z + OFF_Z) / TILE * s;
  mm.fillStyle = '#ffffff';
  mm.beginPath(); mm.arc(px, pz, 2.4, 0, 7); mm.fill();
  mm.strokeStyle = '#ffffff'; mm.lineWidth = 1.5;
  mm.beginPath(); mm.moveTo(px, pz);
  mm.lineTo(px + Math.sin(player.yaw) * 5, pz + Math.cos(player.yaw) * 5); mm.stroke();
}

// Hint arrow follows the next step of the A* path (to switch, then to flag).
function updateHintArrow(dt) {
  hintTimer -= dt;
  if (hintTimer > 0) return;
  hintTimer = 0.5;
  hintDir = null;
  if (state === 'playing' && !won) {
    const [sx, sz] = worldToTile(player.group.position.x, player.group.position.z);
    const target = gateOpen ? flagCell : switchCell;
    const path = target && findPathCells(sx, sz, target[0], target[1]);
    if (path && path.length > 1) {
      const [nx, nz] = path[1];
      hintDir = Math.atan2(nx - sx, nz - sz);
    }
  }
  if (hintDir === null) { $('hintarrow').style.opacity = '0.25'; return; }
  $('hintarrow').style.opacity = '1';
  const f = Math.atan2(-Math.sin(camYaw), -Math.cos(camYaw)); // camera forward
  $('hintarrow').style.transform = `rotate(${-(hintDir - f)}rad)`;
}

/* ================= FLOW ================= */
function wireUI() {
  wireGameInput();
  $('startBtn').addEventListener('click', () => {
    if (!selectedChar) return;
    startGame();
  });
  $('againBtn').addEventListener('click', () => resetGame());
  $('changeBtn').addEventListener('click', () => toSelect());
}

function resetRunState() {
  gateOpen = false; gateAnim = 0; switchOn = false;
  openE[gateTile[1]][gateTile[0]] = 0;
  gateGroup.position.y = 0;
  switchTop.position.y = 0.2; switchTop.material.emissive.setHex(0xff6a00);
  visited = Array.from({ length: MAP_H }, () => new Array(MAP_W).fill(false));
  clearClickMove();
  restoreFaded();
}

function placeCameraBehindPlayer() {
  camYaw = player.yaw + Math.PI;
  camPitch = CAM_PITCH; camDist = CAM_DIST;
  const p = player.group.position;
  const cp = Math.cos(camPitch), sp = Math.sin(camPitch);
  gameCamera.position.set(
    p.x + Math.sin(camYaw) * cp * camDist,
    p.y + 1.7 + sp * camDist,
    p.z + Math.cos(camYaw) * cp * camDist
  );
  gameCamera.lookAt(p.x, p.y + 1.7, p.z);
}

function startGame() {
  $('fader').style.opacity = '1';
  setTimeout(() => {
    if (!gameScene) buildDungeon();
    resetRunState();
    spawnPlayer();
    placeCameraBehindPlayer();
    debugOn = false; if (debugOrbit) debugOrbit.enabled = false;
    if (debugOverlay) debugOverlay.visible = false;
    startTime = performance.now(); elapsed = 0; totalDist = 0; stepCount = 0;
    won = false; keys = {}; hintTimer = 0;
    state = 'playing';
    activeScene = gameScene; activeCamera = gameCamera;
    $('select').classList.add('hidden');
    $('hud').classList.remove('hidden');
    $('win').classList.add('hidden');
    $('fader').style.opacity = '0';
    toast('FIND THE GOLDEN FLAG TO ESCAPE', 3.2);
  }, 450);
}

function resetGame() {
  resetRunState();
  player.group.position.copy(startPos);
  player.yaw = Math.PI; player.group.rotation.y = player.yaw + FACE_OFFSET;
  setAnim('idle');
  placeCameraBehindPlayer();
  startTime = performance.now(); elapsed = 0; totalDist = 0; stepCount = 0;
  won = false; keys = {}; hintTimer = 0;
  state = 'playing';
  $('win').classList.add('hidden');
  $('hud').classList.remove('hidden');
  toast('FIND THE GOLDEN FLAG TO ESCAPE', 3.2);
}

function toSelect() {
  state = 'select';
  won = false;
  selCamGoal = null;
  selTargetGoal.set(0, 1.2, 0.6);
  $('win').classList.add('hidden');
  $('hud').classList.add('hidden');
  $('select').classList.remove('hidden');
  activeScene = selectScene; activeCamera = selectCamera;
}

function showWin() {
  state = 'won';
  $('wintime').textContent = 'TIME  ' + fmtTime(elapsed);
  $('winsteps').textContent = stepCount + ' STEPS';
  $('win').classList.remove('hidden');
}

/* ================= MAIN LOOP ================= */
function tick() {
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;
  if (state === 'select') updateSelect(dt);
  else if (gameScene) updateGame(dt, t);
  renderer.render(activeScene, activeCamera);
}

// debug/testing handle
window.__game = {
  get state() { return state; },
  get selected() { return selectedChar; },
  get charCount() { return selectChars.length; },
  get gateOpen() { return gateOpen; },
  get switchOn() { return switchOn; },
  playerPos: () => player ? player.group.position.toArray() : null,
  flagPos: () => flagPos ? flagPos.toArray() : null,
  switchPos: () => switchPos ? switchPos.toArray() : null,
  gatePos: () => gateTile ? tileToWorld(gateTile[0], gateTile[1]).toArray() : null,
  tileSize: () => TILE,
  worldOf: (tx, tz) => tileToWorld(tx, tz).toArray(),
  cellOf: (x, z) => worldToTile(x, z),
  walkableAt: (x, z) => { const [tx, tz] = worldToTile(x, z); return isWalkable(tx, tz); },
  edgesAt: (tx, tz) => (inBounds(tx, tz) ? openE[tz][tx] : -1),
  pathCells: (sx, sz, tx, tz) => findPathCells(sx, sz, tx, tz),
  teleport: (x, z) => { if (player) { player.group.position.set(x, 0, z); clearClickMove(); } },
  setCamYaw: y => { camYaw = y; },
  // deterministic collision test hook: move exactly (dx,dz) through collideAxis
  nudge: (dx, dz) => { if (player) { collideAxis('x', dx); collideAxis('z', dz); } },
  clickAt: (x, z) => startClickMove(new THREE.Vector3(x, 0, z)),
  hasPath: () => !!clickPath,
  bfs: () => startupPathCheck(true),
  rooms: () => rooms.map(r => ({ ...r })),
  kindMap: () => cellKind.map(row => row.map(k => k ? k[0] : '.').join('')).join('\n'),
  layout: () => LAYOUT.slice(),
  sceneInfo: () => {
    let tris = 0, meshes = 0, lights = 0;
    gameScene.traverse(o => {
      if (o.isMesh) {
        meshes++;
        const g = o.geometry;
        tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
      }
      if (o.isLight) lights++;
    });
    return { tris: Math.round(tris), meshes, lights, drawHint: renderer.info.render.calls };
  },
  hideDungeon: h => { if (dungeonGroup) dungeonGroup.visible = !h; },
  get debugOn() { return debugOn; },
  overlayInfo: () => {
    if (!debugOverlay) return null;
    return debugOverlay.children.map(m => ({
      quads: m.geometry.index.count / 6,
      color: '#' + m.material.color.getHexString(),
    }));
  },
  choose: i => chooseCharacter(CHARACTERS[i]),
  start: () => startGame(),
};
