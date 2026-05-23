import { Notification } from '../libs/Notification';
import { state } from '../util/state';

export class AudioEngine {
  volume: number = 0.6;
  sounds: Record<string, AudioBuffer> = {};
  paused: boolean = true;

  init(): this { return this; }
  load(_id: string, _url: string, _cb?: () => void): void {}
  play(_id: string, _vol: number, _delay_ms: number, _part_id: string): void {}
  stop(_id: string, _delay_ms: number, _part_id: string): void {}
  setVolume(vol: number): void { this.volume = vol; }
  resume(): void { this.paused = false; }
}

interface PooledVoice {
  gainNode: GainNode;
  source: AudioBufferSourceNode | null;
  noteId: string;
  partId: string;
  startTime: number;
  generation: number;
  synthVoice: any;
}

class VoicePool {
  private readonly slots: PooledVoice[];
  private readonly free: PooledVoice[];

  constructor(context: AudioContext, destination: AudioNode, size: number) {
    this.slots = [];
    this.free = [];
    for (let i = 0; i < size; i++) {
      const gainNode = context.createGain();
      gainNode.connect(destination);
      const v: PooledVoice = {
        gainNode,
        source: null,
        noteId: '',
        partId: '',
        startTime: -Infinity,
        generation: 0,
        synthVoice: null,
      };
      this.slots.push(v);
      this.free.push(v);
    }
  }

  acquire(now: number): PooledVoice {
    const v = this.free.pop();
    if (v) return v;

    let oldest = this.slots[0];
    for (let i = 1; i < this.slots.length; i++) {
      if (this.slots[i].startTime < oldest.startTime) oldest = this.slots[i];
    }

    if (oldest.source) {
      try { oldest.source.stop(now); } catch { /* already stopped */ }
      oldest.source = null;
    }
    if (oldest.synthVoice) {
      try { oldest.synthVoice.stop(now); } catch {}
      oldest.synthVoice = null;
    }
    oldest.generation++;
    return oldest;
  }

  release(v: PooledVoice): void {
    v.source = null;
    v.synthVoice = null;
    this.free.push(v);
  }

  reset(): void {
    for (const v of this.slots) {
      if (v.source) { try { v.source.stop(0); } catch {} v.source = null; }
      if (v.synthVoice) { try { v.synthVoice.stop(0); } catch {} v.synthVoice = null; }
      v.generation++;
    }
    this.free.length = 0;
    this.free.push(...this.slots);
  }
}

export class AudioEngineWeb extends AudioEngine {
  private static readonly POOL_SIZE = 128;

  context!: AudioContext;
  masterGain!: GainNode;
  limiterNode!: DynamicsCompressorNode;
  pianoGain!: GainNode;
  synthGain!: GainNode;

  private pool!: VoicePool;

  private active: Map<string, PooledVoice> = new Map();

  init(): this {
    super.init();
    this.context = new AudioContext({ latencyHint: 'interactive' });

    this.masterGain = this.context.createGain();
    this.masterGain.gain.value = this.volume;
    this.masterGain.connect(this.context.destination);

    this.limiterNode = this.context.createDynamicsCompressor();
    this.limiterNode.threshold.value = -10;
    this.limiterNode.knee.value = 0;
    this.limiterNode.ratio.value = 20;
    this.limiterNode.attack.value = 0;
    this.limiterNode.release.value = 0.1;
    this.limiterNode.connect(this.masterGain);

    this.pianoGain = this.context.createGain();
    this.pianoGain.gain.value = 0.5;
    this.pianoGain.connect(this.limiterNode);

    this.synthGain = this.context.createGain();
    this.synthGain.gain.value = 0.5;
    this.synthGain.connect(this.limiterNode);

    this.pool = new VoicePool(this.context, this.pianoGain, AudioEngineWeb.POOL_SIZE);
    this.active = new Map();
    return this;
  }


  stopAllSynthVoices(): void {
    for (const voice of this.active.values()) {
      if (voice.synthVoice) {
        try { voice.synthVoice.osc.stop(); } catch {}
        voice.synthVoice = null;
      }
    }
  }

  load(id: string, url: string, cb?: () => void): void {
    fetch(url)
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.arrayBuffer();
      })
      .then(buf => this.context.decodeAudioData(buf))
      .then(decoded => {
        this.sounds[id] = decoded;
        cb?.();
      })
      .catch(e => {
        new Notification({
          id: 'audio-download-error',
          title: 'Problem',
          text: `Audio download failed: ${e.message}`,
          target: '#piano',
          duration: 10000,
        });
      });
  }

  play(id: string, vol: number, delay_ms: number, part_id: string): void {
    if (this.paused || !(id in this.sounds)) return;
    const time = this.context.currentTime + delay_ms / 1000;
    this.schedulePlay(id, vol, time, part_id);
  }

  private schedulePlay(id: string, vol: number, time: number, part_id: string): void {
    const now = this.context.currentTime;

    const prev = this.active.get(id);
    if (prev) {
      const pg = prev.gainNode.gain;
      pg.cancelScheduledValues(time);
      pg.setValueAtTime(pg.value, time);
      pg.linearRampToValueAtTime(0, time + 0.05);
      if (prev.source) {
        try { prev.source.stop(time + 0.051); } catch {}
      }
      if (prev.synthVoice) {
        try { prev.synthVoice.stop(time); } catch {}
      }
    }

    const voice = this.pool.acquire(now);
    voice.generation++;
    const capturedGen = voice.generation;

    const source = this.context.createBufferSource();
    source.buffer = this.sounds[id];

    const gain = voice.gainNode.gain;
    gain.cancelScheduledValues(time);
    gain.setValueAtTime(vol, time);

    source.connect(voice.gainNode);
    source.start(time);

    source.onended = () => {
      if (voice.generation === capturedGen) {
        this.active.delete(id);
        this.pool.release(voice);
      }
    };

    voice.source   = source;
    voice.noteId   = id;
    voice.partId   = part_id;
    voice.startTime = time;

    if (state.enableSynth && state.synthVoice) {
      voice.synthVoice = new state.synthVoice(id, time);
    }

    this.active.set(id, voice);
  }

  stop(id: string, delay_ms: number, part_id: string): void {
    const voice = this.active.get(id);
    if (!voice || voice.partId !== part_id) return;

    const time = this.context.currentTime + delay_ms / 1000;

    const gain = voice.gainNode.gain;
    gain.cancelScheduledValues(time);
    gain.setValueAtTime(gain.value, time);
    gain.linearRampToValueAtTime(gain.value * 0.1, time + 0.16);
    gain.linearRampToValueAtTime(0, time + 0.4);
    if (voice.source) {
      try { voice.source.stop(time + 0.41); } catch {}
    }
    if (voice.synthVoice) {
      try { voice.synthVoice.stop(time); } catch {}
    }

    this.active.delete(id);
  }

  setVolume(vol: number): void {
    super.setVolume(vol);
    if (this.masterGain) this.masterGain.gain.value = vol;
  }

  resume(): void {
    this.paused = false;
    this.context.resume();
  }
}
