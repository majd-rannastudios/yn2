/* Sound and haptics for the guest phone.
 *
 * Every sound is synthesised with the Web Audio API rather than loaded as a
 * file: nothing to download over venue wifi, nothing to cache, no delay at the
 * moment it matters. The rotation alert firing on three hundred phones at once
 * is the loudest cue in the room, so it is the one tuned hardest.
 *
 * Browsers refuse to make noise until the user has tapped something, so the
 * context is created lazily and unlocked on the first real gesture.
 */

export const Sound = (() => {
  let ctx = null;
  let master = null;
  let enabled = localStorage.getItem('stw-sound') !== 'off';

  function boot() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.32;
    master.connect(ctx.destination);
    return ctx;
  }

  /** Call from inside a click handler, once. */
  function unlock() {
    const c = boot();
    if (!c) return;
    if (c.state === 'suspended') c.resume();
  }

  /**
   * One shaped tone. Envelopes are always ramped - setting gain instantly
   * produces a click on every note.
   */
  function tone({ freq, start = 0, duration = 0.3, type = 'sine', peak = 0.6, glide = null }) {
    if (!enabled || !boot()) return;
    const t0 = ctx.currentTime + start;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (glide) osc.frequency.exponentialRampToValueAtTime(glide, t0 + duration);

    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);

    osc.connect(gain).connect(master);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  }

  function buzz(pattern) {
    try { navigator.vibrate?.(pattern); } catch { /* unsupported, no matter */ }
  }

  return {
    unlock,

    get enabled() { return enabled; },

    toggle() {
      enabled = !enabled;
      localStorage.setItem('stw-sound', enabled ? 'on' : 'off');
      if (enabled) { unlock(); this.tick(); }
      return enabled;
    },

    /** Wheel starts turning: a rising sweep under the animation. */
    spin() {
      unlock();
      tone({ freq: 180, glide: 620, duration: 1.1, type: 'triangle', peak: 0.18 });
      buzz(22);
    },

    /** Light click as the wheel passes a segment. */
    tick() {
      tone({ freq: 1400, duration: 0.035, type: 'square', peak: 0.06 });
    },

    /** The wheel lands. A major arpeggio - this is the guest's payoff. */
    land() {
      tone({ freq: 523.25, start: 0.00, duration: 0.34, type: 'sine', peak: 0.5 });  // C5
      tone({ freq: 659.25, start: 0.09, duration: 0.34, type: 'sine', peak: 0.5 });  // E5
      tone({ freq: 783.99, start: 0.18, duration: 0.46, type: 'sine', peak: 0.55 }); // G5
      tone({ freq: 1046.5, start: 0.27, duration: 0.60, type: 'sine', peak: 0.42 }); // C6
      buzz([0, 45, 55, 90]);
    },

    /**
     * A new round has started - the guest has to physically move.
     * Deliberately insistent: two rising two-note calls, low tone underneath so
     * it carries through a room full of conversation.
     */
    rotate() {
      unlock();
      for (const at of [0, 0.62]) {
        tone({ freq: 880, start: at, duration: 0.20, type: 'triangle', peak: 0.62 });
        tone({ freq: 1318.5, start: at + 0.17, duration: 0.30, type: 'triangle', peak: 0.62 });
        tone({ freq: 220, start: at, duration: 0.44, type: 'sine', peak: 0.34 });
      }
      buzz([0, 140, 90, 140, 90, 240]);
    },

    /** The event has finished. */
    finish() {
      tone({ freq: 783.99, start: 0.00, duration: 0.4, type: 'sine', peak: 0.45 });
      tone({ freq: 659.25, start: 0.16, duration: 0.4, type: 'sine', peak: 0.45 });
      tone({ freq: 523.25, start: 0.32, duration: 0.9, type: 'sine', peak: 0.5 });
      buzz([0, 60, 40, 60]);
    },

    buzz
  };
})();
