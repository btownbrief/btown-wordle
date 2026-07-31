// Quiet, opt-in WebAudio cues for the daily word game. No context is created
// until the player turns sound on with a gesture.

const SOUND_KEY = 'bw-sound-enabled';
let enabled = localStorage.getItem(SOUND_KEY) === '1';
let context;
let master;

function ensureAudio() {
  if (!enabled) return null;
  if (!context) {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return null;
    context = new AudioContext();
    master = context.createGain();
    master.gain.value = 0.1;
    master.connect(context.destination);
  }
  if (context.state === 'suspended') void context.resume();
  master.gain.setTargetAtTime(0.1, context.currentTime, 0.01);
  return context;
}

function tone(frequency, {
  delay = 0, duration = 0.08, volume = 0.2, type = 'sine', endFrequency,
} = {}) {
  const audio = ensureAudio();
  if (!audio) return;
  const start = audio.currentTime + delay;
  const oscillator = audio.createOscillator();
  const gain = audio.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, start);
  if (endFrequency) {
    oscillator.frequency.exponentialRampToValueAtTime(endFrequency, start + duration);
  }
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(volume, start + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(gain);
  gain.connect(master);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.02);
}

export function soundEnabled() {
  return enabled;
}

export function setSoundEnabled(next) {
  enabled = Boolean(next);
  localStorage.setItem(SOUND_KEY, enabled ? '1' : '0');
  if (enabled) {
    ensureAudio();
  } else if (context && master) {
    master.gain.cancelScheduledValues(context.currentTime);
    master.gain.setTargetAtTime(0.0001, context.currentTime, 0.01);
  }
}

export function playTap() {
  tone(310, { duration: 0.035, volume: 0.12, type: 'triangle', endFrequency: 270 });
}

export function playFlip(result) {
  const pitches = { absent: 190, present: 285, correct: 430 };
  tone(pitches[result] || pitches.absent, {
    duration: 0.09, volume: 0.2, type: result === 'correct' ? 'sine' : 'triangle',
  });
}

export function playError() {
  tone(210, { duration: 0.13, volume: 0.14, type: 'sine', endFrequency: 165 });
}

export function playWin(guessIndex) {
  const notes = guessIndex >= 4 ? [392, 523] : [392, 523, 659];
  if (guessIndex <= 1) notes.push(784);
  notes.forEach((frequency, i) => {
    tone(frequency, { delay: i * 0.09, duration: 0.18, volume: 0.22, type: 'sine' });
  });
}
