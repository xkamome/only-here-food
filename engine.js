/* =========================================================
   Dish Engine — 以零件組裝 3D 食物（three.js r147, UMD 全域）
   依賴：THREE, THREE.OrbitControls, THREE.RoomEnvironment,
         THREE.BufferGeometryUtils
   ========================================================= */
(function () {
  const T = THREE;
  T.ColorManagement.legacyMode = false;

  /* ---------- 亂數與雜訊 ---------- */
  function rngFrom(seed) {
    let s = seed >>> 0;
    return function () {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashStr(str) {
    let h = 2166136261;
    for (const ch of String(str)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function hash3(x, y, z) {
    let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 1274126177);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967295;
  }
  function noise3(x, y, z) {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const xf = x - xi, yf = y - yi, zf = z - zi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
    const L = (a, b, t) => a + (b - a) * t;
    const c000 = hash3(xi, yi, zi), c100 = hash3(xi + 1, yi, zi), c010 = hash3(xi, yi + 1, zi), c110 = hash3(xi + 1, yi + 1, zi);
    const c001 = hash3(xi, yi, zi + 1), c101 = hash3(xi + 1, yi, zi + 1), c011 = hash3(xi, yi + 1, zi + 1), c111 = hash3(xi + 1, yi + 1, zi + 1);
    return L(L(L(c000, c100, u), L(c010, c110, u), v), L(L(c001, c101, u), L(c011, c111, u), v), w);
  }
  function fbm(x, y, z, oct = 3) {
    let a = 0.5, f = 1, s = 0, n = 0;
    for (let i = 0; i < oct; i++) { s += a * noise3(x * f, y * f, z * f); n += a; a *= 0.5; f *= 2.03; }
    return s / n;
  }

  /* ---------- 顏色與材質 ---------- */
  const colCache = new Map();
  function C(hex) {
    const key = String(hex || '#cccccc');
    if (!colCache.has(key)) {
      const c = new T.Color();
      try { c.set(/^#?[0-9a-f]{3,8}$/i.test(key) ? (key[0] === '#' ? key : '#' + key) : key); } catch (e) { c.set('#cccccc'); }
      colCache.set(key, c);
    }
    return colCache.get(key).clone();
  }
  function safeHex(v, fallback) {
    return (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)) ? v : fallback;
  }
  function mix(a, b, t) { return a.clone().lerp(b, Math.max(0, Math.min(1, t))); }

  function mat(color, o = {}) {
    const base = { color: C(color), roughness: o.rough ?? 0.6, metalness: o.metal ?? 0 };
    let m;
    if (o.clearcoat || o.transmission || o.sheen) {
      const extra = { clearcoat: o.clearcoat || 0, clearcoatRoughness: o.ccr ?? 0.12 };
      if (o.transmission) Object.assign(extra, { transmission: o.transmission, thickness: o.thickness ?? 0.1, ior: o.ior ?? 1.4 });
      if (o.sheen) Object.assign(extra, { sheen: o.sheen, sheenRoughness: 0.7, sheenColor: C(o.sheenColor || '#ffffff') });
      m = new T.MeshPhysicalMaterial(Object.assign(base, extra));
    } else {
      m = new T.MeshStandardMaterial(base);
    }
    if (o.vc) { m.vertexColors = true; m.color.set('#ffffff'); }
    if (o.opacity != null && o.opacity < 1) { m.transparent = true; m.opacity = o.opacity; m.depthWrite = o.depthWrite ?? false; }
    if (o.side) m.side = o.side;
    if (o.map) m.map = o.map;
    if (o.alphaMap) { m.alphaMap = o.alphaMap; m.alphaTest = 0.5; }
    if (o.flat) m.flatShading = true;
    if (o.emissive) { m.emissive = C(o.emissive); m.emissiveIntensity = o.emissiveIntensity ?? 0.3; }
    return m;
  }
  function mesh(geo, m, cast = true) {
    const x = new T.Mesh(geo, m);
    x.castShadow = cast; x.receiveShadow = true;
    return x;
  }

  /* ---------- 幾何工具 ---------- */
  const V2 = (x, y) => new T.Vector2(x, y);
  const V3 = (x, y, z) => new T.Vector3(x, y, z);
  const merge = (arr) => T.BufferGeometryUtils.mergeBufferGeometries(arr, false);

  function weld(geo) {
    geo.deleteAttribute('normal');
    geo.deleteAttribute('uv');
    const g = T.BufferGeometryUtils.mergeVertices(geo, 1e-4);
    g.computeVertexNormals();
    return g;
  }
  // 沿「從中心向外」方向做雜訊位移，重複頂點會得到相同位移，不會裂開
  function lumpy(geo, amp, freq, seed = 0, center = V3(0, 0, 0), oct = 3) {
    const p = geo.attributes.position, v = new T.Vector3(), d = new T.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      d.copy(v).sub(center);
      const len = d.length() || 1;
      d.divideScalar(len);
      const n = fbm(v.x * freq + seed, v.y * freq + seed * 0.7, v.z * freq - seed * 1.3, oct) - 0.5;
      v.addScaledVector(d, n * amp * 2);
      p.setXYZ(i, v.x, v.y, v.z);
    }
    geo.computeVertexNormals();
    return geo;
  }
  function roundedBox(w, h, d, r, seg = 6) {
    const g = new T.BoxGeometry(w, h, d, seg, seg, seg);
    const p = g.attributes.position, v = new T.Vector3(), inner = new T.Vector3();
    const hx = Math.max(0.0001, w / 2 - r), hy = Math.max(0.0001, h / 2 - r), hz = Math.max(0.0001, d / 2 - r);
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      inner.set(Math.max(-hx, Math.min(hx, v.x)), Math.max(-hy, Math.min(hy, v.y)), Math.max(-hz, Math.min(hz, v.z)));
      const dir = v.clone().sub(inner);
      if (dir.lengthSq() > 1e-12) { dir.normalize().multiplyScalar(r); v.copy(inner).add(dir); }
      p.setXYZ(i, v.x, v.y, v.z);
    }
    return weld(g);
  }
  function paint(geo, fn) {
    const p = geo.attributes.position, n = geo.attributes.normal;
    const arr = new Float32Array(p.count * 3);
    const v = new T.Vector3(), nn = new T.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      if (n) nn.fromBufferAttribute(n, i);
      const c = fn(v, nn, i);
      arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new T.BufferAttribute(arr, 3));
    return geo;
  }
  function bottomAt0(obj) {
    const b = new T.Box3().setFromObject(obj);
    if (isFinite(b.min.y)) obj.position.y -= b.min.y;
    return obj;
  }
  function wrapBase(obj) { // 回傳底部在 y=0、中心在原點的群組
    const g = new T.Group();
    g.add(obj);
    obj.updateMatrixWorld(true);
    const b = new T.Box3().setFromObject(obj);
    if (isFinite(b.min.y)) {
      obj.position.x -= (b.min.x + b.max.x) / 2;
      obj.position.z -= (b.min.z + b.max.z) / 2;
      obj.position.y -= b.min.y;
    }
    return g;
  }
  // 平面圓盤（有同心環，可做位移）
  function disc(r, rings = 14, seg = 64) {
    const pts = [];
    for (let i = rings; i >= 0; i--) pts.push(V2((i / rings) * r + (i === 0 ? 0.0001 : 0), 0));
    const g = new T.LatheGeometry(pts, seg); // 由外往內 → 法線朝上
    return weld(g);
  }
  // 變半徑管
  function taperTube(points, rFn, tubular = 48, radial = 12, closed = false) {
    const curve = new T.CatmullRomCurve3(points, closed, 'catmullrom', 0.5);
    const frames = curve.computeFrenetFrames(tubular, closed);
    const pos = [], idx = [], uvs = [];
    const P = new T.Vector3();
    for (let i = 0; i <= tubular; i++) {
      const t = i / tubular;
      curve.getPointAt(t, P);
      const N = frames.normals[i], B = frames.binormals[i];
      const r = rFn(t);
      for (let j = 0; j <= radial; j++) {
        const a = (j / radial) * Math.PI * 2;
        const s = Math.sin(a), c = -Math.cos(a);
        pos.push(P.x + r * (c * N.x + s * B.x), P.y + r * (c * N.y + s * B.y), P.z + r * (c * N.z + s * B.z));
        uvs.push(t, j / radial);
      }
    }
    for (let i = 0; i < tubular; i++) for (let j = 0; j < radial; j++) {
      const a = i * (radial + 1) + j, b = (i + 1) * (radial + 1) + j;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new T.Float32BufferAttribute(uvs, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }
  // 扁平帶狀（寬麵、洋蔥絲）
  function ribbon(points, width, thick = 0.006, samples = 60) {
    const curve = new T.CatmullRomCurve3(points);
    const pos = [], idx = [];
    const P = new T.Vector3(), Tg = new T.Vector3(), up = V3(0, 1, 0), S = new T.Vector3();
    for (let i = 0; i <= samples; i++) {
      const t = i / samples;
      curve.getPointAt(t, P); curve.getTangentAt(t, Tg);
      S.crossVectors(Tg, up); if (S.lengthSq() < 1e-6) S.set(1, 0, 0); S.normalize();
      const twist = Math.sin(t * 9 + points.length) * 0.35;
      const U = up.clone().applyAxisAngle(Tg, twist), Sd = S.clone().applyAxisAngle(Tg, twist);
      for (const [sx, sy] of [[-1, 1], [1, 1], [1, -1], [-1, -1]]) {
        pos.push(P.x + Sd.x * width / 2 * sx + U.x * thick / 2 * sy, P.y + Sd.y * width / 2 * sx + U.y * thick / 2 * sy, P.z + Sd.z * width / 2 * sx + U.z * thick / 2 * sy);
      }
    }
    for (let i = 0; i < samples; i++) for (let k = 0; k < 4; k++) {
      const a = i * 4 + k, b = i * 4 + ((k + 1) % 4), c = (i + 1) * 4 + k, d = (i + 1) * 4 + ((k + 1) % 4);
      idx.push(a, c, b, b, c, d);
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }
  // 摺成 U 形（塔可、刈包）
  function foldU(geo, halfLen, angle = Math.PI * 0.92) {
    const R = halfLen / (angle / 2);
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const a = (z / halfLen) * (angle / 2);
      const rr = R - y;
      p.setXYZ(i, x, R - rr * Math.cos(a), rr * Math.sin(a));
    }
    geo.computeVertexNormals();
    return geo;
  }

  /* ---------- Canvas 紋理 ---------- */
  function canvasTex(size, draw, repeat) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const ctx = cv.getContext('2d');
    draw(ctx, size);
    const t = new T.CanvasTexture(cv);
    t.encoding = T.sRGBEncoding;
    t.anisotropy = 4;
    if (repeat) { t.wrapS = t.wrapT = T.RepeatWrapping; t.repeat.set(repeat, repeat); }
    return t;
  }
  function tableTexture(kind, color) {
    return canvasTex(1024, (g, s) => {
      const base = C(color || '#8a5a36');
      const hex = '#' + base.getHexString();
      g.fillStyle = hex; g.fillRect(0, 0, s, s);
      const rng = rngFrom(7);
      if (kind === 'marble' || kind === 'stone') {
        for (let i = 0; i < 26; i++) {
          g.strokeStyle = `rgba(${kind === 'marble' ? '120,120,130' : '40,40,40'},${0.08 + rng() * 0.12})`;
          g.lineWidth = 1 + rng() * 3;
          g.beginPath();
          let x = rng() * s, y = rng() * s; g.moveTo(x, y);
          for (let k = 0; k < 12; k++) { x += (rng() - 0.3) * 120; y += (rng() - 0.5) * 120; g.lineTo(x, y); }
          g.stroke();
        }
        for (let i = 0; i < 4000; i++) { g.fillStyle = `rgba(0,0,0,${rng() * 0.05})`; g.fillRect(rng() * s, rng() * s, 2, 2); }
      } else if (kind === 'cloth' || kind === 'linen') {
        for (let y = 0; y < s; y += 4) { g.fillStyle = `rgba(255,255,255,${0.04 + rng() * 0.04})`; g.fillRect(0, y, s, 2); }
        for (let x = 0; x < s; x += 4) { g.fillStyle = `rgba(0,0,0,${0.03 + rng() * 0.04})`; g.fillRect(x, 0, 2, s); }
      } else if (kind === 'gingham') {
        const n = 16, cs = s / n;
        g.fillStyle = '#f4efe4'; g.fillRect(0, 0, s, s);
        for (let i = 0; i < n; i++) {
          g.fillStyle = 'rgba(' + [Math.round(base.r * 255), Math.round(base.g * 255), Math.round(base.b * 255)].join(',') + ',0.55)';
          if (i % 2 === 0) { g.fillRect(i * cs, 0, cs, s); g.fillRect(0, i * cs, s, cs); }
        }
        for (let y = 0; y < s; y += 3) { g.fillStyle = 'rgba(0,0,0,0.03)'; g.fillRect(0, y, s, 1); }
      } else if (kind === 'tile') {
        const n = 8, cs = s / n;
        for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
          g.fillStyle = `rgba(255,255,255,${0.05 + rng() * 0.08})`; g.fillRect(i * cs + 3, j * cs + 3, cs - 6, cs - 6);
          g.strokeStyle = 'rgba(0,0,0,0.18)'; g.lineWidth = 3; g.strokeRect(i * cs, j * cs, cs, cs);
          g.fillStyle = 'rgba(30,70,140,0.16)';
          g.beginPath(); g.arc(i * cs + cs / 2, j * cs + cs / 2, cs * 0.18, 0, Math.PI * 2); g.fill();
        }
      } else { // wood
        const plank = s / 4;
        for (let pI = 0; pI < 4; pI++) {
          const shade = 0.85 + rng() * 0.3;
          g.fillStyle = `rgba(${shade > 1 ? '255,255,255' : '0,0,0'},${Math.abs(1 - shade) * 0.6})`;
          g.fillRect(0, pI * plank, s, plank);
          for (let k = 0; k < 70; k++) {
            g.strokeStyle = `rgba(40,20,5,${0.05 + rng() * 0.12})`;
            g.lineWidth = 0.6 + rng() * 2;
            g.beginPath();
            const y0 = pI * plank + rng() * plank;
            g.moveTo(0, y0);
            for (let x = 0; x <= s; x += 32) g.lineTo(x, y0 + Math.sin(x * 0.01 + k) * 4 + (rng() - 0.5) * 2);
            g.stroke();
          }
          g.fillStyle = 'rgba(20,10,0,0.45)'; g.fillRect(0, pI * plank, s, 2);
        }
      }
    }, 3);
  }
  function leafTextures(color) {
    const col = C(color || '#3f7d2c');
    const draw = (g, s, alpha) => {
      g.clearRect(0, 0, s, s);
      g.save();
      g.translate(s / 2, s / 2);
      g.beginPath();
      g.ellipse(0, 0, s * 0.49, s * 0.3, 0, 0, Math.PI * 2);
      g.fillStyle = alpha ? '#fff' : '#' + col.getHexString();
      g.fill();
      if (!alpha) {
        g.clip();
        for (let i = -40; i <= 40; i++) {
          g.strokeStyle = 'rgba(255,255,230,0.10)'; g.lineWidth = 1.2;
          g.beginPath(); g.moveTo(i * s * 0.012, 0); g.lineTo(i * s * 0.012 + s * 0.08 * Math.sign(i || 1), -s * 0.35); g.stroke();
          g.beginPath(); g.moveTo(i * s * 0.012, 0); g.lineTo(i * s * 0.012 + s * 0.08 * Math.sign(i || 1), s * 0.35); g.stroke();
        }
        g.fillStyle = 'rgba(230,240,190,0.55)'; g.fillRect(-s * 0.49, -3, s * 0.98, 6);
        const grd = g.createRadialGradient(0, 0, s * 0.1, 0, 0, s * 0.5);
        grd.addColorStop(0, 'rgba(255,255,200,0.08)'); grd.addColorStop(1, 'rgba(0,0,0,0.25)');
        g.fillStyle = grd; g.fillRect(-s / 2, -s / 2, s, s);
      }
      g.restore();
    };
    const map = canvasTex(512, (g, s) => draw(g, s, false));
    const alpha = canvasTex(512, (g, s) => draw(g, s, true));
    alpha.encoding = T.LinearEncoding;
    return { map, alpha };
  }
  function crossSectionTex(outer, rings) {
    // rings: [{color, r}] 由外到內；fillings: 小圓點
    return canvasTex(256, (g, s) => {
      g.fillStyle = outer; g.fillRect(0, 0, s, s);
      const rng = rngFrom(hashStr(outer));
      rings.forEach((ring) => {
        g.fillStyle = ring.color;
        g.beginPath(); g.arc(s / 2, s / 2, ring.r * s / 2, 0, Math.PI * 2); g.fill();
        if (ring.grain) {
          for (let i = 0; i < 260; i++) {
            const a = rng() * Math.PI * 2, rr = rng() * ring.r * s / 2;
            g.fillStyle = 'rgba(0,0,0,0.07)';
            g.beginPath(); g.ellipse(s / 2 + Math.cos(a) * rr, s / 2 + Math.sin(a) * rr, 5, 2.5, rng() * 3, 0, Math.PI * 2); g.fill();
          }
        }
        if (ring.bits) {
          ring.bits.forEach((bc, i) => {
            const a = (i / ring.bits.length) * Math.PI * 2 + 0.4, rr = ring.r * s * 0.22;
            g.fillStyle = bc;
            g.beginPath();
            g.ellipse(s / 2 + Math.cos(a) * rr * (i % 2 ? 0.4 : 1), s / 2 + Math.sin(a) * rr * (i % 2 ? 0.4 : 1), s * 0.07, s * 0.045, a, 0, Math.PI * 2);
            g.fill();
          });
        }
      });
    });
  }
  function slicePatternTex(pattern, color, rim) {
    return canvasTex(256, (g, s) => {
      const c = s / 2;
      g.fillStyle = rim || color; g.fillRect(0, 0, s, s);
      g.fillStyle = color; g.beginPath(); g.arc(c, c, s * 0.46, 0, Math.PI * 2); g.fill();
      const rng = rngFrom(hashStr(pattern + color));
      if (pattern === 'cucumber') {
        g.fillStyle = 'rgba(200,220,150,0.8)'; g.beginPath(); g.arc(c, c, s * 0.22, 0, Math.PI * 2); g.fill();
        for (let i = 0; i < 3; i++) { const a = i * 2.09; g.fillStyle = 'rgba(255,255,230,0.9)'; g.beginPath(); g.ellipse(c + Math.cos(a) * s * 0.1, c + Math.sin(a) * s * 0.1, 8, 4, a, 0, Math.PI * 2); g.fill(); }
      } else if (pattern === 'tomato') {
        for (let i = 0; i < 4; i++) {
          const a = i * Math.PI / 2 + 0.3;
          g.fillStyle = 'rgba(255,140,90,0.9)'; g.beginPath(); g.ellipse(c + Math.cos(a) * s * 0.22, c + Math.sin(a) * s * 0.22, s * 0.12, s * 0.08, a, 0, Math.PI * 2); g.fill();
          for (let k = 0; k < 5; k++) { g.fillStyle = '#f3e3a0'; g.beginPath(); g.ellipse(c + Math.cos(a) * s * (0.17 + k * 0.025), c + Math.sin(a) * s * (0.17 + k * 0.025), 4, 2.5, a, 0, Math.PI * 2); g.fill(); }
        }
      } else if (pattern === 'citrus') {
        for (let i = 0; i < 10; i++) {
          const a0 = (i / 10) * Math.PI * 2, a1 = a0 + Math.PI * 2 / 10 - 0.06;
          g.fillStyle = 'rgba(255,255,255,0.18)';
          g.beginPath(); g.moveTo(c, c); g.arc(c, c, s * 0.42, a0 + 0.03, a1); g.closePath(); g.fill();
        }
        g.fillStyle = 'rgba(255,255,240,0.8)'; g.beginPath(); g.arc(c, c, s * 0.05, 0, Math.PI * 2); g.fill();
      } else if (pattern === 'egg') {
        g.fillStyle = '#f7f2e6'; g.beginPath(); g.arc(c, c, s * 0.46, 0, Math.PI * 2); g.fill();
        g.fillStyle = color; g.beginPath(); g.arc(c, c, s * 0.24, 0, Math.PI * 2); g.fill();
      } else if (pattern === 'rings') {
        for (let k = 0; k < 4; k++) { g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 3; g.beginPath(); g.arc(c, c, s * (0.1 + k * 0.09), 0, Math.PI * 2); g.stroke(); }
      } else if (pattern === 'noodle') {
        for (let i = 0; i < 70; i++) { const a = rng() * 6.28, rr = rng() * s * 0.4; g.strokeStyle = `rgba(200,170,175,${0.35 + rng() * 0.3})`; g.lineWidth = 3 + rng() * 3; g.beginPath(); const x0 = c + Math.cos(a) * rr, y0 = c + Math.sin(a) * rr; g.moveTo(x0, y0); g.quadraticCurveTo(x0 + (rng() - 0.5) * 30, y0 + (rng() - 0.5) * 30, x0 + (rng() - 0.5) * 40, y0 + (rng() - 0.5) * 40); g.stroke(); }
        for (let i = 0; i < 40; i++) { g.fillStyle = `rgba(240,230,215,${0.4 + rng() * 0.3})`; const a = rng() * 6.28, rr = rng() * s * 0.4; g.beginPath(); g.ellipse(c + Math.cos(a) * rr, c + Math.sin(a) * rr, 5, 3, rng() * 3, 0, Math.PI * 2); g.fill(); }
      } else if (pattern === 'speckle') {
        for (let i = 0; i < 120; i++) { g.fillStyle = `rgba(0,0,0,${0.1 + rng() * 0.15})`; const a = rng() * 6.28, rr = rng() * s * 0.44; g.fillRect(c + Math.cos(a) * rr, c + Math.sin(a) * rr, 3, 3); }
      }
    });
  }

  /* ---------- 容器（器皿） ---------- */
  function latheVessel(profileFn, opt) {
    const { h, th = 0.035, foot = 0.06, footR, seg = 72, rimRound = 0.012 } = opt;
    const N = 28;
    const pts = [];
    const floorY = foot + th;
    pts.push(V2(0.0001, floorY));
    for (let i = 0; i <= N; i++) { const s = i / N; pts.push(V2(Math.max(0.0005, profileFn(s) - th), floorY + s * (h - floorY))); }
    pts.push(V2(profileFn(1) - th * 0.5, h + rimRound));
    for (let i = N; i >= 0; i--) { const s = i / N; pts.push(V2(profileFn(s), foot + s * (h - foot))); }
    const fr = footR ?? profileFn(0) * 0.8;
    pts.push(V2(fr, foot)); pts.push(V2(fr, 0)); pts.push(V2(fr - 0.05, 0)); pts.push(V2(fr - 0.05, foot * 0.6)); pts.push(V2(0.0001, foot * 0.6));
    pts.reverse(); // 從底部中心往外、往上、再沿內壁回到中心 → 法線朝外
    const geo = new T.LatheGeometry(pts, seg);
    geo.computeVertexNormals();
    const radiusAt = (y) => {
      const s = Math.max(0, Math.min(1, (y - floorY) / (h - floorY)));
      return profileFn(s) - th;
    };
    return { geo, floorY, rimY: h, radiusAt, innerR: profileFn(1) - th };
  }
  function glazeMaterial(p, fallback) {
    const col = safeHex(p.color, fallback);
    const rim = safeHex(p.rimColor, null);
    const pattern = p.pattern || (rim ? 'rim' : 'none');
    return { col, rim, pattern };
  }
  function paintGlaze(geo, h, col, rim, pattern) {
    const base = C(col), rc = rim ? C(rim) : null;
    return paint(geo, (v) => {
      const a = Math.atan2(v.z, v.x);
      const r = Math.hypot(v.x, v.z);
      if (rc) {
        if (pattern === 'rim' && v.y > h - 0.06) return rc;
        if (pattern === 'doubleRim' && (v.y > h - 0.05 || (v.y > h - 0.13 && v.y < h - 0.1))) return rc;
        if (pattern === 'stripes' && Math.sin(a * 24) > 0.6 && v.y > h * 0.3) return rc;
        if (pattern === 'dots' && v.y > h * 0.35 && v.y < h * 0.75 && Math.sin(a * 12) > 0.8 && Math.abs(v.y - h * 0.55) < 0.05) return rc;
        if (pattern === 'wave' && Math.abs(v.y - (h * 0.7 + Math.sin(a * 10) * 0.04)) < 0.025) return rc;
        if (pattern === 'ring' && r > 0.55 && r < 0.6 && v.y < h * 0.6) return rc;
        if (pattern === 'rim' || pattern === 'doubleRim' || pattern === 'stripes' || pattern === 'dots' || pattern === 'wave' || pattern === 'ring') return base;
      }
      return base;
    });
  }

  const VESSELS = {
    bowl(p) {
      const R = 0.95 * (p.size || 1), H = (p.h || 0.62) * (p.size || 1);
      const L = latheVessel((s) => R * (0.44 + 0.56 * (1 - Math.pow(1 - s, 2.1))), { h: H, footR: R * 0.42 });
      if (p.metal) {
        const m = mesh(L.geo, mat(safeHex(p.color, '#c9cdd2'), { metal: 1, rough: 0.2 }));
        return Object.assign(L, { obj: m });
      }
      const g = glazeMaterial(p, '#f3f1ea');
      paintGlaze(L.geo, H, g.col, g.rim, g.pattern);
      const m = mesh(L.geo, mat('#fff', { vc: true, rough: 0.28, clearcoat: 0.7 }));
      return Object.assign(L, { obj: m });
    },
    dish(p) {
      const R = 1.15 * (p.size || 1), H = 0.26 * (p.size || 1);
      const L = latheVessel((s) => R * (0.62 + 0.38 * Math.pow(s, 0.7)), { h: H, footR: R * 0.5, foot: 0.04 });
      const g = glazeMaterial(p, '#f4f2ec');
      paintGlaze(L.geo, H, g.col, g.rim, g.pattern);
      const m = mesh(L.geo, mat('#fff', { vc: true, rough: 0.3, clearcoat: 0.6 }));
      return Object.assign(L, { obj: m });
    },
    plate(p) {
      const R = 1.3 * (p.size || 1), H = 0.12 * (p.size || 1);
      const L = latheVessel((s) => (s < 0.35 ? R * (0.66 + s * 0.3) : R * (0.765 + (s - 0.35) / 0.65 * 0.235)), { h: H, th: 0.03, foot: 0.03, footR: R * 0.55 });
      const g = glazeMaterial(p, '#f6f5f0');
      paintGlaze(L.geo, H, g.col, g.rim, g.pattern === 'rim' ? 'rimPlate' : g.pattern);
      if (g.rim && (g.pattern === 'rim' || !p.pattern)) {
        const base = C(g.col), rc = C(g.rim);
        paint(L.geo, (v) => { const r = Math.hypot(v.x, v.z); return (r > R * 0.9 && r < R * 0.96) || (r > R * 0.78 && r < R * 0.8) ? rc : base; });
      }
      const m = mesh(L.geo, mat('#fff', { vc: true, rough: 0.3, clearcoat: 0.6 }));
      return Object.assign(L, { obj: m, innerR: R * 0.78 });
    },
    steel(p) {
      const R = 1.35 * (p.size || 1), H = 0.1;
      const L = latheVessel((s) => R * (0.9 + 0.1 * Math.pow(s, 3)), { h: H, th: 0.015, foot: 0.01, footR: R * 0.85 });
      const m = mesh(L.geo, mat(safeHex(p.color, '#c9cdd2'), { metal: 1, rough: 0.22 }));
      return Object.assign(L, { obj: m, innerR: R * 0.88 });
    },
    stonebowl(p) {
      const R = 0.9 * (p.size || 1), H = 0.56;
      const L = latheVessel((s) => R * (0.62 + 0.38 * Math.pow(s, 0.8)), { h: H, th: 0.08, foot: 0.02, footR: R * 0.6 });
      lumpy(L.geo, 0.006, 12, 3);
      const m = mesh(L.geo, mat(safeHex(p.color, '#2e2b29'), { rough: 0.85 }));
      const g = new T.Group(); g.add(m);
      const base = mesh(roundedBox(2.1, 0.12, 2.1, 0.04, 3), mat('#6b4526', { rough: 0.7 }));
      base.position.y = -0.06; g.add(base);
      m.position.y = 0.0;
      return Object.assign(L, { obj: g });
    },
    claypot(p) {
      const R = 1.0 * (p.size || 1), H = 0.55;
      const L = latheVessel((s) => R * (0.7 + 0.3 * Math.sin(s * Math.PI * 0.6)), { h: H, th: 0.06, foot: 0.03, footR: R * 0.6 });
      lumpy(L.geo, 0.008, 6, 5);
      const clay = safeHex(p.color, '#8b4a2b');
      const m = mesh(L.geo, mat(clay, { rough: 0.8 }));
      const g = new T.Group(); g.add(m);
      if (p.glazeInside !== false) {
        const inner = latheVessel((s) => R * (0.7 + 0.3 * Math.sin(s * Math.PI * 0.6)) - 0.061, { h: H - 0.02, th: 0.004, foot: 0.09, footR: 0.1 });
        const im = mesh(inner.geo, mat(safeHex(p.rimColor, '#3a2419'), { rough: 0.3, clearcoat: 0.5 }), false);
        g.add(im);
      }
      for (const sx of [-1, 1]) {
        const handle = mesh(new T.TorusGeometry(0.1, 0.03, 8, 16, Math.PI), mat(clay, { rough: 0.8 }));
        handle.position.set(sx * (R + 0.02), H * 0.72, 0); handle.rotation.set(0, sx > 0 ? Math.PI / 2 : -Math.PI / 2, Math.PI / 2);
        g.add(handle);
      }
      return Object.assign(L, { obj: g });
    },
    tagine(p) {
      const R = 1.2 * (p.size || 1), H = 0.22;
      const L = latheVessel((s) => R * (0.8 + 0.2 * s), { h: H, th: 0.04, foot: 0.03 });
      const clay = safeHex(p.color, '#9c4b2a');
      const m = mesh(L.geo, mat(clay, { rough: 0.55, clearcoat: 0.3 }));
      const g = new T.Group(); g.add(m);
      const lid = mesh(new T.ConeGeometry(R * 0.95, 1.5, 48, 1, true), mat(clay, { rough: 0.55, clearcoat: 0.3, side: T.DoubleSide }));
      const knob = mesh(new T.SphereGeometry(0.09, 16, 12), mat(clay, { rough: 0.5 }));
      knob.position.y = 0.78; knob.userData.prop = true; lid.add(knob);
      lid.position.set(1.9, 0.72, -0.9); lid.rotation.z = -0.25;
      lid.userData.prop = true;
      g.add(lid);
      return Object.assign(L, { obj: g });
    },
    paella(p) {
      const R = 1.45 * (p.size || 1), H = 0.14;
      const L = latheVessel((s) => R * (0.9 + 0.1 * s), { h: H, th: 0.012, foot: 0.005, footR: R * 0.85 });
      const m = mesh(L.geo, mat(safeHex(p.color, '#2c2c2e'), { metal: 0.85, rough: 0.45 }));
      const g = new T.Group(); g.add(m);
      for (const sx of [-1, 1]) {
        const handle = mesh(new T.TorusGeometry(0.16, 0.022, 8, 20, Math.PI), mat('#8d8f93', { metal: 1, rough: 0.35 }));
        handle.position.set(sx * (R + 0.02), H - 0.02, 0); handle.rotation.set(-Math.PI / 2, 0, sx > 0 ? -Math.PI / 2 : Math.PI / 2);
        g.add(handle);
      }
      return Object.assign(L, { obj: g, innerR: R * 0.88 });
    },
    skillet(p) {
      const R = 1.05 * (p.size || 1), H = 0.2;
      const L = latheVessel((s) => R * (0.85 + 0.15 * s), { h: H, th: 0.03, foot: 0.01 });
      const m = mesh(L.geo, mat(safeHex(p.color, '#262322'), { metal: 0.6, rough: 0.55 }));
      const g = new T.Group(); g.add(m);
      const handle = mesh(roundedBox(1.1, 0.07, 0.16, 0.03, 3), mat(safeHex(p.color, '#262322'), { metal: 0.6, rough: 0.55 }));
      handle.position.set(R + 0.5, H - 0.03, 0); handle.rotation.z = 0.12;
      g.add(handle);
      return Object.assign(L, { obj: g });
    },
    steamer(p) {
      const R = 1.05 * (p.size || 1), H = 0.36;
      const g = new T.Group();
      const wall = new T.CylinderGeometry(R, R, H, 64, 1, true);
      paint(wall, (v) => (Math.sin(Math.atan2(v.z, v.x) * 60) > 0.7 ? C('#b98e57') : C('#d6ae72')));
      const wm = mesh(wall, mat('#fff', { vc: true, rough: 0.75, side: T.DoubleSide }));
      wm.position.y = H / 2; g.add(wm);
      const rimT = mesh(new T.TorusGeometry(R, 0.025, 8, 64), mat('#b98e57', { rough: 0.7 }));
      rimT.rotation.x = Math.PI / 2; rimT.position.y = H; g.add(rimT);
      const rimB = rimT.clone(); rimB.position.y = 0.02; g.add(rimB);
      const floorTex = canvasTex(512, (c, s) => {
        c.fillStyle = '#caa36a'; c.fillRect(0, 0, s, s);
        c.strokeStyle = '#8a6a3c'; c.lineWidth = 6;
        for (let i = 0; i < s; i += 34) { c.beginPath(); c.moveTo(i, 0); c.lineTo(i, s); c.stroke(); }
        c.fillStyle = 'rgba(245,240,225,0.9)';
        c.beginPath(); c.arc(s / 2, s / 2, s * 0.47, 0, Math.PI * 2); c.fill(); // 蒸籠紙
        for (let i = 0; i < 40; i++) { c.fillStyle = 'rgba(0,0,0,0.12)'; c.beginPath(); c.arc(s / 2 + Math.cos(i) * s * (0.1 + (i % 4) * 0.09), s / 2 + Math.sin(i) * s * (0.1 + (i % 4) * 0.09), 4, 0, Math.PI * 2); c.fill(); }
      });
      const fl = mesh(new T.CircleGeometry(R - 0.01, 64), mat('#fff', { map: floorTex, rough: 0.85 }));
      fl.rotation.x = -Math.PI / 2; fl.position.y = 0.05; g.add(fl);
      const rad = (y) => R - 0.03;
      return { obj: g, floorY: 0.05, rimY: H, radiusAt: rad, innerR: R - 0.05 };
    },
    board(p) {
      const w = 2.5 * (p.size || 1), d = 1.6 * (p.size || 1);
      const shape = new T.Shape();
      const r = 0.2;
      shape.moveTo(-w / 2 + r, -d / 2); shape.lineTo(w / 2 - r, -d / 2); shape.quadraticCurveTo(w / 2, -d / 2, w / 2, -d / 2 + r);
      shape.lineTo(w / 2, d / 2 - r); shape.quadraticCurveTo(w / 2, d / 2, w / 2 - r, d / 2); shape.lineTo(-w / 2 + r, d / 2);
      shape.quadraticCurveTo(-w / 2, d / 2, -w / 2, d / 2 - r); shape.lineTo(-w / 2, -d / 2 + r); shape.quadraticCurveTo(-w / 2, -d / 2, -w / 2 + r, -d / 2);
      const geo = new T.ExtrudeGeometry(shape, { depth: 0.08, bevelEnabled: true, bevelThickness: 0.015, bevelSize: 0.015, bevelSegments: 3 });
      geo.rotateX(-Math.PI / 2);
      const tex = tableTexture('wood', safeHex(p.color, '#b58352'));
      tex.repeat.set(0.35, 0.35);
      const m = mesh(geo, mat('#fff', { map: tex, rough: 0.6 }));
      m.position.y = 0.015;
      return { obj: m, floorY: 0.11, rimY: 0.11, radiusAt: () => 1.2, innerR: 1.15 };
    },
    tray(p) {
      const R = 1.2 * (p.size || 1), H = p.material === 'paper' ? 0.24 : 0.14;
      const L = latheVessel((s) => R * (0.82 + 0.18 * s), { h: H, th: 0.015, foot: 0.005, seg: 4 });
      L.geo.rotateY(Math.PI / 4);
      L.geo.scale(1, 1, 0.72);
      L.geo.computeVertexNormals();
      const col = safeHex(p.color, '#d3d5d8');
      const metal = p.material !== 'paper';
      if (!metal) {
        const kraft = C(col), spot = mix(C(col), C('#6b4a24'), 0.5);
        paint(L.geo, (v) => (fbm(v.x * 5, v.y * 5, v.z * 5) > 0.66 ? spot : kraft));
      }
      const m = mesh(L.geo, metal ? mat(col, { metal: 0.9, rough: 0.3 }) : mat('#fff', { vc: true, rough: 0.9, side: T.DoubleSide }));
      return Object.assign(L, { obj: m, innerR: R * 0.62 });
    },
    paper(p) { return VESSELS.tray(Object.assign({ color: '#e9dcc0', material: 'paper' }, p)); },
    leaf(p) {
      const g = new T.Group();
      const { map, alpha } = leafTextures(safeHex(p.color, '#3d7a2a'));
      const geo = new T.PlaneGeometry(3.0, 3.0, 40, 40);
      geo.rotateX(-Math.PI / 2);
      const pp = geo.attributes.position;
      for (let i = 0; i < pp.count; i++) {
        const x = pp.getX(i), z = pp.getZ(i);
        pp.setY(i, 0.012 + Math.pow(Math.abs(z) / 0.9, 4) * 0.05 + (fbm(x * 2, 0, z * 2) - 0.5) * 0.03);
      }
      geo.computeVertexNormals();
      const m = mesh(geo, mat('#fff', { map, alphaMap: alpha, rough: 0.45, clearcoat: 0.4, side: T.DoubleSide }));
      g.add(m);
      if (p.onPlate !== false) {
        const plate = VESSELS.plate({ color: safeHex(p.plateColor, '#f2efe8'), size: 1.12 });
        g.add(plate.obj);
        m.position.y = plate.floorY - 0.004;
        m.scale.set(0.88, 1, 0.88);
      }
      const fy = (p.onPlate !== false) ? 0.07 : 0.03;
      return { obj: g, floorY: fy, rimY: fy, radiusAt: () => 1.2, innerR: 1.0 };
    },
    basket(p) {
      const R = 1.05 * (p.size || 1), H = 0.3;
      const L = latheVessel((s) => R * (0.8 + 0.2 * s), { h: H, th: 0.03, foot: 0.02 });
      const tex = canvasTex(256, (c, s) => {
        c.fillStyle = '#c79a5b'; c.fillRect(0, 0, s, s);
        for (let y = 0; y < s; y += 16) for (let x = 0; x < s; x += 16) {
          c.fillStyle = ((x + y) / 16) % 2 ? '#a57a41' : '#dcb57a';
          c.fillRect(x + 1, y + 1, 14, 14);
        }
      }, 6);
      const m = mesh(L.geo, mat('#fff', { map: tex, rough: 0.9 }));
      const g = new T.Group(); g.add(m);
      if (p.liner !== false) {
        const lt = leafTextures(safeHex(p.linerColor, '#5d8f34'));
        const liner = mesh(new T.PlaneGeometry(R * 2.1, R * 2.1), mat('#fff', { map: lt.map, alphaMap: lt.alpha, rough: 0.5, clearcoat: 0.3, side: T.DoubleSide }), false);
        liner.rotation.x = -Math.PI / 2; liner.rotation.z = 0.5; liner.position.y = L.floorY + 0.004; g.add(liner);
      }
      return Object.assign(L, { obj: g });
    },
    glass(p) {
      const R = 0.5 * (p.size || 1), H = 1.45 * (p.size || 1);
      const L = latheVessel((s) => R * (0.82 + 0.18 * s), { h: H, th: 0.02, foot: 0.05, footR: R * 0.82 });
      const m = mesh(L.geo, mat('#ffffff', { rough: 0.04, transmission: 1, thickness: 0.05, ior: 1.5, opacity: 0.35 }), false);
      m.renderOrder = 10;
      return Object.assign(L, { obj: m });
    },
    cup(p) {
      const R = 0.55 * (p.size || 1), H = 0.62 * (p.size || 1);
      const L = latheVessel((s) => R * (0.72 + 0.28 * Math.pow(s, 0.8)), { h: H, th: 0.03, foot: 0.04 });
      const g0 = glazeMaterial(p, '#f3efe6');
      paintGlaze(L.geo, H, g0.col, g0.rim, g0.pattern);
      const m = mesh(L.geo, mat('#fff', { vc: true, rough: 0.3, clearcoat: 0.6 }));
      const g = new T.Group(); g.add(m);
      let handle = null;
      if (p.handle !== false) {
        handle = mesh(new T.TorusGeometry(0.16, 0.03, 10, 24, Math.PI * 1.2), mat(g0.col, { rough: 0.3 }));
        handle.position.set(R + 0.03, H * 0.5, 0); handle.rotation.z = -Math.PI * 0.6; g.add(handle);
      }
      if (p.saucer !== false) {
        const sc = VESSELS.plate({ color: g0.col, size: 0.62 });
        g.add(sc.obj);
        m.position.y = sc.floorY; if (handle) handle.position.y += sc.floorY;
        L.floorY += sc.floorY; L.rimY += sc.floorY;
        const r0 = L.radiusAt, fy = sc.floorY;
        L.radiusAt = (y) => r0(y - fy);
      }
      return Object.assign(L, { obj: g });
    },
    claycup(p) {
      const R = 0.55 * (p.size || 1), H = 0.7 * (p.size || 1);
      const L = latheVessel((s) => R * (0.62 + 0.38 * Math.pow(s, 0.7)), { h: H, th: 0.05, foot: 0.03 });
      lumpy(L.geo, 0.006, 8, 2);
      const m = mesh(L.geo, mat(safeHex(p.color, '#a4532e'), { rough: 0.9 }));
      return Object.assign(L, { obj: m });
    },
    none() {
      return { obj: new T.Group(), floorY: 0, rimY: 0, radiusAt: () => 1.3, innerR: 1.3 };
    },
  };

  /* ---------- 食材零件 ---------- */
  // 每個零件函式：(p, rng, ctx) => Object3D，底部在 y=0，中心在原點
  // ctx.heightAt(x,z) 可取得目前表面高度；surface 類零件以絕對座標建造
  const P = {};
  const SURFACE = new Set(['sprinkle', 'herbs', 'scallion', 'drizzle', 'greens', 'slivers', 'chili', 'broth', 'rice', 'noodles', 'sauce']);

  function proxyDome(R, H, power = 0.8) {
    const pts = [];
    for (let i = 0; i <= 16; i++) { const d = (i / 16) * R; pts.push(V2(d, H * Math.pow(Math.max(0, 1 - Math.pow(d / R, 2)), power))); }
    pts.reverse();
    const g = new T.LatheGeometry(pts, 32);
    const m = new T.Mesh(g, new T.MeshBasicMaterial({ visible: false }));
    m.userData.proxy = true;
    return m;
  }

  // 米飯：小顆米粒 instanced + 內部實心
  P.rice = function (p, rng, ctx) {
    const R = (p.r || 0.55) * (p.size || 1), H = (p.h ?? 0.32) * (p.size || 1);
    const style = p.style || 'mound';
    const cx = p.pos ? p.pos[0] : 0, cz = p.pos ? p.pos[1] : 0;
    const baseY = ctx.heightAt(cx, cz) + (p.y || 0) - (p.sink ?? 0.01);
    const g = new T.Group();
    const hf = (d) => {
      const t = Math.min(1, d / R);
      if (style === 'layer') return H * Math.pow(Math.max(0, 1 - Math.pow(t, 8)), 0.5);
      if (style === 'ball') return H * Math.sqrt(Math.max(0, 1 - t * t));
      return H * Math.pow(Math.max(0, 1 - t * t), 0.75);
    };
    const colors = (p.colors && p.colors.length ? p.colors : [p.color || '#f5f2ea']).map((c) => C(safeHex(c, '#f5f2ea')));
    const weights = p.weights || colors.map((_, i) => (i === 0 ? 3 : 1));
    const wsum = weights.reduce((a, b) => a + b, 0);
    const pick = () => { let r = rng() * wsum; for (let i = 0; i < colors.length; i++) { r -= weights[i]; if (r <= 0) return colors[i]; } return colors[0]; };
    // 容器內壁限制：米飯不能穿出碗壁
    const off = Math.hypot(cx, cz);
    const wallR = (y) => (ctx.vessel && ctx.vessel.radiusAt ? ctx.vessel.radiusAt(y) - off - 0.03 : Infinity);
    const Rcore = Math.max(0.04, Math.min(R, wallR(baseY + 0.01)));
    const Rtop = Math.max(0.04, Math.min(R, wallR(baseY + H)));
    // 內芯
    const pts = [];
    for (let i = 0; i <= 18; i++) { const d = (1 - i / 18) * Rcore * 0.97; pts.push(V2(d, Math.max(0.001, hf(d) - 0.02))); }
    const coreGeo = new T.LatheGeometry(pts, 48);
    const core = mesh(coreGeo, mat(safeHex(p.color, '#f5f2ea'), { rough: 0.7 }));
    core.material.color.multiplyScalar(0.9);
    g.add(core);
    // 米粒
    const grainLen = (p.grain || 0.034) * (style === 'sticky' ? 0.9 : 1);
    const grainGeo = new T.CapsuleGeometry(grainLen * 0.32, grainLen * 0.75, 2, 6);
    const count = Math.min(3200, Math.round((p.density || 1) * 2600 * (R * R) / 0.3));
    const im = new T.InstancedMesh(grainGeo, mat('#ffffff', { rough: p.gloss ? 0.3 : 0.55, clearcoat: p.gloss ? 0.6 : 0 }), count);
    im.castShadow = true; im.receiveShadow = true;
    const M = new T.Matrix4(), Q = new T.Quaternion(), E = new T.Euler(), S = V3(1, 1, 1), Pp = new T.Vector3();
    for (let i = 0; i < count; i++) {
      const a = rng() * Math.PI * 2, d = Math.sqrt(rng()) * R;
      const x = Math.cos(a) * d, z = Math.sin(a) * d;
      let y = hf(d) - rng() * 0.012;
      // 貼著碗底的弧度；落在碗壁外或被碗壁蓋住的米粒不放
      const floor = ctx.heightAt(cx + x, cz + z) - baseY + grainLen * 0.35;
      let hide = false;
      if (floor > y) { if (floor > H + 0.02) hide = true; else y = floor; }
      if (d > wallR(baseY + y) - grainLen * 0.5) hide = true;
      E.set(rng() * Math.PI, rng() * Math.PI, rng() * Math.PI);
      Q.setFromEuler(E); Pp.set(x, y, z); S.setScalar(hide ? 0 : 0.85 + rng() * 0.3);
      M.compose(Pp, Q, S); im.setMatrixAt(i, M);
      const c = pick().clone(); c.offsetHSL(0, 0, (rng() - 0.5) * 0.06);
      im.setColorAt(i, c);
    }
    im.raycast = function () {};
    g.add(im);
    g.add(proxyDome(Rtop, H));
    g.position.set(cx, baseY, cz);
    g.userData.absolute = true;
    return g;
  };

  // 麵條：彎曲管或扁帶，合併成單一幾何
  P.noodles = function (p, rng, ctx) {
    const R = (p.r || 0.7) * (p.size || 1), H = (p.h ?? 0.22);
    const n = Math.min(90, p.count || 42);
    const th = p.thick || 0.018;
    const flat = p.flat || 0;
    const style = p.style || 'nest';
    const cx = p.pos ? p.pos[0] : 0, cz = p.pos ? p.pos[1] : 0;
    const baseY = ctx.heightAt(cx, cz) + (p.y || 0) - 0.01;
    const col = C(safeHex(p.color, '#f1e3b0'));
    const geos = [];
    for (let s = 0; s < n; s++) {
      const pts = [];
      let a = rng() * Math.PI * 2, d = rng() * R * 0.8;
      let x = Math.cos(a) * d, z = Math.sin(a) * d;
      let hd = rng() * Math.PI * 2;
      const layer = rng();
      const steps = style === 'straight' ? 10 : 26;
      if (style === 'straight') {
        const ang = (p.rot || 0) * Math.PI / 180 + (rng() - 0.5) * 0.25;
        const off = (rng() - 0.5) * R * 1.4;
        for (let i = 0; i <= steps; i++) {
          const t = i / steps - 0.5;
          const px = Math.cos(ang) * t * R * 2 - Math.sin(ang) * off + Math.sin(t * 9 + s) * 0.03;
          const pz = Math.sin(ang) * t * R * 2 + Math.cos(ang) * off;
          const dd = Math.hypot(px, pz);
          pts.push(V3(px, H * Math.max(0, 1 - Math.pow(dd / R, 2)) * (0.3 + layer * 0.7) + th, pz));
        }
      } else {
        for (let i = 0; i < steps; i++) {
          hd += (rng() - 0.5) * 1.3 + (style === 'swirl' ? 0.35 : 0);
          x += Math.cos(hd) * 0.09; z += Math.sin(hd) * 0.09;
          const dd = Math.hypot(x, z);
          if (dd > R) { x *= R / dd * 0.96; z *= R / dd * 0.96; hd += Math.PI * 0.8; }
          const dome = H * Math.max(0, 1 - Math.pow(Math.hypot(x, z) / R, 2));
          let y = th + dome * (0.25 + layer * 0.75) + Math.sin(i * 0.9 + s) * 0.015;
          y = Math.max(y, ctx.heightAt(cx + x, cz + z) - baseY + th);
          if (ctx.vessel) { const wr = ctx.vessel.radiusAt(baseY + y) - Math.hypot(cx, cz) - th * 2; const dd2 = Math.hypot(x, z); if (dd2 > wr && wr > 0.05) { x *= wr / dd2; z *= wr / dd2; } }
          pts.push(V3(x, y, z));
        }
      }
      const geo = flat ? ribbon(pts, th * flat, th * 0.5, steps * 3) : taperTube(pts, () => th, steps * 3, 5);
      const c = col.clone(); c.offsetHSL(0, 0, (rng() - 0.5) * 0.05);
      if (geo.index) {
        const cnt = geo.attributes.position.count;
        const arr = new Float32Array(cnt * 3);
        for (let i = 0; i < cnt; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
        geo.setAttribute('color', new T.BufferAttribute(arr, 3));
      }
      if (geo.attributes.uv) geo.deleteAttribute('uv');
      geos.push(geo);
    }
    const g = new T.Group();
    const m = mesh(merge(geos), mat('#fff', { vc: true, rough: p.gloss === false ? 0.6 : 0.35, clearcoat: p.gloss === false ? 0 : 0.5, side: flat ? T.DoubleSide : T.FrontSide }));
    g.add(m);
    g.add(proxyDome(R, H + th, 1));
    g.position.set(cx, baseY, cz);
    g.userData.absolute = true;
    return g;
  };

  // 湯／醬汁液面（填入容器）
  P.broth = function (p, rng, ctx) {
    const v = ctx.vessel;
    const fill = p.fill ?? 0.7;
    const y = v.floorY + (v.rimY - v.floorY) * fill;
    const r = Math.max(0.1, v.radiusAt(y) - 0.004);
    const g = new T.Group();
    const geo = disc(r, 12, 72);
    const thick = !!p.thick;
    if (thick || p.mound) {
      const pp = geo.attributes.position;
      for (let i = 0; i < pp.count; i++) { const x = pp.getX(i), z = pp.getZ(i); const d = Math.hypot(x, z) / r; pp.setY(i, (thick ? (fbm(x * 4 + 9, 0, z * 4) - 0.5) * 0.04 * (1 - d * d) : 0) + (p.mound || 0) * Math.sqrt(Math.max(0, 1 - d * d))); }
      geo.computeVertexNormals();
    }
    const m = mesh(geo, mat(safeHex(p.color, '#c98a3c'), { rough: thick ? 0.35 : 0.06, clearcoat: 1, ccr: 0.05, opacity: thick ? 1 : (p.opacity ?? 0.86), depthWrite: thick }), false);
    m.receiveShadow = true;
    g.add(m);
    if (p.oil) {
      const oilCol = safeHex(p.oilColor, '#f2b544');
      const n = p.oil === true ? 60 : p.oil;
      for (let i = 0; i < n; i++) {
        const a = rng() * Math.PI * 2, d = Math.sqrt(rng()) * r * 0.92;
        const s = 0.012 + rng() * rng() * 0.07;
        const o = mesh(new T.CircleGeometry(s, 20), mat(oilCol, { rough: 0.05, clearcoat: 1, opacity: 0.7 }), false);
        o.rotation.x = -Math.PI / 2; o.position.set(Math.cos(a) * d, 0.003, Math.sin(a) * d);
        g.add(o);
      }
    }
    if (p.swirl) { // 奶油、椰奶線條
      const pts = [];
      for (let i = 0; i < 40; i++) { const t = i / 40, a = t * Math.PI * 5, d = r * 0.12 + t * r * 0.55; pts.push(V3(Math.cos(a) * d, 0.006, Math.sin(a) * d)); }
      const sw = mesh(ribbon(pts, 0.05, 0.004, 120), mat(safeHex(p.swirl, '#fff7e6'), { rough: 0.3 }), false);
      g.add(sw);
    }
    if (p.body || ctx.vesselType === 'glass') { // 透明杯：畫出液體側面
      const y0 = v.floorY + (v.rimY - v.floorY) * (p.fromFill || 0) + 0.002;
      const pts = [];
      for (let i = 0; i <= 12; i++) { const yy = y0 + (y - y0) * (i / 12); pts.push(V2(Math.max(0.01, v.radiusAt(yy) - 0.008), yy - y)); }
      const side = mesh(new T.LatheGeometry(pts, 64), mat(safeHex(p.color, '#c98a3c'), { rough: 0.2, clearcoat: 0.6, opacity: thick ? 1 : (p.opacity ?? 0.86), depthWrite: thick }), false);
      g.add(side);
    }
    g.position.set(0, y, 0);
    g.userData.absolute = true;
    g.userData.level = y - (p.sinkDepth ?? 0.045);
    g.userData.levelR = r;
    return g;
  };

  // 醬汁：一灘或淋線
  P.sauce = function (p, rng, ctx) {
    const style = p.style || 'pool';
    const col = safeHex(p.color, '#7a2e12');
    const cx = p.pos ? p.pos[0] : 0, cz = p.pos ? p.pos[1] : 0;
    const R = (p.r || 0.35) * (p.size || 1);
    const g = new T.Group();
    if ((style === 'pool') && (p.count || 1) > 1 && !p._one) {
      const n = Math.min(20, p.count);
      for (let i = 0; i < n; i++) {
        const a = rng() * Math.PI * 2, d = Math.sqrt(rng()) * (p.spread ?? 0.6);
        const sub = P.sauce(Object.assign({}, p, { _one: true, count: 1, pos: [cx + Math.cos(a) * d, cz + Math.sin(a) * d], r: R * (0.6 + rng() * 0.7) }), rng, ctx);
        g.add(sub);
      }
      g.userData.absolute = true;
      return g;
    }
    if (style === 'pool' || style === 'glaze') {
      const geo = disc(R, 12, 64);
      const pp = geo.attributes.position;
      const seed = rng() * 10;
      const t = p.t ?? 0.025;
      for (let i = 0; i < pp.count; i++) {
        const x = pp.getX(i), z = pp.getZ(i);
        const a = Math.atan2(z, x), d = Math.hypot(x, z) / R;
        const w = style === 'glaze' ? 1 : 1 + (noise3(Math.cos(a) * 1.6 + seed, Math.sin(a) * 1.6, seed) - 0.5) * 0.55;
        const nx = cx + x * w, nz = cz + z * w;
        const base = style === 'glaze' ? ctx.heightAt(nx, nz) : ctx.heightAt(cx, cz);
        pp.setXYZ(i, nx, base + t * Math.sqrt(Math.max(0, 1 - Math.pow(d, 6))) + 0.002, nz);
      }
      geo.computeVertexNormals();
      g.add(mesh(geo, mat(col, { rough: 0.12, clearcoat: 1, ccr: 0.04, opacity: p.opacity }), false));
    } else { // drizzle 線
      const pts = [];
      const kind = p.pattern || 'zigzag';
      const n = kind === 'spiral' ? 140 : 110;
      const amp = p.amp ?? 0.8;
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        let x, z;
        if (kind === 'spiral') { const a = t * Math.PI * 6; x = Math.cos(a) * R * t; z = Math.sin(a) * R * t; }
        else if (kind === 'lines') { x = (t * 2 - 1) * R; z = Math.sin(t * 40) > 0 ? R * 0.1 : -R * 0.1; }
        else { const zz = p.zigs || 7; const k = Math.floor(t * zz); const f = t * zz - k; x = (t * 2 - 1) * R; z = (k % 2 ? 1 - f * 2 : f * 2 - 1) * R * amp; }
        const ang = (p.rot || 0) * Math.PI / 180;
        const rx = cx + x * Math.cos(ang) - z * Math.sin(ang), rz = cz + x * Math.sin(ang) + z * Math.cos(ang);
        pts.push(V3(rx, ctx.heightAt(rx, rz) + (p.thick || 0.014) * 0.6, rz));
      }
      // 平滑高度，避免在高低落差處拱起
      for (let pass = 0; pass < 2; pass++) for (let i = 1; i < pts.length - 1; i++) pts[i].y = Math.max(ctx.heightAt(pts[i].x, pts[i].z) + 0.004, (pts[i - 1].y + pts[i].y * 2 + pts[i + 1].y) / 4);
      g.add(mesh(taperTube(pts, () => p.thick || 0.014, n * 3, 6), mat(col, { rough: 0.2, clearcoat: 1 }), false));
    }
    g.userData.absolute = true;
    return g;
  };
  P.drizzle = function (p, rng, ctx) { return P.sauce(Object.assign({ style: 'drizzle' }, p), rng, ctx); };

  // 餃子
  P.dumpling = function (p, rng) {
    const style = p.style || 'crescent';
    const s = (p.size || 1);
    const col = C(safeHex(p.color, '#f0e6d0'));
    const brown = C(safeHex(p.bottomColor, '#b87a2e'));
    let geo;
    if (style === 'crescent' || style === 'wonton') {
      geo = new T.SphereGeometry(0.5, 40, 24);
      const pp = geo.attributes.position;
      for (let i = 0; i < pp.count; i++) {
        let x = pp.getX(i), y = pp.getY(i), z = pp.getZ(i);
        x *= 1.0; y *= 0.62; z *= 0.52;
        if (y < -0.12) y = -0.12 + (y + 0.12) * 0.25;
        const crest = Math.exp(-Math.pow(z / 0.12, 2)) * Math.max(0, y + 0.05) * 0.9;
        y += crest * 0.45 * (1 - Math.pow(x / 0.5, 4));
        z += Math.sin(x * 38) * 0.018 * Math.max(0, y) * 3;
        z += 0.34 * (x * x) - 0.06;
        if (style === 'wonton') { const n = fbm(x * 5, y * 5, z * 5) - 0.5; x += n * 0.08; y += n * 0.05; }
        pp.setXYZ(i, x, y, z);
      }
      geo = weld(geo);
    } else if (style === 'tortellini') {
      geo = new T.TorusGeometry(0.3, 0.16, 20, 40, Math.PI * 1.65);
      const pp = geo.attributes.position;
      for (let i = 0; i < pp.count; i++) {
        let x = pp.getX(i), y = pp.getY(i), z = pp.getZ(i);
        const a = Math.atan2(y, x);
        z *= 0.8 + 0.4 * Math.max(0, Math.sin(a * 1.2));
        pp.setXYZ(i, x, y, z + Math.sin(a * 3) * 0.02);
      }
      geo.rotateX(-Math.PI / 2 + 0.25);
      geo = weld(geo);
    } else if (style === 'khinkali') {
      geo = new T.SphereGeometry(0.5, 48, 32);
      const pp = geo.attributes.position;
      for (let i = 0; i < pp.count; i++) {
        let x = pp.getX(i), y = pp.getY(i), z = pp.getZ(i);
        const a = Math.atan2(z, x);
        if (y > 0) {
          const k = Math.pow(y / 0.5, 1.6);
          const sc = 1 - k * 0.82 + Math.sin(a * 18 + y * 10) * 0.05 * k;
          x *= sc; z *= sc; y *= 1.05;
          if (y > 0.46) { y += (y - 0.46) * 3; }
        } else { y *= 0.72; x *= 1.02; z *= 1.02; }
        pp.setXYZ(i, x, y, z);
      }
      geo = weld(geo);
    } else { // round：小籠包／包子
      geo = new T.SphereGeometry(0.5, 48, 32);
      const pp = geo.attributes.position;
      for (let i = 0; i < pp.count; i++) {
        let x = pp.getX(i), y = pp.getY(i), z = pp.getZ(i);
        const a = Math.atan2(z, x);
        if (y > 0) {
          const k = Math.pow(y / 0.5, 2);
          const sc = 1 - k * 0.35 + Math.sin(a * (p.pleats || 18) + y * 14) * 0.045 * k;
          x *= sc; z *= sc;
          y *= 0.78;
        } else { y *= 0.55; }
        pp.setXYZ(i, x, y, z);
      }
      geo = weld(geo);
    }
    const bb = new T.Box3().setFromBufferAttribute(geo.attributes.position);
    paint(geo, (v) => {
      const hy = (v.y - bb.min.y) / (bb.max.y - bb.min.y);
      if (p.fried && hy < 0.18) return mix(brown, col, hy / 0.18 * 0.6 + fbm(v.x * 20, 0, v.z * 20) * 0.3);
      if (p.fried === 'all') return mix(brown, col, 0.3 + fbm(v.x * 9, v.y * 9, v.z * 9) * 0.5);
      return mix(col, col.clone().offsetHSL(0, 0, -0.06), fbm(v.x * 8, v.y * 8, v.z * 8));
    });
    const sc = style === 'round' ? 0.34 : style === 'khinkali' ? 0.4 : 0.36;
    geo.scale(sc * s, sc * s, sc * s);
    const m = mesh(geo, mat('#fff', { vc: true, rough: p.glossy ? 0.25 : 0.5, clearcoat: p.glossy ? 0.8 : 0.15, sheen: p.glossy ? 0 : 0.3, sheenColor: '#fff8ea' }));
    if (style === 'khinkali' || (style === 'round' && p.knob)) {
      const kg = new T.SphereGeometry(0.03 * s, 12, 8);
      paint(kg, () => col);
      const knob = mesh(kg, m.material);
      knob.position.y = (bb.max.y) * sc * s + 0.005;
      const gg = new T.Group(); gg.add(m, knob); return wrapBase(gg);
    }
    return wrapBase(m);
  };

  // 包子、麵包
  P.bun = function (p, rng) {
    const style = p.style || 'round';
    const s = p.size || 1;
    const col = C(safeHex(p.color, '#f6efe0'));
    const top = C(safeHex(p.topColor, style === 'bread' ? '#b9722f' : safeHex(p.color, '#f6efe0')));
    if (style === 'pleated') return P.dumpling(Object.assign({ style: 'round', pleats: 22, knob: true }, p, { size: s * 1.7 }), rng);
    if (style === 'split' || style === 'sandwich') { // 夾餡麵包
      const g = new T.Group();
      const L = (p.len || 0.9) * s, W = (p.width || 0.42) * s;
      const mk = (upper) => {
        let geo = new T.SphereGeometry(0.5, 40, 20, 0, Math.PI * 2, upper ? 0 : Math.PI / 2, Math.PI / 2);
        geo.scale(L, upper ? W * 0.9 : W * 0.35, W);
        geo = weld(geo);
        lumpy(geo, 0.02, 4, upper ? 1 : 2);
        paint(geo, (v) => (upper ? mix(col, top, Math.min(1, v.y / (W * 0.3)) * 0.9 + fbm(v.x * 6, v.y * 6, v.z * 6) * 0.2) : mix(col, top, Math.min(1, -v.y / (W * 0.15)))));
        return mesh(geo, mat('#fff', { vc: true, rough: 0.65 }));
      };
      const lower = mk(false); lower.position.y = W * 0.17;
      const upper = mk(true); upper.position.y = W * 0.17 + (p.gap ?? 0.12) * s; upper.rotation.z = 0.03;
      if (p.open) { upper.rotation.x = -0.75; upper.position.z = -W * 0.42; upper.position.y += W * 0.22; }
      g.add(lower, upper);
      if (p.sausage) {
        const sg = P.sausage({ color: p.sausage, color2: p.sausage2 || '#5e1d0f', len: L * 0.95, rad: W * 0.2, bend: 0.02, grill: true }, rng);
        sg.position.set(0, W * 0.17 + 0.01, 0.02);
        g.add(sg);
      }
      if (p.filling) {
        const fillCols = Array.isArray(p.filling) ? p.filling : [p.filling];
        fillCols.forEach((fc, i) => {
          let fg = new T.SphereGeometry(0.5, 24, 12);
          fg.scale(L * 0.95, 0.12 * s, W * (0.95 - i * 0.12));
          fg = weld(fg); lumpy(fg, 0.03, 6, i + 3);
          const fm = mesh(fg, mat(safeHex(fc, '#8a3b1e'), { rough: 0.45, clearcoat: 0.3 }));
          fm.position.y = W * 0.17 + 0.03 + i * 0.045 * s;
          g.add(fm);
        });
      }
      return wrapBase(g);
    }
    if (style === 'fold' || style === 'guabao') {
      let geo = new T.SphereGeometry(0.5, 40, 24);
      geo.scale(0.8 * s, 0.07 * s, 1.1 * s);
      geo = weld(geo);
      foldU(geo, 0.55 * s, Math.PI * 0.72);
      paint(geo, () => col);
      const shell = mesh(geo, mat('#fff', { vc: true, rough: 0.55, sheen: 0.4, sheenColor: '#ffffff' }));
      shell.rotation.x = -Math.PI / 2 * 0.12;
      const g = new T.Group(); g.add(shell);
      const fills = p.filling || ['#6b2e14', '#5a8f3a', '#d7c29a'];
      fills.forEach((fc, i) => {
        let fg = new T.SphereGeometry(0.2 * s, 18, 12);
        fg.scale(1.6, 0.8 + i * 0.2, 0.6);
        fg = weld(fg); lumpy(fg, 0.05, 5, i * 3);
        const fm = mesh(fg, mat(safeHex(fc, '#6b2e14'), { rough: 0.5, clearcoat: 0.3 }));
        fm.position.set((i - 1) * 0.08 * s, 0.18 * s + i * 0.06 * s, 0);
        g.add(fm);
      });
      return wrapBase(g);
    }
    // round / bread / dome
    let geo = new T.SphereGeometry(0.5, 48, 28);
    const pp = geo.attributes.position;
    const flatten = style === 'bread' ? 0.55 : 0.68;
    for (let i = 0; i < pp.count; i++) {
      let x = pp.getX(i), y = pp.getY(i), z = pp.getZ(i);
      if (y < -0.05) y = -0.05 + (y + 0.05) * 0.2;
      y *= flatten;
      pp.setXYZ(i, x, y, z);
    }
    geo = weld(geo);
    lumpy(geo, style === 'bread' ? 0.025 : 0.01, 4, rng() * 10);
    paint(geo, (v) => mix(col, top, Math.max(0, (v.y + 0.02) / 0.3) * 0.9 + (fbm(v.x * 7, v.y * 7, v.z * 7) - 0.5) * 0.3));
    geo.scale((p.w || 0.62) * s, 0.62 * s * (p.hScale || 1), (p.d || 0.62) * s);
    const m = mesh(geo, mat('#fff', { vc: true, rough: style === 'bread' ? 0.6 : 0.5, sheen: style === 'bread' ? 0 : 0.4, sheenColor: '#ffffff' }));
    const g = new T.Group(); g.add(m);
    if (p.seeds) {
      const sg = new T.SphereGeometry(0.012, 6, 4); sg.scale(1, 0.45, 0.6);
      const im = new T.InstancedMesh(sg, mat(safeHex(p.seeds, '#f1e2bf'), { rough: 0.6 }), 90);
      const M = new T.Matrix4();
      for (let i = 0; i < 90; i++) {
        const a = rng() * Math.PI * 2, d = Math.sqrt(rng()) * 0.26 * s;
        M.makeRotationY(rng() * 6).setPosition(Math.cos(a) * d, 0.62 * s * 0.5 * flatten * Math.sqrt(1 - Math.pow(d / (0.31 * s), 2)) + 0.045 * s, Math.sin(a) * d);
        im.setMatrixAt(i, M);
      }
      g.add(im);
    }
    return wrapBase(g);
  };

  // 薄餅、烙餅、可麗餅、煎餅
  P.flatbread = function (p, rng) {
    const R = (p.r || 0.7) * (p.size || 1), t = p.t || 0.05;
    const col = C(safeHex(p.color, '#e8c98f'));
    const spot = C(safeHex(p.spotColor, '#7a4a1e'));
    let geo = new T.SphereGeometry(1, 64, 20);
    geo.scale(R, t, R * (p.oval || 1));
    geo = weld(geo);
    const pp = geo.attributes.position;
    const seed = rng() * 20;
    for (let i = 0; i < pp.count; i++) {
      let x = pp.getX(i), y = pp.getY(i), z = pp.getZ(i);
      const a = Math.atan2(z, x);
      const w = 1 + (noise3(Math.cos(a) * 2 + seed, Math.sin(a) * 2, 0) - 0.5) * (p.wobble ?? 0.12);
      x *= w; z *= w;
      if (p.bubbles) y += Math.max(0, fbm(x * 5 + seed, 0, z * 5) - 0.55) * p.bubbles * (y > 0 ? 1 : 0.2);
      if (y < 0) y *= 0.4;
      if (p.cup) { const d = Math.hypot(x, z) / R; y += p.cup * Math.pow(d, 2.2); }
      if (p.center) { const d = Math.hypot(x, z) / R; y += p.center * Math.max(0, 1 - d * d * 3) * (y > 0 ? 1 : 0); }
      pp.setXYZ(i, x, y, z);
    }
    geo.computeVertexNormals();
    paint(geo, (v) => {
      const n = fbm(v.x * (p.spotScale || 7) + seed, v.y * 7, v.z * (p.spotScale || 7));
      const edge = Math.hypot(v.x, v.z) / R;
      let c = col.clone();
      if (p.spots !== false && n > (p.spotThreshold ?? 0.62)) c = mix(col, spot, (n - (p.spotThreshold ?? 0.62)) * 4);
      if (p.edgeColor && edge > (p.edgeFrom ?? 0.85)) c = mix(c, C(p.edgeColor), (edge - (p.edgeFrom ?? 0.85)) / (1 - (p.edgeFrom ?? 0.85)));
      return c;
    });
    if (p.fold) {
      const angle = Math.PI * (p.fold === true ? 0.96 : p.fold);
      const q = geo.attributes.position;
      for (let i = 0; i < q.count; i++) {
        const x = q.getX(i), y = q.getY(i), z = q.getZ(i);
        if (z > 0) {
          const nz = z * Math.cos(angle) - (y) * Math.sin(angle);
          const ny = z * Math.sin(angle) + y * Math.cos(angle) + t * 2.2;
          q.setXYZ(i, x, ny, nz);
        }
      }
      geo.computeVertexNormals();
    }
    const m = mesh(geo, mat('#fff', { vc: true, rough: p.gloss ? 0.25 : 0.7, clearcoat: p.gloss ? 0.8 : 0, opacity: p.opacity }));
    return wrapBase(m);
  };
  P.pancake = function (p, rng) { return P.flatbread(Object.assign({ wobble: 0.22, bubbles: 0.05, spotScale: 5 }, p), rng); };

  // 肉片（扇形排列）
  P.slices = function (p, rng) {
    const n = p.count || 5;
    const w = (p.w || 0.34) * (p.size || 1), l = (p.l || 0.5) * (p.size || 1), t = (p.t || 0.05) * (p.size || 1);
    const col = C(safeHex(p.color, '#b5553a')), fat = p.fatColor ? C(p.fatColor) : null, edge = p.edgeColor ? C(p.edgeColor) : null;
    const g = new T.Group();
    for (let i = 0; i < n; i++) {
      let geo = roundedBox(w, t, l, Math.min(t * 0.45, 0.02), 5);
      const pp = geo.attributes.position;
      const droop = p.droop ?? 0.18;
      for (let k = 0; k < pp.count; k++) {
        const x = pp.getX(k), z = pp.getZ(k);
        const edge = 1 + (noise3(x * 9 + i * 3, 0, z * 9) - 0.5) * 0.12;
        pp.setX(k, x * edge);
        pp.setY(k, pp.getY(k) + Math.sin(z * 6 + i) * 0.012 * (p.wave ?? 1) - Math.pow((2 * z) / l, 2) * l * droop * 0.35 - Math.pow((2 * x) / w, 2) * w * droop * 0.12);
      }
      geo.computeVertexNormals();
      const seed = rng() * 10;
      paint(geo, (v) => {
        let c = col.clone();
        if (p.stripes) { const s = Math.sin((v.x * 2 + v.z) * (p.stripes === true ? 28 : p.stripes)); if (s > 0.75) c = mix(c, C(p.stripeColor || '#fff5ea'), 0.8); }
        if (fat && v.x > w / 2 - w * 0.22) c = mix(c, fat, 0.9);
        if (p.marble) { const n2 = fbm(v.x * 18 + seed, v.y * 18, v.z * 18); if (n2 > 0.62) c = mix(c, fat || C('#f5e6dc'), 0.85); }
        if (edge && (Math.abs(v.x) > w / 2 - 0.018 || Math.abs(v.z) > l / 2 - 0.018 || v.y > t / 2 - 0.004)) {
          const e = Math.max(Math.abs(v.x) / (w / 2), Math.abs(v.z) / (l / 2));
          if (e > 0.93 || v.y > t / 2 - 0.004) c = mix(c, edge, v.y > t / 2 - 0.004 && e < 0.93 ? (p.topEdge ?? 0.15) : 0.9);
        }
        return c.offsetHSL(0, 0, (fbm(v.x * 30, v.y * 30, v.z * 30) - 0.5) * 0.06);
      });
      const m = mesh(geo, mat('#fff', { vc: true, rough: p.gloss ? 0.2 : 0.55, clearcoat: p.gloss ? 0.9 : 0.1 }));
      const spread = p.spread ?? 0.11;
      m.position.set((i - (n - 1) / 2) * spread * (p.size || 1), t / 2 + i * t * 0.55, 0);
      m.rotation.z = -(p.tilt ?? 0.22);
      m.rotation.y = (rng() - 0.5) * 0.08;
      g.add(m);
    }
    return wrapBase(g);
  };

  // 塊狀（滷肉、豆腐、蔬菜丁、炸物）
  P.chunk = function (p, rng) {
    const s = (p.s || 0.16) * (p.size || 1) * (0.85 + rng() * 0.3);
    const asp = p.aspect || [1, 0.85, 1];
    const shape = p.shape || 'cube';
    let geo;
    if (shape === 'round' || shape === 'blob') { geo = new T.IcosahedronGeometry(0.5, 4); geo = weld(geo); }
    else if (shape === 'wedge') { geo = new T.CylinderGeometry(0.5, 0.5, 0.5, 3, 3); geo = weld(geo); geo.rotateZ(Math.PI / 2); }
    else if (shape === 'stick') { geo = roundedBox(1, 0.28, 0.28, 0.06, 6); }
    else if (shape === 'halfmoon') { geo = new T.CylinderGeometry(0.5, 0.5, 0.22, 24, 2, false, 0, Math.PI); geo = weld(geo); }
    else { geo = roundedBox(1, 1, 1, p.round ?? 0.14, 6); }
    geo.scale(s * asp[0], s * asp[1], s * asp[2]);
    const crispy = p.crispy;
    lumpy(geo, s * (p.noise ?? (crispy ? 0.12 : 0.06)), (crispy ? 9 : 4) / s * 0.16, rng() * 50, V3(0, 0, 0), crispy ? 4 : 3);
    const col = C(safeHex(p.color, '#9b5a2c'));
    const col2 = p.color2 ? C(p.color2) : col.clone().offsetHSL(0, 0.05, -0.12);
    const seed = rng() * 30;
    paint(geo, (v) => {
      const n = fbm(v.x / s * 1.5 + seed, v.y / s * 1.5, v.z / s * 1.5, 4);
      let c = mix(col, col2, n * (p.variation ?? 1.1) - 0.1);
      if (p.char) { const k = fbm(v.x / s * 3 + seed, v.y / s * 3, v.z / s * 3); if (k > 0.6) c = mix(c, C('#2b160a'), (k - 0.6) * 3 * p.char); }
      if (p.fatLayer) { const f = Math.sin(v.y / s * 9); if (f > 0.65) c = mix(c, C(p.fatLayer), 0.85); }
      if (p.topColor && v.y > s * asp[1] * 0.35) c = mix(c, C(p.topColor), 0.9);
      if (shape === 'halfmoon' && p.skinColor) { const rr = Math.hypot(v.x / (s * asp[0]), v.z / (s * asp[2])); if (rr > 0.43) c = mix(c, C(p.skinColor), Math.min(1, (rr - 0.43) * 14)); }
      return c;
    });
    const m = mesh(geo, mat('#fff', { vc: true, rough: p.glaze ? 0.22 : crispy ? 0.75 : 0.55, clearcoat: p.glaze ? 1 : 0, ccr: 0.08 }));
    m.rotation.set((rng() - 0.5) * (p.tumble ?? 0.5), rng() * Math.PI * 2, (rng() - 0.5) * (p.tumble ?? 0.5));
    return wrapBase(m);
  };
  P.fried = function (p, rng) { return P.chunk(Object.assign({ crispy: true, shape: 'blob', color: '#d19a4a', color2: '#8f5a1f', noise: 0.16 }, p), rng); };
  P.tofu = function (p, rng) { return P.chunk(Object.assign({ color: '#efe6cf', round: 0.06, noise: 0.015, variation: 0.3 }, p), rng); };

  // 球狀（肉丸、湯圓、章魚燒）
  P.balls = function (p, rng) {
    const r = (p.rad || 0.1) * (p.size || 1) * (0.9 + rng() * 0.2);
    if (p.cut) { // 切半露出剖面
      const g = new T.Group();
      let hg = new T.SphereGeometry(r, 40, 20, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
      hg = weld(hg); lumpy(hg, r * 0.05, 3 / r * 0.1, 3);
      const col = C(safeHex(p.color, '#c8862e'));
      paint(hg, (v) => mix(col, col.clone().offsetHSL(0, 0, -0.1), fbm(v.x / r * 3, v.y / r * 3, v.z / r * 3)));
      g.add(mesh(hg, mat('#fff', { vc: true, rough: 0.7 })));
      const rings = Array.isArray(p.cut) ? p.cut : [{ color: '#f2c24a', r: 0.86, grain: true }, { color: '#7a2a14', r: 0.4, bits: ['#5a9a2e', '#5a9a2e', '#a8401e'] }];
      const tex = crossSectionTex('#' + col.getHexString(), rings);
      const cap = mesh(new T.CircleGeometry(r * 0.99, 40), mat('#fff', { map: tex, rough: 0.6 }));
      cap.rotation.x = -Math.PI / 2; cap.position.y = 0.001;
      g.add(cap);
      return wrapBase(g);
    }
    let geo = new T.IcosahedronGeometry(r, 4);
    geo = weld(geo);
    geo.scale(1, p.squash ?? 0.92, 1);
    if (p.cone) { const q = geo.attributes.position; for (let i = 0; i < q.count; i++) { const y = q.getY(i); if (y > 0) { const k = 1 - (y / r) * 0.75; q.setX(i, q.getX(i) * k); q.setZ(i, q.getZ(i) * k); q.setY(i, y * (1 + p.cone)); } } geo.computeVertexNormals(); }
    lumpy(geo, r * (p.noise ?? 0.08), 3 / r * 0.1, rng() * 40);
    const col = C(safeHex(p.color, '#8a4a25'));
    const col2 = p.color2 ? C(p.color2) : col.clone().offsetHSL(0, 0, -0.08);
    const seed = rng() * 9;
    paint(geo, (v) => {
      let c = mix(col, col2, fbm(v.x / r * 2 + seed, v.y / r * 2, v.z / r * 2));
      if (p.topColor && v.y > r * 0.35) c = mix(c, C(p.topColor), Math.min(1, (v.y - r * 0.35) / (r * 0.3)));
      if (p.dust) { if (fbm(v.x / r * 12, v.y / r * 12, v.z / r * 12) > 0.55) c = mix(c, C(p.dust), 0.8); }
      return c;
    });
    const m = mesh(geo, mat('#fff', { vc: true, rough: p.glossy ? 0.18 : 0.55, clearcoat: p.glossy ? 1 : 0, transmission: p.translucent ? 0.4 : 0, thickness: 0.2 }));
    return wrapBase(m);
  };

  // 串燒
  P.skewer = function (p, rng) {
    const L = (p.len || 1.3) * (p.size || 1);
    const items = p.items && p.items.length ? p.items : ['#8a3f1c', '#8a3f1c', '#8a3f1c', '#8a3f1c'];
    const n = p.n || items.length;
    const g = new T.Group();
    const stick = mesh(new T.CylinderGeometry(0.012, 0.009, L, 8), mat(safeHex(p.stickColor, '#d9b77e'), { rough: 0.8 }));
    stick.rotation.z = Math.PI / 2;
    g.add(stick);
    const seg = (L * 0.72) / n;
    for (let i = 0; i < n; i++) {
      const it = items[i % items.length];
      const color = typeof it === 'string' ? it : it.color;
      const shape = (typeof it === 'object' && it.shape) || p.shape || 'cube';
      const piece = P.chunk({ color, s: seg * 0.95 * (p.pieceScale || 1), shape, char: p.char ?? 0.8, glaze: p.glaze, aspect: shape === 'round' ? [1, 1, 1] : [0.8, 0.9, 1.1], tumble: 0.2 }, rng);
      piece.position.set(-L * 0.36 + seg * (i + 0.5), -seg * 0.45, 0);
      g.add(piece);
    }
    return wrapBase(g);
  };

  // 香腸
  P.sausage = function (p, rng) {
    const L = (p.len || 0.8) * (p.size || 1), r = (p.rad || 0.07) * (p.size || 1);
    const bend = p.bend ?? 0.12;
    const pts = [];
    for (let i = 0; i <= 8; i++) { const t = i / 8 - 0.5; pts.push(V3(t * L, 0, -bend * (1 - 4 * t * t) * L * 0.5)); }
    const geo = taperTube(pts, (t) => r * Math.pow(Math.sin(Math.min(1, Math.max(0, t)) * Math.PI), 0.18), 64, 20);
    const col = C(safeHex(p.color, '#a2472a')), col2 = C(safeHex(p.color2, '#6b2512'));
    paint(geo, (v) => {
      let c = mix(col, col2, fbm(v.x * 20, v.y * 20, v.z * 20));
      if (p.grill && Math.sin((v.x + v.z) * 40) > 0.85 && v.y > 0) c = mix(c, C('#2a1208'), 0.8);
      if (p.scored && Math.sin(v.x * 30) > 0.92 && v.y > r * 0.3) c = mix(c, C(p.innerColor || '#e8b59a'), 0.8);
      return c;
    });
    const m = mesh(geo, mat('#fff', { vc: true, rough: 0.3, clearcoat: 0.8 }));
    return wrapBase(m);
  };

  // 蝦
  P.shrimp = function (p, rng) {
    const s = (p.size || 1) * 0.28;
    const pts = [];
    for (let i = 0; i <= 10; i++) { const t = i / 10, a = t * Math.PI * 1.25; pts.push(V3(Math.cos(a) * s * (1 - t * 0.35), 0, Math.sin(a) * s * (1 - t * 0.35))); }
    const geo = taperTube(pts, (t) => s * 0.3 * (1 - t * 0.72), 50, 14);
    const col = C(safeHex(p.color, '#f07a4d')), stripe = C(safeHex(p.stripe, '#fbe0cf'));
    paint(geo, (v) => { const a = Math.atan2(v.z, v.x); return Math.sin(a * 11) > 0.35 && v.y > -s * 0.1 ? col : mix(stripe, col, 0.25); });
    const m = mesh(geo, mat('#fff', { vc: true, rough: 0.35, clearcoat: 0.6 }));
    const g = new T.Group(); g.add(m);
    const tailShape = new T.Shape(); tailShape.moveTo(0, 0); tailShape.lineTo(s * 0.35, s * 0.18); tailShape.lineTo(s * 0.3, -s * 0.18); tailShape.lineTo(0, 0);
    const tail = mesh(new T.ShapeGeometry(tailShape), mat(safeHex(p.tailColor, '#e2572c'), { rough: 0.4, side: T.DoubleSide }));
    const end = pts[pts.length - 1];
    tail.rotation.x = -Math.PI / 2; tail.position.set(end.x, 0, end.z); tail.rotation.z = -Math.PI * 1.2;
    g.add(tail);
    return wrapBase(g);
  };

  // 蛋
  P.egg = function (p, rng) {
    const style = p.style || 'half';
    const s = p.size || 1;
    const white = C(safeHex(p.whiteColor, '#fbf8f0')), yolk = C(safeHex(p.yolkColor, '#f4a51c'));
    const g = new T.Group();
    if (style === 'fried') {
      let geo = disc(0.34 * s, 10, 48);
      const pp = geo.attributes.position; const seed = rng() * 10;
      for (let i = 0; i < pp.count; i++) {
        const x = pp.getX(i), z = pp.getZ(i), a = Math.atan2(z, x), d = Math.hypot(x, z) / (0.34 * s);
        const w = 1 + (noise3(Math.cos(a) * 2 + seed, Math.sin(a) * 2, 1) - 0.5) * 0.6;
        pp.setXYZ(i, x * w, 0.02 * s * (1 - d * d) + (fbm(x * 9, 0, z * 9) - 0.5) * 0.01, z * w);
      }
      geo.computeVertexNormals();
      paint(geo, (v) => { const d = Math.hypot(v.x, v.z) / (0.36 * s); return d > 0.82 && p.crispy !== false ? mix(white, C('#b9782f'), (d - 0.82) * 4) : white; });
      g.add(mesh(geo, mat('#fff', { vc: true, rough: 0.3, clearcoat: 0.6 })));
      const y = mesh(new T.SphereGeometry(0.1 * s, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), mat('#fff', { rough: 0.15, clearcoat: 1 }));
      y.material.color.copy(yolk); y.scale.y = 0.7; y.position.set(0.03, 0.018 * s, -0.02); g.add(y);
      return wrapBase(g);
    }
    if (style === 'yolk') {
      const y = mesh(new T.SphereGeometry(0.11 * s, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), mat('#fff', { rough: 0.1, clearcoat: 1 }));
      y.material.color.copy(yolk); y.scale.y = 0.75; g.add(y); return wrapBase(g);
    }
    if (style === 'rolled') { // 玉子燒
      const geo = roundedBox(0.5 * s, 0.22 * s, 0.26 * s, 0.03, 6);
      paint(geo, (v) => (Math.sin(v.y * 90 / s) > 0.6 ? C('#e7b04a') : C(safeHex(p.color, '#f5cf5e'))));
      g.add(mesh(geo, mat('#fff', { vc: true, rough: 0.45 })));
      return wrapBase(g);
    }
    // 雞蛋形狀（長軸 x）
    const eggGeo = (half) => {
      let geo = new T.SphereGeometry(0.5, 48, 32, 0, Math.PI * 2, 0, half ? Math.PI / 2 : Math.PI);
      const pp = geo.attributes.position;
      for (let i = 0; i < pp.count; i++) {
        const x = pp.getX(i), y = pp.getY(i), z = pp.getZ(i);
        // 蛋形：y 軸方向一端較尖
        const k = 1 - 0.14 * (y / 0.5);
        pp.setXYZ(i, x * k * 0.74, y, z * k * 0.74);
      }
      geo.computeVertexNormals();
      return geo;
    };
    const quail = style === 'quail';
    const scale = (quail ? 0.13 : 0.3) * s;
    if (style === 'half') {
      const geo = eggGeo(false);
      // 切半：保留 z<=0 的一半，轉成切面朝上
      const pp = geo.attributes.position;
      for (let i = 0; i < pp.count; i++) { if (pp.getZ(i) > 0) pp.setZ(i, 0); }
      geo.computeVertexNormals();
      const brown = p.marinated ? C(p.marinated === true ? '#a9642a' : p.marinated) : null;
      paint(geo, (v, n) => {
        const onCut = Math.abs(v.z) < 1e-4;
        if (onCut) {
          const rx = v.x / 0.37, ry = (v.y + 0.04) / 0.5;
          const yd = Math.hypot(v.x / 0.2, (v.y + 0.02) / 0.24);
          if (yd < 1) return p.jammy ? mix(C('#f9a11b'), yolk, yd) : yolk;
          if (brown && Math.hypot(rx, ry) > 0.8) return mix(white, brown, 0.8);
          return white;
        }
        return brown ? brown : white;
      });
      geo.rotateX(-Math.PI / 2);
      geo.rotateY(rng() * Math.PI);
      geo.scale(scale, scale, scale);
      g.add(mesh(geo, mat('#fff', { vc: true, rough: 0.3, clearcoat: 0.5 })));
      return wrapBase(g);
    }
    const geo = eggGeo(false);
    const tea = style === 'tea' || p.marbled;
    paint(geo, (v) => {
      if (quail && p.speckled) return fbm(v.x * 20, v.y * 20, v.z * 20) > 0.6 ? C('#5a4331') : C('#e9dcc5');
      if (tea) { const n = Math.abs(fbm(v.x * 9, v.y * 9, v.z * 9) - 0.5); return n < 0.03 ? C('#4a2a14') : mix(C('#c89260'), C('#e9d2ad'), n * 3); }
      if (p.color) return C(p.color);
      return white;
    });
    geo.rotateZ(Math.PI / 2);
    geo.scale(scale, scale, scale);
    g.add(mesh(geo, mat('#fff', { vc: true, rough: 0.3, clearcoat: 0.5 })));
    return wrapBase(g);
  };

  // 表面散布：葉子
  function scatterOnSurface(p, rng, ctx, n, fn) {
    const cx = p.pos ? p.pos[0] : 0, cz = p.pos ? p.pos[1] : 0;
    const R = (p.r ?? 0.5);
    const RX = p.rx ?? R, RZ = p.rz ?? R;
    const out = [];
    for (let i = 0; i < n; i++) {
      const a = rng() * Math.PI * 2, d = Math.pow(rng(), p.center ? 1.2 : 0.5);
      const x = cx + Math.cos(a) * d * RX, z = cz + Math.sin(a) * d * RZ;
      out.push(fn(x, ctx.heightAt(x, z), z, i));
    }
    return out;
  }
  function leafGeometry(len, wid, curl, ruffle, seed) {
    const geo = new T.PlaneGeometry(1, 1, 6, 12);
    const pp = geo.attributes.position;
    for (let i = 0; i < pp.count; i++) {
      const u = pp.getX(i), v = pp.getY(i) + 0.5;
      const w = Math.pow(Math.sin(Math.PI * Math.min(1, v * 1.05)), 0.8) * wid;
      const x = u * w;
      const y = curl * x * x * 4 + Math.sin(v * Math.PI) * 0.02 + (ruffle ? (noise3(u * 8 + seed, v * 8, seed) - 0.5) * ruffle * Math.abs(u) * 2 : 0);
      pp.setXYZ(i, x, y, (v - 0.5) * len);
    }
    geo.computeVertexNormals();
    return geo;
  }
  P.greens = function (p, rng, ctx) {
    const style = p.style || 'leaf';
    const n = p.count || 8;
    const col = C(safeHex(p.color, '#4f8f35'));
    const col2 = C(safeHex(p.color2, '#a8cf6a'));
    const g = new T.Group();
    const size = p.size || 1;
    scatterOnSurface(p, rng, ctx, n, (x, y, z, i) => {
      let geo;
      if (style === 'bokchoy') {
        const gg = new T.Group();
        const stem = mesh(roundedBox(0.09 * size, 0.04 * size, 0.3 * size, 0.018, 4), mat(safeHex(p.stemColor, '#e6f0cf'), { rough: 0.35, clearcoat: 0.4 }));
        stem.position.z = -0.12 * size; gg.add(stem);
        const lg = leafGeometry(0.34 * size, 0.2 * size, 0.2, 0.02, i);
        paint(lg, (v) => mix(col, col.clone().offsetHSL(0, 0, -0.08), Math.abs(v.x) * 6));
        const lf = mesh(lg, mat('#fff', { vc: true, rough: 0.4, clearcoat: 0.5, side: T.DoubleSide }));
        lf.position.z = 0.14 * size; lf.position.y = 0.02; gg.add(lf);
        gg.position.set(x, y + 0.02, z); gg.rotation.y = rng() * Math.PI * 2; gg.rotation.z = (rng() - 0.5) * 0.2;
        g.add(gg); return;
      }
      const len = (style === 'lettuce' ? 0.5 : style === 'basil' ? 0.12 : style === 'mint' ? 0.09 : 0.26) * size * (0.8 + rng() * 0.4);
      const wid = len * (style === 'lettuce' ? 0.8 : style === 'basil' ? 0.55 : 0.5);
      geo = leafGeometry(len, wid, style === 'lettuce' ? 0.05 : 0.18, style === 'lettuce' ? 0.25 : 0.03, i * 3.1);
      paint(geo, (v) => { const k = Math.abs(v.x) / (wid / 2 + 1e-6); return mix(col2, col, Math.min(1, k * 1.4 + (v.z / len + 0.5) * 0.2)); });
      const m = mesh(geo, mat('#fff', { vc: true, rough: 0.45, clearcoat: 0.3, side: T.DoubleSide }));
      m.position.set(x, y + 0.01 + len * 0.05, z);
      m.rotation.set((rng() - 0.5) * 0.5, rng() * Math.PI * 2, (rng() - 0.5) * 0.5);
      g.add(m);
    });
    g.userData.absolute = true;
    return g;
  };

  // 香菜等小葉子
  P.herbs = function (p, rng, ctx) {
    const n = Math.min(400, p.count || 40);
    const sz = (p.leaf || 0.045) * (p.size || 1);
    const shape = new T.Shape();
    for (let i = 0; i <= 24; i++) { const a = (i / 24) * Math.PI * 2; const r = sz * (0.7 + 0.3 * Math.cos(a * 3)) * (1 + 0.15 * Math.sin(a * 9)); const x = Math.cos(a) * r, y = Math.sin(a) * r; if (i === 0) shape.moveTo(x, y); else shape.lineTo(x, y); }
    const geo = new T.ShapeGeometry(shape); geo.rotateX(-Math.PI / 2);
    const im = new T.InstancedMesh(geo, mat('#ffffff', { rough: 0.5, side: T.DoubleSide }), n);
    im.castShadow = true;
    const col = C(safeHex(p.color, '#3f8f2e'));
    const M = new T.Matrix4(), Q = new T.Quaternion(), E = new T.Euler(), S = new T.Vector3();
    scatterOnSurface(p, rng, ctx, n, (x, y, z, i) => {
      E.set((rng() - 0.5) * 0.9, rng() * 6.28, (rng() - 0.5) * 0.9); Q.setFromEuler(E);
      S.setScalar(0.6 + rng() * 0.7);
      M.compose(V3(x, y + 0.012, z), Q, S); im.setMatrixAt(i, M);
      im.setColorAt(i, col.clone().offsetHSL(0, 0, (rng() - 0.5) * 0.1));
    });
    const g = new T.Group(); g.add(im); g.userData.absolute = true; return g;
  };

  // 蔥花
  P.scallion = function (p, rng, ctx) {
    const n = Math.min(500, p.count || 60);
    const r = (p.ring || 0.022) * (p.size || 1);
    const geo = new T.CylinderGeometry(r, r, r * 0.9, 12, 1, true);
    const im = new T.InstancedMesh(geo, mat('#ffffff', { rough: 0.35, clearcoat: 0.4, side: T.DoubleSide }), n);
    im.castShadow = true;
    const c1 = C(safeHex(p.color, '#5fae3c')), c2 = C(safeHex(p.color2, '#e8f2c9'));
    const M = new T.Matrix4(), Q = new T.Quaternion(), E = new T.Euler(), S = V3(1, 1, 1);
    scatterOnSurface(p, rng, ctx, n, (x, y, z, i) => {
      E.set(rng() * 0.8 - 0.4 + (rng() > 0.6 ? Math.PI / 2 : 0), rng() * 6.28, rng() * 0.6); Q.setFromEuler(E);
      M.compose(V3(x, y + r * 0.5, z), Q, S); im.setMatrixAt(i, M);
      im.setColorAt(i, mix(c1, c2, rng() * rng()));
    });
    const g = new T.Group(); g.add(im); g.userData.absolute = true; return g;
  };

  // 辣椒
  P.chili = function (p, rng, ctx) {
    const style = p.style || 'slices';
    const col = safeHex(p.color, '#d8261c');
    if (style === 'slices') return P.scallion(Object.assign({}, p, { color: col, color2: safeHex(p.color2, col), ring: p.ring || 0.028, count: p.count || 20 }), rng, ctx);
    if (style === 'flakes') return P.sprinkle(Object.assign({ shape: 'flake' }, p, { color: col }), rng, ctx);
    const g = new T.Group();
    const n = p.count || 2;
    scatterOnSurface(p, rng, ctx, n, (x, y, z) => {
      const L = (p.len || 0.4) * (p.size || 1);
      const pts = []; for (let i = 0; i <= 6; i++) { const t = i / 6; pts.push(V3(t * L - L / 2, Math.sin(t * Math.PI) * 0.03, Math.sin(t * 2.2) * L * 0.18)); }
      const geo = taperTube(pts, (t) => (p.rad || 0.035) * (p.size || 1) * Math.pow(1 - t, 0.6) * Math.min(1, t * 10 + 0.5), 32, 10);
      if (style === 'dried') lumpy(geo, 0.008, 30, rng() * 10);
      const m = mesh(geo, mat(col, { rough: style === 'dried' ? 0.6 : 0.2, clearcoat: style === 'dried' ? 0 : 1 }));
      const stem = mesh(new T.CylinderGeometry(0.008, 0.012, 0.07, 6), mat('#4b7a2a', { rough: 0.6 }));
      stem.rotation.z = Math.PI / 2; stem.position.set(-L / 2 - 0.03, 0, 0); m.add(stem);
      m.position.set(x, y + (p.rad || 0.035), z); m.rotation.y = rng() * 6.28;
      g.add(m);
    });
    g.userData.absolute = true; return g;
  };

  // 芝麻、花生碎、粉
  P.sprinkle = function (p, rng, ctx) {
    const n = Math.min(900, p.count || 150);
    const shape = p.shape || 'seed';
    const sz = (p.grain || (shape === 'seed' ? 0.012 : shape === 'nut' ? 0.03 : shape === 'powder' ? 0.006 : 0.018)) * (p.size || 1);
    let geo;
    if (shape === 'seed') { geo = new T.SphereGeometry(sz, 8, 6); geo.scale(1, 0.4, 0.6); }
    else if (shape === 'flake') { geo = new T.CircleGeometry(sz, 5); geo.rotateX(-Math.PI / 2); }
    else if (shape === 'powder') { geo = new T.CircleGeometry(sz, 6); geo.rotateX(-Math.PI / 2); }
    else if (shape === 'kernel') { geo = roundedBox(sz * 1.3, sz, sz * 1.1, sz * 0.3, 3); }
    else { geo = new T.IcosahedronGeometry(sz, 0); }
    const im = new T.InstancedMesh(geo, mat('#ffffff', { rough: 0.6, side: T.DoubleSide }), n);
    im.castShadow = shape !== 'powder';
    const cols = (p.colors && p.colors.length ? p.colors : [p.color || '#f2e6c8']).map((c) => C(safeHex(c, '#f2e6c8')));
    const M = new T.Matrix4(), Q = new T.Quaternion(), E = new T.Euler(), S = new T.Vector3();
    scatterOnSurface(p, rng, ctx, n, (x, y, z, i) => {
      E.set((rng() - 0.5) * 0.6, rng() * 6.28, (rng() - 0.5) * 0.6); Q.setFromEuler(E);
      S.setScalar(0.6 + rng() * 0.8);
      M.compose(V3(x, y + sz * 0.3, z), Q, S); im.setMatrixAt(i, M);
      im.setColorAt(i, cols[Math.floor(rng() * cols.length)].clone().offsetHSL(0, 0, (rng() - 0.5) * 0.08));
    });
    const g = new T.Group(); g.add(im); g.userData.absolute = true; return g;
  };

  // 洋蔥絲、薑絲
  P.slivers = function (p, rng, ctx) {
    const n = Math.min(120, p.count || 20);
    const col = safeHex(p.color, '#b04c8f');
    const geos = [];
    scatterOnSurface(p, rng, ctx, n, (x, y, z) => {
      const L = (p.len || 0.22) * (p.size || 1) * (0.7 + rng() * 0.5);
      const a0 = rng() * 6.28, bend = p.straight ? 0.1 : 0.6 + rng() * 0.8;
      const pts = [];
      for (let i = 0; i <= 5; i++) { const t = i / 5 - 0.5; pts.push(V3(x + Math.cos(a0) * t * L - Math.sin(a0) * Math.cos(t * Math.PI) * L * 0.25 * bend, y + 0.012 + Math.sin((t + 0.5) * Math.PI) * 0.015, z + Math.sin(a0) * t * L + Math.cos(a0) * Math.cos(t * Math.PI) * L * 0.25 * bend)); }
      const geo = p.round ? taperTube(pts, () => p.w || 0.008, 20, 5) : ribbon(pts, p.w || 0.028, 0.008, 20);
      if (geo.attributes.uv) geo.deleteAttribute('uv');
      geos.push(geo);
    });
    const c1 = C(col), c2 = C(safeHex(p.color2, '#f3e3ee'));
    const merged = merge(geos);
    paint(merged, (v) => mix(c1, c2, (Math.sin(v.x * 200 + v.z * 150) + 1) / 2 * (p.color2 ? 0.8 : 0.2)));
    const g = new T.Group();
    g.add(mesh(merged, mat('#fff', { vc: true, rough: 0.3, clearcoat: 0.6, side: T.DoubleSide })));
    g.userData.absolute = true;
    return g;
  };

  // 魚
  P.fish = function (p, rng) {
    const style = p.style || 'whole';
    const s = p.size || 1;
    const col = C(safeHex(p.color, '#8a7d6a')), belly = C(safeHex(p.bellyColor, '#e7e0cf'));
    if (style === 'fillet') {
      const geo = roundedBox(0.8 * s, 0.1 * s, 0.34 * s, 0.04, 8);
      const pp = geo.attributes.position;
      for (let i = 0; i < pp.count; i++) {
        const x = pp.getX(i); const k = 1 - Math.pow(Math.max(0, x / (0.4 * s)), 2) * 0.5;
        pp.setY(i, pp.getY(i) * k + (p.curl || 0) * Math.pow(pp.getZ(i) / (0.17 * s), 2) * 0.1 * s); pp.setZ(i, pp.getZ(i) * k);
      }
      geo.computeVertexNormals();
      const skin = p.skinColor ? C(p.skinColor) : null;
      paint(geo, (v) => {
        if (skin && p.skinSide === 'bottom') { if (v.y < -0.01 * s || Math.abs(v.z) > 0.13 * s) return mix(skin, C('#e8ecef'), fbm(v.x * 25, v.y * 25, v.z * 25) * 0.6); }
        else if (skin && v.y > 0.035 * s) return mix(skin, C('#1c1c1c'), fbm(v.x * 20, 0, v.z * 20) * 0.3);
        return Math.sin(v.x * 45 / s + v.z * 10) > 0.8 ? mix(C(safeHex(p.color, '#f1e7d8')), C('#ffffff'), 0.5) : C(safeHex(p.color, '#f1e7d8'));
      });
      return wrapBase(mesh(geo, mat('#fff', { vc: true, rough: 0.35, clearcoat: 0.6 })));
    }
    let geo = new T.SphereGeometry(0.5, 48, 24);
    const pp = geo.attributes.position;
    for (let i = 0; i < pp.count; i++) {
      let x = pp.getX(i), y = pp.getY(i), z = pp.getZ(i);
      const tail = x < 0 ? 1 + x * 1.3 : 1 - Math.pow(x / 0.5, 2) * 0.35;
      y *= 0.32 * Math.max(0.12, tail); z *= 0.34 * Math.max(0.12, tail) * 1.2;
      pp.setXYZ(i, x * 1.1, y, z);
    }
    geo = weld(geo);
    paint(geo, (v) => {
      let c = mix(belly, col, Math.max(0, Math.min(1, (v.z + 0.06) / 0.14)));
      if (p.scored && Math.sin(v.x * 26) > 0.9 && v.y > 0) c = mix(c, C('#3c2415'), 0.6);
      if (p.fried) c = mix(c, C('#a9651f'), 0.55 + fbm(v.x * 10, v.y * 10, v.z * 10) * 0.3);
      if (p.charred) { if (fbm(v.x * 14, v.y * 14, v.z * 14) > 0.58) c = mix(c, C('#20120a'), 0.7); }
      return c;
    });
    const g = new T.Group();
    const body = mesh(geo, mat('#fff', { vc: true, rough: 0.3, clearcoat: 0.7 }));
    g.add(body);
    const tailShape = new T.Shape();
    tailShape.moveTo(0, 0); tailShape.quadraticCurveTo(-0.12, 0.08, -0.2, 0.17); tailShape.quadraticCurveTo(-0.14, 0, -0.2, -0.17); tailShape.quadraticCurveTo(-0.12, -0.08, 0, 0);
    const finMat = mat(p.fried ? '#8f561c' : '#' + col.getHexString(), { rough: 0.5, side: T.DoubleSide, opacity: 0.92, depthWrite: true });
    const tailM = mesh(new T.ShapeGeometry(tailShape), finMat);
    tailM.rotation.x = -Math.PI / 2; tailM.position.set(-0.52, 0.0, 0); g.add(tailM);
    const dor = new T.Shape(); dor.moveTo(-0.25, 0); dor.quadraticCurveTo(0, 0.12, 0.15, 0); dor.lineTo(-0.25, 0);
    const dm = mesh(new T.ShapeGeometry(dor), finMat); dm.rotation.x = -Math.PI / 2; dm.position.set(0, 0.0, -0.16); g.add(dm);
    const eye = mesh(new T.SphereGeometry(0.028, 12, 8), mat('#f1eee5', { rough: 0.1, clearcoat: 1 }));
    eye.position.set(0.38, 0.07, -0.02); g.add(eye);
    const pupil = mesh(new T.SphereGeometry(0.016, 10, 8), mat('#101010', { rough: 0.1, clearcoat: 1 }));
    pupil.position.set(0.385, 0.088, -0.02); g.add(pupil);
    g.scale.setScalar(s * 1.6);
    return wrapBase(g);
  };

  // 捲（春捲、生春捲、壽司、墨西哥捲）
  P.roll = function (p, rng) {
    const style = p.style || 'spring';
    const L = (p.len || 0.55) * (p.size || 1), r = (p.rad || 0.1) * (p.size || 1);
    const g = new T.Group();
    if (style === 'sushi' || style === 'gimbap' || style === 'cut') {
      const outer = safeHex(p.color, '#1f2a1d');
      const rings = [{ color: safeHex(p.riceColor, '#f7f4ec'), r: 0.9, grain: true, bits: p.filling || ['#f07a4d', '#4f8f35', '#f5cf5e'] }];
      const tex = crossSectionTex(outer, rings);
      const h = (p.h || 0.12) * (p.size || 1);
      const sideMat = mat(outer, { rough: 0.6 });
      const capMat = mat('#fff', { map: tex, rough: 0.7 });
      const geo = new T.CylinderGeometry(r, r, h, 40);
      const m = mesh(geo, [sideMat, capMat, capMat]);
      g.add(m);
      return wrapBase(g);
    }
    const col = C(safeHex(p.color, style === 'fresh' ? '#f2efe6' : '#d59a45'));
    const pts = [V3(-L / 2, 0, 0), V3(0, 0, 0), V3(L / 2, 0, 0)];
    const geo = taperTube(pts, (t) => r * Math.pow(Math.sin(Math.min(1, Math.max(0.0001, t)) * Math.PI), 0.12), 40, 24);
    if (style === 'spring') lumpy(geo, 0.012, 25, rng() * 10);
    if (style === 'fresh') {
      const fills = p.filling || ['#f07a4d', '#4f8f35', '#f3eee0'];
      fills.forEach((fc, i) => {
        const a = (i / fills.length) * Math.PI * 2;
        const ig = taperTube([V3(-L * 0.45, Math.sin(a) * r * 0.45, Math.cos(a) * r * 0.45), V3(L * 0.45, Math.sin(a) * r * 0.45, Math.cos(a) * r * 0.45)], (t) => r * 0.45 * Math.pow(Math.sin(Math.min(1, Math.max(0.0001, t)) * Math.PI), 0.3), 16, 10);
        g.add(mesh(ig, mat(safeHex(fc, '#4f8f35'), { rough: 0.5 })));
      });
      g.add(mesh(geo, mat('#' + col.getHexString(), { rough: 0.15, clearcoat: 1, opacity: 0.55 })));
      return wrapBase(g);
    }
    paint(geo, (v) => mix(col, col.clone().offsetHSL(0, 0, -0.15), fbm(v.x * 12, v.y * 12, v.z * 12) * (style === 'spring' ? 1.2 : 0.5)));
    g.add(mesh(geo, mat('#fff', { vc: true, rough: style === 'spring' ? 0.55 : 0.7, clearcoat: style === 'spring' ? 0.3 : 0 })));
    return wrapBase(g);
  };

  // 蛋糕與層疊甜點
  P.cake = function (p, rng) {
    const style = p.style || 'wedge';
    const layers = p.layers && p.layers.length ? p.layers : [{ color: '#f3d9a0', h: 0.12 }, { color: '#fff6e6', h: 0.05 }, { color: '#f3d9a0', h: 0.12 }];
    const R = (p.r || 0.55) * (p.size || 1);
    const g = new T.Group();
    let y = 0;
    layers.forEach((L, i) => {
      const h = (L.h || 0.1) * (p.size || 1);
      let geo;
      if (style === 'wedge') {
        const sh = new T.Shape(); sh.moveTo(0, 0); sh.absarc(0, 0, R, -0.35, 0.35, false); sh.lineTo(0, 0);
        geo = new T.ExtrudeGeometry(sh, { depth: h, bevelEnabled: false, curveSegments: 16 });
        geo.rotateX(-Math.PI / 2);
      } else if (style === 'block') {
        geo = roundedBox((p.w || 0.7) * (p.size || 1), h, (p.d || 0.45) * (p.size || 1), Math.min(0.02, h * 0.3), 3); geo.translate(0, h / 2, 0);
      } else {
        geo = new T.CylinderGeometry(R, R, h, 64); geo.translate(0, h / 2, 0);
      }
      const m = mesh(geo, mat(safeHex(L.color, '#f3d9a0'), { rough: L.gloss ? 0.2 : 0.7, clearcoat: L.gloss ? 1 : 0 }));
      m.position.y = y; g.add(m);
      y += h;
    });
    if (p.dust) {
      const d = mesh(new T.CircleGeometry(style === 'wedge' ? R * 0.2 : R * 0.95, 32), mat(safeHex(p.dust, '#5a3a22'), { rough: 0.95 }), false);
      d.rotation.x = -Math.PI / 2; d.position.y = y + 0.002; if (style === 'wedge') d.position.x = R * 0.5; g.add(d);
    }
    return wrapBase(g);
  };

  // 刨冰
  P.shavedIce = function (p, rng) {
    const R = (p.r || 0.6) * (p.size || 1), H = (p.h || 0.6) * (p.size || 1);
    const pts = [];
    for (let i = 0; i <= 24; i++) { const t = i / 24; pts.push(V2(R * Math.sin((1 - t) * Math.PI / 2) + 0.0001, H * Math.pow(t, 0.8))); }
    let geo = new T.LatheGeometry(pts, 64);
    geo = weld(geo);
    lumpy(geo, 0.03, 12, rng() * 10, V3(0, 0, 0), 4);
    const base = C(safeHex(p.color, '#f7f5ef')), syrup = p.syrup ? C(p.syrup) : null;
    paint(geo, (v) => {
      let c = base.clone().offsetHSL(0, 0, (fbm(v.x * 30, v.y * 30, v.z * 30) - 0.5) * 0.08);
      if (syrup && fbm(v.x * 3 + 5, v.y * 3, v.z * 3) > 0.48 && v.y > H * 0.25) c = mix(c, syrup, 0.85);
      return c;
    });
    return wrapBase(mesh(geo, mat('#fff', { vc: true, rough: 0.55, sheen: 0.8, sheenColor: '#ffffff' })));
  };

  // 生蠔／蚵仔
  P.oyster = function (p, rng) {
    const s = (p.size || 1) * 0.09 * (0.8 + rng() * 0.4);
    let geo = new T.SphereGeometry(1, 24, 14);
    geo.scale(s * 1.3, s * 0.45, s);
    geo = weld(geo);
    lumpy(geo, s * 0.25, 2 / s * 0.1, rng() * 20);
    const body = C(safeHex(p.color, '#d8cbb3')), edge = C(safeHex(p.edgeColor, '#4a4540'));
    paint(geo, (v) => { const d = Math.hypot(v.x / (s * 1.3), v.z / s); return d > 0.75 ? mix(body, edge, (d - 0.75) * 3) : body.clone().offsetHSL(0, 0, (fbm(v.x / s * 3, 0, v.z / s * 3) - 0.5) * 0.15); });
    return wrapBase(mesh(geo, mat('#fff', { vc: true, rough: 0.15, clearcoat: 1 })));
  };

  // 菇類
  P.mushroom = function (p, rng) {
    const style = p.style || 'shiitake';
    const s = (p.size || 1);
    const g = new T.Group();
    if (style === 'enoki') {
      for (let i = 0; i < 14; i++) {
        const L = 0.35 * s;
        const pts = [V3(0, 0, 0), V3((rng() - 0.5) * 0.08, L * 0.5, 0), V3((rng() - 0.5) * 0.12, L, (rng() - 0.5) * 0.1)];
        const st = mesh(taperTube(pts, () => 0.008 * s, 12, 5), mat('#f4efdc', { rough: 0.5 }));
        const cap = mesh(new T.SphereGeometry(0.018 * s, 10, 6), mat('#efe6c8', { rough: 0.5 }));
        cap.position.copy(pts[2]); st.add(cap);
        st.position.set((rng() - 0.5) * 0.06, 0, (rng() - 0.5) * 0.06);
        g.add(st);
      }
      g.rotation.z = Math.PI / 2;
      return wrapBase(g);
    }
    let cap = new T.SphereGeometry(0.2 * s, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2);
    cap.scale(1, 0.55, 1);
    const cc = C(safeHex(p.color, '#6b4428'));
    paint(cap, (v) => { const a = Math.atan2(v.z, v.x); const star = style === 'shiitake' && Math.min(Math.abs(Math.sin(a * 3)), 1) < 0.08 && Math.hypot(v.x, v.z) < 0.14 * s; return star ? C('#efe2c8') : mix(cc, cc.clone().offsetHSL(0, 0, 0.1), Math.hypot(v.x, v.z) / (0.2 * s)); });
    const cm = mesh(cap, mat('#fff', { vc: true, rough: 0.5, clearcoat: 0.4 }));
    cm.position.y = 0.06 * s;
    const under = mesh(new T.CircleGeometry(0.2 * s, 32), mat('#e7dcc4', { rough: 0.8, side: T.DoubleSide }));
    under.rotation.x = Math.PI / 2; under.position.y = 0.06 * s;
    const stem = mesh(new T.CylinderGeometry(0.04 * s, 0.05 * s, 0.08 * s, 12), mat('#e7dcc4', { rough: 0.8 }));
    stem.position.y = 0.03 * s;
    g.add(cm, under, stem);
    if (p.lying !== false) g.rotation.z = 1.2 + rng() * 0.4;
    return wrapBase(g);
  };

  // 切片（黃瓜、番茄、檸檬、玉米、地瓜）
  P.rounds = function (p, rng) {
    const r = (p.rad || 0.12) * (p.size || 1), t = (p.t || 0.03) * (p.size || 1);
    const pattern = p.pattern || 'plain';
    const col = safeHex(p.color, '#8fc26a'), rim = safeHex(p.rimColor, '#2f6b22');
    const tex = slicePatternTex(pattern, col, rim);
    const geo = new T.CylinderGeometry(r, r, t, 32);
    const side = mat(rim, { rough: 0.4 });
    const cap = mat('#fff', { map: tex, rough: 0.35, clearcoat: 0.5 });
    const m = mesh(geo, [side, cap, cap]);
    m.rotation.set((rng() - 0.5) * 0.2, rng() * 6, (rng() - 0.5) * 0.2);
    return wrapBase(m);
  };

  // 柑橘角
  P.wedge = function (p, rng) {
    const r = (p.rad || 0.13) * (p.size || 1);
    const col = safeHex(p.color, '#9bc53d'), flesh = safeHex(p.flesh, '#d9ec7a');
    const g = new T.Group();
    const skin = mesh(new T.SphereGeometry(r, 24, 16, 0, Math.PI / 2.4), mat(col, { rough: 0.45, clearcoat: 0.5 }));
    g.add(skin);
    const ftex = slicePatternTex('citrus', flesh, col);
    for (const ang of [0, Math.PI / 2.4]) {
      const f = mesh(new T.CircleGeometry(r * 0.98, 24, 0, Math.PI), mat('#fff', { map: ftex, rough: 0.3, clearcoat: 0.8, side: T.DoubleSide }));
      f.rotation.y = -ang; f.rotation.z = Math.PI / 2;
      g.add(f);
    }
    g.rotation.set(Math.PI / 2 * (0.9 + rng() * 0.2), 0, rng() * 6);
    return wrapBase(g);
  };

  // 塔可、刈包形夾餅
  P.taco = function (p, rng) {
    const s = p.size || 1;
    const col = C(safeHex(p.color, '#e6c27a'));
    let geo = new T.SphereGeometry(0.5, 40, 20);
    geo.scale(0.72 * s, 0.03 * s, 0.9 * s);
    geo = weld(geo);
    const seed = rng() * 10;
    paint(geo, (v) => (fbm(v.x * 10 + seed, 0, v.z * 10) > 0.63 ? mix(col, C('#6d4518'), 0.6) : col));
    foldU(geo, 0.45 * s, Math.PI * (p.open ?? 0.7));
    const g = new T.Group();
    g.add(mesh(geo, mat('#fff', { vc: true, rough: 0.7, side: T.DoubleSide })));
    const fills = p.filling || ['#9a3d18', '#ffffff', '#3f8f2e'];
    fills.forEach((fc, i) => {
      for (let k = 0; k < 7; k++) {
        const piece = P.chunk({ color: fc, s: 0.07 * s, tumble: 3 }, rng);
        piece.position.set((rng() - 0.5) * 0.5 * s, 0.14 * s + i * 0.035 * s + rng() * 0.03, (rng() - 0.5) * 0.12 * s);
        g.add(piece);
      }
    });
    return wrapBase(g);
  };

  // 葉包（粽子、竹葉包、玉米葉）
  P.parcel = function (p, rng) {
    const style = p.style || 'box';
    const s = p.size || 1;
    const col = C(safeHex(p.color, '#5a7d2a'));
    let geo;
    if (style === 'pyramid') { geo = new T.ConeGeometry(0.3 * s, 0.34 * s, 3, 4); geo = weld(geo); lumpy(geo, 0.012, 8, 2); }
    else if (style === 'cylinder') { geo = roundedBox(0.8 * s, 0.18 * s, 0.22 * s, 0.07 * s, 6); }
    else { geo = roundedBox(0.55 * s, 0.16 * s, 0.4 * s, 0.05, 6); }
    paint(geo, (v) => (Math.sin((v.x * 0.3 + v.z) * 70) > 0.5 ? col.clone().offsetHSL(0, 0, 0.06) : col));
    const g = new T.Group();
    g.add(mesh(geo, mat('#fff', { vc: true, rough: 0.5, clearcoat: 0.3 })));
    if (p.tie !== false) {
      const b = new T.Box3().setFromBufferAttribute(geo.attributes.position);
      const tieR = Math.max(b.max.x, b.max.z) * (style === 'pyramid' ? 0.6 : 1.02);
      const tie = mesh(new T.TorusGeometry(tieR, 0.008, 6, 40), mat(safeHex(p.tieColor, '#c9b28a'), { rough: 0.9 }));
      tie.rotation.x = style === 'pyramid' ? Math.PI / 2 : 0;
      tie.scale.set(1, style === 'pyramid' ? 1 : (b.max.y - b.min.y) / (2 * tieR) + 0.1, style === 'pyramid' ? 1 : 1);
      if (style === 'pyramid') tie.position.y = b.min.y + (b.max.y - b.min.y) * 0.35;
      g.add(tie);
    }
    return wrapBase(g);
  };

  // 酥皮類
  P.pastry = function (p, rng) {
    const style = p.style || 'tart';
    const s = p.size || 1;
    const col = C(safeHex(p.color, '#d99c4b'));
    const g = new T.Group();
    if (style === 'tart') {
      const pts = [];
      const R = 0.3 * s, H = 0.12 * s;
      pts.push(V2(0.0001, 0)); pts.push(V2(R * 0.95, 0.0)); pts.push(V2(R, H)); pts.push(V2(R * 0.92, H)); pts.push(V2(R * 0.8, 0.02)); pts.push(V2(0.0001, 0.02));
      let shell = new T.LatheGeometry(pts, 96);
      const pp = shell.attributes.position;
      for (let i = 0; i < pp.count; i++) { const x = pp.getX(i), z = pp.getZ(i), a = Math.atan2(z, x), r = Math.hypot(x, z); if (r > R * 0.85) { const k = 1 + Math.sin(a * 24) * 0.03; pp.setX(i, x * k); pp.setZ(i, z * k); } }
      shell.computeVertexNormals();
      g.add(mesh(shell, mat('#' + col.getHexString(), { rough: 0.6 })));
      const fill = disc(R * 0.86, 10, 64);
      const fp = fill.attributes.position;
      for (let i = 0; i < fp.count; i++) { const d = Math.hypot(fp.getX(i), fp.getZ(i)) / (R * 0.86); fp.setY(i, H * 0.85 + 0.015 * (1 - d * d)); }
      fill.computeVertexNormals();
      const fc = C(safeHex(p.fillColor, '#f4c542')), burn = C(safeHex(p.burnColor, '#5a2e0e'));
      paint(fill, (v) => { const n = fbm(v.x * 12, 0, v.z * 12); return p.burnt && n > 0.6 ? mix(fc, burn, (n - 0.6) * 3) : fc; });
      g.add(mesh(fill, mat('#fff', { vc: true, rough: 0.3, clearcoat: 0.8 })));
      return wrapBase(g);
    }
    if (style === 'croissant') {
      for (let i = -3; i <= 3; i++) {
        const t = i / 3;
        let seg = new T.SphereGeometry(0.1 * s * (1 - Math.abs(t) * 0.55), 20, 12);
        seg.scale(0.9, 0.85, 1.25);
        const a = t * 1.1;
        const m = mesh(seg, mat('#' + col.clone().offsetHSL(0, 0, -Math.abs(t) * 0.08).getHexString(), { rough: 0.5, clearcoat: 0.3 }));
        m.position.set(Math.sin(a) * 0.3 * s, 0, -Math.cos(a) * 0.3 * s + 0.3 * s); m.rotation.y = -a;
        g.add(m);
      }
      return wrapBase(g);
    }
    if (style === 'samosa') {
      let geo = new T.ConeGeometry(0.25 * s, 0.3 * s, 3, 4); geo = weld(geo);
      lumpy(geo, 0.02, 7, 3);
      geo.rotateX(Math.PI / 2);
      paint(geo, (v) => mix(col, col.clone().offsetHSL(0, 0, -0.12), fbm(v.x * 14, v.y * 14, v.z * 14) * 1.3));
      g.add(mesh(geo, mat('#fff', { vc: true, rough: 0.6 })));
      return wrapBase(g);
    }
    if (style === 'empanada') {
      let geo = new T.SphereGeometry(0.5, 40, 20, 0, Math.PI);
      geo.scale(0.5 * s, 0.14 * s, 0.4 * s);
      geo = weld(geo);
      paint(geo, (v) => { let c = mix(col, col.clone().offsetHSL(0, 0, -0.1), fbm(v.x * 10, v.y * 10, v.z * 10)); if (Math.abs(v.z) < 0.03 * s && Math.sin(Math.atan2(v.y, v.x) * 30) > 0.5) c = mix(c, C('#8a5a24'), 0.5); return c; });
      geo.rotateX(Math.PI / 2);
      g.add(mesh(geo, mat('#fff', { vc: true, rough: 0.55, clearcoat: 0.3 })));
      return wrapBase(g);
    }
    // puff / 泡芙、puri
    let geo = new T.IcosahedronGeometry(0.2 * s, 4);
    geo = weld(geo);
    geo.scale(1, p.hScale || 0.75, 1);
    lumpy(geo, 0.03 * s, 5, rng() * 10);
    paint(geo, (v) => mix(col, col.clone().offsetHSL(0, 0, -0.1), fbm(v.x * 10, v.y * 10, v.z * 10)));
    const m = mesh(geo, mat('#fff', { vc: true, rough: 0.55 }));
    g.add(m);
    if (p.hole) {
      const hole = mesh(new T.CircleGeometry(0.06 * s, 16), mat(safeHex(p.hole, '#3a2412'), { rough: 0.9 }));
      hole.rotation.x = -Math.PI / 2; hole.position.y = 0.2 * s * (p.hScale || 0.75) + 0.002;
      g.add(hole);
    }
    return wrapBase(g);
  };

  // 雞腿、骨頭肉
  P.drumstick = function (p, rng) {
    const s = p.size || 1;
    const g = new T.Group();
    let geo = new T.SphereGeometry(0.5, 32, 20);
    geo.scale(0.36 * s, 0.22 * s, 0.24 * s);
    const pp = geo.attributes.position;
    for (let i = 0; i < pp.count; i++) { const x = pp.getX(i); const k = x < 0 ? 1 + x / (0.18 * s) * 0.45 : 1; pp.setY(i, pp.getY(i) * k); pp.setZ(i, pp.getZ(i) * k); }
    geo = weld(geo);
    lumpy(geo, 0.02 * s, 8, rng() * 10);
    const col = C(safeHex(p.color, '#b0662a'));
    paint(geo, (v) => mix(col, col.clone().offsetHSL(0, 0, -0.15), fbm(v.x * 10, v.y * 10, v.z * 10) * 1.2));
    g.add(mesh(geo, mat('#fff', { vc: true, rough: p.crispy ? 0.7 : 0.3, clearcoat: p.crispy ? 0 : 0.8 })));
    const bone = mesh(new T.CylinderGeometry(0.022 * s, 0.022 * s, 0.22 * s, 10), mat('#efe6d6', { rough: 0.5 }));
    bone.rotation.z = Math.PI / 2; bone.position.x = -0.26 * s; g.add(bone);
    const knob = mesh(new T.SphereGeometry(0.035 * s, 12, 8), mat('#efe6d6', { rough: 0.5 }));
    knob.position.x = -0.37 * s; g.add(knob);
    return wrapBase(g);
  };

  // 玉米
  P.corn = function (p, rng) {
    const style = p.style || 'cob';
    const s = p.size || 1;
    const col = C(safeHex(p.color, '#f2c649'));
    const L = style === 'round' ? 0.1 * s : 0.6 * s, r = 0.1 * s;
    const g = new T.Group();
    const core = mesh(new T.CylinderGeometry(r * 0.7, r * 0.7, L, 16), mat('#e9d9a8', { rough: 0.8 }));
    core.rotation.z = Math.PI / 2; g.add(core);
    const kg = roundedBox(0.03 * s, 0.028 * s, 0.03 * s, 0.009 * s, 2);
    const rows = 14, per = Math.max(3, Math.round(L / (0.032 * s)));
    const im = new T.InstancedMesh(kg, mat('#ffffff', { rough: 0.3, clearcoat: 0.6 }), rows * per);
    const M = new T.Matrix4(), Q = new T.Quaternion();
    let k = 0;
    for (let i = 0; i < per; i++) for (let j = 0; j < rows; j++) {
      const a = (j / rows) * Math.PI * 2 + (i % 2) * 0.2;
      Q.setFromEuler(new T.Euler(a, 0, 0));
      M.compose(V3(-L / 2 + (i + 0.5) * (L / per), Math.cos(a) * r * 0.85, Math.sin(a) * r * 0.85), Q, V3(1, 1, 1));
      im.setMatrixAt(k, M); im.setColorAt(k, col.clone().offsetHSL(0, 0, (rng() - 0.5) * 0.08)); k++;
    }
    im.castShadow = true; g.add(im);
    if (style === 'round') g.rotation.z = Math.PI / 2;
    return wrapBase(g);
  };

  // 螃蟹（醬蟹、辣醬蟹）
  P.crab = function (p, rng) {
    const style = p.style || 'shell';
    const s = p.size || 1;
    const shellCol = C(safeHex(p.color, '#5a4a2e')), edgeCol = C(safeHex(p.edgeColor, '#b5652a'));
    const roe = C(safeHex(p.roeColor, '#e98a24')), green = C(safeHex(p.tomalley, '#6b6a2a'));
    const g = new T.Group();
    const legMat = mat(safeHex(p.legColor, '#6b4a30'), { rough: 0.3, clearcoat: 0.8 });
    const leg = (x, z, ang, len, thick) => {
      const pts = [];
      for (let i = 0; i <= 3; i++) { const t = i / 3; pts.push(V3(x + Math.cos(ang) * len * t, 0.03 + Math.sin(t * Math.PI) * 0.06 * s, z + Math.sin(ang) * len * t + (i === 2 ? 0.03 : 0))); }
      const lg = mesh(taperTube(pts, (t) => thick * (1 - t * 0.55) * (1 + 0.25 * Math.sin(t * Math.PI * 3)), 24, 8), legMat);
      return lg;
    };
    if (style === 'shell') {
      let geo = new T.SphereGeometry(0.5, 40, 18, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
      const asp = p.aspect || [1.1, 0.78];
      geo.scale(asp[0] * s, 0.34 * s, asp[1] * s);
      const pp = geo.attributes.position;
      for (let i = 0; i < pp.count; i++) {
        const x = pp.getX(i), z = pp.getZ(i); const a = Math.atan2(z, x);
        if (p.spines !== false) pp.setX(i, x * (1 + 0.35 * Math.pow(Math.abs(Math.cos(a)), 12)));
        if (p.taper) pp.setZ(i, z * (1 - p.taper * (x / (asp[0] * s * 0.5) + 1) / 2));
      }
      geo.computeVertexNormals();
      paint(geo, (v) => mix(shellCol, edgeCol, Math.max(0, Math.min(1, (v.y + 0.12 * s) / (0.12 * s))) * 0.8));
      const shell = mesh(geo, mat('#fff', { vc: true, rough: 0.3, clearcoat: 0.9, side: T.DoubleSide }));
      g.add(shell);
      const fill = disc(0.5 * s * 0.98, 10, 48);
      fill.scale(asp[0] * 0.98, 1, asp[1] * 0.97);
      if (p.taper) { const fq = fill.attributes.position; for (let i = 0; i < fq.count; i++) { const x = fq.getX(i); fq.setZ(i, fq.getZ(i) * (1 - p.taper * (x / (asp[0] * s * 0.5) + 1) / 2)); } }
      const fp = fill.attributes.position;
      for (let i = 0; i < fp.count; i++) { const x = fp.getX(i), z = fp.getZ(i); fp.setY(i, -0.035 * s + (fbm(x * 8, 0, z * 8) - 0.5) * 0.03); }
      fill.computeVertexNormals();
      paint(fill, (v) => { const n = fbm(v.x * 6 + 2, 0, v.z * 6); return n > 0.58 ? mix(roe, green, (n - 0.58) * 4) : roe.clone().offsetHSL(0, 0, (n - 0.5) * 0.2); });
      const fm = mesh(fill, mat('#fff', { vc: true, rough: 0.2, clearcoat: 1 }));
      g.add(fm);
      return wrapBase(g);
    }
    if (style === 'body') {
      let body = roundedBox(0.34 * s, 0.14 * s, 0.26 * s, 0.05 * s, 5);
      lumpy(body, 0.01, 8, rng() * 10);
      const meat = C(safeHex(p.meatColor, '#efe6d6'));
      paint(body, (v) => (v.y > 0.03 * s ? mix(roe, green, fbm(v.x * 20, 0, v.z * 20) > 0.6 ? 0.5 : 0) : Math.sin(v.x * 70) > 0.3 ? meat : mix(meat, shellCol, 0.35)));
      g.add(mesh(body, mat('#fff', { vc: true, rough: 0.2, clearcoat: 1 })));
      for (let i = 0; i < 3; i++) g.add(leg(0.12 * s, -0.08 * s + i * 0.08 * s, -0.35 + i * 0.35, 0.34 * s, 0.045 * s));
      return wrapBase(g);
    }
    // whole：殼朝上加腳與螯
    let geo = new T.SphereGeometry(0.5, 40, 18, 0, Math.PI * 2, 0, Math.PI / 2);
    geo.scale(1.1 * s, 0.3 * s, 0.78 * s);
    const pp = geo.attributes.position;
    for (let i = 0; i < pp.count; i++) { const x = pp.getX(i), z = pp.getZ(i); const a = Math.atan2(z, x); pp.setX(i, x * (1 + 0.35 * Math.pow(Math.abs(Math.cos(a)), 12))); }
    geo.computeVertexNormals();
    lumpy(geo, 0.01, 10, 3);
    paint(geo, (v) => mix(shellCol, edgeCol, fbm(v.x * 6, v.y * 6, v.z * 6) * 0.6));
    g.add(mesh(geo, mat('#fff', { vc: true, rough: 0.3, clearcoat: 0.9 })));
    for (const sx of [-1, 1]) for (let i = 0; i < 4; i++) g.add(leg(sx * 0.2 * s, -0.1 * s + i * 0.08 * s, sx > 0 ? -0.5 + i * 0.12 : Math.PI + 0.5 - i * 0.12, 0.5 * s, 0.03 * s));
    for (const sx of [-1, 1]) { const cl = mesh(new T.SphereGeometry(0.08 * s, 16, 10), legMat); cl.scale.set(1.6, 0.8, 1); cl.position.set(sx * 0.3 * s, 0.05, 0.42 * s); g.add(cl); }
    return wrapBase(g);
  };

  // 帶骨腱肉橫切（燉小牛膝等）
  P.shank = function (p, rng) {
    const s = p.size || 1;
    const R = 0.34 * s, H = 0.16 * s;
    const g = new T.Group();
    let geo = new T.CylinderGeometry(R, R * 1.05, H, 40, 4);
    geo = weld(geo);
    lumpy(geo, 0.03 * s, 5, rng() * 10);
    const col = C(safeHex(p.color, '#7a3e1e')), col2 = C(safeHex(p.color2, '#4a2210'));
    paint(geo, (v) => mix(col, col2, fbm(v.x * 9, v.y * 9, v.z * 9) * 1.2));
    g.add(mesh(geo, mat('#fff', { vc: true, rough: 0.35, clearcoat: 0.8 })));
    const bone = mesh(new T.CylinderGeometry(0.09 * s, 0.09 * s, H * 1.1, 24, 1, true), mat('#efe4cc', { rough: 0.5, side: T.DoubleSide }));
    g.add(bone);
    const marrow = mesh(new T.CircleGeometry(0.075 * s, 24), mat(safeHex(p.marrow, '#d9b48a'), { rough: 0.3, clearcoat: 0.8 }));
    marrow.rotation.x = -Math.PI / 2; marrow.position.y = H * 0.52; g.add(marrow);
    return wrapBase(g);
  };

  // 長蔥、韭蔥（烤加泰隆尼亞大蔥等）
  P.leek = function (p, rng) {
    const s = p.size || 1;
    const L = (p.len || 1.5) * s, r = (p.rad || 0.045) * s;
    const g = new T.Group();
    const pts = [];
    for (let i = 0; i <= 8; i++) { const t = i / 8; pts.push(V3(t * L - L / 2, Math.sin(t * Math.PI) * 0.02, Math.sin(t * 3 + rng() * 2) * 0.03)); }
    const geo = taperTube(pts, (t) => r * (t < 0.08 ? 0.6 + t * 5 : 1 - t * 0.35), 60, 12);
    const white = C(safeHex(p.color, '#f2efe0')), green = C(safeHex(p.color2, '#4f8a2e')), charC = C(safeHex(p.charColor, '#1a1612'));
    const charAmt = p.char ?? 0.7;
    paint(geo, (v) => {
      const t = (v.x + L / 2) / L;
      let c = mix(white, green, Math.max(0, Math.min(1, (t - 0.5) * 3)));
      if (fbm(v.x * 8, v.y * 30, v.z * 30) > 0.55 - charAmt * 0.3) c = mix(c, charC, charAmt);
      return c;
    });
    g.add(mesh(geo, mat('#fff', { vc: true, rough: 0.7 })));
    for (let k = 0; k < 3; k++) {
      const a = (k - 1) * 0.25;
      const lp = [V3(L / 2 - 0.02, 0.01, 0), V3(L / 2 + 0.2 * s, 0.03, Math.sin(a) * 0.12), V3(L / 2 + 0.45 * s, 0.02, Math.sin(a) * 0.3)];
      const lg = taperTube(lp, (t) => r * 0.5 * (1 - t * 0.7), 16, 6);
      paint(lg, () => (rng() > 0.5 ? mix(green, charC, 0.4) : green));
      g.add(mesh(lg, mat('#fff', { vc: true, rough: 0.6 })));
    }
    return wrapBase(g);
  };

  // 疊起來的空碗（船麵吃完疊碗）
  P.bowlStack = function (p) {
    const g = new T.Group();
    const n = Math.min(12, p.n || 4);
    for (let i = 0; i < n; i++) {
      const b = VESSELS.bowl({ color: p.color, rimColor: p.rimColor, pattern: p.pattern, size: 1 });
      b.obj.position.y = i * 0.14;
      b.obj.rotation.y = i * 0.7;
      g.add(b.obj);
    }
    g.scale.setScalar((p.size || 1) * 0.42);
    return wrapBase(g);
  };

  // 糯米腸（剖開成溝，可夾香腸）
  P.riceSausage = function (p, rng) {
    const s = p.size || 1;
    const L = (p.len || 1.2) * s, r = (p.rad || 0.17) * s;
    const open = p.split === false ? 0 : (p.open ?? 1.15);
    const tub = 72, rad = 56;
    const skin = C(safeHex(p.color, '#e6ddcb')), grill = C(safeHex(p.grillColor, '#7a4a24')), rice = C(safeHex(p.riceColor, '#f4efe2'));
    const peanut = C('#c9a070'), shallot = C('#8a5a2e');
    const pos = [], cols = [], idx = [];
    const seed = rng() * 50;
    for (let i = 0; i <= tub; i++) {
      const t = i / tub, x = (t - 0.5) * L;
      const endK = Math.pow(Math.sin(Math.max(0.0001, Math.min(1, t)) * Math.PI), 0.3);
      const rr = r * endK * (1 + 0.03 * Math.sin(t * 50));
      const gk = Math.min(1, Math.max(0, (Math.min(t, 1 - t) - 0.05) / 0.08)); // 兩端收口
      for (let j = 0; j <= rad; j++) {
        const phi = -Math.PI + (2 * Math.PI * j) / rad;
        let y = rr * Math.cos(phi), z = rr * Math.sin(phi) * 1.08;
        let groove = false;
        if (open > 0 && Math.abs(phi) < open) {
          const u = Math.abs(phi) / open;
          const lipZ = rr * Math.sin(open) * 1.25, lipY = rr * Math.cos(open) + rr * 0.08;
          const botY = -rr * 0.2;
          const gz = Math.sign(phi) * lipZ * Math.pow(u, 0.65), gy = botY + (lipY - botY) * u * u;
          y = y + (gy - y) * gk; z = z + (gz - z) * gk;
          groove = gk > 0.5;
        }
        pos.push(x, y, z);
        let c;
        if (groove) {
          const n = hash3(Math.round(x * 90 + seed), Math.round(y * 90), Math.round(z * 90));
          c = rice.clone().offsetHSL(0, 0, (n - 0.5) * 0.08);
          if (n > 0.93) c = peanut.clone(); else if (n < 0.05) c = shallot.clone();
        } else {
          c = skin.clone().offsetHSL(0, 0, (fbm(x * 20 + seed, y * 20, z * 20) - 0.5) * 0.1);
          if (y > -rr * 0.3 && Math.sin(x * 22 + z * 6) > 0.8) c = mix(c, grill, 0.75);
          if (fbm(x * 9 + seed, y * 9, z * 9) > 0.63) c = mix(c, grill, 0.45);
        }
        cols.push(c.r, c.g, c.b);
      }
    }
    for (let i = 0; i < tub; i++) for (let j = 0; j < rad; j++) {
      const a = i * (rad + 1) + j, b = (i + 1) * (rad + 1) + j;
      idx.push(a, a + 1, b, b, a + 1, b + 1);
    }
    const geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new T.Float32BufferAttribute(cols, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const m = mesh(geo, mat('#fff', { vc: true, rough: 0.45, clearcoat: 0.35, side: T.DoubleSide }));
    return wrapBase(m);
  };

  // 小配盤（放在主器皿旁，後面的零件會疊在它上面）
  P.sidePlate = function (p) {
    const v = VESSELS[p.vessel === 'dish' ? 'dish' : 'plate']({ color: p.color || '#f3f0e8', rimColor: p.rimColor, pattern: p.pattern, size: 1 });
    v.obj.scale.set((p.size || 1) * 0.45 * (p.oval || 1), (p.size || 1) * 0.45, (p.size || 1) * 0.45);
    return wrapBase(v.obj);
  };

  // 竹籤
  P.stick = function (p) {
    const L = (p.len || 1.0) * (p.size || 1);
    const m = mesh(new T.CylinderGeometry(p.thick || 0.014, (p.thick || 0.014) * 0.7, L, 8), mat(safeHex(p.color, '#d9bb86'), { rough: 0.8 }));
    m.rotation.z = Math.PI / 2;
    return wrapBase(m);
  };

  // 通用：不規則團塊（給 AI 當萬用零件）
  P.blob = function (p, rng) {
    const sz = p.dims || [0.3, 0.2, 0.3];
    let geo = new T.IcosahedronGeometry(0.5, 4);
    geo = weld(geo);
    geo.scale(sz[0] * (p.size || 1), sz[1] * (p.size || 1), sz[2] * (p.size || 1));
    lumpy(geo, Math.min(...sz) * (p.noise ?? 0.15), 3 / Math.max(0.05, Math.min(...sz)), rng() * 30);
    const col = C(safeHex(p.color, '#b07a4a')), col2 = p.color2 ? C(p.color2) : col.clone().offsetHSL(0, 0, -0.1);
    paint(geo, (v) => mix(col, col2, fbm(v.x * 8, v.y * 8, v.z * 8) * 1.2 - 0.1));
    return wrapBase(mesh(geo, mat('#fff', { vc: true, rough: p.glossy ? 0.2 : 0.6, clearcoat: p.glossy ? 1 : 0 })));
  };

  // 小碗（醬料碟、小菜）
  P.sideBowl = function (p, rng, ctx) {
    const s = (p.size || 1) * 0.36;
    const kind = p.vessel || 'bowl';
    const v = kind === 'steel' ? { obj: null } : null;
    let vessel;
    if (kind === 'steel') {
      const L = latheVessel((t) => 0.95 * (0.85 + 0.15 * t), { h: 0.5, th: 0.02, foot: 0.01 });
      vessel = Object.assign(L, { obj: mesh(L.geo, mat('#c9cdd2', { metal: 1, rough: 0.22 })) });
    } else {
      vessel = VESSELS[kind === 'dish' ? 'dish' : kind === 'clay' ? 'claycup' : 'bowl']({ color: p.bowlColor, rimColor: p.rimColor, pattern: p.pattern });
    }
    const g = new T.Group();
    g.add(vessel.obj);
    const fillY = vessel.floorY + (vessel.rimY - vessel.floorY) * (p.fill ?? 0.72);
    const r = vessel.radiusAt(fillY) - 0.01;
    const fg = disc(r, 8, 48);
    if (p.thick !== false) { const fp = fg.attributes.position; for (let i = 0; i < fp.count; i++) { const x = fp.getX(i), z = fp.getZ(i), d = Math.hypot(x, z) / r; fp.setY(i, (fbm(x * 5 + 3, 0, z * 5) - 0.5) * 0.06 * (1 - d * d) + (p.mound ? p.mound * (1 - d * d) : 0)); } fg.computeVertexNormals(); }
    const fc = C(safeHex(p.color, '#c0661f')), fc2 = p.color2 ? C(p.color2) : fc.clone().offsetHSL(0, 0, -0.08);
    paint(fg, (v2) => mix(fc, fc2, fbm(v2.x * 9, 0, v2.z * 9) * 1.3));
    const fm = mesh(fg, mat('#fff', { vc: true, rough: p.gloss === false ? 0.8 : 0.25, clearcoat: p.gloss === false ? 0 : 0.8 }), false);
    fm.position.y = fillY; g.add(fm);
    if (p.rice) {
      const rr = P.rice({ r: r * 0.95, h: p.mound ? p.mound * 1.4 : 0.35, colors: p.riceColors || [p.color || '#f5f2ea'], color: p.color, density: 0.9, grain: 0.07 }, rng, { heightAt: () => fillY - 0.02 });
      g.add(rr);
    }
    if (Array.isArray(p.bits)) {
      p.bits.forEach((b, bi) => {
        const n = Math.min(12, b.n || 3);
        for (let k = 0; k < n; k++) {
          const a = (k / n) * Math.PI * 2 + bi * 1.3 + rng() * 0.5, d = r * (0.25 + rng() * 0.45);
          let piece;
          if (b.shape === 'slice') piece = P.slices({ count: 1, color: b.color, w: (b.s || 0.3) * 1.2, l: (b.s || 0.3) * 1.6, t: 0.05, edgeColor: b.edge, fatColor: b.fat }, rng);
          else if (b.shape === 'round' || b.shape === 'patty') piece = P.balls({ rad: (b.s || 0.3) / 2, color: b.color, color2: b.color2, squash: b.shape === 'patty' ? 0.45 : 0.92, noise: b.shape === 'patty' ? 0.18 : 0.08 }, rng);
          else piece = P.chunk({ s: b.s || 0.3, color: b.color, color2: b.color2, shape: b.shape || 'cube', aspect: b.aspect }, rng);
          piece.position.set(Math.cos(a) * d, fillY - 0.03, Math.sin(a) * d);
          g.add(piece);
        }
      });
    }
    g.scale.setScalar(s);
    return wrapBase(g);
  };

  // 道具
  P.chopsticks = function (p) {
    const g = new T.Group();
    const col = safeHex(p.color, '#6b4127');
    for (const dz of [-0.035, 0.035]) {
      const m = mesh(new T.CylinderGeometry(0.012, 0.02, 1.5, 10), mat(col, { rough: 0.5, clearcoat: 0.4 }));
      m.rotation.z = Math.PI / 2; m.position.set(0, 0.05, dz); m.rotation.y = dz * 0.6;
      g.add(m);
    }
    const rest = mesh(roundedBox(0.08, 0.05, 0.18, 0.02, 3), mat(safeHex(p.restColor, '#dfe4e8'), { rough: 0.3, clearcoat: 0.6 }));
    rest.position.set(0.55, 0.025, 0); g.add(rest);
    return wrapBase(g);
  };
  P.spoon = function (p) {
    const style = p.style || 'chinese';
    const g = new T.Group();
    if (style === 'chinese') {
      const L = latheVessel((t) => 0.15 * (0.55 + 0.45 * Math.sin(t * Math.PI / 2)), { h: 0.075, th: 0.012, foot: 0.012, footR: 0.07 });
      L.geo.scale(1.45, 1, 1);
      L.geo.computeVertexNormals();
      const m = mesh(L.geo, mat(safeHex(p.color, '#f3f1ea'), { rough: 0.25, clearcoat: 0.7 }));
      g.add(m);
      const h = mesh(roundedBox(0.4, 0.03, 0.07, 0.012, 3), mat(safeHex(p.color, '#f3f1ea'), { rough: 0.25, clearcoat: 0.7 }));
      h.position.set(-0.36, 0.1, 0); h.rotation.z = -0.25; g.add(h);
    } else {
      const metal = mat(safeHex(p.color, '#cfd3d8'), { metal: 1, rough: 0.25 });
      let bowl = new T.SphereGeometry(0.1, 24, 12, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
      bowl.scale(1.5, 0.35, 1);
      const m = mesh(bowl, metal); m.material.side = T.DoubleSide; m.position.y = 0.035; g.add(m);
      const h = mesh(roundedBox(0.6, 0.015, 0.04, 0.006, 2), metal);
      h.position.set(-0.43, 0.04, 0); h.rotation.z = -0.08; g.add(h);
    }
    return wrapBase(g);
  };
  P.fork = function (p) {
    const g = new T.Group();
    const metal = mat(safeHex(p.color, '#cfd3d8'), { metal: 1, rough: 0.25 });
    const h = mesh(roundedBox(0.7, 0.015, 0.045, 0.006, 2), metal); h.position.x = -0.35; g.add(h);
    const head = mesh(roundedBox(0.12, 0.012, 0.12, 0.01, 2), metal); head.position.x = 0.04; g.add(head);
    for (let i = 0; i < 4; i++) { const t = mesh(new T.BoxGeometry(0.16, 0.01, 0.014), metal); t.position.set(0.18, 0.004, -0.045 + i * 0.03); g.add(t); }
    g.position.y = 0.01;
    return wrapBase(g);
  };

  /* ---------- 組裝器 ---------- */
  const PROP_TYPES = new Set(['chopsticks', 'spoon', 'fork', 'bowlStack']);
  const DEFAULT_LIFT = {};

  function makeHeightMap(size = 3.6, N = 80) {
    const data = new Float32Array(N * N);
    const cell = size / (N - 1);
    const idx = (i, j) => j * N + i;
    const toIJ = (x, z) => [(x + size / 2) / cell, (z + size / 2) / cell];
    return {
      N, size, cell, data,
      get(x, z) {
        const [fi, fj] = toIJ(x, z);
        const i = Math.max(0, Math.min(N - 2, Math.floor(fi))), j = Math.max(0, Math.min(N - 2, Math.floor(fj)));
        const u = Math.max(0, Math.min(1, fi - i)), v = Math.max(0, Math.min(1, fj - j));
        const a = data[idx(i, j)], b = data[idx(i + 1, j)], c = data[idx(i, j + 1)], d = data[idx(i + 1, j + 1)];
        return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
      },
      maxIn(x0, z0, x1, z1) {
        let m = -Infinity;
        const [i0, j0] = toIJ(x0, z0), [i1, j1] = toIJ(x1, z1);
        for (let j = Math.max(0, Math.floor(j0)); j <= Math.min(N - 1, Math.ceil(j1)); j++)
          for (let i = Math.max(0, Math.floor(i0)); i <= Math.min(N - 1, Math.ceil(i1)); i++) m = Math.max(m, data[idx(i, j)]);
        return m === -Infinity ? this.get((x0 + x1) / 2, (z0 + z1) / 2) : m;
      },
      stamp(obj) {
        obj.updateMatrixWorld(true);
        const box = new T.Box3().setFromObject(obj);
        if (!isFinite(box.min.x)) return;
        const targets = [];
        let hasProxy = false;
        obj.traverse((o) => { if (o.userData.proxy) hasProxy = true; });
        obj.traverse((o) => { if (o.isMesh && !o.isInstancedMesh && (!hasProxy || o.userData.proxy) && !o.userData.noStamp) targets.push(o); });
        const rc = new T.Raycaster();
        rc.ray.direction.set(0, -1, 0);
        const [i0, j0] = toIJ(box.min.x, box.min.z), [i1, j1] = toIJ(box.max.x, box.max.z);
        for (let j = Math.max(0, Math.floor(j0)); j <= Math.min(N - 1, Math.ceil(j1)); j++)
          for (let i = Math.max(0, Math.floor(i0)); i <= Math.min(N - 1, Math.ceil(i1)); i++) {
            const x = -size / 2 + i * cell, z = -size / 2 + j * cell;
            rc.ray.origin.set(x, box.max.y + 1, z);
            const hit = rc.intersectObjects(targets, false)[0];
            if (hit) data[idx(i, j)] = Math.max(data[idx(i, j)], hit.point.y);
          }
      },
      raiseDisc(cx, cz, r, y) {
        for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
          const x = -size / 2 + i * cell, z = -size / 2 + j * cell;
          if (Math.hypot(x - cx, z - cz) <= r) data[idx(i, j)] = Math.max(data[idx(i, j)], y);
        }
      },
    };
  }

  const INTERNAL_COUNT = new Set(['slices']);
  function arrangePositions(p, rng) {
    const n = Math.max(1, Math.min(60, (INTERNAL_COUNT.has(p.type) ? p.groups : p.count) || 1));
    const arr = p.arrange || (n === 1 ? 'at' : 'scatter');
    const cx = p.pos ? +p.pos[0] || 0 : 0, cz = p.pos ? +p.pos[1] || 0 : 0;
    const r = p.r ?? (n > 1 ? 0.5 : 0);
    const out = [];
    const baseRot = ((p.rot || 0) * Math.PI) / 180;
    if (arr === 'ring') {
      for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2 + baseRot; out.push({ x: cx + Math.cos(a) * r, z: cz + Math.sin(a) * r, ry: -a + (p.face === 'tangent' ? Math.PI / 2 : 0) }); }
    } else if (arr === 'row') {
      for (let i = 0; i < n; i++) { const t = n === 1 ? 0 : i / (n - 1) - 0.5; out.push({ x: cx + Math.cos(baseRot) * t * r * 2, z: cz + Math.sin(baseRot) * t * r * 2, ry: -baseRot + (p.itemRot || 0) * Math.PI / 180 }); }
    } else if (arr === 'grid') {
      const cols = Math.ceil(Math.sqrt(n));
      for (let i = 0; i < n; i++) { const gx = i % cols, gz = Math.floor(i / cols), j = p.jitter || 0; out.push({ x: cx + (gx - (cols - 1) / 2) * (p.gap || 0.25) + (rng() - 0.5) * j, z: cz + (gz - (Math.ceil(n / cols) - 1) / 2) * (p.gap || 0.25) + (rng() - 0.5) * j, ry: baseRot + (rng() - 0.5) * j * 2 }); }
    } else if (arr === 'stack') {
      for (let i = 0; i < n; i++) out.push({ x: cx + (rng() - 0.5) * 0.03, z: cz + (rng() - 0.5) * 0.03, ry: rng() * 6.28 });
    } else if (arr === 'scatter' || arr === 'pile') {
      const minD = p.minDist ?? (r * 1.6) / Math.sqrt(n);
      for (let i = 0; i < n; i++) {
        let best = null;
        for (let k = 0; k < 30; k++) {
          const a = rng() * Math.PI * 2, d = Math.sqrt(rng()) * r;
          const c = { x: cx + Math.cos(a) * d, z: cz + Math.sin(a) * d, ry: rng() * Math.PI * 2 };
          const ok = out.every((o) => Math.hypot(o.x - c.x, o.z - c.z) > minD);
          best = c; if (ok || arr === 'pile') break;
        }
        out.push(best);
      }
    } else {
      out.push({ x: cx, z: cz, ry: baseRot });
    }
    return out;
  }

  function buildDish(spec, seedName) {
    const rng = rngFrom(hashStr(seedName || JSON.stringify(spec).slice(0, 200)));
    const root = new T.Group();
    const vSpec = spec.vessel || { type: 'plate' };
    const vFn = VESSELS[vSpec.type] || VESSELS.plate;
    const vessel = vFn(vSpec);
    vessel.obj.userData.vessel = true;
    vessel.obj.traverse((o) => { if (o.isMesh) o.userData.label = vSpec.label || null; });
    root.add(vessel.obj);
    const hm = makeHeightMap();
    // 器皿內表面
    const vesselSurf = [];
    vessel.obj.traverse((o) => { if (o.isMesh && !o.userData.prop) vesselSurf.push(o); });
    root.updateMatrixWorld(true);
    const radialTypes = new Set(['bowl', 'dish', 'plate', 'steel', 'stonebowl', 'claypot', 'tagine', 'paella', 'skillet', 'glass', 'cup', 'claycup', 'basket', 'steamer', 'leaf']);
    const vt = VESSELS[vSpec.type] ? vSpec.type : 'plate';
    if (vt === 'board') {
      for (let j = 0; j < hm.N; j++) for (let i = 0; i < hm.N; i++) {
        const x = -hm.size / 2 + i * hm.cell, z = -hm.size / 2 + j * hm.cell;
        const s = vSpec.size || 1;
        hm.data[j * hm.N + i] = Math.abs(x) < 1.25 * s && Math.abs(z) < 0.8 * s ? vessel.floorY : 0;
      }
    } else if (radialTypes.has(vt)) {
      const rc = new T.Raycaster(); rc.ray.direction.set(0, -1, 0);
      const M = Math.ceil((hm.size / 2) * Math.SQRT2 / hm.cell) + 2;
      const prof = new Float32Array(M + 1);
      // 葉片是平面：沿半徑取樣時略過葉片，再以橢圓範圍補上高度
      const radialSurf = vt === 'leaf' ? vesselSurf.filter((o) => !(o.geometry && o.geometry.type === 'PlaneGeometry')) : vesselSurf;
      for (let k = 0; k <= M; k++) {
        rc.ray.origin.set(k * hm.cell + 0.0005, 5, 0.0007);
        const hit = rc.intersectObjects(radialSurf, false)[0];
        prof[k] = hit ? hit.point.y : 0;
      }
      for (let j = 0; j < hm.N; j++) for (let i = 0; i < hm.N; i++) {
        const x = -hm.size / 2 + i * hm.cell, z = -hm.size / 2 + j * hm.cell;
        const f = Math.hypot(x, z) / hm.cell, k = Math.min(M - 1, Math.floor(f)), u = f - k;
        let h = prof[k] * (1 - u) + prof[k + 1] * u;
        if (vt === 'leaf') { const ex = x / 1.25, ez = z / 0.78; if (ex * ex + ez * ez < 1) h = Math.max(h, vessel.floorY); }
        hm.data[j * hm.N + i] = h;
      }
    } else {
      const rc = new T.Raycaster(); rc.ray.direction.set(0, -1, 0);
      for (let j = 0; j < hm.N; j++) for (let i = 0; i < hm.N; i++) {
        const x = -hm.size / 2 + i * hm.cell, z = -hm.size / 2 + j * hm.cell;
        rc.ray.origin.set(x, 5, z);
        const hit = rc.intersectObjects(vesselSurf, false)[0];
        hm.data[j * hm.N + i] = hit ? hit.point.y : 0;
      }
    }
    const ctx = { vessel, vesselType: vSpec.type, heightAt: (x, z) => hm.get(x, z), rng };
    const parts = [];
    (spec.parts || []).forEach((p, pi) => {
      if (!p || typeof p !== 'object') return;
      const type = P[p.type] ? p.type : 'blob';
      const group = new T.Group();
      group.userData.partIndex = pi;
      group.userData.label = p.label || '';
      group.userData.note = p.note || '';
      const isProp = PROP_TYPES.has(type);
      try {
        if (SURFACE.has(type) || type === 'broth') {
          const obj = P[type](p, rng, ctx);
          group.add(obj);
          root.add(group);
          group.updateMatrixWorld(true);
          if (type === 'broth') hm.raiseDisc(0, 0, obj.userData.levelR, obj.userData.level);
          else if (type === 'rice' || type === 'noodles' || (type === 'sauce' && (p.style || 'pool') !== 'drizzle')) hm.stamp(group);
        } else {
          const positions = arrangePositions(p, rng);
          const selfStack = p.arrange === 'stack' || p.arrange === 'pile';
          const placed = [];
          positions.forEach((pos, k) => {
            const item = P[type](p, rng, ctx);
            item.rotation.y += pos.ry;
            if (p.tilt) item.rotation.z += (p.tilt * Math.PI) / 180;
            if (p.tiltX) item.rotation.x += (p.tiltX * Math.PI) / 180;
            item.position.set(pos.x, 0, pos.z);
            item.updateMatrixWorld(true);
            const b = new T.Box3().setFromObject(item);
            const shrinkX = (b.max.x - b.min.x) * 0.25, shrinkZ = (b.max.z - b.min.z) * 0.25;
            let base = isProp ? 0 : hm.maxIn(b.min.x + shrinkX, b.min.z + shrinkZ, b.max.x - shrinkX, b.max.z - shrinkZ);
            const center = hm.get(pos.x, pos.z);
            base = isProp ? 0 : base * 0.6 + center * 0.4;
            item.position.y = (p.absY != null ? +p.absY : base) - b.min.y + (p.y || 0) - (p.absY != null ? 0 : (p.sink ?? 0.012));
            group.add(item);
            root.add(group);
            item.updateMatrixWorld(true);
            if (selfStack && !p.noStack) hm.stamp(item); else placed.push(item);
          });
          if (!p.noStack) placed.forEach((it) => hm.stamp(it));
        }
      } catch (err) {
        console.warn('part failed', p, err);
      }
      if (group.parent) {
        group.traverse((o) => { if (o.isMesh) { o.userData.partIndex = pi; if (o.userData.proxy) o.userData.proxyOf = pi; } });
        group.userData.isProp = isProp;
        if (isProp && type !== 'bowlStack') group.traverse((o) => { o.userData.prop = true; });
        parts.push(group);
      }
    });
    return { root, parts, vessel };
  }

  /* ---------- 場景檢視器 ---------- */
  class DishViewer {
    constructor(container, opts = {}) {
      this.container = container;
      this.opts = opts;
      const renderer = new T.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: false });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.outputEncoding = T.sRGBEncoding;
      renderer.toneMapping = T.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 0.82;
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = T.PCFSoftShadowMap;
      container.appendChild(renderer.domElement);
      this.renderer = renderer;
      const scene = new T.Scene();
      this.scene = scene;
      const pmrem = new T.PMREMGenerator(renderer);
      scene.environment = pmrem.fromScene(new T.RoomEnvironment(), 0.04).texture;
      const cam = new T.PerspectiveCamera(35, 1, 0.05, 100);
      cam.position.set(0, 2.6, 3.6);
      this.camera = cam;
      const controls = new T.OrbitControls(cam, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.minDistance = 1.2;
      controls.maxDistance = 9;
      controls.maxPolarAngle = Math.PI * 0.47;
      controls.autoRotate = true;
      controls.autoRotateSpeed = 0.8;
      controls.addEventListener('start', () => { this.userInteracted = true; controls.autoRotate = false; this.onAutoRotate && this.onAutoRotate(false); });
      this.controls = controls;
      // 燈光
      const hemi = new T.HemisphereLight(0xfff6e8, 0x6b5a48, 0.2);
      scene.add(hemi);
      const key = new T.DirectionalLight(0xfff1dc, 1.45);
      key.position.set(2.6, 5.5, 2.2);
      key.castShadow = true;
      key.shadow.mapSize.set(2048, 2048);
      key.shadow.camera.left = -3; key.shadow.camera.right = 3; key.shadow.camera.top = 3; key.shadow.camera.bottom = -3;
      key.shadow.camera.near = 1; key.shadow.camera.far = 14;
      key.shadow.bias = -0.0004; key.shadow.normalBias = 0.02; key.shadow.radius = 4;
      scene.add(key);
      const rim = new T.DirectionalLight(0xdfe8ff, 0.5);
      rim.position.set(-3, 3, -3);
      scene.add(rim);
      this.keyLight = key;
      // 桌面
      this.table = new T.Mesh(new T.CircleGeometry(9, 64), new T.MeshStandardMaterial({ color: 0xffffff, roughness: 0.75 }));
      this.table.rotation.x = -Math.PI / 2;
      this.table.receiveShadow = true;
      scene.add(this.table);
      this.setTable('wood', '#8a5a36');
      // 蒸氣
      this.steam = this.makeSteam();
      scene.add(this.steam);
      this.dish = null;
      this.explode = 0; this.explodeTarget = 0;
      this.hoverIdx = -1; this.selectIdx = -1; this.highlightSet = new Set();
      this.raycaster = new T.Raycaster();
      this.pointer = new T.Vector2();
      this.clock = new T.Clock();
      this.bindPointer();
      this.resize();
      new ResizeObserver(() => this.resize()).observe(container);
      this.reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (this.reduceMotion) controls.autoRotate = false;
      this.loop = this.loop.bind(this);
      this.visible = true;
      renderer.setAnimationLoop(this.loop);
    }
    setBackground(hex) { this.scene.background = C(hex); this.scene.fog = new T.Fog(C(hex), 9, 22); }
    setTable(kind, color) {
      const old = this.table.material.map;
      this.table.material.map = tableTexture(kind, color);
      this.table.material.roughness = kind === 'marble' || kind === 'tile' ? 0.35 : 0.75;
      this.table.material.needsUpdate = true;
      if (old) old.dispose();
    }
    makeSteam() {
      const tex = canvasTex(128, (g, s) => {
        const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
        grd.addColorStop(0, 'rgba(255,255,255,0.55)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = grd; g.fillRect(0, 0, s, s);
      });
      const grp = new T.Group();
      for (let i = 0; i < 26; i++) {
        const sp = new T.Sprite(new T.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0 }));
        sp.userData.t = Math.random(); sp.userData.x = (Math.random() - 0.5) * 0.9; sp.userData.z = (Math.random() - 0.5) * 0.9; sp.userData.sp = 0.1 + Math.random() * 0.12;
        grp.add(sp);
      }
      grp.visible = false;
      return grp;
    }
    setDish(spec, seedName) {
      if (this.dish) {
        this.scene.remove(this.dish.root);
        this.dish.root.traverse((o) => { if (o.geometry) o.geometry.dispose(); const ms = Array.isArray(o.material) ? o.material : [o.material]; ms.forEach((m) => { if (m) { if (m.map) m.map.dispose(); m.dispose(); } }); });
      }
      const t0 = performance.now();
      const dish = buildDish(spec, seedName);
      this.buildMs = performance.now() - t0;
      this.dish = dish;
      this.scene.add(dish.root);
      dish.parts.forEach((g, i) => {
        g.userData.basePos = g.position.clone();
        const b = new T.Box3().setFromObject(g);
        const c = b.getCenter(new T.Vector3());
        g.userData.explodeDir = V3(c.x * 0.35, 0, c.z * 0.35);
      });
      // 材質備份（高亮用）
      dish.root.traverse((o) => {
        if (o.isMesh && o.material && !Array.isArray(o.material)) {
          o.material = o.material.clone();
          o.userData.baseEmissive = o.material.emissive ? o.material.emissive.clone() : null;
        }
      });
      const hot = spec.steam ?? false;
      this.steam.visible = !!hot;
      if (hot) {
        const b = new T.Box3().setFromObject(dish.root);
        this.steamTop = b.max.y;
        this.steamR = Math.min(0.8, (b.max.x - b.min.x) / 3);
      }
      this.frame();
      this.explode = 0; this.explodeTarget = 0;
      this.selectIdx = -1; this.highlightSet.clear(); this.applyHighlight();
      if (spec.table) this.setTable(spec.table.kind || 'wood', spec.table.color || '#8a5a36');
    }
    frame() {
      const b = new T.Box3();
      this.dish.root.traverse((o) => { if (o.isMesh && !o.userData.proxy && !o.userData.prop) b.expandByObject(o); });
      const size = b.getSize(new T.Vector3()), c = b.getCenter(new T.Vector3());
      const r = Math.max(size.x, size.z, size.y * 1.5) * 0.5;
      this.controls.target.set(c.x * 0.6, Math.min(c.y * 0.8, 0.6), c.z * 0.6);
      const fit = this.camera.aspect < 1 ? 1 / this.camera.aspect : 1;
      const dist = Math.max(1.8, (r / Math.tan((this.camera.fov * Math.PI) / 360)) * 0.95 * Math.sqrt(fit));
      const dir = V3(0.0, 0.62, 0.78).normalize();
      this.camera.position.copy(this.controls.target).addScaledVector(dir, dist);
      this.controls.update();
    }
    setExplode(on) { this.explodeTarget = on ? 1 : 0; }
    setAutoRotate(on) { this.controls.autoRotate = on && !this.reduceMotion; }
    highlightByLabel(fn) {
      this.highlightSet.clear();
      if (this.dish && fn) this.dish.parts.forEach((g) => { if (fn(g.userData.label || '')) this.highlightSet.add(g.userData.partIndex); });
      this.applyHighlight();
    }
    selectPart(idx) { this.selectIdx = idx; this.applyHighlight(); }
    applyHighlight() {
      if (!this.dish) return;
      const any = this.highlightSet.size > 0 || this.hoverIdx >= 0 || this.selectIdx >= 0;
      this.dish.root.traverse((o) => {
        if (!o.isMesh || !o.material || Array.isArray(o.material) || !o.material.emissive) return;
        const i = o.userData.partIndex;
        const on = i != null && (this.highlightSet.has(i) || i === this.hoverIdx || i === this.selectIdx);
        if (on) { o.material.emissive.set(0xffc766); o.material.emissiveIntensity = 0.22; }
        else { o.material.emissive.set(0x000000); o.material.emissiveIntensity = 1; }
      });
      this.renderer.domElement.style.cursor = this.hoverIdx >= 0 ? 'pointer' : 'grab';
      void any;
    }
    pick(ev) {
      if (!this.dish) return null;
      const rect = this.renderer.domElement.getBoundingClientRect();
      this.pointer.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
      this.raycaster.setFromCamera(this.pointer, this.camera);
      const hits = this.raycaster.intersectObject(this.dish.root, true);
      for (const h of hits) {
        let o = h.object;
        const idx = o.userData.partIndex;
        if (idx != null) return { idx, point: h.point };
      }
      return null;
    }
    bindPointer() {
      const el = this.renderer.domElement;
      let downAt = null;
      el.addEventListener('pointermove', (ev) => {
        if (ev.pointerType === 'touch') return;
        const hit = this.pick(ev);
        const idx = hit ? hit.idx : -1;
        if (idx !== this.hoverIdx) { this.hoverIdx = idx; this.applyHighlight(); }
        this.opts.onHover && this.opts.onHover(hit ? this.partInfo(hit.idx) : null, ev);
      });
      el.addEventListener('pointerleave', () => { this.hoverIdx = -1; this.applyHighlight(); this.opts.onHover && this.opts.onHover(null); });
      el.addEventListener('pointerdown', (ev) => { downAt = [ev.clientX, ev.clientY]; });
      el.addEventListener('pointerup', (ev) => {
        if (!downAt) return;
        const moved = Math.hypot(ev.clientX - downAt[0], ev.clientY - downAt[1]);
        downAt = null;
        if (moved > 6) return;
        const hit = this.pick(ev);
        this.selectIdx = hit ? hit.idx : -1;
        this.applyHighlight();
        this.opts.onSelect && this.opts.onSelect(hit ? this.partInfo(hit.idx) : null, ev);
      });
    }
    partInfo(idx) {
      const g = this.dish.parts.find((x) => x.userData.partIndex === idx);
      return g ? { idx, label: g.userData.label, note: g.userData.note } : null;
    }
    resize() {
      const w = this.container.clientWidth || 300, h = this.container.clientHeight || 300;
      this.renderer.setSize(w, h, false);
      this.renderer.domElement.style.width = '100%';
      this.renderer.domElement.style.height = '100%';
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    snapshot() { this.renderer.render(this.scene, this.camera); return this.renderer.domElement.toDataURL('image/png'); }
    loop() {
      const dt = Math.min(0.05, this.clock.getDelta());
      this.controls.update();
      if (this.dish) {
        this.explode += (this.explodeTarget - this.explode) * Math.min(1, dt * 6);
        let rank = 0;
        this.dish.parts.forEach((g) => {
          if (g.userData.isProp) return;
          const k = this.explode;
          const lift = (0.22 + rank * 0.2) * k;
          g.position.set(g.userData.basePos.x + g.userData.explodeDir.x * k, g.userData.basePos.y + lift, g.userData.basePos.z + g.userData.explodeDir.z * k);
          rank++;
        });
      }
      if (this.steam.visible && !this.reduceMotion) {
        this.steam.children.forEach((sp) => {
          sp.userData.t += dt * sp.userData.sp;
          if (sp.userData.t > 1) { sp.userData.t = 0; sp.userData.x = (Math.random() - 0.5) * this.steamR * 2; sp.userData.z = (Math.random() - 0.5) * this.steamR * 2; }
          const t = sp.userData.t;
          sp.position.set(sp.userData.x + Math.sin(t * 6 + sp.userData.z * 9) * 0.08, this.steamTop + t * 1.4, sp.userData.z);
          const sc = 0.25 + t * 0.7; sp.scale.set(sc, sc, sc);
          sp.material.opacity = Math.sin(t * Math.PI) * 0.22 * (1 - this.explode);
        });
      }
      this.renderer.render(this.scene, this.camera);
    }
  }

  window.DishEngine = {
    DishViewer, buildDish,
    partTypes: Object.keys(P), vesselTypes: Object.keys(VESSELS),
  };
})();
