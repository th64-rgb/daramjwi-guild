// 배포 경로 자동 감지 (GitHub Pages 서브경로 등)
(function () {
  const path = window.location.pathname;
  const lastSlash = path.lastIndexOf('/');
  window.__BASE__ = lastSlash > 0 ? path.slice(0, lastSlash + 1) : '/';
})();