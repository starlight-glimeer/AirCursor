// 跑全部纯逻辑用例。任何一个失败整体 exit 非 0。
//
//   node test/run.js
//
// 每个用例文件单独一个子进程：它们都往 globalThis 挂 THREE 替身和模块，同进程跑
// 会互相污染，而"上一个测试改了全局导致下一个失败"是最难查的那类失败。
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const dir = __dirname;
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort();

// ⚠️ 「环境没装好」和「测试真的失败」要分开报。
//
// 实测踩到：新 worktree 里没跑过 `npm run vendor` ⟹ `input.test.js` /
// `recorder.test.js` 提前退出，而这里报的是「❌ 2/17 个文件有失败」——
// **那句话会让人去找代码 bug，而真相是环境没装好**。
//
// 判成败仍然一律看退出码（用输出内容判会漏掉"根本没跑起来"这一类，
// 那两个文件提前 exit、压根没打过 ✗）。这里只是把原因分类。
const NOT_READY = /缺 src\/vendor|npm run vendor|Cannot find module/;

let failed = 0;
let notReady = 0;
const notReadyFiles = [];
for (const file of files) {
  // stdio: 'pipe' 而不是 inherit —— 要读输出才能分类。读完原样打出来，
  // 所以用户看到的东西不变。
  const result = spawnSync(process.execPath, [path.join(dir, file)], { encoding: 'utf8' });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  if (result.status === 0) continue;
  if (NOT_READY.test(`${result.stdout || ''}${result.stderr || ''}`)) {
    notReady += 1;
    notReadyFiles.push(file);
  } else {
    failed += 1;
  }
}

// ⚠️ 顺序:先报绿的部分,**警告放最后一行**。
//
// 第一版把警告打在前面、`✅ 其余 15 个文件全绿` 打在后面 ⟹ 而我们俩这一整轮都在用
// `node test/run.js | tail -2` 看结果 ⟹ **那正好只看到绿的那行**,把"环境没装好"读成
// 通过了。和 `|| echo` 掩盖退出码是同一个形状:结论在视野外。
// ⚠️ **最坏的情况要打在最后**，因为所有人（包括我们两个 agent）都在用
// `node test/run.js | tail -2` 看结果 —— 落在视野外的结论等于没报。
//
// 三种情况的优先级：真失败 > 环境没装好 > 全绿。
//
// 实测过的两个坑：
//   ① 警告打在绿色结论之前 ⟹ 缺 vendor 时 `tail -2` 只看到「✅ 其余 15 个全绿」
//   ② 只把警告挪到最后 ⟹ **两种问题同时存在**时，`tail -2` 只看到「缺 vendor」，
//      而那条真失败被推出视野 ⟹ 你去跑 npm run vendor，然后以为好了。
//      ⚠️ 这是最坏的组合，而它需要两个条件同时成立才暴露 —— 单独验任一种都是绿的。
if (notReady) {
  console.log(`\n⚠️ ${notReady} 个文件跑不起来（环境没装好，不是测试失败）：`
    + `${notReadyFiles.join(', ')}\n   先跑 npm run vendor`);
}
// 真失败最后打，压在所有其它输出上面。
console.log(failed ? `\n❌ ${failed}/${files.length} 个文件有失败\n`
  // ⚠️ 最后这句要**自带可操作的指令**，不能依赖上面那行 ——
  // `| tail -2` 只看得到最后一句，而"没跑"三个字不告诉人该干什么。
  : (notReady ? `\n⚠️ ${notReady} 个文件没跑起来（先跑 npm run vendor），`
    + `其余 ${files.length - notReady} 个全绿\n`
    : `\n✅ ${files.length} 个文件全绿\n`));
// ⚠️ 环境没装好也要非 0 退出 —— 否则 CI 会把"没跑"读成"通过"。
process.exit(failed || notReady ? 1 : 0);
