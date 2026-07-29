// 图库：用户上传的素材。
//
// 为什么要有它，而不是每次现选文件：三张图要反复换着试（换个主体、换个碎片看哪个搭），
// 而每次都开文件对话框翻到那个目录是纯摩擦。图库让"我攒了一批素材"这件事成立。
//
// 存路径不存副本：用户挑的是他自己的文件，拷一份进 userData 会在他编辑原图之后
// 悄悄变成旧的。代价是文件被移走/删掉后条目失效，所以有 `missing` 标记而不是
// 静默不显示 —— 一个消失的条目比一个标着"文件不在了"的条目更难查。
//
// 无 DOM、无 Electron，能跑纯逻辑用例。
(function (root) {

// 素材归到哪个槽位。`any` 是没标注的：用户可能上传一批图，之后才决定哪张当主体。
const SLOTS = ['background', 'subject', 'shard'];

function idOf(filePath) {
  // 路径本身当 id。同一个文件加两次应该是同一个条目而不是两条 —— 用递增数字当 id
  // 就做不到这一点，而"我怎么有两张一样的图"是会真的发生的困惑。
  return String(filePath || '');
}

function nameOf(filePath) {
  const parts = String(filePath || '').split('/');
  return parts[parts.length - 1] || '未命名';
}

// 新增素材。已存在就更新它的槽位标注，不新增一条。
function add(items, filePath, slot) {
  const id = idOf(filePath);
  if (!id) return items;
  const next = items.filter((item) => item.id !== id);
  const existing = items.find((item) => item.id === id);
  return [
    ...next,
    {
      id,
      path: filePath,
      name: nameOf(filePath),
      slot: slot || (existing && existing.slot) || 'any',
      addedAt: (existing && existing.addedAt) || 0,
    },
  ];
}

function remove(items, id) {
  return items.filter((item) => item.id !== id);
}

function setSlot(items, id, slot) {
  return items.map((item) => (item.id === id ? { ...item, slot } : item));
}

// 某个槽位能用的素材：标了这个槽位的，加上没标注的。
//
// 把 `any` 也算进来是刻意的：上传时逼用户先决定"这是主体还是碎片"是多余的一步，
// 而很多图两个槽位都能用（一张脸既能当主体也能切成碎片）。
function forSlot(items, slot) {
  return items.filter((item) => item.slot === slot || item.slot === 'any');
}

// 标出哪些文件已经不在了。`exists` 由调用方注入（主进程用 fs），所以这个函数本身
// 仍然是纯的、可测的。
function markMissing(items, exists) {
  return items.map((item) => ({ ...item, missing: !exists(item.path) }));
}

root.GestureWallLibrary = {
  SLOTS,
  idOf,
  nameOf,
  add,
  remove,
  setSlot,
  forSlot,
  markMissing,
};
})(typeof window === 'undefined' ? globalThis : window);
