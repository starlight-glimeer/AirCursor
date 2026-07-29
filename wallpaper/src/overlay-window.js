// 骨架窗口的接线。绘制逻辑在 overlay.js，这里只负责收消息、驱动帧循环、管录制提示条。
const T = window.GestureWallTemplates;
const overlay = new window.GestureWallOverlay.HandOverlay(document.getElementById('hands'));

const banner = document.getElementById('banner');
const bannerAction = document.getElementById('banner-action');
const bannerPhase = document.getElementById('banner-phase');
const bannerCount = document.getElementById('banner-count');
const bannerFill = document.getElementById('banner-fill');

const PHASE_LABEL = {
  countdown: '摆好姿势',
  capture: '保持不动',
  ready: '现在做一遍动作',
  move: '做动作，做完停住',
};

function syncSize() {
  overlay.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio);
  // 每次尺寸变化都把自检结果报给主进程,由面板显示。
  //
  // 为什么要报出来:骨架位置错了两轮都没定位到,因为我手上只有"手在数据里的位置",没有
  // "骨架落在屏幕哪个像素"。而后者要跨三层(缓冲/CSS/DPR),缺任何一层都看不出问题在哪。
  if (window.gw && window.gw.reportOverlayGeometry) {
    window.gw.reportOverlayGeometry(overlay.selfCheck());
  }
}
window.addEventListener('resize', syncSize);
syncSize();

// 画不画由 config 决定。
//
// 窗口的存在条件是"手势开着"(因为摄像头在这一层),而"显示骨架"这个开关只控制画不画 ——
// 两件事分开之后,关掉骨架不会连摄像头一起关掉。窗口本来就是全屏透明的,不画就等于不存在。
let showSkeleton = true;
window.gw.onConfig((next) => {
  // 录制时强制显示:那是唯一必须看见手的时刻,而"我关了骨架所以录制时什么都看不到"
  // 不是用户会预期的后果。
  showSkeleton = !!(next && (next.showHands || overlay.recording));
});

// 每帧都画：骨架有淡出和呼吸，只在收到消息时画会一顿一顿。
function frame(now) {
  if (showSkeleton || overlay.recording) overlay.draw(now);
  else overlay.clear();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// 同窗口直喂的入口。sensor.js 现在就在这一层,所以它直接调这个而不是走 IPC ——
// 30/s 的消息绕出进程再绕回来是白付的成本。
window.__gwOverlay = { ingest: (payload) => overlay.update(payload, performance.now()) };
// IPC 那条保留:骨架层将来可能有别的进程要喂它(比如回放录好的关键点)。
window.gw.onHands((payload) => overlay.update(payload, performance.now()));

// ---------------------------------------------------------------------------
// 录制提示条
//
// 骨架回答"手在哪"，这个回答"现在该做什么"。两个都要，因为录制时 dashboard 可能不在
// 视线里 —— 而"保持不动""现在做一遍动作"这类指令错过了就录不成。
// ---------------------------------------------------------------------------
window.gw.onRecordingProgress((p) => {
  if (!p) return;
  banner.classList.add('on');
  const meta = T.ACTIONS[p.action];
  bannerAction.textContent = meta ? `录制「${meta.label}」` : '录制中';
  bannerPhase.textContent = p.hint || PHASE_LABEL[p.phase] || '';
  bannerCount.textContent = p.countdown ? String(p.countdown) : '';
  bannerFill.style.width = `${Math.round((p.progress || 0) * 100)}%`;
});

window.gw.onRecordingResult((r) => {
  // 结果留一下再消失：立刻隐藏的话，成功/失败这个信息只在屏幕上存在一帧。
  if (r && r.ok) {
    bannerAction.textContent = '✅ 录好了';
    bannerPhase.textContent = '';
    bannerCount.textContent = '';
    bannerFill.style.width = '100%';
  } else if (r && !r.cancelled) {
    bannerAction.textContent = '❌ 没录上';
    bannerPhase.textContent = r.conflictWith ? '和已有手势太像' : (r.error || '');
    bannerCount.textContent = '';
    bannerFill.style.width = '0%';
  }
  setTimeout(() => banner.classList.remove('on'), r && r.cancelled ? 0 : 1600);
});
