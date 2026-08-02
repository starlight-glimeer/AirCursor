// 生成一张壁纸的"配方"—— 枚举维度 + 避开已有组合。
//
// ⚠️⚠️⚠️ **这个文件是"防同质化"的实现**。用户 2026-08-02：
//   「我主要是不希望同质化很严重，同一种风格的是允许的，但是每次生成
//     给人感觉说这不是一样的吗，这就不行」
//
// ⚠️ 而**光在提示词里写"请多样化"不管用** —— LLM 有很强的默认偏好，
//   它会说好然后照样输出它偏爱的那几种。
//   （taste-skill 那份文档整章在讲这个，叫 anti-default discipline：
//    "Do not default to: AI-purple gradients, centered hero over dark mesh, …"）
//
// ⟹ 三层，而**第三层才是真正起作用的那个**：
//   ① 把"变化"拆成可枚举的维度（布局/音频映射/配色/运动/环境）
//   ② 每次**显式挑一组**，写进 project.json ⟹ 那让"这次是什么组合"可观测
//   ③ 生成时带上**最近几张的组合**，要求避开
//
// ⚠️ 判据：**"多样"要可观测才可控** —— 靠感觉判"像不像"没法调，
//   而知道"这两张的布局和配色都撞了"就能直接改。

'use strict';

// ---------------------------------------------------------------------------
// 维度表
// ---------------------------------------------------------------------------
//
// ⚠️ 每一项都要**能落到 Three.js 的具体写法上** —— 写"梦幻的"这种形容词
//   等于没约束（模型会把它翻译成它偏爱的那一种）。
//   ⟹ 所以每项后面那句是"怎么做"，不是"什么感觉"。
const DIMENSIONS = {
  // 元素怎么摆 —— 这是"第一眼"差别最大的一维
  layout: [
    ['grid', '平面网格：N×N 个柱体/方块铺在地面上，高度受音频驱动'],
    ['ring', '同心圆环：元素沿若干个半径不同的圆排列，半径受音频驱动'],
    ['spiral', '螺旋：元素沿一条向上盘旋的线排列'],
    ['sphere', '球面：元素均匀分布在球面上（用黄金角分布，别用经纬度 —— 那样两极会挤）'],
    ['tunnel', '隧道：元素沿 Z 轴向远处排成环形通道，相机在里面'],
    ['flow', '流场：粒子按一个噪声场的方向漂移（不是随机跳）'],
    ['column', '立柱林：高矮不一的细长柱体随机散布在地面（位置由索引决定，不是每帧随机）'],
    ['wave', '波面：一张细分的平面网格，顶点高度由音频 + 波函数决定'],
  ],
  // 音频映射到什么
  audioMap: [
    ['height', '低频→高度/长度，中频→颜色亮度，高频→细碎抖动'],
    ['radius', '低频→整体半径膨胀，中频→自转速度，高频→粒子迸发'],
    ['color', '低频→色相偏移，中频→饱和度，高频→白色闪点'],
    ['scatter', '低频→元素向外炸开，中频→回落速度，高频→轨迹拖尾'],
    ['rotate', '低频→整体倾倒角度，中频→局部自转，高频→抖动频率'],
    ['emit', '低频→发射新粒子，中频→粒子寿命，高频→发射角度扩散'],
  ],
  // 配色族 —— ⚠️ 每族给**具体的色值范围**，不是名字
  palette: [
    ['ice', '冰蓝到青（H 185-205，S 0.55-0.8，底色近黑偏蓝 #05070f）'],
    ['ember', '暖橙到深红（H 12-32，S 0.7-0.9，底色暖黑 #100806）'],
    ['neon', '洋红到紫（H 290-320，S 0.75-0.95，底色 #0a0510，对比强）'],
    ['forest', '青绿到黄绿（H 95-155，S 0.45-0.7，底色 #040d08）'],
    ['mono', '单色灰阶 + 一个高饱和点色（底色 #0a0a0c，点色随机一个 H）'],
    ['dusk', '深紫到橙的双色渐变（H 从 265 过渡到 25，底色 #0b0812）'],
    ['gold', '琥珀到奶白（H 38-52，S 0.35-0.75，底色 #0d0a04）'],
  ],
  // 运动规律
  motion: [
    ['breathe', '整体缓慢呼吸（周期 6-10 秒），音频叠在上面'],
    ['drift', '整体沿一个方向匀速漂移，到边界循环回来'],
    ['orbit', '相机绕场景慢速公转（周期 40 秒以上，别快 —— 那会晕）'],
    ['pulse', '静止为主，音频峰值触发一次性扩散（涟漪/冲击波）'],
    ['swirl', '整体绕中轴缓慢扭转，越远转得越慢（差速）'],
    ['settle', '元素持续下落又被音频顶起来（有重力感）'],
  ],
  // ⚠️⚠️ 环境 —— 这一维**最容易被忽略而它影响最大**（0.9.138 我把它锁死了，
  //   而"深蓝黑底 + 同一种打光"正是"这不是一样的吗"的主要来源）
  environment: [
    ['fogDeep', '浓雾近距（fog near 15 far 80）：只看得清近处，纵深强'],
    ['fogNone', '不用雾，靠元素本身的明暗分层'],
    ['topLight', '单顶光 + 弱环境光：元素上亮下暗，有体积感'],
    ['rimLight', '背面轮廓光（相机反方向的强平行光）+ 极弱正面光：剪影感'],
    ['twoTone', '两个方向、两种颜色的平行光（冷暖对撞）'],
    ['glowOnly', '不用真实灯光（材质自发光 MeshBasicMaterial）：扁平霓虹感'],
  ],
};

// ---------------------------------------------------------------------------
// 挑一组
// ---------------------------------------------------------------------------
//
// ⚠️⚠️ **不用 Math.random 直接挑** —— 那样"避开已有的"就没法保证。
//   ⟹ 打分：每个候选算"它和历史撞了几维"，取撞得最少的那些里随机一个。
//   ⚠️ 判据：**避重要算，不能靠随机的运气** ——
//     5 个维度各 6-8 项，随机两次撞 2 维的概率不低。
function pickRecipe(history, rnd) {
  const rand = rnd || Math.random;
  const keys = Object.keys(DIMENSIONS);
  const recent = (history || []).slice(-5);

  // 每一维单独挑：优先选"最近没用过的"
  const chosen = {};
  for (const key of keys) {
    const options = DIMENSIONS[key].map(([id]) => id);
    // ⚠️ 统计每个选项在最近几张里出现过几次
    const used = new Map();
    for (const h of recent) {
      const v = h && h[key];
      if (v) used.set(v, (used.get(v) || 0) + 1);
    }
    const minUse = Math.min(...options.map((o) => used.get(o) || 0));
    const fresh = options.filter((o) => (used.get(o) || 0) === minUse);
    chosen[key] = fresh[Math.floor(rand() * fresh.length)];
  }
  return chosen;
}

// 一组配方 → 喂给模型的文字
function describeRecipe(recipe) {
  const lines = [];
  for (const [key, list] of Object.entries(DIMENSIONS)) {
    const id = recipe[key];
    const found = list.find(([k]) => k === id);
    if (found) lines.push(`  ${key} = ${id}：${found[1]}`);
  }
  return lines.join('\n');
}

// ⚠️ 历史里已经用过的组合，用来告诉模型"别再来一遍"
function describeHistory(history) {
  const recent = (history || []).slice(-5);
  if (!recent.length) return '（这是第一张，没有历史）';
  return recent.map((h, i) => {
    const parts = Object.keys(DIMENSIONS).map((k) => `${k}=${h[k] || '?'}`);
    return `  ${i + 1}. ${parts.join(' ')}`;
  }).join('\n');
}

// ⚠️ 两组配方撞了几维 —— 面板上"这两张太像了"时用它定位
function collide(a, b) {
  return Object.keys(DIMENSIONS).filter((k) => a && b && a[k] === b[k]);
}

module.exports = { DIMENSIONS, pickRecipe, describeRecipe, describeHistory, collide };
