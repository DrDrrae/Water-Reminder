// utils/audio.ts — Web Audio API alert tone synthesis.

/**
 * Play a short water-drop-style alert tone using the Web Audio API.
 * Errors are silently ignored (e.g. when audio context is not available).
 */
export function playAlertSound(): void {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.type = "sine";
    // Rising tone: 440 Hz → 880 Hz over 120 ms, then fade out.
    osc.frequency.setValueAtTime(440, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.12);

    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.5, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);

    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.65);
    osc.onended = () => void ctx.close();
  } catch (e) {
    console.error("[water-reminder] Failed to play alert sound:", e);
  }
}
