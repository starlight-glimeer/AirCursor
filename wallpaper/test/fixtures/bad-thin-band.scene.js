(() => {
  'use strict';

  const _c01 = (v) => { const n = Number(v); return !Number.isFinite(n) ? 0 : (n < 0 ? 0 : (n > 1 ? 1 : n)); };
  const DP = {
    bg: 0x05060f,
    lum(d, energy) {
      const dd = _c01(d);
      const e = _c01(energy);
      const t = dd * 0.65 + dd * dd * 0.35;
      return Math.max(0, Math.min(1, 0.86 + (0.18 - 0.86) * t + e * 0.12));
    },
    sat(d, loudness) {
      const dd = _c01(d);
      const l = _c01(loudness);
      return Math.max(0, Math.min(0.85, 0.32 + 0.28 * dd + l * 0.30));
    },
    hue(d, loudness) {
      const dd = _c01(d);
      const l = _c01(loudness);
      return (294 + (235 - 294) * l + dd * (-43) + 360) % 360;
    },
  };

  const CENTER_Z = -3;
  const SPAN_X = 16;      // 横向铺开（占满画面宽度那一条）
  const SPAN_Z = 7;       // 纵深较薄 => 只占中间一横带
  const COLS = 60;
  const ROWS = 26;

  let mesh = null;
  let points = [];
  let count = 0;
  let dummy = null;
  let col = null;

  function hash(n) {
    const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return s - Math.floor(s);
  }

  function buildPoints() {
    points = [];
    for (let iz = 0; iz < ROWS; iz += 1) {
      for (let ix = 0; ix < COLS; ix += 1) {
        const fx = (ix / (COLS - 1) - 0.5);   // -0.5..0.5
        const fz = (iz / (ROWS - 1));         // 0..1  (0近 1远)
        const x = fx * SPAN_X;
        const z = CENTER_Z - fz * SPAN_Z;     // 往远处延伸
        // 距画面中心的归一化（用于亮度衰减：只有中心一小片亮）
        const dc = Math.min(1, Math.hypot(fx * 2.0, (fz - 0.28) * 2.4));
        const bin = Math.min(63, Math.floor((Math.abs(fx) + fz * 0.4) * 40));
        points.push({ x, z, fx, fz, dc, bin, seed: hash(ix * 7.3 + iz * 3.1) });
      }
    }
    count = points.length;
  }

  window.SCENE = {
    build(ctx) {
      const { THREE } = ctx;
      ctx.scene.remove(ctx.defaultLights);

      buildPoints();
      dummy = new THREE.Object3D();
      col = new THREE.Color();

      const geo = new THREE.PlaneGeometry(0.42, 0.42);
      const mat = new THREE.MeshBasicMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: true,
      });
      mesh = new THREE.InstancedMesh(geo, mat, count);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(
        new Float32Array(count * 3), 3);
      ctx.scene.add(mesh);

      ctx.scene.background = new THREE.Color(DP.bg);
      // 相机距中心约 6，透光率 ~75% => density ~ 0.048 但additive下压小些
      ctx.scene.fog = new THREE.FogExp2(DP.bg, 0.05);

      // 压低相机：高度 0.8 << 距离 6 的 1/4
      ctx.camera.position.set(0, 0.8, 3.2);
      ctx.camera.lookAt(0, 0.35, CENTER_Z);
    },

    frame(ctx) {
      if (!mesh) return;
      const { audio, opts, t } = ctx;
      const intensity = (opts && opts.intensity !== undefined ? opts.intensity : 1);
      const bass = audio.bass;
      const loud = (audio.bass + audio.mid + audio.treble) / 3;

      // 亮点中心在画面里游走（局部脉冲）——制造宽范围、有节奏的帧间变化
      const gx = Math.sin(t * 0.53) * 0.32 + Math.sin(t * 0.19) * 0.12;
      const gz = 0.28 + Math.sin(t * 0.37 + 1.3) * 0.18;
      // 脉冲强度忽大忽小
      const pulse = (0.5 + 0.5 * Math.sin(t * 1.7)) * (0.5 + 0.5 * Math.sin(t * 0.6 + 2.1));
      const flare = pulse * 0.8 + bass * 1.2 * intensity;

      const amp = 0.6 + bass * 1.4 * intensity;

      for (let i = 0; i < count; i += 1) {
        const p = points[i];
        const energy = audio.bins[p.bin] || 0;

        // 高度：中间带起伏，整体偏低
        let h = Math.sin(p.x * 0.6 + t * 1.3) * Math.cos((p.fz) * 3.0 - t * 0.8) * amp;
        h += Math.sin(t * 1.1 - (p.x + p.fz * 4) * 0.5) * 0.35;
        h += energy * 2.2 * intensity;

        const baseY = 0.35 + h * 0.35;

        dummy.position.set(p.x, baseY, p.z);
        const sc = 0.7 + energy * 1.5;
        dummy.scale.set(sc, sc, sc);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);

        // 到游走亮点中心的距离
        const ddx = p.fx - gx;
        const ddy = p.fz - gz;
        const near = Math.max(0, 1 - Math.hypot(ddx * 1.8, ddy * 2.2));  // 0..1 只中心一小片
        const spot = near * near * (0.6 + flare);

        // 大部分点很暗（底色区），只有靠近亮点的才亮
        const d = p.dc;
        const baseL = 0.06 + energy * 0.15;                 // 大面积压暗
        let L = baseL + spot * 0.7;
        L = Math.max(0, Math.min(0.95, L));

        const S = Math.max(0.30, Math.min(0.34, 0.32 + loud * 0.02));
        col.setHSL(DP.hue(d, loud) / 360, S, L);
        mesh.setColorAt(i, col);
      }

      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

      // 相机极缓慢漂移 + 拖拽视差（保持低位贴地平线）
      ctx.camera.position.y = 0.8 + Math.sin(t * 0.22) * 0.12;
      ctx.camera.position.x = Math.sin(t * 0.15) * 0.3 + ctx.pointer.dragX * 0.002;
      ctx.camera.lookAt(0, 0.35, CENTER_Z);
    },
  };
})();