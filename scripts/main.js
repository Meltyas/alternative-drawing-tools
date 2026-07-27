/**
 * Alternative Drawing Tools
 *
 * High-precision drawing layer with a floating toolbar. Foundry's core
 * freehand tool samples the pointer every ~75ms, producing jagged polygons;
 * this layer captures EVERY mouse event, bakes smoothing/styles into the
 * points themselves (WYSIWYG) and saves each stroke as a native Drawing, so
 * persistence, syncing and permissions are handled by the core.
 * Player operations are executed on the GM's client via socketlib.
 */

const MODULE_ID = "alternative-drawing-tools";
const LAYER_NAME = "guardDraw";

const SETTINGS = {
  color: "strokeColor",
  width: "strokeWidth",
  alpha: "strokeAlpha",
  smooth: "smoothing",
  above: "aboveTokens",
  eraser: "eraserSize",
  sketchy: "sketchyStyle",
  lock: "toolLock",
  fill: "fillColor",
  edges: "edges",
  custom: "customSwatches"
};

/** Elevation applied to strokes that should render above tokens. */
const ABOVE_ELEVATION = 100;

const getSetting = (key) => game.settings.get(MODULE_ID, key);
const setSetting = (key, value) => game.settings.set(MODULE_ID, key, value);

/* -------------------------------------------- */
/*  Socket (players operate through the GM)     */
/* -------------------------------------------- */

let gpdSocket = null;

Hooks.once("socketlib.ready", () => {
  gpdSocket = socketlib.registerModule(MODULE_ID) ?? null;
  if (!gpdSocket) {
    // socketlib refuses the registration if the server has not read the
    // "socket": true manifest flag yet (requires a world restart).
    console.error(`${MODULE_ID} | socketlib refused the registration; restart the world to enable the socket.`);
    return;
  }
  gpdSocket.register("createDrawings", socketCreateDrawings);
  gpdSocket.register("deleteDrawings", socketDeleteDrawings);
  gpdSocket.register("updateDrawings", socketUpdateDrawings);
  gpdSocket.register("applyErase", socketApplyErase);
});

/** Runs on the GM client: creates strokes and returns their ids. */
async function socketCreateDrawings(sceneId, dataArray) {
  const scene = game.scenes.get(sceneId);
  if (!scene) return [];
  const docs = await scene.createEmbeddedDocuments("Drawing", dataArray);
  return docs.map((d) => d.id);
}

/** Runs on the GM client: deletes strokes (ignores already-missing ids). */
async function socketDeleteDrawings(sceneId, ids) {
  const scene = game.scenes.get(sceneId);
  if (!scene) return;
  const existing = ids.filter((id) => scene.drawings.has(id));
  if (existing.length) await scene.deleteEmbeddedDocuments("Drawing", existing);
}

/** Runs on the GM client: updates strokes (e.g. moving with the select tool). */
async function socketUpdateDrawings(sceneId, updates) {
  const scene = game.scenes.get(sceneId);
  if (!scene) return;
  const existing = updates.filter((u) => scene.drawings.has(u._id));
  if (existing.length) await scene.updateEmbeddedDocuments("Drawing", existing);
}

/** Runs on the GM client: applies an eraser cut (create fragments + delete originals). */
async function socketApplyErase(sceneId, toCreate, toDelete) {
  const scene = game.scenes.get(sceneId);
  if (!scene) return;
  if (toCreate.length) await scene.createEmbeddedDocuments("Drawing", toCreate);
  const existing = toDelete.filter((id) => scene.drawings.has(id));
  if (existing.length) await scene.deleteEmbeddedDocuments("Drawing", existing);
}

/* -------------------------------------------- */
/*  Geometry                                    */
/* -------------------------------------------- */

function distToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Ramer-Douglas-Peucker simplification (iterative, no recursion). */
function simplifyPath(points, epsilon) {
  if (points.length < 3) return points;
  const keep = new Array(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let maxDist = 0;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = distToSegment(points[i], points[first], points[last]);
      if (d > maxDist) {
        maxDist = d;
        index = i;
      }
    }
    if (maxDist > epsilon && index > 0) {
      keep[index] = true;
      stack.push([first, index], [index, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/**
 * Bakes the smoothing into the points themselves: samples the same
 * midpoint-quadratic curve the live preview draws, with density adapted to
 * the zoom level (~one point every 4 screen px). The saved stroke is thus
 * identical to the preview, without relying on Foundry's bezierFactor
 * (which bulges curves differently).
 */
function smoothPoints(pts, scale) {
  if (pts.length < 3) return pts;
  const out = [{ ...pts[0] }];
  let prev = pts[0];
  for (let i = 1; i < pts.length - 1; i++) {
    const ctrl = pts[i];
    const end = { x: (pts[i].x + pts[i + 1].x) / 2, y: (pts[i].y + pts[i + 1].y) / 2 };
    const chord = Math.hypot(end.x - prev.x, end.y - prev.y);
    const steps = Math.min(16, Math.max(2, Math.ceil((chord * scale) / 4)));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const a = (1 - t) * (1 - t);
      const b = 2 * t * (1 - t);
      const c = t * t;
      out.push({
        x: a * prev.x + b * ctrl.x + c * end.x,
        y: a * prev.y + b * ctrl.y + c * end.y
      });
    }
    prev = end;
  }
  out.push({ ...pts[pts.length - 1] });
  return out;
}

/**
 * Resamples a polyline at regular `spacing` intervals, preserving the
 * endpoints. Needed so the eraser can cut in the middle of long segments,
 * not only at existing vertices.
 */
function resamplePath(pts, spacing) {
  if (pts.length < 2) return pts.map((p) => ({ x: p.x, y: p.y }));
  const out = [{ x: pts[0].x, y: pts[0].y }];
  let need = spacing;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    if (!segLen) continue;
    let travelled = 0;
    while (travelled + need <= segLen) {
      travelled += need;
      const t = travelled / segLen;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      need = spacing;
    }
    need -= segLen - travelled;
  }
  const last = pts[pts.length - 1];
  const tail = out[out.length - 1];
  if (Math.hypot(last.x - tail.x, last.y - tail.y) > 0.01) out.push({ x: last.x, y: last.y });
  return out;
}

function pathLength(pts) {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return len;
}

/** Constrains a line's destination to multiples of 15°. */
function constrainAngle(origin, dest) {
  const dx = dest.x - origin.x;
  const dy = dest.y - origin.y;
  const dist = Math.hypot(dx, dy);
  const step = Math.PI / 12;
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  return { x: origin.x + Math.cos(angle) * dist, y: origin.y + Math.sin(angle) * dist };
}

/** Deterministic PRNG: same seed → same jitter, so preview and final stroke match. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Hand-drawn sketch style: subdivides the segments and applies deterministic
 * (seeded) deviation to each point. Amplitude and step in screen px.
 * `level`: 1 = artist (subtle), 2 = cartoonist (looser).
 */
function sketchify(pts, closed, scale, seed, width, level = 1, allowDouble = true) {
  if (pts.length < 2) return pts;
  const rng = mulberry32(seed);
  const loop = closed ? [...pts, { ...pts[0] }] : pts;
  const spacing = 6 / scale;
  const dense = resamplePath(loop, spacing);
  if (dense.length < 3) return loop;

  const cum = [0];
  for (let i = 1; i < dense.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(dense[i].x - dense[i - 1].x, dense[i].y - dense[i - 1].y));
  }
  const total = cum[cum.length - 1] || 1;

  // Arc-length sampling, with wrap-around so a pass can overshoot the seam
  const sampleAt = (s) => {
    const d = closed ? ((s % total) + total) % total : Math.min(Math.max(s, 0), total);
    const f = (d / total) * (dense.length - 1);
    const i = Math.min(dense.length - 2, Math.floor(f));
    const t = f - i;
    const a = dense[i];
    const b = dense[i + 1];
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  };

  // rough.js technique: the stroke is drawn TWICE, each pass with its own
  // very subtle deviation (1-2 gentle bows + micro-noise). On closed shapes
  // each pass overshoots the seam by 2-5%, so the ends visibly overlap
  // instead of closing perfectly.
  const amp = ((level >= 2 ? 2.6 : 1.2) + width * 0.06) / scale;

  const makePass = () => {
    const bows = 1 + Math.floor(rng() * 2);
    const p1 = rng() * 2 * Math.PI;
    const k2 = 2 + Math.floor(rng() * 2);
    const p2 = rng() * 2 * Math.PI;
    const overshoot = closed ? total * (0.02 + rng() * 0.03) : 0;
    const length = total + overshoot;
    const n = Math.max(8, Math.ceil(length / spacing));
    const out = [];
    for (let j = 0; j <= n; j++) {
      const s = (j / n) * length;
      const p = sampleAt(s);
      const q = sampleAt(s + 2 * spacing);
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      const len = Math.hypot(dx, dy) || 1;
      const t = s / total;
      const wave = 0.7 * Math.sin(Math.PI * bows * t + p1) + 0.3 * Math.sin(2 * Math.PI * k2 * t + p2);
      const off = amp * wave + amp * 0.3 * (rng() * 2 - 1);
      out.push({ x: p.x + (-dy / len) * off, y: p.y + (dx / len) * off });
    }
    return out;
  };

  const pass1 = makePass();
  if (!allowDouble) return pass1;
  // Second pass reversed: the joint between both passes lands in the same
  // area of the stroke, so the jump is imperceptible.
  const pass2 = makePass().reverse();
  return [...pass1, ...pass2];
}

/**
 * Ideal geometry for each shape tool: vertex list plus whether the shape is
 * closed. `proportional` forces square/circle, `snapAngle` constrains lines
 * and arrows to 15° angles.
 */
function shapePoints(tool, o, d, { proportional = false, snapAngle = false, roundEdges = false } = {}) {
  const bbox = () => {
    let w = d.x - o.x;
    let h = d.y - o.y;
    if (proportional) {
      const m = Math.max(Math.abs(w), Math.abs(h));
      w = (w < 0 ? -1 : 1) * m;
      h = (h < 0 ? -1 : 1) * m;
    }
    return { x2: o.x + w, y2: o.y + h, cx: o.x + w / 2, cy: o.y + h / 2, rx: Math.abs(w) / 2, ry: Math.abs(h) / 2 };
  };
  switch (tool) {
    case "rect": {
      const { x2, y2 } = bbox();
      if (roundEdges) {
        const x0 = Math.min(o.x, x2);
        const y0 = Math.min(o.y, y2);
        const x1 = Math.max(o.x, x2);
        const y1 = Math.max(o.y, y2);
        const w = x1 - x0;
        const h = y1 - y0;
        const r = Math.min(0.25 * Math.min(w, h), 40);
        if (r > 2) {
          const pts = [];
          const arc = (cx, cy, a0) => {
            for (let i = 0; i <= 6; i++) {
              const a = a0 + (i / 6) * (Math.PI / 2);
              pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
            }
          };
          arc(x0 + r, y0 + r, Math.PI);        // top-left corner
          arc(x1 - r, y0 + r, 1.5 * Math.PI);  // top-right
          arc(x1 - r, y1 - r, 0);              // bottom-right
          arc(x0 + r, y1 - r, 0.5 * Math.PI);  // bottom-left
          return { pts, closed: true };
        }
      }
      return { pts: [{ x: o.x, y: o.y }, { x: x2, y: o.y }, { x: x2, y: y2 }, { x: o.x, y: y2 }], closed: true };
    }
    case "diamond": {
      const { x2, y2, cx, cy } = bbox();
      return { pts: [{ x: cx, y: o.y }, { x: x2, y: cy }, { x: cx, y: y2 }, { x: o.x, y: cy }], closed: true };
    }
    case "ellipse": {
      const { cx, cy, rx, ry } = bbox();
      const pts = [];
      const N = 48;
      for (let i = 0; i < N; i++) {
        const a = (i / N) * 2 * Math.PI;
        pts.push({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) });
      }
      return { pts, closed: true };
    }
    case "line": {
      const dest = snapAngle ? constrainAngle(o, d) : d;
      return { pts: [{ x: o.x, y: o.y }, { x: dest.x, y: dest.y }], closed: false };
    }
    case "arrow": {
      const dest = snapAngle ? constrainAngle(o, d) : d;
      const ang = Math.atan2(dest.y - o.y, dest.x - o.x);
      const len = Math.hypot(dest.x - o.x, dest.y - o.y);
      const hl = Math.min(Math.max(len * 0.18, 8), 60);
      const spread = 0.45;
      const w1 = { x: dest.x - hl * Math.cos(ang - spread), y: dest.y - hl * Math.sin(ang - spread) };
      const w2 = { x: dest.x - hl * Math.cos(ang + spread), y: dest.y - hl * Math.sin(ang + spread) };
      return { pts: [{ x: o.x, y: o.y }, { x: dest.x, y: dest.y }, w1, { x: dest.x, y: dest.y }, w2], closed: false };
    }
  }
  return { pts: [], closed: false };
}

const SHAPE_TOOLS = ["rect", "diamond", "ellipse", "line", "arrow"];
const SKETCHY_TOOLS = ["rect", "diamond", "ellipse", "line", "arrow"];

/* -------------------------------------------- */
/*  Interaction layer                           */
/* -------------------------------------------- */

class PrecisionDrawLayer extends foundry.canvas.layers.InteractionLayer {
  static get layerOptions() {
    return foundry.utils.mergeObject(super.layerOptions, { name: LAYER_NAME, zIndex: 246 });
  }

  /** Active tool of our own toolbar (does not use game.activeTool). */
  #activeTool = "brush";

  /** Raw points of the in-progress stroke (world coordinates). */
  #points = [];

  /** Baked points of the in-progress shape (rect/ellipse/etc.), ready to save. */
  #shapePts = null;

  #strokeActive = false;

  /** Sketch jitter seed for the in-progress stroke. */
  #seed = 0;

  /** Drag state for hand (pan) and selection (move). */
  #dragState = null;

  /** Ids of the strokes selected with the select tool. */
  #selected = new Set();

  /** IDs of drawings created this session, for undo. */
  #history = [];

  /** Pending eraser circles (processed serially, in order). */
  #eraseQueue = [];

  #eraseRunning = false;

  /** Last known pointer position, to redraw the ring without moving the mouse. */
  #lastPointer = null;

  /**
   * In v14 scene controls are prepared by the layer class itself, and it is
   * the control's onChange that must activate the canvas layer.
   * The tools live in our floating toolbar, not in the scene controls.
   */
  static prepareSceneControls() {
    return {
      name: LAYER_NAME,
      order: 3.5,
      title: "Alternative Drawing Tools",
      icon: "fa-solid fa-pen-nib",
      layer: LAYER_NAME,
      onChange: (event, active) => {
        if ( active ) canvas[LAYER_NAME].activate();
      },
      tools: {}
    };
  }

  async _draw(options) {
    await super._draw(options);
    this.previewG = this.addChild(new PIXI.Graphics());
    this.selectionG = this.addChild(new PIXI.Graphics());
    this.eraserRing = this.addChild(new PIXI.Graphics());
  }

  _activate() {
    super._activate();
    // The eraser ring is tracked from the stage: the layer itself must not
    // be interactive or it would steal pointer events from the tokens.
    canvas.stage.on("globalpointermove", this.#onGlobalMove, this);
    // Alt+wheel never reaches _onMouseWheel (the core sends it to zoom), so
    // it is intercepted in the capture phase, before the MouseManager listener.
    window.addEventListener("wheel", this.#onWheelAlt, { passive: false, capture: true });
    // Keyboard shortcuts (1-0, V/R/D/O/A/L/P/T/E/H). Capture phase so they
    // win over Foundry's macro hotbar.
    window.addEventListener("keydown", this.#onKeyDown, { capture: true });
    DrawToolbar.show();
    DrawPalette.show();
  }

  _deactivate() {
    super._deactivate();
    canvas.stage.off("globalpointermove", this.#onGlobalMove, this);
    window.removeEventListener("wheel", this.#onWheelAlt, { capture: true });
    window.removeEventListener("keydown", this.#onKeyDown, { capture: true });
    this.#resetStroke();
    this.#dragState = null;
    this.#clearSelection();
    this.eraserRing?.clear();
    DrawToolbar.hide();
    DrawPalette.hide();
  }

  /** @override */
  async _tearDown(options) {
    // Scene teardown does NOT call _deactivate: without this cleanup the
    // toolbar/panel would stay visible on the next scene, the window
    // listeners would leak, and the stage listener would keep firing against
    // destroyed graphics (throwing on every pointer move).
    canvas.stage.off("globalpointermove", this.#onGlobalMove, this);
    window.removeEventListener("wheel", this.#onWheelAlt, { capture: true });
    window.removeEventListener("keydown", this.#onKeyDown, { capture: true });
    DrawToolbar.hide();
    DrawPalette.hide();
    return super._tearDown(options);
  }

  /** Native Ctrl+Z: the core routes it to the active layer. */
  _onUndoKey(event) {
    this.undoStroke();
    return true;
  }

  /** Native Ctrl+A: select every module stroke on the scene. */
  _onSelectAllKey(event) {
    this.setTool("select");
    this.#selected = new Set(this.#strokeDrawings().map((d) => d.id));
    this.#drawSelection();
    return true;
  }

  get tool() {
    return this.#activeTool;
  }

  setTool(name) {
    if (this.#activeTool === name) return;
    this.#activeTool = name;
    if (name !== "select") this.#clearSelection();
    this.#drawEraserRing();
    DrawToolbar.setActive(name);
  }

  get #tool() {
    return this.#activeTool;
  }

  /** Eraser radius in world units; the setting is in screen px, zoom-invariant. */
  get #eraserRadius() {
    const scale = canvas.stage.scale.x || 1;
    return getSetting(SETTINGS.eraser) / scale;
  }

  /* ---------- Keyboard ---------- */

  #onKeyDown = (event) => {
    if (!this.active) return;
    const t = event.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t?.isContentEditable) return;

    if (event.code === "Delete" || event.code === "Backspace") {
      if (this.#selected.size) {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.deleteSelected();
      }
      return;
    }
    if (event.code === "Escape") {
      if (this.#selected.size) {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.#clearSelection();
      }
      return;
    }

    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    const map = {
      Digit1: "select", KeyV: "select",
      Digit2: "rect", KeyR: "rect",
      Digit3: "diamond", KeyD: "diamond",
      Digit4: "ellipse", KeyO: "ellipse",
      Digit5: "arrow", KeyA: "arrow",
      Digit6: "line", KeyL: "line",
      Digit7: "brush", KeyP: "brush",
      Digit8: "text", KeyT: "text",
      Digit0: "eraser", KeyE: "eraser",
      KeyH: "hand"
    };
    const tool = map[event.code];
    if (!tool) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.setTool(tool);
  };

  /* ---------- Wheel ---------- */

  /**
   * Ctrl+wheel: next/previous color. Shift+wheel: stroke width (or eraser
   * size). The core only routes here when Ctrl or Shift is held and the
   * pointer is over the canvas, with event.delta already normalized.
   */
  _onMouseWheel(event) {
    const direction = event.delta < 0 ? 1 : -1;
    if (game.keyboard.isModifierActive("CONTROL")) this.#cycleColor(direction);
    else if (this.#tool === "eraser") this.#adjustEraserSize(direction);
    else this.#adjustWidth(direction);
  }

  /** Alt+wheel: opacity (intercepted in capture phase to beat the core zoom). */
  #onWheelAlt = (event) => {
    if (!this.active || !canvas?.ready) return;
    if (!event.altKey || event.ctrlKey || event.shiftKey) return;
    if (game.keyboard.isModifierActive("CONTROL")) return;
    const hover = document.elementFromPoint(event.clientX, event.clientY);
    if (!hover || hover.id !== "board") return;
    const dy = event.deltaY || event.deltaX;
    if (!dy) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.#adjustAlpha(dy < 0 ? 1 : -1);
  };

  async #adjustWidth(direction) {
    const width = Math.max(1, Math.min(40, getSetting(SETTINGS.width) + direction));
    await setSetting(SETTINGS.width, width);
    this.applyStyleToSelection({ width });
    this.#afterStyleChange();
  }

  async #cycleColor(direction) {
    const palette = [...SWATCHES, ...(getSetting(SETTINGS.custom) ?? [])];
    const current = getSetting(SETTINGS.color).toLowerCase();
    let idx = palette.findIndex((c) => c.toLowerCase() === current);
    idx = idx === -1
      ? (direction > 0 ? 0 : palette.length - 1)
      : (idx + direction + palette.length) % palette.length;
    await setSetting(SETTINGS.color, palette[idx]);
    this.applyStyleToSelection({ color: palette[idx] });
    this.#afterStyleChange();
  }

  async #adjustEraserSize(direction) {
    const size = Math.max(4, Math.min(120, getSetting(SETTINGS.eraser) + direction * 3));
    await setSetting(SETTINGS.eraser, size);
    this.#drawEraserRing();
  }

  async #adjustAlpha(direction) {
    const alpha = Math.round(Math.max(0.1, Math.min(1, getSetting(SETTINGS.alpha) + direction * 0.05)) * 100) / 100;
    await setSetting(SETTINGS.alpha, alpha);
    this.applyStyleToSelection({ alpha });
    this.#afterStyleChange();
  }

  /** Reflects a style change in the palette and the in-progress stroke. */
  #afterStyleChange() {
    DrawPalette.sync();
    if (this.#strokeActive) this.#renderPreview();
  }

  /* ---------- Mouse events ---------- */

  #onGlobalMove(event) {
    this.#lastPointer = event.getLocalPosition(this);
    this.#drawEraserRing();
  }

  #drawEraserRing() {
    if (!this.active || this.#tool !== "eraser" || !this.#lastPointer) {
      this.eraserRing.clear();
      return;
    }
    const p = this.#lastPointer;
    this.eraserRing
      .clear()
      .lineStyle({ width: 2, color: 0xffffff, alpha: 0.8 })
      .drawCircle(p.x, p.y, this.#eraserRadius);
  }

  _onClickLeft(event) {
    const origin = event.interactionData.origin;
    switch (this.#tool) {
      case "eraser":
        this.#eraseAt(origin);
        break;
      case "select": {
        const shift = event.shiftKey ?? event.data?.originalEvent?.shiftKey;
        const hit = this.#hitTest(origin);
        if (shift && hit) this.#toggleSelected(hit.id);
        else if (hit) {
          // Clicking an already-selected member keeps the group intact
          if (!this.#selected.has(hit.id)) this.#selectOnly(hit.id);
        }
        else if (!shift) this.#clearSelection();
        break;
      }
      case "text":
        this.#promptText(origin);
        break;
    }
  }

  _onDragLeftStart(event) {
    const origin = event.interactionData.origin;
    switch (this.#tool) {
      case "eraser":
        this.#eraseAt(origin);
        return;
      case "hand":
        this.#dragState = {
          type: "pan",
          startGlobal: { x: event.global.x, y: event.global.y },
          startPivot: { x: canvas.stage.pivot.x, y: canvas.stage.pivot.y }
        };
        return;
      case "select": {
        const shift = event.shiftKey ?? event.data?.originalEvent?.shiftKey;
        const doc = this.#hitTest(origin);
        if (doc) {
          if (shift) this.#selected.add(doc.id);
          else if (!this.#selected.has(doc.id)) this.#selectOnly(doc.id);
          this.#drawSelection();
          // Move the whole selected group
          const starts = {};
          for (const id of this.#selected) {
            const d = canvas.scene.drawings.get(id);
            if (d) starts[id] = { x: d.x, y: d.y };
          }
          this.#dragState = {
            type: "move",
            starts,
            origin: { x: origin.x, y: origin.y },
            delta: { x: 0, y: 0 }
          };
        } else {
          // Rubber-band marquee on empty space; Shift keeps prior selection
          this.#dragState = {
            type: "marquee",
            origin: { x: origin.x, y: origin.y },
            keep: shift ? new Set(this.#selected) : new Set()
          };
          if (!shift) this.#clearSelection();
        }
        return;
      }
      case "text":
        return;
      case "brush":
        this.#strokeActive = true;
        this.#points = [{ x: origin.x, y: origin.y }];
        return;
      default: {
        // Shape tools
        this.#strokeActive = true;
        this.#points = [{ x: origin.x, y: origin.y }];
        this.#seed = (Math.random() * 2 ** 32) >>> 0;
        this.#shapePts = null;
      }
    }
  }

  _onDragLeftMove(event) {
    const pos = event.interactionData.destination;
    const shift = event.shiftKey ?? event.data?.originalEvent?.shiftKey;

    if (this.#tool === "eraser") return this.#eraseAt(pos);

    if (this.#dragState?.type === "pan") {
      const scale = canvas.stage.scale.x || 1;
      const dx = (event.global.x - this.#dragState.startGlobal.x) / scale;
      const dy = (event.global.y - this.#dragState.startGlobal.y) / scale;
      canvas.pan({ x: this.#dragState.startPivot.x - dx, y: this.#dragState.startPivot.y - dy });
      return;
    }

    if (this.#dragState?.type === "move") {
      this.#dragState.delta = { x: pos.x - this.#dragState.origin.x, y: pos.y - this.#dragState.origin.y };
      this.#drawSelection(this.#dragState.delta);
      return;
    }

    if (this.#dragState?.type === "marquee") {
      const o = this.#dragState.origin;
      const band = {
        x: Math.min(o.x, pos.x),
        y: Math.min(o.y, pos.y),
        w: Math.abs(pos.x - o.x),
        h: Math.abs(pos.y - o.y)
      };
      this.#dragState.band = band;
      this.#drawSelection({ x: 0, y: 0 }, band);
      return;
    }

    if (!this.#strokeActive) return;

    if (this.#tool === "brush") {
      const last = this.#points[this.#points.length - 1];
      const minDist = 0.75 / (canvas.stage.scale.x || 1);
      if (Math.hypot(pos.x - last.x, pos.y - last.y) >= minDist) {
        this.#points.push({ x: pos.x, y: pos.y });
      }
      this.#renderPreview();
      return;
    }

    if (SHAPE_TOOLS.includes(this.#tool)) {
      const snapTools = ["line", "arrow"];
      const { pts, closed } = shapePoints(this.#tool, this.#points[0], pos, {
        proportional: shift && !snapTools.includes(this.#tool),
        snapAngle: shift && snapTools.includes(this.#tool),
        roundEdges: this.#tool === "rect" && getSetting(SETTINGS.edges) === "round"
      });
      const scale = canvas.stage.scale.x || 1;
      const level = Number(getSetting(SETTINGS.sketchy)) || 0;
      const sketchy = level > 0 && SKETCHY_TOOLS.includes(this.#tool);
      // With an active fill, use a single pass: the doubled outline
      // self-intersects and the fill triangulation may glitch.
      const fillActive = !!this.#currentFill() && ["rect", "diamond", "ellipse"].includes(this.#tool);
      const baked = sketchy
        ? sketchify(pts, closed, scale, this.#seed, getSetting(SETTINGS.width), level, !fillActive)
        : (closed ? [...pts, { ...pts[0] }] : pts);
      this.#shapePts = baked;
      this.#renderPreview();
    }
  }

  _onDragLeftDrop() {
    if (this.#dragState?.type === "pan") {
      this.#dragState = null;
      return;
    }
    if (this.#dragState?.type === "move") {
      const { starts, delta } = this.#dragState;
      this.#dragState = null;
      if (delta.x || delta.y) {
        const updates = Object.entries(starts).map(([id, start]) => ({
          _id: id,
          x: Math.round(start.x + delta.x),
          y: Math.round(start.y + delta.y)
        }));
        this.#updateStrokes(updates).then(() => this.#drawSelection());
      }
      return;
    }
    if (this.#dragState?.type === "marquee") {
      const { band, keep } = this.#dragState;
      this.#dragState = null;
      if (band) {
        this.#selected = new Set(keep);
        for (const doc of this.#strokeDrawings()) {
          const hit = doc.x < band.x + band.w && doc.x + doc.shape.width > band.x
            && doc.y < band.y + band.h && doc.y + doc.shape.height > band.y;
          if (hit) this.#selected.add(doc.id);
        }
      }
      this.#drawSelection();
      return;
    }
    if (this.#tool === "eraser") return;
    this.#finalizeStroke();
  }

  _onDragLeftCancel() {
    this.#dragState = null;
    this.#resetStroke();
    this.#drawSelection();
  }

  /* ---------- Live preview ---------- */

  #renderPreview() {
    const g = this.previewG;
    g.clear();
    g.lineStyle({
      width: getSetting(SETTINGS.width),
      color: foundry.utils.Color.from(getSetting(SETTINGS.color)),
      alpha: getSetting(SETTINGS.alpha),
      cap: PIXI.LINE_CAP.ROUND,
      join: PIXI.LINE_JOIN.ROUND
    });

    // Shapes: the baked points are exactly what will be saved
    if (SHAPE_TOOLS.includes(this.#tool)) {
      const pts = this.#shapePts;
      if (!pts || pts.length < 2) return;
      const fill = this.#currentFill();
      if (fill && ["rect", "diamond", "ellipse"].includes(this.#tool)) {
        g.beginFill(foundry.utils.Color.from(fill), getSetting(SETTINGS.alpha) * 0.6);
      }
      g.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
      if (fill && ["rect", "diamond", "ellipse"].includes(this.#tool)) g.endFill();
      return;
    }

    // Pencil
    const pts = this.#points;
    if (pts.length < 2) return;
    g.moveTo(pts[0].x, pts[0].y);
    if (pts.length === 2 || !getSetting(SETTINGS.smooth)) {
      for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
      return;
    }
    // Midpoint-quadratic curve: the same smoothing that will be baked into
    // the final points, so the preview is identical.
    for (let i = 1; i < pts.length - 1; i++) {
      const midX = (pts[i].x + pts[i + 1].x) / 2;
      const midY = (pts[i].y + pts[i + 1].y) / 2;
      g.quadraticCurveTo(pts[i].x, pts[i].y, midX, midY);
    }
    g.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
  }

  #resetStroke() {
    this.#strokeActive = false;
    this.#points = [];
    this.#shapePts = null;
    this.previewG?.clear();
  }

  /* ---------- Stroke and shape creation ---------- */

  async #finalizeStroke() {
    const tool = this.#tool;
    let pts = null;

    if (tool === "brush") {
      pts = this.#points;
      if (pts.length >= 2) {
        const scale = canvas.stage.scale.x || 1;
        pts = simplifyPath(pts, 0.9 / scale);
        if (getSetting(SETTINGS.smooth)) {
          pts = smoothPoints(pts, scale);
          // Second pass with sub-pixel tolerance: only removes collinear
          // sampling points, without altering the visible shape.
          pts = simplifyPath(pts, 0.35 / scale);
        }
      }
    } else if (SHAPE_TOOLS.includes(tool)) {
      pts = this.#shapePts;
    }

    this.#resetStroke();
    if (!pts || pts.length < 2) return;

    const data = this.#strokeData(pts, {
      color: getSetting(SETTINGS.color),
      width: getSetting(SETTINGS.width),
      alpha: getSetting(SETTINGS.alpha),
      elevation: getSetting(SETTINGS.above) ? ABOVE_ELEVATION : 0,
      fill: ["rect", "diamond", "ellipse"].includes(tool) ? this.#currentFill() : null
    });

    try {
      const ids = await this.#createStrokes([data]);
      if (ids?.[0]) this.#history.push(ids[0]);
      this.#afterCreate();
    } catch (err) {
      ui.notifications.error(`Drawing Tools: could not create the stroke (${err.message})`);
      console.error(`${MODULE_ID} |`, err);
    }
  }

  /** Without tool lock, return to selection after creating. */
  #afterCreate() {
    if (!getSetting(SETTINGS.lock)) this.setTool("select");
  }

  async #promptText(pos) {
    let text = null;
    try {
      text = await foundry.applications.api.DialogV2.prompt({
        window: { title: "Add text" },
        content: `<input type="text" name="gpd-text" placeholder="Text..." autofocus style="width: 100%;">`,
        ok: {
          label: "Place",
          callback: (event, button) => button.form.elements["gpd-text"]?.value ?? ""
        }
      });
    } catch {
      return; // dialog dismissed
    }
    if (!text?.trim()) return;
    text = text.trim();

    const fontSize = Math.max(24, Math.round(canvas.dimensions.size * 0.5));
    const width = Math.max(fontSize, Math.ceil(text.length * fontSize * 0.62));
    const height = Math.ceil(fontSize * 1.6);
    const data = {
      x: Math.round(pos.x - width / 2),
      y: Math.round(pos.y - height / 2),
      shape: { type: foundry.data.ShapeData.TYPES.RECTANGLE, width, height },
      text,
      fontSize,
      textColor: getSetting(SETTINGS.color),
      textAlpha: getSetting(SETTINGS.alpha),
      strokeWidth: 0,
      strokeAlpha: 0,
      fillType: CONST.DRAWING_FILL_TYPES.NONE,
      elevation: getSetting(SETTINGS.above) ? ABOVE_ELEVATION : 0,
      flags: { [MODULE_ID]: { stroke: true } }
    };
    try {
      const ids = await this.#createStrokes([data]);
      if (ids?.[0]) this.#history.push(ids[0]);
      this.#afterCreate();
    } catch (err) {
      ui.notifications.error(`Drawing Tools: could not create the text (${err.message})`);
      console.error(`${MODULE_ID} |`, err);
    }
  }

  /* ---------- Selection ---------- */

  /** Module stroke/text under the pointer, topmost (visual z-order) first. */
  #hitTest(pos) {
    const scale = canvas.stage.scale.x || 1;
    const slack = 6 / scale;
    const docs = this.#strokeDrawings()
      .sort((a, b) => (a.elevation - b.elevation) || (a.sort - b.sort) || a.id.localeCompare(b.id));
    for (let i = docs.length - 1; i >= 0; i--) {
      const doc = docs[i];
      const inBBox = pos.x >= doc.x - slack && pos.x <= doc.x + doc.shape.width + slack
        && pos.y >= doc.y - slack && pos.y <= doc.y + doc.shape.height + slack;
      if (!inBBox) continue;
      const raw = doc.shape.points;
      if (!raw?.length) return doc; // text and other point-less shapes: the box is enough
      const margin = doc.strokeWidth / 2 + slack;
      for (let j = 0; j + 3 < raw.length; j += 2) {
        const a = { x: doc.x + raw[j], y: doc.y + raw[j + 1] };
        const b = { x: doc.x + raw[j + 2], y: doc.y + raw[j + 3] };
        if (distToSegment(pos, a, b) <= margin) return doc;
      }
    }
    return null;
  }

  #selectOnly(id) {
    this.#selected = new Set([id]);
    this.#drawSelection();
  }

  #toggleSelected(id) {
    if (this.#selected.has(id)) this.#selected.delete(id);
    else this.#selected.add(id);
    this.#drawSelection();
  }

  #clearSelection() {
    this.#selected.clear();
    this.#drawSelection();
  }

  /** Selection boxes; `delta` previews a move, `band` draws the marquee. */
  #drawSelection(delta = { x: 0, y: 0 }, band = null) {
    const g = this.selectionG;
    g.clear();
    const scale = canvas.stage.scale.x || 1;
    const pad = 4 / scale;
    for (const id of [...this.#selected]) {
      const doc = canvas.scene.drawings.get(id);
      if (!doc) {
        this.#selected.delete(id);
        continue;
      }
      g.lineStyle({ width: 1.5 / scale, color: 0x6965db, alpha: 0.9 })
        .beginFill(0x6965db, 0.08)
        .drawRect(doc.x + delta.x - pad, doc.y + delta.y - pad, doc.shape.width + 2 * pad, doc.shape.height + 2 * pad)
        .endFill();
    }
    if (band) {
      g.lineStyle({ width: 1 / scale, color: 0x6965db, alpha: 0.9 })
        .beginFill(0x6965db, 0.05)
        .drawRect(band.x, band.y, band.w, band.h)
        .endFill();
    }
  }

  /** Redraws the selection if a document changed/disappeared (global hook). */
  _onDocChange(doc) {
    if (this.#selected.has(doc.id)) this.#drawSelection();
  }

  async deleteSelected() {
    if (!this.#selected.size) return;
    const ids = [...this.#selected];
    this.#clearSelection();
    await this.#deleteStrokes(ids);
  }

  /**
   * Reorders the selected strokes: "front" | "back" | "up" | "down".
   * The group keeps its relative order; the sort of all module strokes is
   * normalized so the resulting order is exact.
   */
  async reorderSelected(mode) {
    if (!this.#selected.size) {
      ui.notifications.info("Drawing Tools: select a stroke first.");
      return;
    }
    const sorted = this.#strokeDrawings()
      .sort((a, b) => (a.elevation - b.elevation) || (a.sort - b.sort) || a.id.localeCompare(b.id));
    const selected = sorted.filter((d) => this.#selected.has(d.id)).map((d) => d.id);
    const rest = sorted.filter((d) => !this.#selected.has(d.id)).map((d) => d.id);
    const firstIdx = sorted.findIndex((d) => this.#selected.has(d.id));
    const before = sorted.slice(0, firstIdx).filter((d) => !this.#selected.has(d.id)).length;
    const insertAt = {
      back: 0,
      down: Math.max(0, before - 1),
      up: Math.min(rest.length, before + 1),
      front: rest.length
    }[mode] ?? rest.length;
    const order = [...rest.slice(0, insertAt), ...selected, ...rest.slice(insertAt)];
    const updates = order.map((id, i) => ({ _id: id, sort: (i + 1) * 10 }));
    await this.#updateStrokes(updates);
  }

  /** A stroke whose polyline ends where it started (baked closed shape). */
  #isClosedStroke(doc) {
    const p = doc.shape.points;
    if (!p || p.length < 6) return false;
    return Math.hypot(p[0] - p[p.length - 2], p[1] - p[p.length - 1]) < 1;
  }

  /**
   * Applies a style change to the selected strokes (called by the styles
   * panel and the wheel shortcuts). Only retroactively-safe properties:
   * color, width, alpha, fill and above-tokens elevation.
   */
  async applyStyleToSelection(change) {
    if (!this.#selected.size) return;
    const updates = [];
    for (const id of this.#selected) {
      const doc = canvas.scene.drawings.get(id);
      if (!doc) continue;
      const u = { _id: id };
      const isText = !!doc.text;
      if ("color" in change) {
        if (isText) u.textColor = change.color;
        else u.strokeColor = change.color;
      }
      if ("width" in change && !isText) u.strokeWidth = change.width;
      if ("alpha" in change) {
        if (isText) u.textAlpha = change.alpha;
        else {
          u.strokeAlpha = change.alpha;
          if (doc.fillType !== CONST.DRAWING_FILL_TYPES.NONE) u.fillAlpha = change.alpha * 0.6;
        }
      }
      if ("fill" in change && !isText) {
        if (change.fill && (this.#isClosedStroke(doc) || doc.fillType !== CONST.DRAWING_FILL_TYPES.NONE)) {
          u.fillType = CONST.DRAWING_FILL_TYPES.SOLID;
          u.fillColor = change.fill;
          u.fillAlpha = doc.strokeAlpha * 0.6;
        } else if (!change.fill) {
          u.fillType = CONST.DRAWING_FILL_TYPES.NONE;
          u.fillAlpha = 0;
        }
      }
      if ("above" in change) u.elevation = change.above ? ABOVE_ELEVATION : 0;
      if (Object.keys(u).length > 1) updates.push(u);
    }
    if (updates.length) await this.#updateStrokes(updates);
  }

  /* ---------- Mutations (direct for GM, via socket for players) ---------- */

  async #socketExec(name, ...args) {
    if (!gpdSocket) {
      ui.notifications.error(
        "Drawing Tools: socket not registered. Restart the world (Return to Setup → relaunch) to enable it."
      );
      throw new Error(`${MODULE_ID}: socketlib not available`);
    }
    return gpdSocket.executeAsGM(name, ...args);
  }

  /** Creates strokes and returns their ids. */
  async #createStrokes(dataArray) {
    if (game.user.isGM) {
      const docs = await canvas.scene.createEmbeddedDocuments("Drawing", dataArray);
      return docs.map((d) => d.id);
    }
    return this.#socketExec("createDrawings", canvas.scene.id, dataArray);
  }

  async #deleteStrokes(ids) {
    if (game.user.isGM) {
      const existing = ids.filter((id) => canvas.scene.drawings.has(id));
      if (existing.length) await canvas.scene.deleteEmbeddedDocuments("Drawing", existing);
      return;
    }
    return this.#socketExec("deleteDrawings", canvas.scene.id, ids);
  }

  async #updateStrokes(updates) {
    if (game.user.isGM) {
      const existing = updates.filter((u) => canvas.scene.drawings.has(u._id));
      if (existing.length) await canvas.scene.updateEmbeddedDocuments("Drawing", existing);
      return;
    }
    return this.#socketExec("updateDrawings", canvas.scene.id, updates);
  }

  /** Current fill color, or null when transparent. */
  #currentFill() {
    const fill = getSetting(SETTINGS.fill);
    return fill && fill !== "transparent" ? fill : null;
  }

  /** Builds DrawingDocument data for a polyline from absolute points. */
  #strokeData(pts, { color, width, alpha, elevation, fill = null }) {
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const pad = Math.max(width, 1);
    return {
      x: minX - pad,
      y: minY - pad,
      shape: {
        type: foundry.data.ShapeData.TYPES.POLYGON,
        width: Math.max(...xs) - minX + 2 * pad,
        height: Math.max(...ys) - minY + 2 * pad,
        points: pts.flatMap((p) => [p.x - minX + pad, p.y - minY + pad])
      },
      strokeColor: color,
      strokeWidth: width,
      strokeAlpha: alpha,
      fillType: fill ? CONST.DRAWING_FILL_TYPES.SOLID : CONST.DRAWING_FILL_TYPES.NONE,
      fillColor: fill ?? "#ffffff",
      fillAlpha: fill ? alpha * 0.6 : 0,
      elevation,
      bezierFactor: 0,
      flags: { [MODULE_ID]: { stroke: true } }
    };
  }

  /* ---------- Eraser ---------- */

  #strokeDrawings() {
    // Direct flags access: getFlag validates the scope against the active
    // modules and would throw if the id is not registered on the server yet.
    return canvas.scene.drawings.filter((d) => d.flags?.[MODULE_ID]?.stroke);
  }

  /**
   * Queues an eraser circle and processes the queue serially: splitting
   * strokes is asynchronous and a fast drag fires many of these.
   */
  async #eraseAt(pos) {
    this.#eraseQueue.push({ x: pos.x, y: pos.y, r: this.#eraserRadius });
    if (this.#eraseRunning) return;
    this.#eraseRunning = true;
    try {
      while (this.#eraseQueue.length) {
        const circles = this.#eraseQueue.splice(0, this.#eraseQueue.length);
        await this.#eraseCircles(circles);
      }
    } catch (err) {
      console.error(`${MODULE_ID} |`, err);
    } finally {
      this.#eraseRunning = false;
    }
  }

  /**
   * Cuts the strokes touched by the given circles: removes the covered part
   * and keeps the rest as new strokes with the same style. Texts (which have
   * no points) are deleted whole.
   */
  async #eraseCircles(circles) {
    const scale = canvas.stage.scale.x || 1;
    const spacing = Math.max(0.5, 2 / scale);
    const toDelete = [];
    const toCreate = [];

    for (const doc of this.#strokeDrawings()) {
      const margin = doc.strokeWidth / 2;
      const near = circles.filter((c) =>
        c.x >= doc.x - c.r - margin && c.x <= doc.x + doc.shape.width + c.r + margin &&
        c.y >= doc.y - c.r - margin && c.y <= doc.y + doc.shape.height + c.r + margin
      );
      if (!near.length) continue;

      const raw = doc.shape.points;
      if (!raw?.length) {
        // Text: delete whole if the circle touches its box
        toDelete.push(doc.id);
        continue;
      }

      const abs = [];
      for (let i = 0; i + 1 < raw.length; i += 2) {
        abs.push({ x: doc.x + raw[i], y: doc.y + raw[i + 1] });
      }

      // Densify so cuts can happen mid-segment
      const dense = resamplePath(abs, spacing);
      let removedAny = false;
      const runs = [];
      let current = [];
      for (const p of dense) {
        const erased = near.some((c) => Math.hypot(p.x - c.x, p.y - c.y) <= c.r + margin);
        if (erased) {
          removedAny = true;
          if (current.length) {
            runs.push(current);
            current = [];
          }
        } else {
          current.push(p);
        }
      }
      if (current.length) runs.push(current);
      if (!removedAny) continue;

      toDelete.push(doc.id);
      const style = {
        color: doc.strokeColor.toString(),
        width: doc.strokeWidth,
        alpha: doc.strokeAlpha,
        elevation: doc.elevation
      };
      for (const run of runs) {
        if (run.length < 2) continue;
        // Discard specks shorter than the stroke's own width
        if (pathLength(run) < Math.max(spacing * 2, doc.strokeWidth)) continue;
        const frag = simplifyPath(run, 0.3 / scale);
        toCreate.push(this.#strokeData(frag, style));
      }
    }

    if (!toCreate.length && !toDelete.length) return;

    // Create the fragments first and delete the original afterwards: if
    // creation fails, the original stroke stays intact.
    if (game.user.isGM) {
      if (toCreate.length) await canvas.scene.createEmbeddedDocuments("Drawing", toCreate);
      if (toDelete.length) await canvas.scene.deleteEmbeddedDocuments("Drawing", toDelete);
    } else {
      await this.#socketExec("applyErase", canvas.scene.id, toCreate, toDelete);
    }
  }

  /* ---------- Toolbar actions ---------- */

  async undoStroke() {
    while (this.#history.length) {
      const id = this.#history.pop();
      if (!canvas.scene.drawings.has(id)) continue;
      await this.#deleteStrokes([id]);
      return;
    }
    ui.notifications.info("Drawing Tools: nothing to undo in this session.");
  }

  /** GM only, double-confirmed: wipes every module stroke in the scene. */
  async clearAll() {
    if (!game.user.isGM) {
      ui.notifications.warn("Drawing Tools: only the GM can delete all strokes.");
      return;
    }
    const ids = this.#strokeDrawings().map((d) => d.id);
    if (!ids.length) {
      ui.notifications.info("Drawing Tools: no strokes to delete.");
      return;
    }
    const first = await foundry.applications.api.DialogV2.confirm({
      window: { title: "Delete ALL strokes" },
      content: `<p>This will delete <strong>ALL ${ids.length}</strong> drawing stroke(s) in this scene — everyone's, not just yours.</p><p>Continue?</p>`
    });
    if (!first) return;
    const second = await foundry.applications.api.DialogV2.confirm({
      window: { title: "Are you absolutely sure?" },
      content: `<p><strong>Last warning:</strong> all ${ids.length} stroke(s) will be permanently deleted. This cannot be undone.</p>`
    });
    if (!second) return;
    await this.#deleteStrokes(ids);
  }
}

/* -------------------------------------------- */
/*  Floating toolbar                            */
/* -------------------------------------------- */

const TOOL_BUTTONS = [
  { tool: "hand", icon: "fa-solid fa-hand", title: "Hand — pan the map (H)" },
  { tool: "select", icon: "fa-solid fa-arrow-pointer", title: "Select / move (V)", key: "1" },
  { tool: "rect", icon: "fa-regular fa-square", title: "Rectangle (R) · Shift: square", key: "2" },
  { tool: "diamond", icon: "fa-regular fa-square gpd-rot45", title: "Diamond (D)", key: "3" },
  { tool: "ellipse", icon: "fa-regular fa-circle", title: "Ellipse (O) · Shift: circle", key: "4" },
  { tool: "arrow", icon: "fa-solid fa-arrow-right", title: "Arrow (A) · Shift: 15° angles", key: "5" },
  { tool: "line", icon: "fa-solid fa-slash", title: "Line (L) · Shift: 15° angles", key: "6" },
  { tool: "brush", icon: "fa-solid fa-pencil", title: "Pencil — precise freehand (P)", key: "7" },
  { tool: "text", icon: "fa-solid fa-font", title: "Text (T)", key: "8" },
  { tool: "eraser", icon: "fa-solid fa-eraser", title: "Eraser (E) · Shift+wheel: size", key: "0" }
];

class DrawToolbar {
  static #el = null;

  static show() {
    if (!this.#el) this.#build();
    this.#el.style.display = "flex";
    this.setActive(canvas[LAYER_NAME]?.tool ?? "brush");
    this.#syncLock();
  }

  static hide() {
    if (this.#el) this.#el.style.display = "none";
  }

  static setActive(tool) {
    if (!this.#el) return;
    this.#el.querySelectorAll("[data-tool]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tool === tool);
    });
  }

  static #syncLock() {
    if (!this.#el) return;
    const locked = getSetting(SETTINGS.lock);
    const btn = this.#el.querySelector('[data-action="lock"]');
    btn.classList.toggle("active", locked);
    btn.querySelector("i").className = locked ? "fa-solid fa-lock" : "fa-solid fa-lock-open";
  }

  static #build() {
    const el = document.createElement("div");
    el.id = "gpd-toolbar";
    const toolBtns = TOOL_BUTTONS.map(({ tool, icon, title, key }) => `
      <button type="button" data-tool="${tool}" title="${title}">
        <i class="${icon}"></i>${key ? `<span class="gpd-key">${key}</span>` : ""}
      </button>`).join("");
    el.innerHTML = `
      <button type="button" data-action="lock" title="Keep the active tool after drawing">
        <i class="fa-solid fa-lock"></i>
      </button>
      <div class="gpd-tb-sep"></div>
      ${toolBtns}
      <div class="gpd-tb-sep"></div>
      <button type="button" data-action="undo" title="Undo last stroke (Ctrl+Z)"><i class="fa-solid fa-rotate-left"></i></button>
      ${game.user.isGM ? `<button type="button" data-action="clear" title="Delete ALL strokes in the scene (GM only)"><i class="fa-regular fa-trash-can"></i></button>` : ""}
      <button type="button" data-action="palette" title="Show/hide styles"><i class="fa-solid fa-ellipsis-vertical"></i></button>
    `;
    document.body.appendChild(el);
    this.#el = el;

    el.addEventListener("click", async (event) => {
      const btn = event.target.closest("button");
      if (!btn) return;
      const layer = canvas[LAYER_NAME];
      if (btn.dataset.tool) {
        layer?.setTool(btn.dataset.tool);
        return;
      }
      switch (btn.dataset.action) {
        case "lock":
          await setSetting(SETTINGS.lock, !getSetting(SETTINGS.lock));
          this.#syncLock();
          break;
        case "undo":
          layer?.undoStroke();
          break;
        case "clear":
          layer?.clearAll();
          break;
        case "palette":
          DrawPalette.toggle();
          break;
      }
    });
  }
}

/* -------------------------------------------- */
/*  Styles panel                                */
/* -------------------------------------------- */

/** Stroke palette. */
const SWATCHES = ["#1e1e1e", "#e03131", "#2f9e44", "#1971c2", "#f08c00", "#ffffff"];

/** Fill palette (pastels); "transparent" = no fill. */
const FILL_SWATCHES = ["transparent", "#ffc9c9", "#b2f2bb", "#a5d8ff", "#ffec99"];

class DrawPalette {
  static #el = null;

  static show() {
    if (!this.#el) this.#build();
    this.#sync();
    this.#el.style.display = "flex";
  }

  static hide() {
    if (this.#el) this.#el.style.display = "none";
  }

  static toggle() {
    if (!this.#el || this.#el.style.display === "none") this.show();
    else this.hide();
  }

  /** Re-syncs the controls with the settings (e.g. after wheel changes). */
  static sync() {
    if (this.#el && this.#el.style.display !== "none") this.#sync();
  }

  static #build() {
    const el = document.createElement("div");
    el.id = "gpd-palette";

    const fillSwatches = FILL_SWATCHES.map((c) =>
      `<button type="button" class="gpd-fill${c === "transparent" ? " gpd-transparent" : ""}" data-fill="${c}"
        ${c === "transparent" ? 'title="No fill"' : `style="background:${c}" title="${c}"`}></button>`
    ).join("");
    const widthIcon = (w) =>
      `<svg viewBox="0 0 20 20"><path d="M3 10 H17" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" fill="none"/></svg>`;
    const sloppyIcons = [
      `<svg viewBox="0 0 20 20"><path d="M2 12 C7 7 13 13 18 8" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/></svg>`,
      `<svg viewBox="0 0 20 20"><path d="M2 12 C4 8 7 13 10 10 C13 7 16 12 18 9" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/></svg>`,
      `<svg viewBox="0 0 20 20"><path d="M2 13 C3 8 5 14 7 9 C9 5 11 14 13 8 C15 5 17 12 18 9" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/></svg>`
    ];
    const edgeIcons = {
      sharp: `<svg viewBox="0 0 20 20"><path d="M5 16 V4 H17" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/></svg>`,
      round: `<svg viewBox="0 0 20 20"><path d="M5 16 V9 Q5 4 10 4 H17" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/></svg>`
    };

    el.innerHTML = `
      <div id="gpd-drag" title="Drag"><i class="fa-solid fa-grip-lines"></i></div>
      <section>
        <label>Stroke</label>
        <div class="gpd-btnrow">
          <span id="gpd-stroke-swatches" class="gpd-swatch-list"></span>
          <div class="gpd-vsep"></div>
          <input type="color" id="gpd-color" class="gpd-custom" title="Custom color">
          <button type="button" id="gpd-add-swatch" class="gpd-opt gpd-add" title="Save current color as a swatch"><i class="fa-solid fa-plus"></i></button>
        </div>
      </section>
      <section>
        <label>Background</label>
        <div class="gpd-btnrow">
          ${fillSwatches}
          <div class="gpd-vsep"></div>
          <input type="color" id="gpd-fill-custom" class="gpd-custom" title="Custom background">
        </div>
      </section>
      <section>
        <label>Stroke width</label>
        <div class="gpd-btnrow">
          <button type="button" class="gpd-opt" data-width="3" title="Thin">${widthIcon(1.5)}</button>
          <button type="button" class="gpd-opt" data-width="6" title="Medium">${widthIcon(3)}</button>
          <button type="button" class="gpd-opt" data-width="12" title="Bold">${widthIcon(5)}</button>
          <div class="gpd-vsep"></div>
          <input type="number" id="gpd-width-num" min="1" max="40" step="1" title="Custom width">
        </div>
      </section>
      <section>
        <label>Sloppiness</label>
        <div class="gpd-btnrow">
          <button type="button" class="gpd-opt" data-sloppy="0" title="Architect">${sloppyIcons[0]}</button>
          <button type="button" class="gpd-opt" data-sloppy="1" title="Artist">${sloppyIcons[1]}</button>
          <button type="button" class="gpd-opt" data-sloppy="2" title="Cartoonist">${sloppyIcons[2]}</button>
        </div>
      </section>
      <section>
        <label>Edges</label>
        <div class="gpd-btnrow">
          <button type="button" class="gpd-opt" data-edges="sharp" title="Sharp">${edgeIcons.sharp}</button>
          <button type="button" class="gpd-opt" data-edges="round" title="Round">${edgeIcons.round}</button>
        </div>
      </section>
      <section>
        <label>Opacity</label>
        <input type="range" id="gpd-alpha" min="10" max="100" step="5">
        <div class="gpd-range-labels"><span>10</span><span>100</span></div>
      </section>
      <section>
        <label>Layers</label>
        <div class="gpd-btnrow">
          <button type="button" class="gpd-opt" data-layer="back" title="Send to back"><i class="fa-solid fa-angles-down"></i></button>
          <button type="button" class="gpd-opt" data-layer="down" title="Send backward"><i class="fa-solid fa-angle-down"></i></button>
          <button type="button" class="gpd-opt" data-layer="up" title="Bring forward"><i class="fa-solid fa-angle-up"></i></button>
          <button type="button" class="gpd-opt" data-layer="front" title="Bring to front"><i class="fa-solid fa-angles-up"></i></button>
        </div>
      </section>
      <section class="gpd-toggles">
        <label class="gpd-check"><input type="checkbox" id="gpd-smooth"> Smoothing</label>
        <label class="gpd-check"><input type="checkbox" id="gpd-above"> Above tokens</label>
      </section>
    `;
    document.body.appendChild(el);
    this.#el = el;
    this.#renderStrokeSwatches();

    el.addEventListener("click", async (event) => {
      const btn = event.target.closest("button");
      if (!btn) return;
      const layer = canvas[LAYER_NAME];
      if (btn.id === "gpd-add-swatch") {
        const color = getSetting(SETTINGS.color).toLowerCase();
        const customs = (getSetting(SETTINGS.custom) ?? []).map(String);
        const all = [...SWATCHES, ...customs].map((c) => c.toLowerCase());
        if (!all.includes(color)) {
          customs.push(color);
          while (customs.length > 12) customs.shift();
          await setSetting(SETTINGS.custom, customs);
          this.#renderStrokeSwatches();
        }
        this.#sync();
        return;
      }
      if (btn.dataset.color) {
        await setSetting(SETTINGS.color, btn.dataset.color);
        layer?.applyStyleToSelection({ color: btn.dataset.color });
      } else if (btn.dataset.fill !== undefined) {
        await setSetting(SETTINGS.fill, btn.dataset.fill);
        layer?.applyStyleToSelection({ fill: btn.dataset.fill === "transparent" ? null : btn.dataset.fill });
      } else if (btn.dataset.width) {
        const width = Number(btn.dataset.width);
        await setSetting(SETTINGS.width, width);
        layer?.applyStyleToSelection({ width });
      } else if (btn.dataset.sloppy !== undefined) await setSetting(SETTINGS.sketchy, Number(btn.dataset.sloppy));
      else if (btn.dataset.edges) await setSetting(SETTINGS.edges, btn.dataset.edges);
      else if (btn.dataset.layer) {
        layer?.reorderSelected(btn.dataset.layer);
        return;
      } else return;
      this.#sync();
    });

    // Right-click on a saved swatch removes it
    el.addEventListener("contextmenu", async (event) => {
      const btn = event.target.closest("button[data-saved]");
      if (!btn) return;
      event.preventDefault();
      const customs = (getSetting(SETTINGS.custom) ?? [])
        .filter((c) => c.toLowerCase() !== btn.dataset.color.toLowerCase());
      await setSetting(SETTINGS.custom, customs);
      this.#renderStrokeSwatches();
      this.#sync();
    });

    el.querySelector("#gpd-color").addEventListener("input", async (ev) => {
      await setSetting(SETTINGS.color, ev.target.value);
      canvas[LAYER_NAME]?.applyStyleToSelection({ color: ev.target.value });
      this.#sync();
    });
    el.querySelector("#gpd-fill-custom").addEventListener("input", async (ev) => {
      await setSetting(SETTINGS.fill, ev.target.value);
      canvas[LAYER_NAME]?.applyStyleToSelection({ fill: ev.target.value });
      this.#sync();
    });
    el.querySelector("#gpd-width-num").addEventListener("change", async (ev) => {
      const width = Math.max(1, Math.min(40, Math.round(Number(ev.target.value) || 1)));
      await setSetting(SETTINGS.width, width);
      canvas[LAYER_NAME]?.applyStyleToSelection({ width });
      this.#sync();
    });
    el.querySelector("#gpd-alpha").addEventListener("input", async (ev) => {
      const alpha = Number(ev.target.value) / 100;
      await setSetting(SETTINGS.alpha, alpha);
      canvas[LAYER_NAME]?.applyStyleToSelection({ alpha });
    });
    el.querySelector("#gpd-smooth").addEventListener("change", async (ev) => {
      await setSetting(SETTINGS.smooth, ev.target.checked);
    });
    el.querySelector("#gpd-above").addEventListener("change", async (ev) => {
      await setSetting(SETTINGS.above, ev.target.checked);
      canvas[LAYER_NAME]?.applyStyleToSelection({ above: ev.target.checked });
    });

    // Panel dragging via the top handle
    const header = el.querySelector("#gpd-drag");
    header.addEventListener("pointerdown", (down) => {
      down.preventDefault();
      const rect = el.getBoundingClientRect();
      const offX = down.clientX - rect.left;
      const offY = down.clientY - rect.top;
      const onMove = (mv) => {
        el.style.left = `${mv.clientX - offX}px`;
        el.style.top = `${mv.clientY - offY}px`;
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
  }

  /** Rebuilds the Stroke swatch row: fixed palette + saved custom colors. */
  static #renderStrokeSwatches() {
    const wrap = this.#el.querySelector("#gpd-stroke-swatches");
    const customs = getSetting(SETTINGS.custom) ?? [];
    wrap.innerHTML = [
      ...SWATCHES.map((c) =>
        `<button type="button" class="gpd-swatch" data-color="${c}" style="background:${c}" title="${c}"></button>`),
      ...customs.map((c) =>
        `<button type="button" class="gpd-swatch" data-color="${c}" data-saved="1" style="background:${c}" title="${c} — right-click to remove"></button>`)
    ].join("");
  }

  static #sync() {
    const el = this.#el;
    const color = getSetting(SETTINGS.color);
    const fill = getSetting(SETTINGS.fill);
    const width = getSetting(SETTINGS.width);
    const sloppy = String(Number(getSetting(SETTINGS.sketchy)) || 0);
    const edges = getSetting(SETTINGS.edges);

    el.querySelectorAll(".gpd-swatch").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.color.toLowerCase() === color.toLowerCase());
    });
    el.querySelectorAll(".gpd-fill").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.fill.toLowerCase() === fill.toLowerCase());
    });
    el.querySelectorAll("[data-width]").forEach((btn) => {
      btn.classList.toggle("active", Number(btn.dataset.width) === width);
    });
    el.querySelectorAll("[data-sloppy]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.sloppy === sloppy);
    });
    el.querySelectorAll("[data-edges]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.edges === edges);
    });
    el.querySelector("#gpd-color").value = color;
    el.querySelector("#gpd-width-num").value = width;
    el.querySelector("#gpd-fill-custom").value = fill === "transparent" ? "#ffffff" : fill;
    el.querySelector("#gpd-alpha").value = Math.round(getSetting(SETTINGS.alpha) * 100);
    el.querySelector("#gpd-smooth").checked = getSetting(SETTINGS.smooth);
    el.querySelector("#gpd-above").checked = getSetting(SETTINGS.above);
  }
}

/* -------------------------------------------- */
/*  Registration                                */
/* -------------------------------------------- */

Hooks.once("init", () => {
  CONFIG.Canvas.layers[LAYER_NAME] = {
    layerClass: PrecisionDrawLayer,
    group: "interface"
  };

  game.settings.register(MODULE_ID, SETTINGS.color, {
    scope: "client", config: false, type: String, default: "#e03131"
  });
  game.settings.register(MODULE_ID, SETTINGS.width, {
    scope: "client", config: false, type: Number, default: 6
  });
  game.settings.register(MODULE_ID, SETTINGS.alpha, {
    scope: "client", config: false, type: Number, default: 1
  });
  game.settings.register(MODULE_ID, SETTINGS.smooth, {
    scope: "client", config: false, type: Boolean, default: true
  });
  game.settings.register(MODULE_ID, SETTINGS.above, {
    scope: "client", config: false, type: Boolean, default: false
  });
  game.settings.register(MODULE_ID, SETTINGS.eraser, {
    scope: "client", config: false, type: Number, default: 14
  });
  game.settings.register(MODULE_ID, SETTINGS.sketchy, {
    scope: "client", config: false, type: Number, default: 0
  });
  game.settings.register(MODULE_ID, SETTINGS.lock, {
    scope: "client", config: false, type: Boolean, default: true
  });
  game.settings.register(MODULE_ID, SETTINGS.fill, {
    scope: "client", config: false, type: String, default: "transparent"
  });
  game.settings.register(MODULE_ID, SETTINGS.edges, {
    scope: "client", config: false, type: String, default: "sharp"
  });
  game.settings.register(MODULE_ID, SETTINGS.custom, {
    scope: "client", config: false, type: Array, default: []
  });
});

// Keeps the selection box up to date when the stroke changes or disappears
Hooks.on("updateDrawing", (doc) => canvas?.[LAYER_NAME]?._onDocChange?.(doc));
Hooks.on("deleteDrawing", (doc) => canvas?.[LAYER_NAME]?._onDocChange?.(doc));
