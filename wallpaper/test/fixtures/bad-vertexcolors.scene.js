(() => {
  'use strict';

  const _c01 = (v) => { const n = Number(v); return !Number.isFinite(n) ? 0 : (n < 0 ? 0 : (n > 1 ? 1 : n)); };

  const AREA = 12;
  const STEP = 0.55;
  const RADIUS = 12;
  let grid = null;
  let count = 0;
  let dummy = null;
  let col = null;
  let px = null, pz = null, pd = null, pbin = null;
  let ripples = [];
  let nextRipple = 0;

  function buildLayout() {
    const xs = [], zs = [], ds = [], bins = [];
    const N = Math.ceil((AREA * 2) / STEP);
    for (let row = 0; row <= N; row += 1) {
      const z = -AREA + row * STEP;
      for (let col2 = 0; col2 <= N; col2 += 1) {
        const x = -AREA + col2 * STEP;
        const dist = Math.hypot(x, z);
        if (dist > RADIUS) continue;
        xs.push(x); zs.push(z); ds.push(dist);
        bins.push(Math.min(63, Math.floor((dist / RADIUS) * 63)));
      }
    }
    count = xs.length;
    px = new Float32Array(xs);
    pz = new Float32Array(zs);
    pd = new Float32Array(ds);
    pbin = new Int16Array(bins);
  }

  window.SCENE = {
    build(ctx) {
      const { THREE } = ctx;
      dummy = new THREE.Object3D();
      col = new THREE.Color();
      buildLayout();

      // BasicMaterial 不需要灯光；用 vertexColors 让每个实例自带颜色
      const geo = new THREE.BoxGeometry(0.28, 1, 0.28);
      ctx.scene.remove(ctx.defaultLights);
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true });

      grid = new THREE.InstancedMesh(geo, mat, count);
      grid.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      // 初始化为白色，避免全 0（黑）
      const carr = new Float32Array(count * 3).fill(1);
      grid.instanceColor = new THREE.InstancedBufferAttribute(carr, 3);
      grid.frustumCulled = false;
      ctx.scene.add(grid);

      ctx.scene.background = new THREE.Color(0x0a0b1e);
      // 相机处透光率约 70%
      ctx.scene.fog = new THREE.FogExp2(0x0a0b1e, 0.020);

      ctx.camera.fov = 55;
      ctx.camera.position.set(0, 1.2, 16);
      ctx.camera.lookAt(0, 0.6, 0);
      ctx.camera.updateProjectionMatrix();

      nextRipple = 0;
      ripples = [];
    },

    frame(ctx) {
      if (!grid) return;
      const { audio, t, dt } = ctx;
      const bass = _c01(audio.bass);
      const mid = _c01(audio.mid);
      const treble = _c01(audio.treble);
      const loud = Math.max(bass, mid);

      // ── 事件波纹：周期自发（无音乐也动）+ bass 触发
      const period = 1.4 - loud * 0.6;
      if (t >= nextRipple && ripples.length < 6) {
        ripples.push({ t0: t, boost: 0.8 + loud * 0.8 });
        nextRipple = t + Math.max(0.55, period);
      }
      if (bass > 0.6 && ripples.length < 9) {
        ripples.push({ t0: t, boost: 1.3 });
        nextRipple = t + 0.45;
      }
      for (const rp of ripples) {
        rp.age = t - rp.t0;
        rp.r = rp.age * 8.0;
        rp.amp = Math.exp(-rp.age * 1.4) * rp.boost;
      }
      ripples = ripples.filter((rp) => rp.age < 2.0);

      const hueDrift = (t * 12) % 360;
      // 全场呼吸：让整体亮度 29-76 起伏（有节奏）
      const breathe = 0.5 + 0.5 * Math.sin(t * 1.1);

      for (let i = 0; i < count; i += 1) {
        const x = px[i];
        const z = pz[i];
        const dist = pd[i];
        const d = dist / RADIUS;
        const bin = pbin[i];
        const binEnergy = _c01(audio.bins[bin]);

        // 空闲行波：驱动高度和亮度脉动（明显）
        const wave = Math.sin(t * 2.0 - dist * 0.7)
          + Math.sin(x * 0.4 + t * 1.3) * Math.cos(z * 0.45 - t * 0.9);
        const idle = wave * 0.5 + 0.5; // 0..1

        let h = 0.8 + idle * 1.6 + binEnergy * 3.5 + loud * 0.8;

        // 波纹脉冲
        let ripHit = 0;
        for (const rp of ripples) {
          const diff = dist - rp.r;
          const g = Math.exp(-(diff * diff) * 1.2);
          h += rp.amp * g * 4.0;
          ripHit += rp.amp * g;
        }
        h = Math.max(0.2, h);

        dummy.position.set(x, h / 2, z);
        dummy.scale.set(1, h, 1);
        dummy.updateMatrix();
        grid.setMatrixAt(i, dummy.matrix);

        // ── 亮度分层：中心焦点(0.9+)，外围保底 0.45，脉动强烈
        const centerL = 0.45 * (1 - d * d);           // 中心明亮
        const pulse = idle * 0.22 + breathe * 0.10;    // 呼吸/行波带来的明暗
        const ripL = Math.min(0.5, ripHit * 0.5);      // 波纹处冲亮
        let L = 0.45 + centerL + pulse + ripL;
        L = Math.min(1, L);

        // 色相/饱和：中心偏白，外围饱和度高
        const hueDeg = (270 - d * 50 + hueDrift) % 360;
        const S = Math.min(0.85, 0.35 + d * 0.5 + treble * 0.2) * (0.5 + 0.5 * d);
        col.setHSL(hueDeg / 360, S, L);
        grid.setColorAt(i, col);
      }

      grid.instanceMatrix.needsUpdate = true;
      if (grid.instanceColor) grid.instanceColor.needsUpdate = true;
    },
  };
})();