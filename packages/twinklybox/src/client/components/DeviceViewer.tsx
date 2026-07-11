import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — examples submodule lacks types in some setups; runtime fine.
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

// Viewer that mirrors the LED frame the server is shipping. Branches on
// layout shape:
//   - matrix layout (e.g. WLED on a curtain) → flat 2D canvas pixel grid.
//   - 3D point-cloud layout (Twinkly scan) → three.js orbit-able cloud.

interface Coord { x: number; y: number; z: number }
const FRAME_HZ = 30;

// Rolling delay buffer for preview frames. The preview polls the server's
// *current* rendered frame, which reflects the audio already delayed by
// syscapDelay (the bus holds captured audio before release). The actual lights
// get that same frame but additionally held ~500ms (Doggert's on-box buffer /
// Ubert's matching software delay). So to make preview == lights == the music
// you hear, we hold preview frames by that same box delay and no more.
class FrameDelay {
  private q: { t: number; buf: Uint8Array }[] = [];
  push(buf: Uint8Array, now: number) { this.q.push({ t: now, buf }); }
  // Returns the newest frame at least delayMs old (real-time delayed playout),
  // keeping it as the queue head so a tick with nothing newer holds it steady.
  // delayMs<=0 → pass-through latest (buffer off = live preview).
  take(delayMs: number, now: number): Uint8Array | null {
    if (delayMs <= 0) {
      const last = this.q.length ? this.q[this.q.length - 1].buf : null;
      this.q.length = 0;
      return last;
    }
    let idx = -1;
    for (let i = 0; i < this.q.length; i++) {
      if (now - this.q[i].t >= delayMs) idx = i; else break;
    }
    if (idx < 0) {
      // Nothing aged enough yet (startup / just raised delay). Trim runaway.
      while (this.q.length > 2 && now - this.q[0].t > delayMs + 1000) this.q.shift();
      return null;
    }
    const buf = this.q[idx].buf;
    if (idx > 0) this.q.splice(0, idx); // drop the consumed older frames
    return buf;
  }
}

interface LayoutResp {
  numLeds: number;
  bytesPerLed: number;
  coords: Coord[] | null;
  matrix: { w: number; h: number } | null;
  source: string | null;
}

export function DeviceViewer({
  height = 360,
  origin = null,
  delayMs = 0,
}: {
  height?: number;
  // Pattern origin in normalized [0,1]^3 coords (for megadrome). The
  // viewer paints a small marker so you can see where the radial pulse
  // emanates from. Pass null to hide.
  origin?: { x: number; y: number; z: number } | null;
  // Hold preview frames this long (ms) so the preview lines up with the
  // box-delayed lights / the music you hear. Typically the box buffer (~500ms).
  delayMs?: number;
}) {
  const [layout, setLayout] = useState<LayoutResp | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/layout').then((r) => r.json()).then((j: LayoutResp) => {
      if (!cancelled) setLayout(j);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  if (!layout) {
    return (
      <div className="bg-zinc-950 rounded overflow-hidden flex items-center justify-center text-[10px] text-zinc-600 font-mono"
        style={{ height }}>
        loading layout…
      </div>
    );
  }
  if (layout.matrix) {
    return <Viewer2D height={height} matrix={layout.matrix} bytesPerLed={layout.bytesPerLed} origin={origin} delayMs={delayMs} />;
  }
  return <Viewer3D height={height} origin={origin} delayMs={delayMs} />;
}

// ---- 2D canvas viewer (matrix layouts) ----
//
// Renders an ImageData of size (matrix.w × matrix.h) — one pixel per LED —
// then scales it up to the visible canvas with nearest-neighbor sampling
// (imageSmoothingEnabled = false) for the crisp pixel-grid look.
function Viewer2D({
  height,
  matrix,
  bytesPerLed,
  origin,
  delayMs,
}: {
  height: number;
  matrix: { w: number; h: number };
  bytesPerLed: number;
  origin: { x: number; y: number; z: number } | null;
  delayMs: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const originRef = useRef<typeof origin>(origin);
  useEffect(() => { originRef.current = origin; }, [origin]);
  // Read the delay via ref so toggling buffer doesn't tear down the canvas.
  const delayRef = useRef(delayMs);
  useEffect(() => { delayRef.current = delayMs; }, [delayMs]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;

    // Offscreen pixel-sized buffer we draw into each frame, then upscale.
    const W = matrix.w, H = matrix.h;
    const offscreen = document.createElement('canvas');
    offscreen.width = W;
    offscreen.height = H;
    const offCtx = offscreen.getContext('2d');
    if (!offCtx) return;
    const imgData = offCtx.createImageData(W, H);

    // Size the canvas to fit `height` vertically while preserving aspect.
    function fit() {
      if (!canvas) return;
      const parentW = canvas.parentElement?.clientWidth ?? 600;
      // Cell size from the tighter constraint.
      const cellByH = Math.floor(height / H);
      const cellByW = Math.floor(parentW / W);
      const cell = Math.max(1, Math.min(cellByH, cellByW));
      canvas.width = cell * W;
      canvas.height = cell * H;
      ctx!.imageSmoothingEnabled = false;
    }
    fit();
    const ro = new ResizeObserver(fit);
    if (canvas.parentElement) ro.observe(canvas.parentElement);

    let cancelled = false;
    const frameDelay = new FrameDelay();
    async function tick() {
      if (cancelled) return;
      try {
        const r = await fetch('/api/frame');
        if (!r.ok) return;
        const incoming = new Uint8Array(await r.arrayBuffer());
        // Hold frames by the box delay so the preview matches the lights.
        frameDelay.push(incoming, performance.now());
        const buf = frameDelay.take(delayRef.current, performance.now());
        if (!buf) return; // nothing aged enough yet — keep last drawn frame
        const stride = bytesPerLed;
        // RGBW: byte order is W,R,G,B per LED in our driver. RGB: R,G,B.
        const rOff = stride === 4 ? 1 : 0;
        const gOff = stride === 4 ? 2 : 1;
        const bOff = stride === 4 ? 3 : 2;
        const n = Math.min(W * H, Math.floor(buf.length / stride));
        // Write pixels into the ImageData (RGBA). Row-major, matching the
        // server's wledMatrixLayout (linear index i → row=i/W, col=i%W).
        for (let i = 0; i < n; i++) {
          imgData.data[i * 4 + 0] = buf[i * stride + rOff];
          imgData.data[i * 4 + 1] = buf[i * stride + gOff];
          imgData.data[i * 4 + 2] = buf[i * stride + bOff];
          imgData.data[i * 4 + 3] = 255;
        }
        offCtx!.putImageData(imgData, 0, 0);
        ctx!.fillStyle = '#0a0a0a';
        ctx!.fillRect(0, 0, canvas!.width, canvas!.height);
        ctx!.drawImage(offscreen, 0, 0, canvas!.width, canvas!.height);

        // Origin marker — paint a single-cell red highlight at the LED
        // closest to (origin.x, origin.y) in matrix coords. Hidden when
        // origin is null.
        const o = originRef.current;
        if (o) {
          const cellW = canvas!.width / W;
          const cellH = canvas!.height / H;
          // Server's matrix layout uses y-up (row 0 = bottom), so flip.
          const col = Math.max(0, Math.min(W - 1, Math.round(o.x * (W - 1))));
          const row = Math.max(0, Math.min(H - 1, Math.round((1 - o.y) * (H - 1))));
          ctx!.strokeStyle = '#ff2244';
          ctx!.lineWidth = 2;
          ctx!.strokeRect(col * cellW, row * cellH, cellW, cellH);
        }
      } catch { /* server restarting / not connected */ }
    }
    const timer = window.setInterval(tick, 1000 / FRAME_HZ);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      ro.disconnect();
    };
  }, [matrix.w, matrix.h, bytesPerLed, height]);

  return (
    <div className="bg-zinc-950 rounded overflow-hidden">
      <div className="flex justify-center" style={{ height }}>
        <canvas ref={canvasRef} className="block" style={{ imageRendering: 'pixelated' }} />
      </div>
      <div className="text-[10px] font-mono text-zinc-500 px-2 py-1 border-t border-zinc-800">
        {matrix.w}×{matrix.h} matrix
      </div>
    </div>
  );
}

// ---- 3D point-cloud viewer (non-matrix layouts) ----
function Viewer3D({
  height,
  origin,
  delayMs,
}: {
  height: number;
  origin: { x: number; y: number; z: number } | null;
  delayMs: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const originRef = useRef<typeof origin>(origin);
  useEffect(() => { originRef.current = origin; }, [origin]);
  const delayRef = useRef(delayMs);
  useEffect(() => { delayRef.current = delayMs; }, [delayMs]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0a0a);

    let width = container.clientWidth;
    const h = height;

    const camera = new THREE.PerspectiveCamera(45, width / h, 0.01, 100);
    camera.position.set(2, 1.5, 2);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(width, h);
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;

    const axes = new THREE.AxesHelper(0.3);
    scene.add(axes);

    const originCube = new THREE.Mesh(
      new THREE.BoxGeometry(0.04, 0.04, 0.04),
      new THREE.MeshBasicMaterial({ color: 0xff2244 }),
    );
    originCube.visible = false;
    scene.add(originCube);

    let points: THREE.Points | null = null;
    let positions: Float32Array | null = null;
    let colors: Float32Array | null = null;
    let numLeds = 0;
    let bytesPerLed = 4;
    const cloudCentroid = { x: 0, y: 0, z: 0 };

    function buildPoints(coords: Coord[]) {
      numLeds = coords.length;
      positions = new Float32Array(numLeds * 3);
      colors = new Float32Array(numLeds * 3);
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (const c of coords) {
        if (c.x < minX) minX = c.x; if (c.y < minY) minY = c.y; if (c.z < minZ) minZ = c.z;
        if (c.x > maxX) maxX = c.x; if (c.y > maxY) maxY = c.y; if (c.z > maxZ) maxZ = c.z;
      }
      const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
      cloudCentroid.x = cx; cloudCentroid.y = cy; cloudCentroid.z = cz;
      for (let i = 0; i < numLeds; i++) {
        positions[i * 3 + 0] = coords[i].x - cx;
        positions[i * 3 + 1] = coords[i].y - cy;
        positions[i * 3 + 2] = coords[i].z - cz;
      }
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      const mat = new THREE.PointsMaterial({
        size: 0.025, vertexColors: true, sizeAttenuation: true,
        blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
      });
      points = new THREE.Points(geom, mat);
      scene.add(points);
      const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
      const dist = span * 2.5;
      camera.position.set(dist, dist * 0.6, dist);
      controls.target.set(0, 0, 0);
      controls.update();
    }

    fetch('/api/layout').then((r) => r.json()).then((j: LayoutResp) => {
      if (!j.coords || j.coords.length === 0) {
        const n = 100;
        const fake: Coord[] = [];
        for (let i = 0; i < n; i++) fake.push({ x: i / n - 0.5, y: 0, z: 0 });
        buildPoints(fake);
      } else {
        buildPoints(j.coords);
      }
      bytesPerLed = j.bytesPerLed ?? 4;
    }).catch(console.error);

    let cancelled = false;
    const frameDelay = new FrameDelay();
    async function pullFrame() {
      if (cancelled || !points || !colors) return;
      try {
        const r = await fetch('/api/frame');
        if (!r.ok) return;
        const incoming = new Uint8Array(await r.arrayBuffer());
        frameDelay.push(incoming, performance.now());
        const buf = frameDelay.take(delayRef.current, performance.now());
        if (!buf) return;
        const stride = bytesPerLed;
        const rOff = stride === 4 ? 1 : 0;
        const gOff = stride === 4 ? 2 : 1;
        const bOff = stride === 4 ? 3 : 2;
        const n = Math.min(numLeds, Math.floor(buf.length / stride));
        for (let i = 0; i < n; i++) {
          colors[i * 3 + 0] = buf[i * stride + rOff] / 255;
          colors[i * 3 + 1] = buf[i * stride + gOff] / 255;
          colors[i * 3 + 2] = buf[i * stride + bOff] / 255;
        }
        const attr = points.geometry.getAttribute('color') as THREE.BufferAttribute;
        attr.needsUpdate = true;
      } catch { /* ignore */ }
    }
    const frameTimer = window.setInterval(pullFrame, 1000 / FRAME_HZ);

    let rafId = 0;
    const animate = () => {
      controls.update();
      const o = originRef.current;
      if (o) {
        originCube.visible = true;
        originCube.position.set(o.x - cloudCentroid.x, o.y - cloudCentroid.y, o.z - cloudCentroid.z);
      } else {
        originCube.visible = false;
      }
      renderer.render(scene, camera);
      rafId = requestAnimationFrame(animate);
    };
    animate();

    const ro = new ResizeObserver(() => {
      width = container.clientWidth;
      camera.aspect = width / h;
      camera.updateProjectionMatrix();
      renderer.setSize(width, h);
    });
    ro.observe(container);

    return () => {
      cancelled = true;
      window.clearInterval(frameTimer);
      cancelAnimationFrame(rafId);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      if (points) {
        points.geometry.dispose();
        (points.material as THREE.Material).dispose();
      }
      originCube.geometry.dispose();
      (originCube.material as THREE.Material).dispose();
      container.removeChild(renderer.domElement);
    };
  }, [height]);

  return (
    <div className="bg-zinc-950 rounded overflow-hidden">
      <div ref={containerRef} style={{ height, width: '100%' }} />
      <div className="text-[10px] font-mono text-zinc-500 px-2 py-1 border-t border-zinc-800">
        drag · scroll-zoom · right-drag pan
      </div>
    </div>
  );
}
