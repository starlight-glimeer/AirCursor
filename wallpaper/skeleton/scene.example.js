// ⚠️⚠️⚠️ **这是模型要写的那个文件的参考实现**（`scene.js`）。
//
// 它有两个用途：
//   ① 骨架自测时当默认场景（`_skeleton/` 目录直接能跑）
//   ② **喂给模型当例子** —— 比任何自然语言描述都准
//
// 用户 2026-08-02 要的参考效果是 `粒子效果_网易云监听`（3D 柱体网格随音乐起伏、
// 低频涟漪、高频流星）。这个实现就是那种风格的一个最小可跑版本。
//
// ⚠️ 契约只有三个函数，`ctx` 里的东西全是骨架给的：
//   ctx.THREE / scene / camera / renderer
//   ctx.audio    { bass, mid, treble, bins[64], everGot }
//   ctx.track    { title, artist, thumbnail, primaryColor, playing }
//   ctx.pointer  { x, y, down, dragX, dragY }
//   ctx.opts     project.json 里那些参数（颜色已转成 [r,g,b] 数组）
//   ctx.t / dt / W / H
//   ctx.warn(msg)  报一句进诊断报告

(() => {
  'use strict';

  // ── 这个场景自己的状态（别挂全局，换场景时要能干净替换）
  let grid = null;          // InstancedMesh
  let cols = 0;
  let rows = 0;
  const dummy = { m: null };  // 复用的 Matrix4，避免每帧 new
  let ripples = [];         // 低频触发的涟漪
  let baseColor = null;

  function config(ctx) {
    // ⚠️ 从 opts 读，而**每个都要有默认值** —— 用户没碰过滑块时 opts 里没有那个键
    const n = Math.max(8, Math.min(96, Math.round(ctx.opts.gridSize || 48)));
    cols = n;
    rows = n;
  }

  window.SCENE = {
    build(ctx) {
      const { THREE } = ctx;
      config(ctx);
      dummy.m = new THREE.Object3D();

      // ⚠️⚠️ **InstancedMesh 而不是 N 个 Mesh** —— 48×48 = 2304 个柱子，
      //   每个一个 Mesh 会是 2304 次 draw call ⟹ 帧率直接掉到个位数。
      //   InstancedMesh 是**一次** draw call。
      const geo = new THREE.BoxGeometry(0.62, 1, 0.62);
      const mat = new THREE.MeshStandardMaterial({
        roughness: 0.45, metalness: 0.15,
      });
      grid = new THREE.InstancedMesh(geo, mat, cols * rows);
      // ⚠️ 每帧要改 matrix ⟹ 必须声明 dynamic，否则 three 会警告且可能不更新
      grid.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      // ⚠️ 逐实例颜色要显式建 —— 不建的话 setColorAt 会抛
      grid.instanceColor = new THREE.InstancedBufferAttribute(
        new Float32Array(cols * rows * 3), 3);
      ctx.scene.add(grid);

      baseColor = new THREE.Color();

      // 相机：俯视一点，能看到网格的起伏
      ctx.camera.position.set(0, 15, 26);
      ctx.camera.lookAt(0, 0, 0);
    },

    // ⚠️ 参数变了要重建（`gridSize` 改了实例数就变了）
    reconfig(ctx) {
      if (!grid) return;
      const before = cols;
      config(ctx);
      if (cols !== before) {
        ctx.scene.remove(grid);
        grid.geometry.dispose();
        grid.material.dispose();
        this.build(ctx);
      }
    },

    frame(ctx) {
      if (!grid) return;
      const { THREE, audio, opts, t } = ctx;
      const intensity = (opts.intensity !== undefined ? opts.intensity : 1) * 1.6;

      // ── 低频触发涟漪
      if (audio.bass > 0.42 && ripples.length < 6) {
        // ⚠️ 位置由**音频和时间**决定，不是 Math.random —— 随机的话每次触发
        //   位置乱跳，看起来是噪点而不是"从某处扩散开"
        const a = t * 1.7;
        ripples.push({ x: Math.cos(a) * cols * 0.22, z: Math.sin(a) * rows * 0.22, r: 0, life: 1 });
      }
      for (const rp of ripples) { rp.r += ctx.dt * 14; rp.life -= ctx.dt * 0.55; }
      ripples = ripples.filter((rp) => rp.life > 0);

      // ── 主色：跟着封面走（拿不到就用参数里的）
      const c = ctx.track.primaryColor || opts.accent || [0.33, 0.84, 0.98];

      const half = (cols - 1) / 2;
      let i = 0;
      for (let gz = 0; gz < rows; gz += 1) {
        for (let gx = 0; gx < cols; gx += 1, i += 1) {
          const x = (gx - half) * 0.72;
          const z = (gz - half) * 0.72;
          const dist = Math.hypot(gx - half, gz - half);

          // ⚠️ 频段按**距中心的距离**取 —— 那让低频在中间、高频在外圈，
          //   而那正是"音域地形"的观感（同一个频段铺满全场是平的）
          const bin = Math.min(63, Math.floor(dist / (cols * 0.5) * 40));
          let h = 0.25 + audio.bins[bin] * 14 * intensity;

          // 空闲呼吸：没音乐时也要动（否则看起来像坏了）
          h += Math.sin(t * 1.1 + dist * 0.34) * 0.34;

          // 涟漪：柱子被推起来
          for (const rp of ripples) {
            const d = Math.abs(Math.hypot(x - rp.x, z - rp.z) - rp.r);
            if (d < 2.4) h += (2.4 - d) * 1.5 * rp.life;
          }
          h = Math.max(0.16, h);

          dummy.m.position.set(x, h / 2, z);
          dummy.m.scale.set(1, h, 1);
          dummy.m.updateMatrix();
          grid.setMatrixAt(i, dummy.m.matrix);

          // 颜色：高的更亮（HSL 的 L 跟高度走）
          const lum = Math.min(0.72, 0.24 + h * 0.055);
          baseColor.setRGB(c[0], c[1], c[2]);
          baseColor.multiplyScalar(0.5 + lum);
          grid.setColorAt(i, baseColor);
        }
      }
      // ⚠️⚠️ **必须置 needsUpdate** —— 不置的话 GPU 上还是上一帧的数据，
      //   症状是"画面完全静止"而没有任何报错。
      grid.instanceMatrix.needsUpdate = true;
      if (grid.instanceColor) grid.instanceColor.needsUpdate = true;

      // 相机：鼠标拖拽转视角 + 中频轻微推近
      const yaw = 0.0006 * ctx.pointer.dragX;
      const rad = 26 - audio.mid * 2.5;
      ctx.camera.position.x = Math.sin(yaw) * rad;
      ctx.camera.position.z = Math.cos(yaw) * rad;
      ctx.camera.position.y = 15 - ctx.pointer.dragY * 0.012;
      ctx.camera.lookAt(0, 0, 0);
    },
  };
})();
