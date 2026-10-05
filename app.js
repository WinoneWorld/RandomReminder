const $ = (selector) => document.querySelector(selector);
const focusCard = $('.focus-card');
const minRange = $('#minRange');
const maxRange = $('#maxRange');
const rangeSummary = $('#rangeSummary');
const rangeFill = $('#rangeFill');
const timerValue = $('#timerValue');
const ringProgress = $('#ringProgress');
const circumference = 2 * Math.PI * 139;
const DEFAULTS = { focusMinutes: 90, microSeconds: 10, longBreakMinutes: 20, cycles: 4, microEnabled: true, longEnabled: true, adaptiveEnabled: true };
const SOUND_IDS = ['soundFocusStart', 'soundReminder', 'soundMicroEnd', 'soundLongBreak'];
const SOUND_DEFAULTS = { soundFocusStart: 'soft', soundReminder: 'bell', soundMicroEnd: 'bell', soundLongBreak: 'double' };
const SOUND_PROFILES = {
  soft: [
    { frequency: 523.25, type: 'sine', duration: 0.82, volume: 0.18, attack: 0.12, start: 0 },
    { frequency: 659.25, type: 'sine', duration: 0.92, volume: 0.12, attack: 0.16, start: 0.18 }
  ],
  bell: [
    { frequency: 880, type: 'sine', duration: 0.9, volume: 0.2, attack: 0.008, start: 0 },
    { frequency: 1760, type: 'sine', duration: 0.52, volume: 0.055, attack: 0.006, start: 0 }
  ],
  double: [
    { frequency: 740, type: 'sine', duration: 0.14, volume: 0.21, attack: 0.006, start: 0 },
    { frequency: 988, type: 'sine', duration: 0.15, volume: 0.21, attack: 0.006, start: 0.34 }
  ],
  low: [
    { frequency: 196, type: 'triangle', duration: 0.58, volume: 0.3, attack: 0.025, start: 0 },
    { frequency: 392, type: 'sine', duration: 0.42, volume: 0.105, attack: 0.02, start: 0 }
  ],
  wood: [
    { frequency: 620, type: 'square', duration: 0.075, volume: 0.12, attack: 0.004, start: 0 },
    { frequency: 470, type: 'square', duration: 0.085, volume: 0.12, attack: 0.004, start: 0.19 }
  ],
  marimba: [
    { frequency: 523.25, type: 'triangle', duration: 0.25, volume: 0.2, attack: 0.008, start: 0 },
    { frequency: 659.25, type: 'triangle', duration: 0.25, volume: 0.19, attack: 0.008, start: 0.12 },
    { frequency: 783.99, type: 'triangle', duration: 0.32, volume: 0.18, attack: 0.008, start: 0.24 }
  ],
  water: [
    { frequency: 1174.66, endFrequency: 784, type: 'sine', duration: 0.58, volume: 0.17, attack: 0.025, start: 0 },
    { frequency: 1567.98, endFrequency: 1046.5, type: 'sine', duration: 0.38, volume: 0.045, attack: 0.02, start: 0.035 }
  ],
  digital: [
    { frequency: 880, type: 'square', duration: 0.09, volume: 0.105, attack: 0.004, start: 0 },
    { frequency: 1174.66, type: 'square', duration: 0.09, volume: 0.1, attack: 0.004, start: 0.14 },
    { frequency: 880, type: 'square', duration: 0.12, volume: 0.105, attack: 0.004, start: 0.28 }
  ],
  off: []
};

let state = 'idle';
let audioEnabled = true;
let settings = { ...DEFAULTS };
let sounds = { ...SOUND_DEFAULTS };
let focusRemaining = 0;
let phaseEndsAt = 0;
let nextReminderAt = 0;
let focusElapsedMs = 0;
let focusSegmentStartedAt = 0;
let toastTimeout = null;
let cycle = 1;
let audioContext;
let pausedFrom = 'focus';
let pausedPhaseRemaining = 0;
let remainingReminder = 0;

function focusMs() { return settings.focusMinutes * 60_000; }
function longBreakMs() { return settings.longBreakMinutes * 60_000; }
function microBreakMs() { return settings.microSeconds * 1000; }

function updateRange() {
  let low = Number(minRange.value);
  let high = Number(maxRange.value);
  if (low > high) {
    if (document.activeElement === minRange) high = low;
    else low = high;
    minRange.value = low;
    maxRange.value = high;
  }
  rangeSummary.textContent = `${low} – ${high}`;
  const left = ((low - 1) / 29) * 100;
  const right = ((high - 1) / 29) * 100;
  rangeFill.style.left = `${left}%`;
  rangeFill.style.width = `${Math.max(0, right - left)}%`;
  localStorage.setItem('intervalRange', JSON.stringify([low, high]));
  if (state === 'idle' || state === 'done') syncControls();
}

function randomReminderDelay() {
  const min = Number(minRange.value);
  const max = Number(maxRange.value);
  const uniform = Math.random();
  if (!settings.adaptiveEnabled || min === max) return (min + uniform * (max - min)) * 60_000;

  const duration = focusMs();
  const earlyWindow = Math.min(30 * 60_000, duration * 0.4);
  const lateWindow = Math.min(20 * 60_000, duration * 0.3);
  const elapsed = focusElapsedMs + (state === 'focus' ? Math.max(0, Date.now() - focusSegmentStartedAt) : 0);
  const isDensePhase = elapsed < earlyWindow || elapsed >= duration - lateWindow;
  // Keep the user's chosen bounds while skewing the random draw toward shorter
  // intervals early and late, and toward longer intervals in the middle.
  const position = isDensePhase ? Math.pow(uniform, 1.5) : Math.sqrt(uniform);
  return (min + position * (max - min)) * 60_000;
}

function formatTime(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}<span>:</span>${String(seconds).padStart(2, '0')}`;
}

function setTimer(ms, total) {
  timerValue.innerHTML = formatTime(ms);
  const progress = total > 0 ? 1 - ms / total : 0;
  ringProgress.style.strokeDasharray = String(circumference);
  ringProgress.style.strokeDashoffset = String(circumference * (1 - Math.max(0, Math.min(1, progress))));
}

function playSound(kind) {
  if (!audioEnabled) return;
  const tones = SOUND_PROFILES[sounds[kind] ?? 'off'] ?? [];
  if (!tones.length) return;
  try {
    audioContext ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === 'suspended') audioContext.resume();
    const now = audioContext.currentTime;
    tones.forEach((tone) => {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      const startAt = now + tone.start;
      oscillator.type = tone.type;
      oscillator.frequency.setValueAtTime(tone.frequency, startAt);
      if (tone.endFrequency) oscillator.frequency.exponentialRampToValueAtTime(tone.endFrequency, startAt + tone.duration);
      gain.gain.setValueAtTime(0.0001, startAt);
      gain.gain.exponentialRampToValueAtTime(tone.volume, startAt + tone.attack);
      gain.gain.exponentialRampToValueAtTime(0.0001, startAt + tone.duration);
      oscillator.connect(gain).connect(audioContext.destination);
      oscillator.start(startAt);
      oscillator.stop(startAt + tone.duration + 0.015);
    });
  } catch (error) {
    console.warn('Audio playback is unavailable in this browser.', error);
  }
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.remove('show'), 3600);
}

function syncControls() {
  const isIdle = state === 'idle' || state === 'done';
  $('#startButton').classList.toggle('hidden', !isIdle);
  $('#pauseButton').classList.toggle('hidden', isIdle);
  $('#stopButton').classList.toggle('hidden', isIdle);
  $('#pauseButton').querySelector('span:last-child').textContent = state === 'paused' ? '继续' : '暂停';
  focusCard.classList.toggle('is-active', state === 'focus');
  focusCard.classList.toggle('is-resting', state === 'micro' || state === 'long');
  $('#cycleLabel').innerHTML = `专注循环 <b>${String(Math.min(cycle, settings.cycles)).padStart(2, '0')}</b> / ${settings.cycles}`;
  if (state === 'idle' || state === 'done') {
    $('#phaseLabel').textContent = state === 'done' ? '本次完成' : '准备开始';
    $('#timerCaption').textContent = state === 'done' ? '做得很好' : '准备好了吗？';
    $('#timerSubtitle').textContent = state === 'done' ? '给自己一点时间，好好休息' : '一段专注，从此刻开始';
    $('#cardHint').innerHTML = `随机提示每 <b>${minRange.value}–${maxRange.value} 分钟</b> 轻响一次`;
  } else if (state === 'paused') {
    $('#phaseLabel').textContent = '已暂停';
    $('#timerCaption').textContent = '休息一下';
    $('#timerSubtitle').textContent = '准备好后，继续当前节奏';
  } else if (state === 'focus') {
    $('#phaseLabel').textContent = '专注中';
    $('#timerCaption').textContent = '此刻，只做一件事';
    $('#timerSubtitle').textContent = '听到提示时，闭眼休息一下';
    $('#cardHint').innerHTML = '下一次随机提示已安排 <b>· · ·</b>';
  } else if (state === 'micro') {
    $('#phaseLabel').textContent = '微休息';
    $('#timerCaption').textContent = '闭上眼睛';
    $('#timerSubtitle').textContent = '让眼睛和思绪都放松一下';
    $('#cardHint').textContent = '微休息结束后，将自动继续专注';
  } else if (state === 'long') {
    $('#phaseLabel').textContent = '长休息';
    $('#timerCaption').textContent = '离开屏幕，走一走';
    $('#timerSubtitle').textContent = '充分休息，为下一轮充电';
    $('#cardHint').innerHTML = `长休息结束后，自动开始第 <b>${cycle}</b> 轮`;
  }
}

function startFocus() {
  state = 'focus';
  focusSegmentStartedAt = Date.now();
  phaseEndsAt = focusSegmentStartedAt + focusRemaining;
  nextReminderAt = Date.now() + randomReminderDelay();
  playSound('soundFocusStart');
  syncControls();
  tick();
}

function beginSession() {
  if (state === 'done' || state === 'idle') {
    cycle = 1;
    focusRemaining = focusMs();
    focusElapsedMs = 0;
  }
  startFocus();
}

function beginMicroBreak() {
  state = 'micro';
  const now = Date.now();
  focusElapsedMs += Math.max(0, now - focusSegmentStartedAt);
  focusRemaining = Math.max(0, phaseEndsAt - now);
  phaseEndsAt = now + microBreakMs();
  playSound('soundReminder');
  showToast('轻轻闭上眼睛，休息一下。');
  syncControls();
}

function beginLongBreak() {
  state = 'long';
  phaseEndsAt = Date.now() + longBreakMs();
  playSound('soundLongBreak');
  showToast(`这一轮完成了，开始 ${settings.longBreakMinutes} 分钟长休息。`);
  syncControls();
}

function completeSession() {
  state = 'done';
  focusRemaining = focusMs();
  playSound('soundLongBreak');
  showToast('设定的专注循环都完成了，辛苦啦！');
  setTimer(focusMs(), focusMs());
  syncControls();
}

function tick() {
  if (state === 'focus') {
    const left = Math.max(0, phaseEndsAt - Date.now());
    setTimer(left, focusMs());
    if (left <= 0) {
      if (cycle >= settings.cycles) completeSession();
      else if (settings.longEnabled) {
        cycle += 1;
        focusRemaining = focusMs();
        focusElapsedMs = 0;
        beginLongBreak();
      } else {
        cycle += 1;
        focusRemaining = focusMs();
        focusElapsedMs = 0;
        startFocus();
      }
      return;
    }
    if (Date.now() >= nextReminderAt) {
      if (settings.microEnabled) beginMicroBreak();
      else {
        playSound('soundReminder');
        nextReminderAt = Date.now() + randomReminderDelay();
        showToast('随机专注提示');
      }
      return;
    }
  } else if (state === 'micro') {
    const left = Math.max(0, phaseEndsAt - Date.now());
    setTimer(left, microBreakMs());
    if (left <= 0) {
      playSound('soundMicroEnd');
      startFocus();
    }
  } else if (state === 'long') {
    const left = Math.max(0, phaseEndsAt - Date.now());
    setTimer(left, longBreakMs());
    if (left <= 0) startFocus();
  } else if (state === 'idle' || state === 'done') {
    setTimer(focusMs(), focusMs());
  }
}

function togglePause() {
  if (state === 'paused') {
    if (pausedFrom === 'focus') {
      state = 'focus';
      focusSegmentStartedAt = Date.now();
      phaseEndsAt = focusSegmentStartedAt + focusRemaining;
      nextReminderAt = focusSegmentStartedAt + remainingReminder;
    } else {
      state = pausedFrom;
      phaseEndsAt = Date.now() + pausedPhaseRemaining;
    }
  } else {
    pausedFrom = state;
    pausedPhaseRemaining = Math.max(0, phaseEndsAt - Date.now());
    if (state === 'focus') {
      focusElapsedMs += Math.max(0, Date.now() - focusSegmentStartedAt);
      focusRemaining = pausedPhaseRemaining;
      remainingReminder = Math.max(0, nextReminderAt - Date.now());
    }
    state = 'paused';
  }
  syncControls();
  tick();
}

function stopSession() {
  state = 'idle';
  focusRemaining = focusMs();
  focusElapsedMs = 0;
  cycle = 1;
  syncControls();
  setTimer(focusMs(), focusMs());
  showToast('本轮已结束，准备好时再开始。');
}

function clampInput(input, min, max) {
  const value = Math.max(min, Math.min(max, Math.round(Number(input.value) || min)));
  input.value = String(value);
  return value;
}

function saveSettings() {
  settings.focusMinutes = clampInput($('#focusMinutes'), 1, 240);
  settings.microSeconds = clampInput($('#microSeconds'), 1, 300);
  settings.longBreakMinutes = clampInput($('#longBreakMinutes'), 1, 120);
  settings.cycles = clampInput($('#cycles'), 1, 12);
  settings.microEnabled = $('#microToggle').getAttribute('aria-checked') === 'true';
  settings.longEnabled = $('#longToggle').getAttribute('aria-checked') === 'true';
  settings.adaptiveEnabled = $('#adaptiveToggle').checked;
  localStorage.setItem('sessionSettings', JSON.stringify(settings));
  if (state === 'idle' || state === 'done') setTimer(focusMs(), focusMs());
  syncControls();
}

function setToggle(button) {
  const enabled = button.getAttribute('aria-checked') !== 'true';
  button.setAttribute('aria-checked', String(enabled));
  button.classList.toggle('is-on', enabled);
  saveSettings();
}

function readStored(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; }
  catch { return fallback; }
}

function initialize() {
  const interval = readStored('intervalRange', [3, 5]);
  if (Array.isArray(interval) && interval.length === 2) {
    minRange.value = Math.min(30, Math.max(1, Number(interval[0]) || 3));
    maxRange.value = Math.min(30, Math.max(Number(minRange.value), Number(interval[1]) || 5));
  }
  settings = { ...DEFAULTS, ...readStored('sessionSettings', {}) };
  $('#focusMinutes').value = settings.focusMinutes;
  $('#microSeconds').value = settings.microSeconds;
  $('#longBreakMinutes').value = settings.longBreakMinutes;
  $('#cycles').value = settings.cycles;
  $('#microToggle').setAttribute('aria-checked', String(settings.microEnabled));
  $('#microToggle').classList.toggle('is-on', settings.microEnabled);
  $('#longToggle').setAttribute('aria-checked', String(settings.longEnabled));
  $('#longToggle').classList.toggle('is-on', settings.longEnabled);
  $('#adaptiveToggle').checked = settings.adaptiveEnabled;
  sounds = { ...SOUND_DEFAULTS, ...readStored('phaseSounds', {}) };
  SOUND_IDS.forEach((id) => {
    const select = document.getElementById(id);
    select.value = sounds[id];
    select.addEventListener('change', () => {
      sounds[id] = select.value;
      localStorage.setItem('phaseSounds', JSON.stringify(sounds));
      playSound(id);
    });
  });
  minRange.addEventListener('input', updateRange);
  maxRange.addEventListener('input', updateRange);
  $('#startButton').addEventListener('click', beginSession);
  $('#pauseButton').addEventListener('click', togglePause);
  $('#stopButton').addEventListener('click', stopSession);
  $('#microToggle').addEventListener('click', (event) => setToggle(event.currentTarget));
  $('#longToggle').addEventListener('click', (event) => setToggle(event.currentTarget));
  $('#adaptiveToggle').addEventListener('change', saveSettings);
  ['focusMinutes', 'microSeconds', 'longBreakMinutes', 'cycles'].forEach((id) => {
    document.getElementById(id).addEventListener('change', saveSettings);
    document.getElementById(id).addEventListener('keydown', (event) => {
      if (event.key === 'Enter') event.currentTarget.blur();
    });
  });
  document.querySelectorAll('.preview-sound').forEach((button) => {
    button.addEventListener('click', () => playSound(button.dataset.preview));
  });
  $('#soundToggle').addEventListener('click', (event) => {
    audioEnabled = !audioEnabled;
    event.currentTarget.classList.toggle('muted', !audioEnabled);
    event.currentTarget.setAttribute('aria-label', audioEnabled ? '关闭提示音' : '开启提示音');
    event.currentTarget.title = audioEnabled ? '关闭提示音' : '开启提示音';
    showToast(audioEnabled ? '提示音已开启' : '提示音已关闭');
  });
  updateRange();
  focusRemaining = focusMs();
  syncControls();
  setTimer(focusRemaining, focusRemaining);
  setInterval(tick, 250);
}

initialize();
