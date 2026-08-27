// three.js renderer: hero board (own field) + opponent mini-board, studio lighting.
import * as THREE from "three";
import { COLS, VISIBLE_ROWS } from "../../../shared/protocol";
import type { MatchSim, PlayerSim } from "../../../shared/game/engine";
import { PIECE_CELLS } from "../../../shared/game/pieces";

export const PIECE_COLORS: number[] = [0x3ee6f0, 0xffcf3f, 0xc05ce8, 0x4ade80, 0xef4444, 0x3b82f6, 0xfb923c];
const GARBAGE_COLOR = 0xb9c2d8;

interface BoardVisual {
  group: THREE.Group;
  cells: THREE.InstancedMesh;
  piece: THREE.Mesh[]; // 4 boxes for the active piece
  ghost: THREE.Mesh[];
  frame: THREE.LineSegments;
  scale: number;
}

function makeBoard(scale: number, withShadow: boolean): BoardVisual {
  const group = new THREE.Group();
  const geo = new THREE.BoxGeometry(0.94, 0.94, 0.94);
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.1 });

  const maxCells = COLS * (VISIBLE_ROWS + 2) + 8;
  const cells = new THREE.InstancedMesh(geo, mat, maxCells);
  cells.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  if (withShadow) { cells.castShadow = true; cells.receiveShadow = true; }
  group.add(cells);

  const pieceMat = new THREE.MeshStandardMaterial({ roughness: 0.25, metalness: 0.15 });
  const pieceGeo = new THREE.BoxGeometry(0.96, 0.96, 0.96);
  const piece: THREE.Mesh[] = [];
  for (let i = 0; i < 4; i++) {
    const m = new THREE.Mesh(pieceGeo, pieceMat.clone());
    if (withShadow) { m.castShadow = true; }
    m.visible = false;
    group.add(m);
    piece.push(m);
  }

  const ghostMat = new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.28, roughness: 0.6 });
  const ghost: THREE.Mesh[] = [];
  for (let i = 0; i < 4; i++) {
    const m = new THREE.Mesh(pieceGeo, ghostMat);
    m.visible = false;
    group.add(m);
    ghost.push(m);
  }

  // frame outline around the visible field
  const w = COLS, h = VISIBLE_ROWS;
  const pts: number[] = [];
  const push = (x1: number, y1: number, x2: number, y2: number) => { pts.push(x1, y1, 0, x2, y2, 0); };
  push(0, 0, w, 0); push(w, 0, w, h); push(w, h, 0, h); push(0, h, 0, 0);
  const fg = new THREE.BufferGeometry();
  fg.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  const frame = new THREE.LineSegments(fg, new THREE.LineBasicMaterial({ color: 0x4a5a9e, transparent: true, opacity: 0.8 }));
  group.add(frame);

  // subtle back panel for depth
  const back = new THREE.Mesh(
    new THREE.PlaneGeometry(w + 1.2, h + 1.2),
    new THREE.MeshStandardMaterial({ color: 0x0d1226, roughness: 0.9, transparent: true, opacity: 0.55 })
  );
  back.position.set(w / 2, h / 2, -0.7);
  group.add(back);

  // floor slab (catches shadows)
  if (withShadow) {
    const floor = new THREE.Mesh(
      new THREE.BoxGeometry(w + 1.6, 0.3, 4),
      new THREE.MeshStandardMaterial({ color: 0x111735, roughness: 0.8 })
    );
    floor.position.set(w / 2, -0.16, 0.9);
    floor.receiveShadow = true;
    group.add(floor);
  }

  return { group, cells, piece, ghost, frame, scale };
}

export class Scene3D {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private own: BoardVisual;
  private opp: BoardVisual;
  private dummy = new THREE.Object3D();
  private colorObj = new THREE.Color();
  private clearFx: { pos: [number, number]; life: number; board: "own" | "opp"; group: THREE.Group }[] = [];

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b0e1a);
    this.scene.fog = new THREE.Fog(0x0b0e1a, 42, 90);

    this.camera = new THREE.PerspectiveCamera(46, 1, 0.1, 200);
    this.camera.position.set(COLS / 2, VISIBLE_ROWS * 0.52 + 3.2, 27);
    this.camera.lookAt(COLS / 2, VISIBLE_ROWS * 0.46, 0);

    // lighting: key + fill + ambient
    const amb = new THREE.AmbientLight(0x8899cc, 0.55);
    this.scene.add(amb);
    const key = new THREE.DirectionalLight(0xffffff, 1.35);
    key.position.set(COLS / 2 + 14, VISIBLE_ROWS + 16, 18);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = -16; key.shadow.camera.right = 16;
    key.shadow.camera.top = 26; key.shadow.camera.bottom = -8;
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x6ea8ff, 0.35);
    fill.position.set(-10, 8, 14);
    this.scene.add(fill);

    // hero board (own) — centered
    this.own = makeBoard(1, true);
    this.own.group.position.set(0, 0, 0);
    this.scene.add(this.own.group);

    // opponent mini-board — upper right, angled toward center
    this.opp = makeBoard(0.52, false);
    this.opp.group.position.set(COLS / 2 + 8.6, VISIBLE_ROWS * 0.74, -3);
    this.opp.group.rotation.y = -0.16;
    this.scene.add(this.opp.group);

    window.addEventListener("resize", () => this.resize());
    this.resize();
  }

  resize(): void {
    const c = this.renderer.domElement;
    const w = c.clientWidth || window.innerWidth, h = c.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // keep the hero board framed on narrow screens
    const fitDist = Math.max(27, (COLS * 0.62) / Math.tan((this.camera.fov * Math.PI) / 360));
    this.camera.position.z = fitDist;
    this.camera.updateProjectionMatrix();
  }

  private cellPos(b: BoardVisual, x: number, y: number): [number, number, number] {
    return [x + 0.5, y + 0.5, 0];
  }

  /** Render one frame of the match state. */
  render(sim: MatchSim, dt: number): void {
    this.drawBoard(this.own, sim.players[0]);
    this.drawBoard(this.opp, sim.players[1]);

    // clear effects (fading ghost rows)
    for (let i = this.clearFx.length - 1; i >= 0; i--) {
      const fx = this.clearFx[i];
      fx.life -= dt * 2.4;
      if (fx.life <= 0) {
        this.scene.remove(fx.group);
        fx.group.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.geometry) m.geometry.dispose();
        });
        this.clearFx.splice(i, 1);
        continue;
      }
      fx.group.children.forEach((c) => {
        const mat = (c as THREE.Mesh).material as THREE.MeshBasicMaterial;
        mat.opacity = Math.max(0, fx.life) * 0.9;
      });
    }

    this.renderer.render(this.scene, this.camera);
  }

  private drawBoard(b: BoardVisual, p: PlayerSim): void {
    // locked cells (visible + hidden rows that are in range)
    let n = 0;
    for (let y = 0; y < VISIBLE_ROWS + 2 && n < b.cells.count; y++) {
      for (let x = 0; x < COLS && n < b.cells.count; x++) {
        const v = p.grid[y * COLS + x];
        if (v === 0) continue;
        this.dummy.position.set(...this.cellPos(b, x, y));
        this.dummy.scale.setScalar(1);
        this.dummy.updateMatrix();
        b.cells.setMatrixAt(n, this.dummy.matrix);
        const color = v >= 8 ? GARBAGE_COLOR : PIECE_COLORS[v - 1];
        this.colorObj.setHex(color);
        // slight vertical shading for depth
        this.colorObj.multiplyScalar(0.92 + (y / VISIBLE_ROWS) * 0.16);
        b.cells.setColorAt(n, this.colorObj);
        n++;
      }
    }
    b.cells.count = n;
    b.cells.instanceMatrix.needsUpdate = true;
    if (b.cells.instanceColor) b.cells.instanceColor.needsUpdate = true;

    // active piece + ghost
    const a = p.active;
    for (let i = 0; i < 4; i++) { b.piece[i].visible = false; b.ghost[i].visible = false; }
    if (!a) return;
    const cellsArr = PIECE_CELLS[a.type][a.rot];

    // ghost: hard-drop landing position
    let gy = a.y;
    while (true) {
      let ok = true;
      for (const [cx, cy] of cellsArr) {
        const gx = a.x + cx, gyy = gy + cy;
        if (gx < 0 || gx >= COLS || gyy < 0 || (gyy < p.grid.length / COLS && p.grid[gyy * COLS + gx] > 0)) { ok = false; break; }
      }
      if (!ok) break;
      gy--;
    }

    for (let i = 0; i < 4; i++) {
      const [cx, cy] = cellsArr[i];
      b.piece[i].position.set(a.x + cx + 0.5, a.y + cy + 0.5, 0);
      (b.piece[i].material as THREE.MeshStandardMaterial).color.setHex(PIECE_COLORS[a.type]);
      b.piece[i].visible = true;

      if (gy !== a.y) {
        b.ghost[i].position.set(a.x + cx + 0.5, gy + cy + 0.5, 0);
        (b.ghost[i].material as THREE.MeshStandardMaterial).color.setHex(PIECE_COLORS[a.type]);
        b.ghost[i].visible = true;
      }
    }
  }

  /** Spawn a fading flash where rows were cleared on the given board. */
  addClearFx(board: "own" | "opp", rows: number[], lines: number): void {
    const group = new THREE.Group();
    const color = lines >= 4 ? 0xffffff : 0x9ecbff;
    for (const y of rows) {
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(COLS, 1, 1.02),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85 })
      );
      m.position.set(COLS / 2, y + 0.5, 0);
      group.add(m);
    }
    const target = board === "own" ? this.own : this.opp;
    target.group.add(group);
    this.clearFx.push({ pos: [0, 0], life: 1, board, group });
  }

  /** Brief red pulse on the opponent frame when garbage lands (or own). */
  pulseFrame(board: "own" | "opp"): void {
    const b = board === "own" ? this.own : this.opp;
    const mat = b.frame.material as THREE.LineBasicMaterial;
    mat.color.setHex(0xef4444);
    setTimeout(() => mat.color.setHex(0x4a5a9e), 260);
  }

  /** Project a board-space point to screen px (for DOM labels). */
  project(board: "own" | "opp", x: number, y: number): { x: number; y: number } | null {
    const b = board === "own" ? this.own : this.opp;
    const v = new THREE.Vector3(x, y, 0).applyMatrix4(b.group.matrixWorld);
    v.project(this.camera);
    if (v.z > 1) return null;
    const c = this.renderer.domElement;
    return { x: (v.x * 0.5 + 0.5) * c.clientWidth, y: (-v.y * 0.5 + 0.5) * c.clientHeight };
  }

  dispose(): void {
    this.renderer.dispose();
  }
}
