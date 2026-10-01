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
//   S start room 3x3 | L large room 5x5 | W wide room 5x3 | F finish room 5x5 (large)
//   - corridor (auto-picks straight/corner/end/junction/intersection + rotation)
//   J junction (3-way) | X intersection (4-way, forced)
//   G locked gate (gate-metal-bars, opens via floor switch)
//   T stairs, 2x1 tiles, anchor = west tile, ascends eastward
//   P floor switch (walkable room floor + pressure plate)
//   . empty
const LAYOUT = [
  ".......LLLLL..............",
  ".SSS...LLLLL..............",
  ".SSS--JLLLLL--............",
  ".SSS..-LLLLL.-............",
  "......-LLLLL.-.......FFFFF",
  "...........WWWPW.....FFFFF",
  "...........WWWWW-G-..FFFFF",
  "...........WWWWW.....FFFFF",
  ".....................FFFFF",
];
const ROOM_DEFS = {
  S: { piece: 'room-small', w: 3, h: 3 },
  L: { piece: 'room-large', w: 5, h: 5 },
  W: { piece: 'room-wide',  w: 5, h: 3 },
  F: { piece: 'room-large', w: 5, h: 5 }, // finish room
};
const PIECE_FILES = { // glb file per piece key (+ variations unused for now)
  'room-small': 'room-small.glb', 'room-large': 'room-large.glb', 'room-wide': 'room-wide.glb',
  'corridor': 'corridor.glb', 'corridor-corner': 'corridor-corner.glb',
  'corridor-end': 'corridor-end.glb', 'corridor-junction': 'corridor-junction.glb',
  'corridor-intersection': 'corridor-intersection.glb',
  'gate-metal-bars': 'gate-metal-bars.glb', 'stairs': 'stairs.glb',
};

// ---------------- Tunables ----------------
const WALK_SPEED = 3.4, SPRINT_SPEED = 6.8, PLAYER_RADIUS = 0.45;
const CAM_DIST = 8, CAM_MIN = 3.5, CAM_MAX = 13;
const STEP_LENGTH = 0.8; // world units per counted step

// ---------------- Globals ----------------
let renderer, clock;
let selectScene, selectCamera, gameScene, gameCamera, activeScene, activeCamera;
let TILE = 4;                       // measured at boot from corridor.glb
let MAP_W, MAP_H, OFF_X, OFF_Z;     // dungeon extents / centering offsets
let pieceTemplates = {};            // piece key -> Object3D template
let charCache = {};                 // 'a'..'r' -> { gltf, height }
let state = 'loading';              // loading | select | playing | won
let selectedChar = null;            // chosen letter
let selectChars = [];               // {letter, group, mixer, platform}
let selectRaycaster = new THREE.Raycaster();
let selectPointer = new THREE.Vector2();
let selCamGoal = null;              // camera tween target on select screen
let selDrag = null;

// game state
let player = null;                  // {group, mixer, actions, yaw}
let walkGrid = [];                  // [z][x] -> true walkable
let gateTile = null, gateGroup = null, gateOpen = false, gateAnim = 0;
let switchPos = null, switchGroup = null, switchTop = null, switchOn = false;
let startPos = null, flagPos = null, flagMesh = null, flagBase = null, flagLight = null;
let torches = [];                   // {light, base, phase}
let dungeonGroup = null, colliderMeshes = [];
let camYaw = -Math.PI / 2, camPitch = 0.42, camDist = CAM_DIST;
let keys = {}, clickTarget = null;
let moveDir = new THREE.Vector3();
let startTime = 0, elapsed = 0, totalDist = 0, stepCount = 0;
let winTimer = 0, won = false;
let debugOrbit = null, debugOn = false;
let animState = 'idle';
let toastTimer = 0;

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
        const h = new THREE.Box3().setFromObject(gltf.scene).max.y - new THREE.Box3().setFromObject(gltf.scene).min.y;
        charCache[j.key] = { gltf, height: h };
      }
      done++;
      $('loadfill').style.width = (done / jobs.length * 100).toFixed(1) + '%';
      $('loadtext').textContent = `SUMMONING ASSETS… ${done}/${jobs.length}`;
    }));
    // load a few at a time so the progress bar paints
    if (partial.length % 4 === 0) await Promise.all(partial.splice(0));
  }
  await Promise.all(partial);

  // Measure the grid tile size from a room + a corridor (bounding boxes).
  const roomBox = new THREE.Box3().setFromObject(pieceTemplates['room-small']);
  const corBox = new THREE.Box3().setFromObject(pieceTemplates['corridor']);
  const roomSize = roomBox.max.x - roomBox.min.x;   // 12 -> 3 tiles
  const corSize = corBox.max.x - corBox.min.x;      // 4  -> 1 tile
  TILE = corSize;
  console.log(`tile=${TILE}, room-small=${roomSize} (${(roomSize / TILE).toFixed(1)} tiles)`);

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
function isWalkable(tx, tz) {
  if (tx < 0 || tz < 0 || tx >= MAP_W || tz >= MAP_H) return false;
  return !!walkGrid[tz][tx];
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
    selectChars.push({ letter, group, mixer, ring, baseX: cx, baseZ: cz, spin: Math.random() * Math.PI * 2 });
  });

  // frame all 18
  selectCamera.position.set(0, 9.5, 15.5);
  selectCamera.lookAt(0, 1.2, 0.6);

  // picking + drag-look
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
  // tween camera in for a closer look
  selCamGoal = {
    target: new THREE.Vector3(c.baseX, 1.3, c.baseZ),
    dist: 6.2, elev: 0.32, azimuth: null, // keep current azimuth
  };
  selTargetGoal.copy(selCamGoal.target);
}
const selTargetGoal = new THREE.Vector3(0, 1.2, 0.6);

function updateSelect(dt, t) {
  for (const c of selectChars) {
    c.mixer.update(dt);
    if (c.letter !== selectedChar) c.group.rotation.y += dt * 0.55; // slow turntable
  }
  // camera drift / tween
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
// Parse LAYOUT into piece placements, auto-rotating corridors from neighbor masks.
// Returns nothing; fills walkGrid, gateTile, switchPos, startPos, flagPos.
function buildDungeon() {
  gameScene = new THREE.Scene();
  gameScene.background = new THREE.Color(0x05060a);
  gameScene.fog = new THREE.FogExp2(0x05060a, 0.02);
  gameCamera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 300);
  dungeonGroup = new THREE.Group();
  gameScene.add(dungeonGroup);
  colliderMeshes = [];
  walkGrid = Array.from({ length: MAP_H }, () => new Array(MAP_W).fill(false));

  gameScene.add(new THREE.AmbientLight(0x2a2438, 0.5));
  const hemi = new THREE.HemisphereLight(0x3a3f5a, 0x0a0805, 0.35);
  gameScene.add(hemi);

  const placements = []; // {piece, ax, az, w, h, rotY, off:[x,y,z]}

  // pass 1: rooms, stairs, gate, switch — mark walkable footprints
  const claim = (ax, az, w, h) => {
    for (let dz = 0; dz < h; dz++) for (let dx = 0; dx < w; dx++) {
      const tx = ax + dx, tz = az + dz;
      if (tx >= 0 && tz >= 0 && tx < MAP_W && tz < MAP_H) walkGrid[tz][tx] = true;
    }
  };
  for (let z = 0; z < MAP_H; z++) for (let x = 0; x < MAP_W; x++) {
    const ch = LAYOUT[z][x];
    if (ROOM_DEFS[ch]) {
      const d = ROOM_DEFS[ch];
      placements.push({ piece: d.piece, ax: x, az: z, w: d.w, h: d.h, rotY: 0, off: [0, 0, 0] });
      claim(x, z, d.w, d.h);
      if (ch === 'S') startPos = tileToWorld(x + 1, z + 1);       // room-small center tile
      if (ch === 'F') flagPos = tileToWorld(x + 2, z + 2);        // room-large center tile
    } else if (ch === 'T') {
      placements.push({ piece: 'stairs', ax: x, az: z, w: 2, h: 1, rotY: -Math.PI / 2, off: [-2, -7.3, 0] });
      claim(x, z, 2, 1);
    } else if (ch === 'G') {
      gateTile = [x, z];
      placements.push({ piece: 'gate-metal-bars', ax: x, az: z, w: 1, h: 1, rotY: Math.PI / 2, off: [0, 0, 0], gate: true });
      claim(x, z, 1, 1); // walkable for connectivity, but blocked until opened
    } else if (ch === 'P') {
      claim(x, z, 1, 1);
      switchPos = tileToWorld(x, z);
    }
  }

  // pass 2: corridors — resolve piece + rotation from orthogonal neighbor mask
  const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]]; // N E S W
  const conn = (x, z) => {
    const m = [false, false, false, false];
    DIRS.forEach(([dx, dz], i) => {
      const nx = x + dx, nz = z + dz;
      if (nx >= 0 && nz >= 0 && nx < MAP_W && nz < MAP_H && walkGrid[nz][nx]) m[i] = true;
    });
    return m;
  };
  for (let z = 0; z < MAP_H; z++) for (let x = 0; x < MAP_W; x++) {
    const ch = LAYOUT[z][x];
    if (ch !== '-' && ch !== 'J' && ch !== 'X') continue;
    const [n, e, s, w] = conn(x, z);
    const count = [n, e, s, w].filter(Boolean).length;
    let piece = 'corridor', rotY = 0;
    if (ch === 'J' || (ch === '-' && count === 3)) {
      piece = 'corridor-junction';
      // default (rot 0): openings E,W,N — wall on S
      if (!s) rotY = 0; else if (!n) rotY = Math.PI; else if (!e) rotY = Math.PI / 2; else rotY = -Math.PI / 2;
    } else if (ch === 'X' || count === 4) {
      piece = 'corridor-intersection';
    } else if (count <= 1) {
      piece = 'corridor-end'; // default opening faces +X (E)
      if (e) rotY = 0; else if (w) rotY = Math.PI; else if (s) rotY = -Math.PI / 2; else rotY = Math.PI / 2;
    } else if ((n && s) || (e && w)) {
      piece = 'corridor'; // default runs E-W
      rotY = (n && s) ? Math.PI / 2 : 0;
    } else {
      piece = 'corridor-corner'; // default openings E+S
      if (e && s) rotY = 0; else if (s && w) rotY = -Math.PI / 2;
      else if (w && n) rotY = Math.PI; else rotY = Math.PI / 2;
    }
    placements.push({ piece, ax: x, az: z, w: 1, h: 1, rotY, off: [0, 0, 0] });
    claim(x, z, 1, 1);
  }

  // instantiate
  for (const p of placements) {
    const tpl = pieceTemplates[p.piece];
    if (!tpl) { console.warn('missing piece', p.piece); continue; }
    const g = new THREE.Group();
    const model = tpl.clone(true);
    model.rotation.y = p.rotY;
    model.position.set(p.off[0], p.off[1], p.off[2]);
    model.traverse(o => { if (o.isMesh) { o.receiveShadow = true; colliderMeshes.push(o); } });
    g.add(model);
    const cx = (p.ax + p.w / 2) * TILE - OFF_X;
    const cz = (p.az + p.h / 2) * TILE - OFF_Z;
    g.position.set(cx, 0, cz);
    if (p.gate) { gateGroup = g; }
    dungeonGroup.add(g);
  }

  buildTorches();
  buildStartRing();
  buildFlag();
  buildSwitch();
  buildPlayerLight();
}

function torchPositions() {
  // room centers + junction, in tile coords
  return [[2, 2], [9, 2], [13, 6], [23, 6], [6, 2]];
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
    const flameMat = new THREE.MeshBasicMaterial({ color: 0xffb347 });
    const flame = new THREE.Mesh(flameGeo, flameMat);
    flame.position.set(p.x + 1.2, 2.75, p.z + 1.2);
    dungeonGroup.add(flame);
    const light = new THREE.PointLight(0xff8c3a, 22, 20, 2);
    light.position.copy(flame.position);
    dungeonGroup.add(light);
    torches.push({ light, flame, base: 22, phase: Math.random() * 10 });
  }
}

function buildStartRing() {
  const geo = new THREE.RingGeometry(0.9, 1.25, 40);
  const mat = new THREE.MeshBasicMaterial({ color: 0x53e9ff, transparent: true, opacity: 0.85, side: THREE.DoubleSide });
  const ring = new THREE.Mesh(geo, mat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(startPos.x, 0.06, startPos.z);
  ring.userData.startRing = true;
  dungeonGroup.add(ring);
  dungeonGroup.userData.startRing = ring;
}

function buildFlag() {
  const g = new THREE.Group();
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x5a3a1a, roughness: 0.7 });
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 3.4, 10), poleMat);
  pole.position.y = 1.7;
  g.add(pole);
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 12),
    new THREE.MeshStandardMaterial({ color: 0xd8a93f, metalness: 0.9, roughness: 0.25, emissive: 0x664411, emissiveIntensity: 0.4 }));
  knob.position.y = 3.5;
  g.add(knob);
  // waving flag: plane with sine-displaced vertices, anchored at the pole edge
  const fgeo = new THREE.PlaneGeometry(1.9, 1.05, 16, 6);
  fgeo.translate(0.95, 0, 0); // x=0 edge at pole
  const fmat = new THREE.MeshStandardMaterial({ color: 0xc22730, side: THREE.DoubleSide, roughness: 0.6,
    emissive: 0x550000, emissiveIntensity: 0.35 });
  const flag = new THREE.Mesh(fgeo, fmat);
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
    new THREE.MeshStandardMaterial({ color: 0xcc7722, roughness: 0.4, metalness: 0.3,
      emissive: 0xff6a00, emissiveIntensity: 0.9 }));
  switchTop.position.y = 0.2;
  g.add(switchTop);
  g.position.set(switchPos.x, 0, switchPos.z);
  switchGroup = g;
  dungeonGroup.add(g);
}

// one shadow-casting light that follows the player (shadows on player only)
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

/* ================= PLAYER ================= */
const FACE_OFFSET = 0; // tweak if the character model faces away from movement
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
  player = { group, mixer, actions, yaw: Math.PI / 2 };
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

/* ================= INPUT ================= */
function wireGameInput() {
  const el = renderer.domElement;
  addEventListener('keydown', e => {
    if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code)) e.preventDefault();
    if (state !== 'playing' || won) return;
    keys[e.code] = true;
    if (/^(KeyW|KeyA|KeyS|KeyD|Arrow)/.test(e.code)) clickTarget = null;
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
  });
  el.addEventListener('pointerup', e => {
    if (state !== 'playing' || won || !downPos) return;
    const dx = e.clientX - downPos[0], dy = e.clientY - downPos[1];
    downPos = null;
    if (dx * dx + dy * dy > 36) return; // it was a drag
    // click-to-move: raycast onto the floor plane
    selectPointer.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    selectRaycaster.setFromCamera(selectPointer, gameCamera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const hit = new THREE.Vector3();
    if (selectRaycaster.ray.intersectPlane(plane, hit)) {
      const [tx, tz] = worldToTile(hit.x, hit.z);
      if (isWalkable(tx, tz)) { clickTarget = hit.clone(); clickTarget.y = 0; }
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
  toast(debugOn ? 'DEBUG CAMERA ON (O TO EXIT)' : 'DEBUG CAMERA OFF');
}

/* ================= COLLISION (walkable-cell grid, no physics lib) ================= */
const _clamp = THREE.MathUtils.clamp;
function collide(pos) {
  for (let iter = 0; iter < 2; iter++) {
    const tx0 = Math.floor((pos.x - PLAYER_RADIUS + OFF_X) / TILE);
    const tz0 = Math.floor((pos.z - PLAYER_RADIUS + OFF_Z) / TILE);
    const tx1 = Math.floor((pos.x + PLAYER_RADIUS + OFF_X) / TILE);
    const tz1 = Math.floor((pos.z + PLAYER_RADIUS + OFF_Z) / TILE);
    for (let tz = tz0; tz <= tz1; tz++) for (let tx = tx0; tx <= tx1; tx++) {
      if (isWalkable(tx, tz)) continue;
      const minX = tx * TILE - OFF_X, maxX = minX + TILE;
      const minZ = tz * TILE - OFF_Z, maxZ = minZ + TILE;
      const cx = _clamp(pos.x, minX, maxX), cz = _clamp(pos.z, minZ, maxZ);
      const dx = pos.x - cx, dz = pos.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 < PLAYER_RADIUS * PLAYER_RADIUS) {
        if (d2 > 1e-9) {
          const d = Math.sqrt(d2), push = (PLAYER_RADIUS - d) / d;
          pos.x += dx * push; pos.z += dz * push;
        } else { pos.x += PLAYER_RADIUS; }
      }
    }
  }
}

/* ================= GAME UPDATE ================= */
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3();
const _ray = new THREE.Raycaster();

function updateGame(dt, t) {
  const p = player.group.position;

  // --- movement ---
  let mvx = 0, mvz = 0, sprinting = false;
  if (state === 'playing' && !won) {
    const fx = -Math.sin(camYaw), fz = -Math.cos(camYaw); // camera forward on ground
    const rx = -fz, rz = fx;                              // camera right
    const fwd = (keys.KeyW || keys.ArrowUp ? 1 : 0) - (keys.KeyS || keys.ArrowDown ? 1 : 0);
    const str = (keys.KeyD || keys.ArrowRight ? 1 : 0) - (keys.KeyA || keys.ArrowLeft ? 1 : 0);
    mvx = fx * fwd + rx * str; mvz = fz * fwd + rz * str;
    sprinting = !!(keys.ShiftLeft || keys.ShiftRight);
    if (clickTarget) {
      const dx = clickTarget.x - p.x, dz = clickTarget.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.35) clickTarget = null;
      else { mvx = dx / d; mvz = dz / d; }
    }
    const mlen = Math.hypot(mvx, mvz);
    if (mlen > 0.01) {
      const sp = (sprinting && !clickTarget ? SPRINT_SPEED : (clickTarget ? WALK_SPEED : (sprinting ? SPRINT_SPEED : WALK_SPEED)));
      const nx = mvx / mlen, nz = mvz / mlen;
      _v1.set(p.x, 0, p.z);
      p.x += nx * sp * dt; p.z += nz * sp * dt;
      collide(p);
      const moved = Math.hypot(p.x - _v1.x, p.z - _v1.z);
      totalDist += moved;
      stepCount = Math.floor(totalDist / STEP_LENGTH);
      if (clickTarget && moved < sp * dt * 0.25) clickTarget = null; // blocked
      // face movement
      const targetYaw = Math.atan2(nx, nz);
      let d = targetYaw - player.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      player.yaw += d * Math.min(1, dt * 11);
      player.group.rotation.y = player.yaw + FACE_OFFSET;
      setAnim(sprinting ? 'sprint' : 'walk');
    } else setAnim('idle');
  }
  player.mixer.update(dt);

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
    const e = gateAnim * gateAnim;
    gateGroup.position.y = -4.4 * e;
    if (gateAnim >= 1) {
      walkGrid[gateTile[1]][gateTile[0]] = true;
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
  // --- start ring pulse ---
  const ring = dungeonGroup.userData.startRing;
  if (ring) ring.material.opacity = 0.55 + Math.sin(t * 3) * 0.3;

  // --- player-following shadow light ---
  playerLight.position.set(p.x + 6, 12, p.z + 4);
  playerLight.target.position.set(p.x, 0, p.z);

  // --- camera ---
  updateCamera(dt);

  // --- HUD ---
  if (state === 'playing' && !won) {
    elapsed = (performance.now() - startTime) / 1000;
    $('timer').textContent = fmtTime(elapsed);
    $('steps').textContent = stepCount + ' STEPS';
  }
  drawMinimap();
  updateHintArrow();
  if (toastTimer > 0) { toastTimer -= dt; if (toastTimer <= 0) $('toast').style.opacity = '0'; }

  // --- win check ---
  if (state === 'playing' && !won) {
    const d = Math.hypot(p.x - flagPos.x, p.z - flagPos.z);
    if (d < TILE) {
      won = true; winTimer = 1.6;
      const em = player.actions['emote-yes'];
      if (em) {
        const prev = player.actions[animState];
        if (prev) prev.fadeOut(0.25);
        em.reset(); em.setLoop(THREE.LoopOnce, 1); em.clampWhenFinished = true;
        em.fadeIn(0.25).play();
        animState = 'emote-yes';
      }
      clickTarget = null;
    }
  } else if (won && state === 'playing') {
    winTimer -= dt;
    if (winTimer <= 0) showWin();
  }
}

function updateCamera(dt) {
  if (debugOn && debugOrbit) {
    debugOrbit.target.copy(player.group.position); debugOrbit.target.y += 1.2;
    debugOrbit.update();
    return;
  }
  const p = player.group.position;
  _v1.set(p.x, p.y + 1.7, p.z); // head
  const cp = Math.cos(camPitch), sp2 = Math.sin(camPitch);
  _v2.set(Math.sin(camYaw) * cp, sp2, Math.cos(camYaw) * cp); // head -> camera dir
  _ray.set(_v1, _v2); _ray.far = camDist;
  const hits = _ray.intersectObjects(colliderMeshes, false);
  let d = camDist;
  if (hits.length) d = Math.max(1.7, hits[0].distance - 0.45);
  _v2.multiplyScalar(d).add(_v1);
  gameCamera.position.lerp(_v2, 1 - Math.pow(0.0001, dt));
  gameCamera.lookAt(_v1);
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
  const s = 6;
  mm.clearRect(0, 0, 156, 54);
  for (let z = 0; z < MAP_H; z++) for (let x = 0; x < MAP_W; x++) {
    if (!walkGrid[z][x]) continue;
    mm.fillStyle = '#4d465e';
    mm.fillRect(x * s, z * s, s - 0.5, s - 0.5);
  }
  if (gateTile) {
    mm.fillStyle = gateOpen ? '#3fd06a' : '#d04848';
    mm.fillRect(gateTile[0] * s, gateTile[1] * s, s - 0.5, s - 0.5);
  }
  if (switchPos && !switchOn) {
    const [tx, tz] = worldToTile(switchPos.x, switchPos.z);
    mm.fillStyle = '#ff9a2a';
    mm.fillRect(tx * s + 1, tz * s + 1, s - 2.5, s - 2.5);
  }
  // flag
  const [fx, fz] = worldToTile(flagPos.x, flagPos.z);
  mm.fillStyle = '#ffd94d';
  mm.beginPath();
  mm.moveTo(fx * s + 3, fz * s + 0.5); mm.lineTo(fx * s + 3, fz * s + 5.5); mm.lineTo(fx * s + 6, fz * s + 3);
  mm.closePath(); mm.fill();
  // player
  const p = player.group.position;
  mm.fillStyle = '#ffffff';
  mm.beginPath();
  mm.arc((p.x + OFF_X) / TILE * s, (p.z + OFF_Z) / TILE * s, 2.2, 0, 7);
  mm.fill();
}
function updateHintArrow() {
  const p = player.group.position;
  const b = Math.atan2(flagPos.x - p.x, flagPos.z - p.z);
  const f = Math.atan2(-Math.sin(camYaw), -Math.cos(camYaw));
  let rel = b - f;
  $('hintarrow').style.transform = `rotate(${-rel}rad)`;
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

function startGame() {
  $('fader').style.opacity = '1';
  setTimeout(() => {
    if (!gameScene) buildDungeon();
    // gate starts closed
    gateOpen = false; gateAnim = 0; switchOn = false;
    walkGrid[gateTile[1]][gateTile[0]] = false;
    if (gateGroup) gateGroup.position.y = 0;
    if (switchTop) { switchTop.position.y = 0.2; switchTop.material.emissive.setHex(0xff6a00); }
    spawnPlayer();
    camYaw = -Math.PI / 2; camPitch = 0.42; camDist = CAM_DIST;
    gameCamera.position.copy(startPos).add(new THREE.Vector3(-9, 6, 0));
    debugOn = false; if (debugOrbit) debugOrbit.enabled = false;
    startTime = performance.now(); elapsed = 0; totalDist = 0; stepCount = 0;
    won = false; clickTarget = null; keys = {};
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
  gateOpen = false; gateAnim = 0; switchOn = false;
  walkGrid[gateTile[1]][gateTile[0]] = false;
  gateGroup.position.y = 0;
  switchTop.position.y = 0.2; switchTop.material.emissive.setHex(0xff6a00);
  player.group.position.copy(startPos);
  player.yaw = Math.PI / 2; player.group.rotation.y = player.yaw + FACE_OFFSET;
  setAnim('idle');
  camYaw = -Math.PI / 2; camPitch = 0.42;
  startTime = performance.now(); elapsed = 0; totalDist = 0; stepCount = 0;
  won = false; clickTarget = null;
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
  if (state === 'select') updateSelect(dt, t);
  else if (gameScene) updateGame(dt, t);
  renderer.render(activeScene, activeCamera);
}

// tiny debug/testing handle
window.__game = {
  get state() { return state; },
  get selected() { return selectedChar; },
  playerPos: () => player ? player.group.position.toArray() : null,
  flagPos: () => flagPos ? flagPos.toArray() : null,
  tileSize: () => TILE,
  choose: i => chooseCharacter(CHARACTERS[i]),
  start: () => startGame(),
};
