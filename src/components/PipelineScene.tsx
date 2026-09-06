"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";

// An interactive 3D diagram of how work moves through OpenVault: one agent's
// loop, and then two agents on the same project without a human relaying
// between them.
//
// Styled after the SPX6900 look already in globals.css — neon on paper,
// Orbitron, chunky offset shadows, sharp edges, zero rounding — so the diagram
// reads as part of the same world rather than a stock chart.
//
// Deliberately orthographic and edge-lit rather than a perspective glossy
// render: this is a wiring diagram that happens to be in 3D, and depth is used
// to separate the two agents' lanes, not for spectacle.

const INK = 0x0a0a0a;
const PAPER = 0xf5f5f5;
const LIME = 0xe5ff1a;
const MAGENTA = 0xff1a66;
const CYAN = 0x00e5ff;

type Step = {
  id: string;
  label: string;
  sub: string;
  lane: 0 | 1 | 2; // 0 = agent A, 1 = the vault, 2 = agent B
  x: number;
  colour: number;
};

// The loop, laid out left to right, one column per step. Lanes are ROWS, not
// depth: a swim-lane diagram is fundamentally 2D, and separating the lanes
// along the view axis made three parallel tracks read as one diagonal
// staircase with the cards occluding each other. Depth is now used only for
// the extruded card and its shadow.
//
// Column pitch must exceed CARD_W or neighbours overlap — which is exactly
// what went wrong at a pitch of 3 with 4.6-wide cards.
const CARD_W = 4.6;
// CARD_H must match the card geometry below, and for a while it did not: the
// box was built from a hardcoded 1.44 while the label plane used CARD_H. Once
// CARD_H moved, the label — which draws its own black border — sat inset
// inside a box that has its own edge outline, so every card wore a doubled
// border with a white sliver between the two. Everything is derived from these
// two constants now, so the pair cannot drift again.
const CARD_H = 1.44;
const CARD_D = 0.34; // extrusion depth
const PITCH = 5.0;

// Lane assignment follows WHERE THE THING LIVES, not who benefits from it.
// The review queue is vault state — CodeSuggestion rows — so it sits in the
// vault lane and carries the vault's colour. Approving is a separate act
// performed BY the other agent, so it gets its own step in their lane; without
// it the diagram jumped from vault storage straight to "owner applies" and the
// queue looked misfiled.
const RAW: Array<Omit<Step, "x">> = [
  { id: "prompt", label: "YOU PROMPT", sub: "“add retries to the client”", lane: 0, colour: LIME },
  { id: "brief", label: "GET_BRIEFING", sub: "state, skills, open queue", lane: 1, colour: CYAN },
  { id: "read", label: "READ_CODE", sub: "the mirror, at one commit", lane: 1, colour: CYAN },
  { id: "announce", label: "ANNOUNCE_WORK", sub: "warns on overlap", lane: 0, colour: LIME },
  { id: "suggest", label: "SUGGEST_CHANGE", sub: "anchored edits + reason", lane: 0, colour: LIME },
  { id: "queue", label: "REVIEW QUEUE", sub: "vault state, unreviewed", lane: 1, colour: CYAN },
  { id: "review", label: "REVIEW_SUGGESTION", sub: "they approve or reject", lane: 2, colour: MAGENTA },
  { id: "apply", label: "OWNER APPLIES", sub: "their checkout, then push", lane: 2, colour: MAGENTA },
  { id: "ci", label: "CI MIRRORS", sub: "vault follows git", lane: 1, colour: CYAN },
];
const STEPS: Step[] = RAW.map((s, i) => ({ ...s, x: (i - (RAW.length - 1) / 2) * PITCH }));

// Row height per lane. Generous rather than tight: the diagram is inherently
// wide (nine columns), so an orthographic frame sized to that width leaves
// vertical room, and spreading the lanes uses it instead of leaving the whole
// thing floating in an empty box. At 4.4 the three rows filled about 60% of
// the frame's height and sat in a band with dead space above and below.
const LANE_Y = [6.6, 0, -6.6];

export default function PipelineScene() {
  const hostRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(PAPER);

    // Orthographic: a diagram should not have vanishing points arguing with it.
    // The frustum is derived from the actual span of the chain rather than
    // guessed — a hand-picked number left the diagram floating small in a large
    // empty frame, which is the usual failure of 3D-for-its-own-sake.
    // Width is driven by the lane plates on the left through to the last card
    // on the right, so the whole diagram is framed rather than guessed at.
    const left = STEPS[0].x - CARD_W / 2 - 5.2;
    const right = STEPS[STEPS.length - 1].x + CARD_W / 2 + 1.4;
    const spanX = right - left;
    // Height of the content itself, so the frame fits BOTH dimensions and the
    // diagram is drawn as large as it can be without clipping.
    const spanY = LANE_Y[0] - LANE_Y[2] + CARD_H + 1.6;
    const aspect = host.clientWidth / host.clientHeight;
    const frustum = Math.max(spanX / (2 * aspect), spanY / 2) * 1.05;
    const camera = new THREE.OrthographicCamera(-frustum * aspect, frustum * aspect, frustum, -frustum, 0.1, 300);
    // Nearly front-on, with just enough offset for the extruded cards to show
    // a side and cast their offset shadow. Any more rotation and the rows stop
    // reading as rows.
    camera.position.set(3.4, 3.0, 26);
    camera.lookAt((left + right) / 2, 0, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(host.clientWidth, host.clientHeight);
    host.appendChild(renderer.domElement);

    scene.add(new THREE.AmbientLight(0xffffff, 0.85));
    const key = new THREE.DirectionalLight(0xffffff, 0.5);
    key.position.set(8, 14, 10);
    scene.add(key);

    // A label drawn to a canvas, so the Orbitron/Space Mono pairing carries
    // into the scene instead of being replaced by a generic 3D font.
    //
    // Two lines, title over sub. A single line was tried when a ninth column
    // was added, on the theory that the sub-line had become too small to read;
    // it made every card half-empty instead, because the box is sized for two.
    // The sub-line is texture as much as text — it is what makes a card look
    // like a filled card — and the hover read-out is there for anyone who
    // actually needs to read it.
    //
    // The canvas aspect must track CARD_W:CARD_H, or the texture is stretched
    // onto the plane and the border stroke comes out thicker on two sides than
    // the other two.
    const LABEL_W = 640;
    const LABEL_H = Math.round((LABEL_W * CARD_H) / CARD_W);
    const makeLabel = (title: string, sub: string, colour: number) => {
      const c = document.createElement("canvas");
      c.width = LABEL_W;
      c.height = LABEL_H;
      const g = c.getContext("2d")!;
      g.fillStyle = "#ffffff";
      g.fillRect(0, 0, c.width, c.height);
      g.strokeStyle = "#0a0a0a";
      g.lineWidth = 10;
      g.strokeRect(5, 5, c.width - 10, c.height - 10);
      g.fillStyle = `#${colour.toString(16).padStart(6, "0")}`;
      g.fillRect(5, 5, c.width - 10, 16);
      g.fillStyle = "#0a0a0a";
      // Shrink to fit rather than overflow: REVIEW_SUGGESTION is half again as
      // long as READ_CODE, and a clipped label is worse than a smaller one.
      const inner = c.width - 52;
      let size = 44;
      do {
        g.font = `900 ${size}px Orbitron, sans-serif`;
        g.letterSpacing = "3px";
        size -= 2;
      } while (g.measureText(title).width > inner && size > 28);
      g.fillText(title, 26, 92);
      let subSize = 26;
      do {
        g.font = `${subSize}px 'Space Mono', ui-monospace, monospace`;
        subSize -= 1;
      } while (g.measureText(sub).width > inner && subSize > 16);
      g.fillStyle = "#444";
      g.fillText(sub, 26, 140);
      const tex = new THREE.CanvasTexture(c);
      tex.anisotropy = 8;
      const mat = new THREE.MeshBasicMaterial({ map: tex });
      return new THREE.Mesh(new THREE.PlaneGeometry(CARD_W, CARD_H), mat);
    };

    const nodes: Array<{ step: Step; group: THREE.Group; box: THREE.Mesh }> = [];
    const raycastTargets: THREE.Object3D[] = [];

    for (const step of STEPS) {
      const group = new THREE.Group();
      group.position.set(step.x, LANE_Y[step.lane], 0);
      group.userData.baseY = LANE_Y[step.lane];

      // The chunky offset shadow, as geometry: a black slab behind the card.
      const shadow = new THREE.Mesh(
        new THREE.BoxGeometry(CARD_W, CARD_H, CARD_D + 0.01),
        new THREE.MeshBasicMaterial({ color: INK }),
      );
      shadow.position.set(0.28, -0.28, -0.34);
      group.add(shadow);

      const box = new THREE.Mesh(
        new THREE.BoxGeometry(CARD_W, CARD_H, CARD_D),
        new THREE.MeshLambertMaterial({ color: 0xffffff }),
      );
      group.add(box);

      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(box.geometry),
        new THREE.LineBasicMaterial({ color: INK }),
      );
      group.add(edges);

      const label = makeLabel(step.label, step.sub, step.colour);
      label.position.set(0, 0, 0.18);
      group.add(label);

      scene.add(group);
      nodes.push({ step, group, box });
      raycastTargets.push(box);
      box.userData.id = step.id;
    }

    // Connectors, drawn as thick ink lines between consecutive steps. Static:
    // the wires are the diagram's skeleton, and nothing rides along them.
    const linkMat = new THREE.LineBasicMaterial({ color: INK });
    for (let i = 0; i < STEPS.length - 1; i++) {
      const a = new THREE.Vector3(STEPS[i].x + CARD_W / 2, LANE_Y[STEPS[i].lane], 0);
      const b = new THREE.Vector3(STEPS[i + 1].x - CARD_W / 2, LANE_Y[STEPS[i + 1].lane], 0);
      // Right-angled elbows rather than diagonals: a lane change should look
      // like a lane change, not like a slope.
      const mid = new THREE.Vector3((a.x + b.x) / 2, a.y, 0);
      const mid2 = new THREE.Vector3((a.x + b.x) / 2, b.y, 0);
      const pts = a.y === b.y ? [a, b] : [a, mid, mid2, b];
      scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), linkMat));
    }

    // Lane plates. Billboarded to face the camera rather than lying flat on
    // the ground: laid flat they were skewed by the isometric projection into
    // near-illegibility, which defeats the point of labelling the lanes.
    const laneNames = ["CONTRIBUTOR", "THE VAULT", "OWNER"];
    const laneColours = [LIME, CYAN, MAGENTA];
    const billboards: THREE.Mesh[] = [];
    laneNames.forEach((name, i) => {
      const c = document.createElement("canvas");
      c.width = 560;
      c.height = 120;
      const g = c.getContext("2d")!;
      g.fillStyle = `#${laneColours[i].toString(16).padStart(6, "0")}`;
      g.fillRect(0, 0, c.width, c.height);
      g.strokeStyle = "#0a0a0a";
      g.lineWidth = 12;
      g.strokeRect(6, 6, c.width - 12, c.height - 12);
      g.fillStyle = "#0a0a0a";
      g.font = "900 46px Orbitron, sans-serif";
      g.letterSpacing = "5px";
      g.textBaseline = "middle";
      g.fillText(name, 30, c.height / 2 + 2);
      const tex = new THREE.CanvasTexture(c);
      tex.anisotropy = 4;
      const plate = new THREE.Mesh(
        new THREE.PlaneGeometry(4.5, 0.96),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true }),
      );
      plate.position.set(STEPS[0].x - CARD_W / 2 - 2.6, LANE_Y[i], 0);
      scene.add(plate);
      billboards.push(plate);
    });

    // Graph paper BEHIND the diagram rather than a floor under it: with a
    // front-on camera a ground plane is edge-on and reads as a stray line.
    const paper = new THREE.GridHelper(80, 80, 0xdddddd, 0xeaeaea);
    paper.rotation.x = Math.PI / 2;
    paper.position.z = -4;
    scene.add(paper);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let hovered: string | null = null;

    const onMove = (e: PointerEvent) => {
      const r = renderer.domElement.getBoundingClientRect();
      pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
      pointer.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    };
    renderer.domElement.addEventListener("pointermove", onMove);

    // Every card and lane plate faces the camera, so text is never read at a
    // slant. Done once here rather than per-frame because the camera is fixed.
    const faceCamera = (o: THREE.Object3D) => o.quaternion.copy(camera.quaternion);
    billboards.forEach(faceCamera);
    nodes.forEach((n) => {
      n.group.rotation.set(0, 0, 0);
      n.group.quaternion.copy(camera.quaternion);
    });

    // One step is live at a time, and the live step walks the chain in order.
    // There is no travelling marker any more — the sequence itself carries the
    // direction, and a puck sliding along the wires competed with the thing it
    // was supposed to be pointing at.
    //
    // GAP is the beat between steps. Without it each card would hand straight
    // over to the next and the row would read as one continuous wave rather
    // than nine discrete steps firing in turn.
    const DWELL = 0.85;
    const GAP = 0.22;
    const SLOT = DWELL + GAP;
    const CYCLE = STEPS.length * SLOT;

    let t = 0;
    let raf = 0;
    const clock = new THREE.Clock();

    const animate = () => {
      raf = requestAnimationFrame(animate);
      const dt = clock.getDelta();
      if (!pausedRef.current) t = (t + dt) % CYCLE;

      // Which step is live, and how far into its dwell. During the GAP no step
      // is live, so every card is settling.
      const slot = Math.floor(t / SLOT);
      const intoSlot = t - slot * SLOT;
      const dwellAt = intoSlot < DWELL ? slot : -1;
      const dwellT = intoSlot;

      nodes.forEach((n, i) => {
        const base = n.group.userData.baseY as number;
        const isLive = i === dwellAt;
        // A steady bob while the work is HERE, settling back the instant it
        // moves on — the animation says "this step is happening now" rather
        // than just marking a position.
        const bob = isLive ? Math.sin((dwellT / DWELL) * Math.PI * 2 * 1.5) * 0.22 + 0.3 : 0;
        const target = base + bob;
        // Snap up quickly, settle down gently: an abrupt drop reads as a
        // glitch, an abrupt rise reads as arrival.
        n.group.position.y += (target - n.group.position.y) * Math.min(1, dt * (isLive ? 14 : 7));
        const mat = n.box.material as THREE.MeshLambertMaterial;
        mat.color.lerp(new THREE.Color(isLive ? n.step.colour : 0xffffff), Math.min(1, dt * 9));
      });

      // Hover read-out.
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(raycastTargets, false)[0];
      const id = (hit?.object.userData.id as string) ?? null;
      if (id !== hovered) {
        hovered = id;
        setActive(id);
        renderer.domElement.style.cursor = id ? "pointer" : "default";
      }

      renderer.render(scene, camera);
    };
    animate();

    const onResize = () => {
      const w = host.clientWidth;
      const h = host.clientHeight;
      const a = w / h;
      camera.left = -frustum * a;
      camera.right = frustum * a;
      camera.top = frustum;
      camera.bottom = -frustum;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(host);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.domElement.removeEventListener("pointermove", onMove);
      renderer.dispose();
      host.removeChild(renderer.domElement);
    };
  }, []);

  const step = STEPS.find((s) => s.id === active);

  return (
    <div className="pipe-wrap">
      <div ref={hostRef} className="pipe-canvas" />
      <div className="pipe-hud">
        <button className="pipe-btn" onClick={() => setPaused((p) => !p)}>
          {paused ? "▶ PLAY" : "❚❚ PAUSE"}
        </button>
        <div className="pipe-read">
          {step ? (
            <>
              <strong>{step.label}</strong>
              <span>{step.sub}</span>
            </>
          ) : (
            <span className="pipe-dim">hover a step</span>
          )}
        </div>
      </div>
    </div>
  );
}
