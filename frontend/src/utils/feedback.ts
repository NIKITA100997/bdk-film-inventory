/** Звуковая и тактильная обратная связь для мобильных устройств, ТСД и планшетов.
 * Использует Web Audio API для генерации звуков на лету (без внешних mp3-файлов).
 */

class AudioFeedback {
  private ctx: AudioContext | null = null;

  private getContext(): AudioContext | null {
    if (this.ctx && this.ctx.state !== "closed") {
      if (this.ctx.state === "suspended") {
        this.ctx.resume().catch(() => {});
      }
      return this.ctx;
    }
    try {
      const AudioCtx =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return null;
      this.ctx = new AudioCtx();
      return this.ctx;
    } catch {
      return null;
    }
  }

  /** Приятный высокий двухтоновый звук успешного сканирования (880 Гц -> 1760 Гц). */
  playSuccessSound() {
    try {
      const ctx = this.getContext();
      if (!ctx) return;
      const now = ctx.currentTime;

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.type = "sine";
      osc.frequency.setValueAtTime(880, now);
      osc.frequency.exponentialRampToValueAtTime(1760, now + 0.08);

      gain.gain.setValueAtTime(0.18, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);

      osc.start(now);
      osc.stop(now + 0.12);
    } catch {
      // Игнорируем блокировку браузера до первого клика
    }
  }

  /** Низкий звук ошибки или ненайденного штрихкода (220 Гц). */
  playErrorSound() {
    try {
      const ctx = this.getContext();
      if (!ctx) return;
      const now = ctx.currentTime;

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(220, now);
      osc.frequency.exponentialRampToValueAtTime(160, now + 0.2);

      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);

      osc.start(now);
      osc.stop(now + 0.22);
    } catch {
      // Игнорируем
    }
  }
}

const audio = new AudioFeedback();

/**
 * Комплексная обратная связь при сканировании (звук + вибрация).
 * @param success - true: успешное сканирование, false: ошибка/не найдено.
 */
export function triggerScanFeedback(success = true) {
  if (success) {
    audio.playSuccessSound();
    try {
      if (typeof navigator !== "undefined" && navigator.vibrate) {
        navigator.vibrate([40, 30, 40]);
      }
    } catch {
      // Вибрация не поддерживается или запрещена
    }
  } else {
    audio.playErrorSound();
    try {
      if (typeof navigator !== "undefined" && navigator.vibrate) {
        navigator.vibrate([150, 50, 150]);
      }
    } catch {
      // Вибрация не поддерживается
    }
  }
}
