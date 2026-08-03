(() => {
  'use strict';

  // 根因分析：上一版用 setHSL 时把 lum 一路乘小(*(0.15+0.85*(1-d))
  // 又 *(1-d)^2)，中心那点被 core 提亮后仍被压回去，实际 L 峰值远不到 0.7。
  // 这一版：让中心一小片直接给足高亮度(L 0.8~0.95)，不再对内圈做距离压暗，
  // 只压外圈；并且把中心柱子做粗做高，保证高亮像素占比达标。

  const COUNT = 2600;
  const RADIUS = 13;
  const GOLDEN = 2.399963;

  let grid = null;
  let dummy = null;
  let color = null;
  let ripples = [];
  let heights = null;
  let baseR = null;
  let baseX = null;
  let baseZ = null;
  let baseBin = null;
  let lastAutoRipple = 0;
  let camBaseX = 0;
  let camBaseY = 3.2;

  function spawnRipple(life) {
    ripples.push({ r: 0, life: life });
  }

  window.SCENE = {
    build(ctx) {
      const { THREE } = ctx;

      dummy = new THREE.Object3D();
      color = new THREE.Color();
      ripples = [];
      lastAutoRipple = 0;

      ctx.scene.background = new THREE.Color(0x05060f);
      ctx.scene.fog = new THREE.FogExp2(0x05060f, 0.06);

      ctx.scene.remove(ctx.defaultLights);

      const geo = new THREE.BoxGeometry(0.16, 1, 0.16);
      const mat = new THREE.MeshBasicMaterial();
      grid = new THREE.InstancedMesh(geo, mat, COUNT);
      grid.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      grid.instanceColor = new THREE.InstancedBufferAttribute(
        new Float32Array(COUNT * 3), 3);
      grid.frustumCulled = false;
      ctx.scene.add(grid);

      heights = new Float32Array(COUNT).fill(0.3);
      baseR = new Float32Array(COUNT);
      baseX = new Float32Array(COUNT);
      baseZ = new Float32Array(COUNT);
      baseBin = new Int32Array(COUNT);

      for (let i = 0; i < COUNT; i += 1) {
        const r = RADIUS * Math.sqrt(i / COUNT);
        const th = i * GOLDEN;
        baseR[i] = r;
        baseX[i] = r * Math.cos(th);
        baseZ[i] = r * Math.sin(th);
        const d = r / RADIUS;
        baseBin[i] = Math.min(63, Math.floor(d * 63));
      }

      camBaseX = 0;
      camBaseY = 3.2;
      ctx.camera.fov = 50;
      ctx.camera.updateProjectionMatrix();
      ctx.camera.position.set(0, 3.2, 15);
      ctx.camera.lookAt(0, 1.2, 0);
    },

    frame(ctx) {
      if (!grid) return;
      const { audio, opts, t, dt } = ctx;
      const intensity = (opts.intensity !== undefined ? opts.intensity : 1);

      if (audio.bass > 0.6 && ripples.length < 6) {
        const near = ripples.some((rp) => rp.r < 1.2);
        if (!near) spawnRipple(1);
      }

      const idle = !audio.everGot || (audio.bass < 0.05 && audio.mid < 0.05);
      if (idle && t - lastAutoRipple > 7) {
        lastAutoRipple = t;
        spawnRipple(0.6);
      }

      for (const rp of ripples) rp.r += 9 * dt;
      ripples = ripples.filter((rp) => rp.r < RADIUS + 1);

      const hueBase = 290 - (audio.bass + audio.mid) * 0.5 * 40;
      const hueSlow = 275 + Math.sin(t * (2 * Math.PI / 30)) * 15;
      const hueMix = hueBase * 0.4 + hueSlow * 0.6;
      const hueDeg = Math.max(210, Math.min(330, hueMix));

      ctx.camera.position.x = camBaseX + Math.sin(t * (2 * Math.PI / 24)) * 0.6;
      ctx.camera.position.y = camBaseY + Math.cos(t * (2 * Math.PI / 24)) * 0.5;
      ctx.camera.position.z = 15;
      ctx.camera.lookAt(0, 1.2, 0);

      const hasAudio = audio.everGot && !idle;
      const breathe = 0.5 + 0.5 * Math.sin(t * 0.8);

      for (let i = 0; i < COUNT; i += 1) {
        const x = baseX[i];
        const z = baseZ[i];
        const r = baseR[i];
        const d = r / RADIUS; // 0..1

        // 中心焦点：内圈一小片(d<0.3)是高亮核心
        const core = Math.max(0, 1 - d / 0.3); // 1 at center → 0 at d=0.3

        let target;
        if (hasAudio) {
          const e = audio.bins[baseBin[i]] || 0;
          target = 0.3 + e * 3.5 * intensity + audio.bass * 0.9 + core * 2.6;
          if (d > 0.6) {
            target += audio.treble * (Math.sin(t * 8 + i * 0.7) * 0.5 + 0.5) * 0.6;
          }
        } else {
          target = 0.3 + core * 2.4
            + 0.35 * Math.sin(x * 0.3 + t * 0.5) * Math.cos(z * 0.3 + t * 0.4)
            + 0.8 * breathe * core;
        }

        let rippleBoost = 0;
        for (const rp of ripples) {
          const dd = Math.abs(r - rp.r);
          if (dd < 1) rippleBoost += (1 - dd) * 2.5 * rp.life;
        }
        target += rippleBoost;
        target = Math.max(0.12, target);

        const h = heights[i] + (target - heights[i]) * 0.25;
        heights[i] = h;

        dummy.position.set(x, h / 2, z);
        // 中心柱子做粗一点，扩大高亮像素占比
        const w = 1 + core * 1.6;
        dummy.scale.set(w, h, w);
        dummy.updateMatrix();
        grid.setMatrixAt(i, dummy.matrix);

        // 配色：
        // 中心核心区直接给足高亮 L≈0.8~0.95（不被距离压暗），成为视觉焦点。
        // 外圈按距离衰减到没入雾底（近黑区）。
        const sat = Math.max(0.15, Math.min(0.7, 0.55 - core * 0.35 + d * 0.2));

        let lum;
        if (core > 0) {
          // 焦点：0.6 打底 + core 拉到 ~0.95，再叠呼吸/波纹
          lum = 0.6 + core * 0.32
            + core * breathe * 0.08
            + Math.min(0.15, rippleBoost * 0.06);
        } else {
          // 外圈：随距离压暗至近黑
          const dd = (d - 0.3) / 0.7; // 0..1 over outer ring
          lum = 0.4 * (1 - dd) * (1 - dd);
          lum += Math.min(0.15, (h - 0.3) * 0.04);
          lum += Math.min(0.2, rippleBoost * 0.07);
          lum *= (0.1 + 0.9 * (1 - dd));
        }
        lum = Math.max(0.0, Math.min(0.98, lum));

        color.setHSL(hueDeg / 360, sat, lum);
        grid.setColorAt(i, color);
      }

      grid.instanceMatrix.needsUpdate = true;
      if (grid.instanceColor) grid.instanceColor.needsUpdate = true;
    },

    layout(ctx) {
      ctx.camera.lookAt(0, 1.2, 0);
    },
  };
})();