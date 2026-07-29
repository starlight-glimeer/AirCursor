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
}
window.addEventListener('resize', syncSize);
syncSize();

// 每帧都画：骨架有淡出和呼吸，只在收到消息时画会一顿一顿。
function frame(now) {
  overlay.draw(now);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

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
