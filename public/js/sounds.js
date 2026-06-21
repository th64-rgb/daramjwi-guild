const SoundManager = (() => {
  let enabled = localStorage.getItem('omok_sound') !== 'off';
  let ctx = null;

  function getCtx() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    return ctx;
  }

  function tone(freq, duration, type = 'sine', vol = 0.15) {
    if (!enabled) return;
    try {
      const ac = getCtx();
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(vol, ac.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + duration);
      osc.connect(gain);
      gain.connect(ac.destination);
      osc.start();
      osc.stop(ac.currentTime + duration);
    } catch (_) { /* ignore */ }
  }

  return {
    isEnabled: () => enabled,
    toggle() {
      enabled = !enabled;
      localStorage.setItem('omok_sound', enabled ? 'on' : 'off');
      if (enabled) this.place();
      return enabled;
    },
    place() { tone(440, 0.08, 'sine', 0.12); },
    win() {
      if (!enabled) return;
      [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => tone(f, 0.2, 'sine', 0.18), i * 120));
    },
    notify() { tone(330, 0.12, 'triangle', 0.1); },
    error() { tone(180, 0.15, 'square', 0.08); },
    tick() { tone(800, 0.03, 'sine', 0.05); },
  };
})();