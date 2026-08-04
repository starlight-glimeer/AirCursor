#!/usr/bin/env node
// scene 类壁纸的**批量审计** —— 渲染器开发的主要工具。
//
//   node wallpaper/scripts/scene-audit.js <目录或壁纸根目录> [...]
//   node wallpaper/scripts/scene-audit.js ~/Documents/DreamPaper/Wallpapers
//
// ⚠️⚠️⚠️ **为什么要有这个**（用户 2026-08-04 定的协作模型）：
//   「其实就是我给你很多壁纸，然后我看效果，你来优化开发渲染器，
//     以此实现 mac 版本适配 steam 的 wallpaper」
//
// ⟹ 而在这个模型下，**一次往返要能覆盖很多张**，不是一张。
//   ⚠️ 我前面那七轮每次只验一张：用户打包→安装→点开→截图→我改一行。
//     而每一轮都发现一个**新的格式形状**（属性包装 / 变换树 / 贴图链 /
//     TEXB 容器 / flipY / camera.eye）—— 那些**全都能在解析层就看出来**，
//     根本不用等真机。
//   ⟹ 判据：**真机只该用来验"画出来对不对"，不该用来发现"格式长什么样"。**
//
// ⚠️ 所以这个脚本做的是：把一批壁纸的**格式形状**全部摊开，
//   自动标出"我们还不认识的东西" —— 那才是渲染器下一步该做什么的依据。
//
// ⚠️⚠️ 它**只读**（用户：「不动壁纸本身」）。

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const S = require(path.join(__dirname, '..', 'src', 'scene-pkg.js'));

// ── 找壁纸目录（有 project.json 的）
function findWallpapers(root, depth = 0, out = []) {
  if (depth > 3) return out;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  if (entries.some((e) => e.isFile() && e.name === 'project.json')) {
    out.push(root);
    return out;   // ⚠️ 找到就停，不进壁纸内部
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    findWallpapers(path.join(root, e.name), depth + 1, out);
  }
  return out;
}

// ── 审计一张
function auditOne(dir) {
  const r = { dir, name: path.basename(dir) };
  let pj;
  try { pj = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8')); }
  catch (e) { r.error = `project.json: ${e.message}`; return r; }
  r.type = String(pj.type || '').toLowerCase();
  r.title = pj.title;
  if (r.type !== 'scene') { r.skip = `type=${r.type}`; return r; }

  // pkg 或散包
  const pkgPath = path.join(dir, 'scene.pkg');
  let buf = null;
  let pkg = null;
  if (fs.existsSync(pkgPath)) {
    buf = fs.readFileSync(pkgPath);
    pkg = S.parsePkg(buf);
    if (!pkg.ok) { r.error = `解包：${pkg.error}`; return r; }
    r.pkgVersion = pkg.version;
    r.entries = pkg.entries.length;
    r.bytes = buf.length;
    r.warnings = pkg.warnings;
  } else if (fs.existsSync(path.join(dir, 'scene.json'))) {
    r.loose = true;
  } else {
    r.error = '既没有 scene.pkg 也没有 scene.json';
    return r;
  }

  // scene.json
  let raw;
  if (pkg) {
    const name = ['scene.json', 'gifscene.json'].find(
      (n) => pkg.entries.some((e) => e.name === n));
    if (!name) { r.error = '包里没有 scene.json / gifscene.json'; return r; }
    r.sceneFile = name;
    raw = S.readEntry(buf, pkg, name).toString('utf8');
  } else {
    raw = fs.readFileSync(path.join(dir, 'scene.json'), 'utf8');
  }
  const sc = S.parseScene(raw);
  if (!sc.ok) { r.error = `解析 scene.json：${sc.error}`; return r; }
  S.flattenTransforms(sc);

  r.canvas = `${sc.canvas.width}×${sc.canvas.height}`;
  r.canvasSource = sc.canvas.source;
  r.objects = sc.objects.length;
  r.counts = sc.counts;
  r.skipped = sc.skipped.length;
  r.boundFields = sc.boundFields;
  r.transformWarnings = sc.transformWarnings || [];
  r.visibleSelf = sc.objects.filter(
    (o) => (o.kind === 'image' || o.kind === 'text') && o.visible).length;
  r.visibleTree = sc.objects.filter(
    (o) => (o.kind === 'image' || o.kind === 'text') && o.worldVisible).length;

  // ⚠️ 相机：那是我漏读过的字段
  const eye = String((sc.camera || {}).eye || '').trim().split(/\s+/).map(Number);
  r.cameraEye = eye.length >= 2 && eye.every(Number.isFinite)
    ? [eye[0], eye[1]] : null;
  r.zoom = Number((sc.general || {}).zoom);
  r.cameraParallax = S.unwrapValue((sc.general || {}).cameraparallax) === true;

  // ── 贴图链
  const readJson = (n) => {
    const b = pkg ? S.readEntry(buf, pkg, n) : (() => {
      const f = path.join(dir, n);
      return fs.existsSync(f) ? fs.readFileSync(f) : null;
    })();
    if (!b) return null;
    try { return JSON.parse(b.toString('utf8')); } catch { return null; }
  };
  r.tex = { ok: 0, composite: 0, failed: [] };
  r.containers = {};
  r.texFormats = {};
  r.compositeKinds = {};
  const seen = new Set();
  for (const o of sc.objects) {
    if (o.kind !== 'image' || !o.worldVisible) continue;
    if (seen.has(o.image)) continue;
    seen.add(o.image);
    if (!pkg) { r.tex.failed.push(`${o.name}（散包审计还没做）`); continue; }
    const res = S.resolveImageTexture(buf, pkg, o.image, readJson);
    if (res.composite) {
      r.tex.composite += 1;
      r.compositeKinds[res.composite] = (r.compositeKinds[res.composite] || 0) + 1;
      continue;
    }
    if (!res.ok) { r.tex.failed.push(`${o.name || o.id}：${res.error}`); continue; }
    const tb = S.readEntry(buf, pkg, res.texPath);
    const head = S.parseTexHeader(tb);
    if (!head.ok) { r.tex.failed.push(`${res.texPath}：${head.error}`); continue; }
    const body = S.parseTexData(tb, head);
    if (!body.ok) { r.tex.failed.push(`${res.texPath}：${body.error}`); continue; }
    // ⚠️⚠️ 走**完整解码**（不只是解头部）—— 那才是"这张贴图能不能画"的答案。
    //   ⚠️ 上一版只判 container 是不是 PNG/JPEG ⟹ 把 DXT/R8 那些
    //     全报成"还不支持"，而 0.9.160 已经支持了。
    const dec = S.decodeTexture(body);
    if (!dec.ok) { r.tex.failed.push(`${res.texPath}：${dec.error}`); continue; }
    r.tex.ok += 1;
    const key = dec.kind === 'rgba' ? dec.pixelFormat
      : (dec.kind === 'video' ? 'MP4' : body.container);
    r.containers[`${key}${body.isLZ4 ? '+LZ4' : ''}`]
      = (r.containers[`${key}${body.isLZ4 ? '+LZ4' : ''}`] || 0) + 1;
    r.texFormats[head.formatName] = (r.texFormats[head.formatName] || 0) + 1;
    // ⚠️ flags 和长度对不上的要报 —— 那是"我的格式判定还有缺口"
    if (body.pixelFormat && body.pixelAgreed === false) {
      r.unknown.push(`${res.texPath} 的 flags(${body.pixelByFlags})`
        + ` 和长度(${(body.pixelByLength || []).join('/')})对不上`);
    }
  }

  // ── effect：哪些能折、哪些要 shader
  r.effects = { folded: {}, shader: {} };
  r.audioBars = 0;
  for (const o of sc.objects) {
    if (!o.worldVisible) continue;
    if (o.audioBars) r.audioBars += 1;
    if (!o.fx) continue;
    for (const f of o.fx.folded) r.effects.folded[f] = (r.effects.folded[f] || 0) + 1;
    for (const n of o.fx.shaderNeeded) r.effects.shader[n] = (r.effects.shader[n] || 0) + 1;
  }

  // ── 字体
  r.fonts = { used: new Set(), packed: 0, system: 0, bytes: 0 };
  for (const o of sc.objects) {
    if (o.kind !== 'text' || !o.worldVisible || typeof o.font !== 'string') continue;
    if (r.fonts.used.has(o.font)) continue;
    r.fonts.used.add(o.font);
    if (/^fonts\//.test(o.font)) {
      r.fonts.packed += 1;
      const e = pkg && pkg.entries.find((x) => x.name === o.font);
      if (e) r.fonts.bytes += e.len;
    } else r.fonts.system += 1;
  }
  r.fonts.used = r.fonts.used.size;

  // ── ⚠️⚠️⚠️ **未知形状**：那才是渲染器下一步该做什么的依据
  r.unknown = [];
  if (!S.KNOWN_VERSIONS.includes(r.pkgVersion) && r.pkgVersion) {
    r.unknown.push(`没见过的归档版本 ${r.pkgVersion}`);
  }
  for (const [kind, n] of Object.entries(sc.counts)) {
    const lvl = S.RENDER_SUPPORT[kind];
    if (!lvl) r.unknown.push(`没见过的对象类型 ${kind}×${n}`);
    else if (lvl === 'none') r.unknown.push(`画不了的类型 ${kind}×${n}`);
  }
  // ⚠️ 0.9.160 起 PNG/JPEG/DXT/R8/RG88/RGBA/MP4 全支持
  //   ⟹ 这里只报**真的解不出来**的（`decodeTexture` 失败那些进 tex.failed）
  // ⚠️ 混合模式：编号→模式的映射我没有权威来源 ⟹ 见到的都要记
  r.blendModes = {};
  for (const o of sc.objects) {
    if (!o.worldVisible || !o.blendMode) continue;
    r.blendModes[o.blendMode] = (r.blendModes[o.blendMode] || 0) + 1;
  }
  const cap = S.renderability(sc);
  r.coverage = cap.coverage;
  r.summary = cap.summary;
  return r;
}

// ── 跑
const roots = process.argv.slice(2);
if (!roots.length) {
  console.error('用法：node wallpaper/scripts/scene-audit.js <壁纸目录> [...]');
  process.exit(1);
}
const dirs = [];
for (const root of roots) {
  const abs = path.resolve(root.replace(/^~/, process.env.HOME || '~'));
  if (fs.existsSync(path.join(abs, 'project.json'))) dirs.push(abs);
  else findWallpapers(abs).forEach((d) => dirs.push(d));
}
if (!dirs.length) { console.error('没找到任何带 project.json 的目录'); process.exit(1); }

const results = dirs.map(auditOne);
const scenes = results.filter((r) => r.type === 'scene' && !r.error);

console.log(`\n扫了 ${dirs.length} 个壁纸目录，其中 scene 类 ${scenes.length} 个`
  + `，其他 ${results.filter((r) => r.skip).length} 个`
  + `，出错 ${results.filter((r) => r.error).length} 个`);

for (const r of results.filter((x) => x.error)) {
  console.log(`\n⚠️ ${r.name}：${r.error}`);
}

for (const r of scenes) {
  console.log(`\n${'═'.repeat(72)}`);
  console.log(`${r.title || r.name}`);
  console.log(`  ${r.pkgVersion || '散包'} · ${r.entries || '?'} 条目 · `
    + `${r.bytes ? `${(r.bytes / 1048576).toFixed(1)}MB` : '?'} · 画布 ${r.canvas}`
    + `${r.canvasSource.includes('默认') ? ' ⚠️（读不到，用了默认）' : ''}`);
  console.log(`  对象 ${r.objects}：`
    + Object.entries(r.counts).map(([k, v]) => `${k}×${v}`).join(' ')
    + `${r.skipped ? `  ⚠️ 不认识 ${r.skipped} 个` : ''}`);
  console.log(`  可见 ${r.visibleSelf} → 继承后 ${r.visibleTree}`
    + `　绑定字段 ${r.boundFields}`);
  console.log(`  相机 eye=${r.cameraEye ? r.cameraEye.map((v) => v.toFixed(0)) : '?'}`
    + ` zoom=${r.zoom} 视差=${r.cameraParallax ? '开' : '关'}`);
  console.log(`  贴图 ${r.tex.ok} 张（${Object.entries(r.containers).map(([k, v]) => `${k}×${v}`).join(' ') || '无'}）`
    + `　合成层 ${r.tex.composite}`
    + `${Object.keys(r.compositeKinds).length ? `（${Object.keys(r.compositeKinds).join('/')}）` : ''}`);
  if (r.tex.failed.length) {
    console.log(`  ⚠️ 贴图失败 ${r.tex.failed.length}：${r.tex.failed.slice(0, 3).join(' | ')}`);
  }
  console.log(`  字体 ${r.fonts.used} 种（包内 ${r.fonts.packed}·${(r.fonts.bytes / 1048576).toFixed(1)}MB`
    + ` / 系统 ${r.fonts.system}）　音频柱 ${r.audioBars}`);
  const fold = Object.entries(r.effects.folded);
  const sh = Object.entries(r.effects.shader).sort((a, b) => b[1] - a[1]);
  console.log(`  effect 折进材质 ${fold.reduce((n, [, v]) => n + v, 0)}`
    + `　要 shader ${sh.reduce((n, [, v]) => n + v, 0)}`
    + `${sh.length ? `：${sh.slice(0, 6).map(([k, v]) => `${k}×${v}`).join(' ')}` : ''}`);
  if (Object.keys(r.blendModes).length) {
    console.log(`  ⚠️ colorBlendMode: ${Object.entries(r.blendModes).map(([k, v]) => `${k}×${v}`).join(' ')}`
      + '（编号→模式的映射还没坐实）');
  }
  console.log(`  覆盖率 ${(r.coverage * 100).toFixed(0)}%`);
  if (r.transformWarnings.length) {
    console.log(`  ⚠️ 变换树：${r.transformWarnings.join(' / ')}`);
  }
  if (r.unknown.length) {
    console.log(`  ⚠️⚠️ 未知/缺口：${r.unknown.join(' · ')}`);
  }
}

// ── ⚠️⚠️⚠️ 汇总：**这才是"渲染器下一步做什么"的依据**
console.log(`\n${'═'.repeat(72)}`);
console.log('汇总 —— 按"影响多少张壁纸"排序（那是优先级）\n');

const agg = (pick) => {
  const m = {};
  for (const r of scenes) {
    for (const [k, v] of Object.entries(pick(r) || {})) {
      if (!m[k]) m[k] = { walls: 0, uses: 0 };
      m[k].walls += 1;
      m[k].uses += v;
    }
  }
  return Object.entries(m).sort((a, b) => b[1].walls - a[1].walls || b[1].uses - a[1].uses);
};

const shaderNeed = agg((r) => r.effects.shader);
if (shaderNeed.length) {
  console.log('要 shader 的 effect：');
  for (const [k, v] of shaderNeed) {
    console.log(`  ${String(k).padEnd(28)} ${v.walls}/${scenes.length} 张 · 共 ${v.uses} 处`);
  }
}
const kinds = agg((r) => {
  const o = {};
  for (const [k, n] of Object.entries(r.counts)) {
    if (S.RENDER_SUPPORT[k] !== 'full' && S.RENDER_SUPPORT[k] !== 'skip') o[k] = n;
  }
  return o;
});
if (kinds.length) {
  console.log('\n画不了的对象类型：');
  for (const [k, v] of kinds) {
    console.log(`  ${String(k).padEnd(28)} ${v.walls}/${scenes.length} 张 · 共 ${v.uses} 个`);
  }
}
const comp = agg((r) => r.compositeKinds);
if (comp.length) {
  console.log('\n合成层（内置模型）：');
  for (const [k, v] of comp) {
    console.log(`  ${String(k).padEnd(28)} ${v.walls}/${scenes.length} 张 · 共 ${v.uses} 个`);
  }
}
const cont = agg((r) => r.containers);
console.log('\n贴图解码后的类型（全部已支持 —— 0.9.160）：');
for (const [k, v] of cont) {
  console.log(`  ✅ ${String(k).padEnd(26)} ${v.walls}/${scenes.length} 张 · 共 ${v.uses} 张`);
}
const bm = agg((r) => r.blendModes);
if (bm.length) {
  console.log('\n⚠️ colorBlendMode 见到的取值（映射还没坐实）：');
  for (const [k, v] of bm) console.log(`  ${String(k).padEnd(28)} ${v.walls} 张 · ${v.uses} 处`);
}
const vers = {};
for (const r of scenes) vers[r.pkgVersion || '散包'] = (vers[r.pkgVersion || '散包'] || 0) + 1;
console.log('\n归档版本：' + Object.entries(vers).map(([k, v]) => `${k}×${v}`).join(' '));

const covs = scenes.map((r) => r.coverage).sort((a, b) => a - b);
if (covs.length) {
  const med = covs[Math.floor(covs.length / 2)];
  console.log(`\n覆盖率：最低 ${(covs[0] * 100).toFixed(0)}%`
    + ` · 中位 ${(med * 100).toFixed(0)}%`
    + ` · 最高 ${(covs[covs.length - 1] * 100).toFixed(0)}%`);
}
const broke = scenes.filter((r) => r.tex.failed.length);
if (broke.length) {
  console.log(`\n⚠️⚠️ ${broke.length} 张有贴图解析失败 —— 那是**真缺口**（不是能力边界）：`);
  for (const r of broke) {
    console.log(`  ${r.name}：${r.tex.failed.slice(0, 2).join(' | ')}`);
  }
}
console.log('');
