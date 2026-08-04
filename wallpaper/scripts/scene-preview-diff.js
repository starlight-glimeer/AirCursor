#!/usr/bin/env node
// ⚠️⚠️⚠️ **拿作者的 preview 当真值，量我们的渲染差多少**（0.9.162）
//
//   node wallpaper/scripts/scene-preview-diff.js <壁纸目录> [...]
//
// 用户 2026-08-04：「有什么你不确定的你就探针呗，拿真机数据你不就知道怎么做了」
//
// ⚠️⚠️ 而这里有一份**我一直没用起来的真值**：每张壁纸都带 `preview.gif` ——
//   那是作者在 WE 里渲染出来的，等于"这张壁纸该长什么样"的标准答案。
//
// ⟹ 判据：**不确定的时候先找真值，而真值往往已经在输入里。**
//   我前面几轮靠"用户看一眼说哪里不对"来发现问题（黑块 / 上下颠倒 / 偏位置），
//   而那些**全都能从 preview 对照里量出来**：
//     · 上下颠倒 ⟹ 上下半边的亮度分布反了
//     · 一块黑色 ⟹ 近黑占比比 preview 高一大截
//     · 位置偏 ⟹ 亮度重心偏移
//     · 偏色 ⟹ 色相/饱和度中位数差很远
//
// ⚠️ 这个脚本**只做量化**（云端能跑的那一半）：
//   它量 preview 的指标，并给出"我们该匹配到什么范围"。
//   ⚠️⚠️ 而"我们实际渲染成什么样"要真机截帧 ⟹ 那部分在 main.js 的
//     `probeScene`（面板上有按钮），两边用**同一套指标**才能对账。
//
// ⚠️ 只读（用户：「不动壁纸本身」）。

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const os = require('node:os');

// ⚠️ 和 main.js 的探针**同一套指标** —— 不然两边的数字没法比。
//   ⟹ 这份实现是"规格"，而 main.js 那边要和它一致（守卫核对）。
const METRICS = {
  nearBlack: '近黑占比（亮度<0.12 的像素比例）',
  highlight: '高亮占比（亮度>0.75）',
  bandTop: '上三分之一的平均亮度',
  bandMid: '中间三分之一',
  bandBottom: '下三分之一',
  satMedian: '饱和度中位数',
  lumMean: '平均亮度',
  lumStd: '亮度标准差（画面的明暗对比）',
  centroidX: '亮度重心 X（0=左 1=右）',
  centroidY: '亮度重心 Y（0=上 1=下）',
  frameDelta: '帧间变化率（相邻帧的平均像素差）',
};

// 抽帧 → 32×32 RGB
function grabFrames(file, count) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-preview-'));
  try {
    // ⚠️ 缩到 32×32：指标全是统计量，不需要分辨率
    //   ⚠️ 而 `-vsync 0` 保证按帧取（gif 的帧间隔不均匀）
    execFileSync('ffmpeg', ['-v', 'error', '-i', file,
      '-vf', `fps=4,scale=32:32:flags=area`, '-vsync', '0',
      '-frames:v', String(count), path.join(dir, 'f%03d.ppm')], { stdio: 'pipe' });
    const out = [];
    for (const n of fs.readdirSync(dir).sort()) {
      const buf = fs.readFileSync(path.join(dir, n));
      // PPM P6: "P6\n32 32\n255\n" + 数据
      const head = buf.toString('latin1', 0, 32);
      const m = /^P6\s+(\d+)\s+(\d+)\s+(\d+)\s/.exec(head);
      if (!m) continue;
      const w = +m[1];
      const h = +m[2];
      out.push({ w, h, data: buf.slice(m[0].length) });
    }
    return out;
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清不掉就算了 */ }
  }
}

// ⚠️ 一帧的指标
function frameMetrics(f) {
  const n = f.w * f.h;
  const lum = new Array(n);
  const sat = [];
  let nearBlack = 0;
  let highlight = 0;
  const bands = [0, 0, 0];
  const bandN = [0, 0, 0];
  let cx = 0;
  let cy = 0;
  let cw = 0;
  for (let i = 0; i < n; i += 1) {
    const r = f.data[i * 3] / 255;
    const g = f.data[i * 3 + 1] / 255;
    const b = f.data[i * 3 + 2] / 255;
    // ⚠️ 用感知亮度（不是算术平均）—— 绿色对亮度的贡献远大于蓝色
    const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    lum[i] = L;
    if (L < 0.12) nearBlack += 1;
    if (L > 0.75) highlight += 1;
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    sat.push(mx > 0 ? (mx - mn) / mx : 0);
    const y = Math.floor(i / f.w);
    const bi = Math.min(2, Math.floor(y / (f.h / 3)));
    bands[bi] += L;
    bandN[bi] += 1;
    const x = i % f.w;
    cx += x * L; cy += y * L; cw += L;
  }
  sat.sort((a, b) => a - b);
  const mean = lum.reduce((a, b) => a + b, 0) / n;
  const std = Math.sqrt(lum.reduce((a, L) => a + (L - mean) ** 2, 0) / n);
  return {
    nearBlack: +(nearBlack / n).toFixed(3),
    highlight: +(highlight / n).toFixed(3),
    bandTop: +(bands[0] / Math.max(1, bandN[0])).toFixed(3),
    bandMid: +(bands[1] / Math.max(1, bandN[1])).toFixed(3),
    bandBottom: +(bands[2] / Math.max(1, bandN[2])).toFixed(3),
    satMedian: +sat[Math.floor(sat.length / 2)].toFixed(3),
    lumMean: +mean.toFixed(3),
    lumStd: +std.toFixed(3),
    centroidX: +(cw > 0 ? cx / cw / (f.w - 1) : 0.5).toFixed(3),
    centroidY: +(cw > 0 ? cy / cw / (f.h - 1) : 0.5).toFixed(3),
  };
}

// ⚠️⚠️ 多帧 ⟹ 加上"帧间变化"（那是"活不活"的唯一判据，单帧测不出）
function analyze(file, count = 12) {
  const frames = grabFrames(file, count);
  if (!frames.length) return { ok: false, error: '一帧都没抽出来（ffmpeg 认不认这个文件？）' };
  const per = frames.map(frameMetrics);
  const avg = {};
  for (const k of Object.keys(per[0])) {
    avg[k] = +(per.reduce((a, m) => a + m[k], 0) / per.length).toFixed(3);
  }
  // 帧间变化
  const deltas = [];
  for (let i = 1; i < frames.length; i += 1) {
    let d = 0;
    const a = frames[i - 1].data;
    const b = frames[i].data;
    const len = Math.min(a.length, b.length);
    for (let j = 0; j < len; j += 1) d += Math.abs(a[j] - b[j]);
    deltas.push(d / len);
  }
  avg.frameDelta = deltas.length
    ? +(deltas.reduce((x, y) => x + y, 0) / deltas.length).toFixed(2) : 0;
  avg.frameDeltaMin = deltas.length ? +Math.min(...deltas).toFixed(2) : 0;
  avg.frameDeltaMax = deltas.length ? +Math.max(...deltas).toFixed(2) : 0;
  return { ok: true, frames: frames.length, metrics: avg, perFrame: per };
}

// ── 跑
const args = process.argv.slice(2);
if (!args.length) {
  console.error('用法：node wallpaper/scripts/scene-preview-diff.js <壁纸目录|壁纸根目录>');
  process.exit(1);
}
function findWallpapers(root, depth = 0, out = []) {
  if (depth > 3) return out;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  if (entries.some((e) => e.isFile() && e.name === 'project.json')) { out.push(root); return out; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    findWallpapers(path.join(root, e.name), depth + 1, out);
  }
  return out;
}
const dirs = [];
for (const a of args) {
  const abs = path.resolve(a.replace(/^~/, process.env.HOME || '~'));
  if (fs.existsSync(path.join(abs, 'project.json'))) dirs.push(abs);
  else findWallpapers(abs).forEach((d) => dirs.push(d));
}

console.log(`\n作者 preview 的指标（那是"这张壁纸该长什么样"的真值）\n`);
console.log('  近黑  高亮  上带  中带  下带  饱和  亮度  σ     重心X 重心Y 帧变(min~max)  壁纸');
const all = [];
for (const dir of dirs) {
  let pj = {};
  try { pj = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8')); } catch { /* */ }
  const cand = [pj.preview, 'preview.gif', 'preview.jpg', 'preview.png']
    .filter(Boolean).map((n) => path.join(dir, n));
  const file = cand.find((f) => fs.existsSync(f));
  if (!file) { console.log(`  ⚠️ ${path.basename(dir).slice(0, 30)}：找不到 preview`); continue; }
  const r = analyze(file);
  if (!r.ok) { console.log(`  ⚠️ ${path.basename(dir).slice(0, 30)}：${r.error}`); continue; }
  const m = r.metrics;
  const p = (v, n = 5) => String(v).padEnd(n);
  console.log(`  ${p(m.nearBlack)} ${p(m.highlight)} ${p(m.bandTop)} ${p(m.bandMid)} `
    + `${p(m.bandBottom)} ${p(m.satMedian)} ${p(m.lumMean)} ${p(m.lumStd)} `
    + `${p(m.centroidX)} ${p(m.centroidY)} `
    + `${p(`${m.frameDelta}(${m.frameDeltaMin}~${m.frameDeltaMax})`, 15)}`
    + ` ${(pj.title || path.basename(dir)).slice(0, 26)}`);
  all.push({ dir: path.basename(dir), title: pj.title, metrics: m, frames: r.frames });
}

if (all.length > 1) {
  console.log(`\n${'─'.repeat(78)}`);
  console.log('这些数字怎么用：\n');
  console.log('  ⚠️ 我们渲染的同一张壁纸，指标该落在它自己 preview 的附近。');
  console.log('     偏差大的那一项直接指向 bug：');
  console.log('       近黑高很多      ⟹ 有图层没画出来，或者一块实心黑盖住了');
  console.log('       上下带反了      ⟹ 上下颠倒（那正是 flipY 那个 bug）');
  console.log('       重心偏          ⟹ 位置/相机偏移算错了');
  console.log('       饱和/亮度差很远  ⟹ 混合模式或者颜色解码错了');
  console.log('       帧变≈0 而真值>0 ⟹ 该动的没动（effect / 视差 / 音频柱）');
  console.log('');
  const rng = (k) => {
    const v = all.map((a) => a.metrics[k]).sort((x, y) => x - y);
    return `${v[0]} ~ ${v[v.length - 1]}`;
  };
  console.log(`  ${all.length} 张 preview 的分布（那是"scene 类壁纸长什么样"的先验）：`);
  for (const k of ['nearBlack', 'highlight', 'satMedian', 'lumMean', 'lumStd', 'frameDelta']) {
    console.log(`    ${k.padEnd(11)}${rng(k).padEnd(18)}${METRICS[k] || ''}`);
  }
}
console.log('');
