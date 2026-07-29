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

let failed = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, [path.join(dir, file)], { stdio: 'inherit' });
  if (result.status !== 0) failed += 1;
}

console.log(failed ? `\n❌ ${failed}/${files.length} 个文件有失败\n` : `\n✅ ${files.length} 个文件全绿\n`);
process.exit(failed ? 1 : 0);
