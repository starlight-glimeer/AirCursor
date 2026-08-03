(() => {
  'use strict';

  const _c01 = (v) => { const n = Number(v); return !Number.isFinite(n) ? 0 : (n < 0 ? 0 : (n > 1 ? 1 : n)); };
  const BG = 0x05060f;

  // 收缩的网格：40×40、格距 0.32 ⟹ 覆盖 XZ ∈ [-6.24, 6.24]
  const GRID = 40;
  const COUNT = GRID * GRID;
  const SPACING = 0.32;
  const HALF = (GRID - 1) / 2;
  const RADIUS = HALF * SPACING;

  // 亮核中心（世界坐标）——落在画面中间横条
  const CORE_Y = 1.2;

  let grid = null;
  let dummy = null;
  let color = null;
  const baseX = new Float32Array(COUNT);
  const baseZ = new Float32Array(COUNT);
  const jitterX = new Float32Array(COUNT);
  const jitterZ = new Float32Array(COUNT);
  const baseNoiseArr = new Float32Array(COUNT);

  let ripples = [];
  let idleTimer = 0;
  let nextIdle = 7 + Math.random() * 4;

  window.SCENE = {
    build(ctx) {
      const { THREE } = ctx;
      dummy = new THREE.Object3D();
      color = new THREE.Color();

      ctx.scene.background = new THREE.Color(BG);
      // 雾：外圈没入黑底 ⟹ 近黑区达标
      ctx.scene.fog = new THREE.FogExp2(BG, 0.12);

      ctx.scene.remove(ctx.defaultLights);

      const geo = new THREE.BoxGeometry(0.16, 0.16, 0.16);
      const mat = new THREE.MeshBasicMaterial({ fog: true });
      grid = new THREE.InstancedMesh(geo, mat, COUNT);
      grid.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      grid.instanceColor = new THREE.InstancedBufferAttribute(
        new Float32Array(COUNT * 3), 3);
      ctx.scene.add(grid);

      for (let i = 0; i < COUNT; i += 1) {
        const x = ((i % GRID) - HALF) * SPACING;
        const z = (Math.floor(i / GRID) - HALF) * SPACING;
        baseX[i] = x;
        baseZ[i] = z;
        jitterX[i] = (Math.random() * 2 - 1) * 0.04;
        jitterZ[i] = (Math.random() * 2 - 1) * 0.04;
        baseNoiseArr[i] = Math.sin(x * 1.1) * Math.cos(z * 1.3) * 0.22
          + Math.sin(x * 2.0 + z * 0.7) * 0.10;
      }

      // 相机：抬高焦点到 CORE_Y ⟹ 亮核落在画面中间
      ctx.camera.fov = 52;
      ctx.camera.updateProjectionMatrix();
      ctx.camera.position.set(0, 3.2, 12);
      ctx.camera.lookAt(0, CORE_Y, 0);
    },

    frame(ctx) {
      if (!grid) return;
      const { audio, opts, t, dt } = ctx;
      const intensity = (opts.intensity !== undefined ? opts.intensity : 1);

      const hasAudio = audio.everGot && (audio.bass + audio.mid + audio.treble) > 0.02;
      const loud = Math.min(1, (audio.bass + audio.mid + audio.treble) / 3);
      const bassPeak = Math.min(1, audio.bass);

      if (hasAudio && audio.bass > 0.7 && ripples.length < 6) {
        if (ripples.length === 0 || (t - ripples[ripples.length - 1].t0) > 0.25) {
          ripples.push({ t0: t });
        }
      }
      if (!hasAudio) {
        idleTimer += dt;
        if (idleTimer >= nextIdle) {
          idleTimer = 0;
          nextIdle = 7 + Math.random() * 4;
          if (ripples.length < 6) ripples.push({ t0: t, weak: true });
        }
      }

      const RSPEED = 3.0;
      ripples = ripples.filter((rp) => ((t - rp.t0) * RSPEED) < RADIUS + 1);

      // 呼吸：亮核大小随时间/音频起伏
      const breath = 0.5 + 0.5 * Math.sin(t * 0.6);
      const coreScale = hasAudio
        ? (0.42 + loud * 0.35)
        : (0.42 + breath * 0.12);

      for (let i = 0; i < COUNT; i += 1) {
        const x = baseX[i] + jitterX[i];
        const z = baseZ[i] + jitterZ[i];

        const dist = Math.hypot(baseX[i], baseZ[i]);
        const d = Math.min(1, dist / RADIUS);
        const bin = Math.min(127, Math.floor(d * 127));

        let energy;
        if (hasAudio) {
          const bIdx = Math.min(63, Math.floor(bin / 2));
          energy = _c01(audio.bins[bIdx]);
        } else {
          energy = 0.5 + 0.5 * Math.sin(t * 0.5 + x * 0.8 + z * 0.6);
        }

        let audioLift;
        if (hasAudio) {
          if (bin <= 20) audioLift = energy * 1.1;
          else if (bin <= 70) audioLift = energy * 0.7;
          else audioLift = energy * 0.2;
          audioLift *= intensity;
        } else {
          audioLift = Math.sin(t * 0.5 + x * 0.8 + z * 0.6) * 0.16;
        }

        let y = baseNoiseArr[i] + audioLift;

        let rippleBoost = 0;
        for (let r = 0; r < ripples.length; r += 1) {
          const rp = ripples[r];
          const R = (t - rp.t0) * RSPEED;
          const decay = Math.max(0, 1 - R / RADIUS);
          const front = Math.abs(dist - R);
          if (front < 0.6) {
            const amp = (1 - front / 0.6) * decay * (rp.weak ? 0.4 : 0.9);
            y += amp;
            rippleBoost = Math.max(rippleBoost, amp);
          }
        }

        dummy.position.set(x, y, z);
        dummy.updateMatrix();
        grid.setMatrixAt(i, dummy.matrix);

        // ── 亮度按到亮核的水平距离强衰减：中心 0.85 → 边缘 0.03
        //    glow: 中心=1, 边缘=0
        const glowDist = dist / (RADIUS * coreScale);
        const glow = Math.exp(-glowDist * glowDist * 1.3);

        // 亮核区注入能量 ⟹ 中带最亮成为焦点
        const L = Math.max(0.03, Math.min(0.92,
          0.06 + glow * 0.80 + (rippleBoost + audioLift * 0.15) * glow * 0.5));

        // 色相：中心偏暖白，外围偏冷紫
        const hue = (255 - glow * 40 + (hasAudio ? loud * 20 : breath * 8)) % 360;
        const sat = Math.min(0.85, 0.15 + (1 - glow) * 0.55 + (hasAudio ? bassPeak * 0.15 : 0));

        color.setHSL(hue / 360, sat, L);
        grid.setColorAt(i, color);
      }

      grid.instanceMatrix.needsUpdate = true;
      if (grid.instanceColor) grid.instanceColor.needsUpdate = true;

      // 慢动态：相机小幅浮动，焦点始终在亮核上
      ctx.camera.position.x = Math.sin(t * 0.18) * 0.7;
      ctx.camera.position.y = 3.2 + Math.sin(t * 0.15) * 0.25;
      ctx.camera.position.z = 12;
      ctx.camera.lookAt(0, CORE_Y, 0);
    },
  };
})();