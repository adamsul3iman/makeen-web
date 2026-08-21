export type PosSoundCue = "SCAN_ACCEPTED" | "ERROR" | "SALE_COMPLETED";

export interface PosSoundTone {
  delayMs: number;
  durationMs: number;
  frequency: number;
  gain: number;
  wave: OscillatorType;
}

export interface PosSoundEventDetail {
  cue: PosSoundCue;
}

export const POS_SOUND_EVENT = "pos:sound-cue";

const SOUND_PATTERNS: Record<PosSoundCue, readonly PosSoundTone[]> = {
  // Mid-range square pulses stay audible on small POS/laptop speakers. The
  // former 880/1175Hz sine chirp was easily lost in shop-floor noise.
  SCAN_ACCEPTED: [
    { delayMs: 0, durationMs: 72, frequency: 660, gain: 0.82, wave: "square" },
    { delayMs: 68, durationMs: 86, frequency: 880, gain: 0.92, wave: "square" },
  ],
  // Descending and deliberately unmistakable as a rejection. Frequencies are
  // kept above the weak bass range of compact register speakers.
  ERROR: [
    { delayMs: 0, durationMs: 135, frequency: 440, gain: 0.9, wave: "square" },
    { delayMs: 130, durationMs: 175, frequency: 294, gain: 1, wave: "square" },
  ],
  // Compact ascending confirmation after the invoice is safely persisted.
  SALE_COMPLETED: [
    { delayMs: 0, durationMs: 85, frequency: 523, gain: 0.7, wave: "triangle" },
    { delayMs: 80, durationMs: 85, frequency: 659, gain: 0.8, wave: "triangle" },
    { delayMs: 160, durationMs: 120, frequency: 784, gain: 0.95, wave: "triangle" },
  ],
};

let sharedAudioContext: AudioContext | null = null;
let sharedCompressor: DynamicsCompressorNode | null = null;

export function normalizeSoundVolume(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 60;
  return Math.round(Math.min(100, Math.max(0, value)));
}

export function getPosSoundPattern(cue: PosSoundCue): readonly PosSoundTone[] {
  return SOUND_PATTERNS[cue];
}

/**
 * Converts the UI slider to perceived loudness. Web Audio gain is linear while
 * hearing is not, so a gentle power curve makes the full slider useful. The
 * old engine multiplied this result by 0.16, making UI 100% only ~16% output.
 */
export function calculatePosSoundGain(
  requestedVolume: unknown,
  toneGain: number,
): number {
  const volume = normalizeSoundVolume(requestedVolume);
  if (volume === 0) return 0;
  const perceptualVolume = Math.pow(volume / 100, 0.68);
  return Math.min(0.98, Math.max(0.0001, perceptualVolume * toneGain * 0.88));
}

export function emitPosSound(cue: PosSoundCue): void {
  if (
    typeof window === "undefined" ||
    typeof window.dispatchEvent !== "function" ||
    typeof CustomEvent === "undefined"
  ) return;

  window.dispatchEvent(
    new CustomEvent<PosSoundEventDetail>(POS_SOUND_EVENT, { detail: { cue } }),
  );
}

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (sharedAudioContext && sharedAudioContext.state !== "closed") {
    return sharedAudioContext;
  }

  const AudioContextConstructor =
    window.AudioContext ??
    (window as typeof window & { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!AudioContextConstructor) return null;

  try {
    sharedAudioContext = new AudioContextConstructor();
    sharedCompressor = null;
    return sharedAudioContext;
  } catch {
    return null;
  }
}

function getAudioOutput(context: AudioContext): AudioNode {
  if (sharedCompressor?.context === context) return sharedCompressor;

  const compressor = context.createDynamicsCompressor();
  compressor.threshold.setValueAtTime(-8, context.currentTime);
  compressor.knee.setValueAtTime(10, context.currentTime);
  compressor.ratio.setValueAtTime(12, context.currentTime);
  compressor.attack.setValueAtTime(0.003, context.currentTime);
  compressor.release.setValueAtTime(0.08, context.currentTime);
  compressor.connect(context.destination);
  sharedCompressor = compressor;
  return compressor;
}

/** Prepare Web Audio while the browser still considers the call user-initiated. */
export async function primePosAudio(): Promise<boolean> {
  const context = getAudioContext();
  if (!context) return false;
  try {
    if (context.state === "suspended") await context.resume();
    return context.state === "running";
  } catch {
    return false;
  }
}

function schedulePattern(
  context: AudioContext,
  pattern: readonly PosSoundTone[],
  volume: number,
): void {
  const baseTime = context.currentTime + 0.004;
  const output = getAudioOutput(context);

  for (const tone of pattern) {
    const start = baseTime + tone.delayMs / 1000;
    const end = start + tone.durationMs / 1000;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const peakGain = calculatePosSoundGain(volume, tone.gain);

    oscillator.type = tone.wave;
    oscillator.frequency.setValueAtTime(tone.frequency, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(peakGain, start + 0.008);
    gain.gain.setValueAtTime(peakGain, Math.max(start + 0.009, end - 0.018));
    gain.gain.exponentialRampToValueAtTime(0.0001, end);

    oscillator.connect(gain);
    gain.connect(output);
    oscillator.start(start);
    oscillator.stop(end + 0.01);
    oscillator.addEventListener("ended", () => {
      oscillator.disconnect();
      gain.disconnect();
    }, { once: true });
  }
}

/**
 * Generated locally: no asset fetch, and audio failure can never interrupt a
 * barcode or checkout operation while offline or under autoplay restrictions.
 */
export async function playPosSound(
  cue: PosSoundCue,
  requestedVolume: number,
): Promise<boolean> {
  const volume = normalizeSoundVolume(requestedVolume);
  if (volume === 0) return false;

  const context = getAudioContext();
  if (!context) return false;

  try {
    if (context.state === "suspended") await context.resume();
    if (context.state !== "running") return false;
    schedulePattern(context, SOUND_PATTERNS[cue], volume);
    return true;
  } catch {
    return false;
  }
}
