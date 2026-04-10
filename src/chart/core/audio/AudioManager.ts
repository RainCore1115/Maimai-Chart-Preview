import { Note, AudioConfig } from '../../types';
import { ANSWER_SOUND_BASE_OFFSET_MS } from '../../utils/constants';

const SCHEDULE_LOOKAHEAD_MS = 1500;

/** close() 返回 Promise，对已关闭的 context 会 reject，需吞掉避免 Uncaught (in promise) */
function safeCloseAudioContext(ctx: AudioContext | null | undefined): void {
  if (!ctx || ctx.state === 'closed') return;
  void ctx.close().catch(() => {});
}

export interface AudioManagerConfig {
  answerSoundPath?: string;
  initialVolume?: number;
  initialTimingOffset?: number;
}

interface ScheduledSourceEntry {
  source: AudioBufferSourceNode;
  gainNode: GainNode;
  startTime: number;
}

export class AudioManager {
  private audioContext: AudioContext | null = null;
  private answerBuffer: AudioBuffer | null = null;
  private initialized = false;

  private enabled = false;
  private holdEndSoundEnabled = true;
  private touchSoundEnabled = true;
  private volume = 0.5;
  private timingOffsetMs = ANSWER_SOUND_BASE_OFFSET_MS;

  private handledEvents = new Set<string>();
  private scheduledSources = new Set<ScheduledSourceEntry>();

  private lastScheduledTimeMs = -Infinity;

  private answerSoundPath: string;

  constructor(config: AudioManagerConfig = {}) {
    this.answerSoundPath = config.answerSoundPath ?? 'assets/maimai/chart/answer.wav';
    this.volume = config.initialVolume ?? 0.5;
    this.timingOffsetMs = config.initialTimingOffset ?? ANSWER_SOUND_BASE_OFFSET_MS;
  }

  /** 与 Vite `public/` 资源对齐，并尊重 `base` 配置 */
  private resolveAnswerSoundUrl(): string {
    const path = this.answerSoundPath.replace(/^\/+/, '');
    if (path.startsWith('http://') || path.startsWith('https://')) return path;
    const base =
      typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL != null
        ? import.meta.env.BASE_URL
        : '/';
    const normalizedBase = base.endsWith('/') ? base : `${base}/`;
    return `${normalizedBase}${path}`;
  }

  /** 当仓库未附带 answer.wav 时，用短促提示音保证正解音功能可用 */
  private createSyntheticAnswerBuffer(audioContext: AudioContext): AudioBuffer {
    const sampleRate = audioContext.sampleRate;
    const durationSec = 0.045;
    const frames = Math.max(1, Math.floor(sampleRate * durationSec));
    const buffer = audioContext.createBuffer(1, frames, sampleRate);
    const data = buffer.getChannelData(0);
    const freq = 920;
    for (let i = 0; i < frames; i++) {
      const t = i / sampleRate;
      const env = Math.exp(-t * 72);
      data[i] = env * Math.sin(2 * Math.PI * freq * t) * 0.32;
    }
    return buffer;
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    const AudioContextClass =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;

    const ctx = new AudioContextClass();
    this.audioContext = ctx;

    /** 仍为当前实例持有的 context（dispose / 切页后会置 null 并 close，避免 await 之后用到已释放的 context） */
    const stillOwner = () => this.audioContext === ctx;

    try {
      let decoded: AudioBuffer | null = null;
      try {
        const response = await fetch(this.resolveAnswerSoundUrl());
        if (response.ok && stillOwner()) {
          const arrayBuffer = await response.arrayBuffer();
          decoded = await ctx.decodeAudioData(arrayBuffer);
        }
      } catch {
        decoded = null;
      }

      if (!stillOwner()) {
        safeCloseAudioContext(ctx);
        return;
      }

      if (!decoded) {
        console.warn(
          'AudioManager: 未加载到 answer.wav（可将文件放在 public/assets/maimai/chart/），已使用内置提示音作为正解音。'
        );
        decoded = this.createSyntheticAnswerBuffer(ctx);
      }

      if (!stillOwner()) {
        safeCloseAudioContext(ctx);
        return;
      }

      this.answerBuffer = decoded;
      this.initialized = true;
    } catch (error) {
      console.error('AudioManager: Failed to initialize', error);
      safeCloseAudioContext(ctx);
      if (stillOwner()) {
        this.audioContext = null;
      }
    }
  }

  async resume(): Promise<void> {
    if (this.audioContext && this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
  }

  dispose(): void {
    this.clearScheduledSources(true);
    if (this.audioContext) {
      safeCloseAudioContext(this.audioContext);
      this.audioContext = null;
    }
    this.answerBuffer = null;
    this.initialized = false;
    this.handledEvents.clear();
  }

  private playAnswerSoundAt(when: number): void {
    if (!this.enabled || !this.answerBuffer || !this.audioContext) return;

    try {
      const source = this.audioContext.createBufferSource();
      const gainNode = this.audioContext.createGain();
      const entry: ScheduledSourceEntry = {
        source,
        gainNode,
        startTime: when > 0 ? when : this.audioContext.currentTime,
      };

      source.buffer = this.answerBuffer;
      gainNode.gain.value = this.volume;

      source.connect(gainNode);
      gainNode.connect(this.audioContext.destination);
      this.scheduledSources.add(entry);
      source.start(when);

      source.onended = () => {
        this.scheduledSources.delete(entry);

        try {
          source.disconnect();
        } catch {
          // 忽略已经断开的 source
        }

        try {
          gainNode.disconnect();
        } catch {
          // 忽略已经断开的 gain
        }
      };
    } catch (error) {
      console.error('AudioManager: Playback error', error);
    }
  }

  private shouldPlaySound(note: Note): boolean {
    switch (note.type) {
      case 'tap':
      case 'break':
      case 'simultaneous':
      case 'hold-start':
      case 'hold-start-simultaneous':
      case 'slide':
        return true;

      case 'touch':
      case 'touch-hold-start':
        return this.touchSoundEnabled;

      case 'touch-hold-end':
        return this.touchSoundEnabled && this.holdEndSoundEnabled;

      case 'hold-end':
      case 'hold-end-simultaneous':
        return this.holdEndSoundEnabled;

      default:
        return false;
    }
  }

  private getEventKey(note: Note): string {
    return note.timingMs.toFixed(3);
  }

  schedule(
    notes: Note[] | null,
    currentTimeMs: number,
    playbackSpeed: number = 1,
    lookAheadMs: number = SCHEDULE_LOOKAHEAD_MS
  ): void {
    if (!this.enabled || !notes || !this.audioContext || !this.answerBuffer) return;

    const normalizedPlaybackSpeed = Math.max(playbackSpeed, 0.001);

    const adjustedCurrentTime = currentTimeMs - this.timingOffsetMs;
    const adjustedLastTime = this.lastScheduledTimeMs - this.timingOffsetMs;
    const adjustedLookAheadTime = adjustedCurrentTime + lookAheadMs;

    for (const note of notes) {
      if (!this.shouldPlaySound(note)) continue;

      const eventKey = this.getEventKey(note);
      if (this.handledEvents.has(eventKey)) continue;

      const noteTime = note.timingMs;
      if (noteTime > adjustedLookAheadTime) continue;

      if (noteTime <= adjustedCurrentTime) {
        this.handledEvents.add(eventKey);
        if (noteTime > adjustedLastTime) {
          this.playAnswerSoundAt(0);
        }
        continue;
      }

      this.handledEvents.add(eventKey);
      const delayMs = noteTime - adjustedCurrentTime;
      const when = this.audioContext.currentTime + delayMs / 1000 / normalizedPlaybackSpeed;
      this.playAnswerSoundAt(when);
    }

    this.lastScheduledTimeMs = currentTimeMs;
  }

  reset(currentTimeMs?: number, stopStartedSources: boolean = false): void {
    this.clearScheduledSources(stopStartedSources);
    this.handledEvents.clear();
    this.lastScheduledTimeMs = currentTimeMs ?? -Infinity;
  }

  setEnabled(enabled: boolean): void {
    if (!enabled) {
      this.clearScheduledSources(true);
    }
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setHoldEndSoundEnabled(enabled: boolean): void {
    this.holdEndSoundEnabled = enabled;
  }

  isHoldEndSoundEnabled(): boolean {
    return this.holdEndSoundEnabled;
  }

  setTouchSoundEnabled(enabled: boolean): void {
    this.touchSoundEnabled = enabled;
  }

  isTouchSoundEnabled(): boolean {
    return this.touchSoundEnabled;
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
  }

  getVolume(): number {
    return this.volume;
  }

  setTimingOffset(offsetMs: number): void {
    this.timingOffsetMs = offsetMs;
  }

  getTimingOffset(): number {
    return this.timingOffsetMs;
  }

  getConfig(): AudioConfig {
    return {
      enabled: this.enabled,
      holdEndSoundEnabled: this.holdEndSoundEnabled,
      touchSoundEnabled: this.touchSoundEnabled,
      volume: this.volume,
      timingOffsetMs: this.timingOffsetMs,
    };
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  private clearScheduledSources(stopStartedSources: boolean = false): void {
    const now = this.audioContext?.currentTime ?? 0;

    for (const entry of this.scheduledSources) {
      if (!stopStartedSources && entry.startTime <= now) {
        continue;
      }

      try {
        entry.source.stop();
      } catch {
        // 忽略已经结束的 source
      }

      try {
        entry.source.disconnect();
      } catch {
        // 忽略已经断开的 source
      }

      try {
        entry.gainNode.disconnect();
      } catch {
        // 忽略已经断开的 gain
      }

      this.scheduledSources.delete(entry);
    }
  }
}

export default AudioManager;
