import {
  CTRL_BYTES, EVENT_FIELDS, RING_CAPACITY,
  CTRL_WRITE_HEAD, CTRL_READ_HEAD, CTRL_VOLUME_F32,
  CTRL_SYNTH_ENABLED, CTRL_SYNTH_TYPE,
  CTRL_SYNTH_ATTACK_F32, CTRL_SYNTH_DECAY_F32,
  CTRL_SYNTH_SUSTAIN_F32, CTRL_SYNTH_RELEASE_F32,
  CTRL_PIANO_GAIN_F32, CTRL_SYNTH_GAIN_F32,
  CMD_PLAY, CMD_STOP, CMD_STOP_ALL_SYNTH,
} from './ring-buffer-layout';

const POOL_SIZE = 2048;
const MIX_CAP = 768;
const GAIN_FLOOR = 0.001;

interface SampleData {
  data: Float32Array[];
  length: number;
  rate: number;
}

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: any): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
  process(inputs: Float32Array[][], outputs: Float32Array[][], params: Record<string, Float32Array>): boolean;
}

class PianoWorkletProcessor extends AudioWorkletProcessor {
  private samples = new Map<number, SampleData>();
  private ctrl: Int32Array | null = null;
  private ctrlF32: Float32Array | null = null;
  private ring: Uint32Array | null = null;
  private ringF32: Float32Array | null = null;
  private useSAB = false;
  private msgQueue: any[] = [];
  private frameCounter = 0;
  private sampleRate_: number = 44100;

  private _volume = 0.6;
  private _pianoGain = 0.5;
  private _synthGain = 0.025;
  private _synthEnabled = 0;
  private _synthType = 1;
  private _synthAttack = 0;
  private _synthDecay = 0.2;
  private _synthSustain = 0.5;
  private _synthRelease = 2.0;

  private vNoteIdx = new Int32Array(POOL_SIZE);
  private vPartHash = new Uint32Array(POOL_SIZE);
  private vPos = new Float64Array(POOL_SIZE);
  private vGain = new Float32Array(POOL_SIZE);
  private vTargetGain = new Float32Array(POOL_SIZE);
  private vFadeRate = new Float32Array(POOL_SIZE);
  private vStartFrame = new Float64Array(POOL_SIZE);
  private vDelayRemaining = new Int32Array(POOL_SIZE);
  private vSynthActive = new Uint8Array(POOL_SIZE);
  private vSynthPhase = new Float64Array(POOL_SIZE);
  private vSynthFreq = new Float32Array(POOL_SIZE);
  private vSynthEnvStage = new Uint8Array(POOL_SIZE);
  private vSynthEnvLevel = new Float32Array(POOL_SIZE);
  private vSynthEnvPos = new Uint32Array(POOL_SIZE);

  private freeStack = new Int32Array(POOL_SIZE);
  private freeCount = POOL_SIZE;
  private activeList = new Int32Array(POOL_SIZE);
  private activeCount = 0;
  private activePos = new Int32Array(POOL_SIZE).fill(-1);
  private noteSlots = new Map<number, number>();

  constructor() {
    super();
    for (let i = 0; i < POOL_SIZE; i++) this.freeStack[i] = i;
    this.port.onmessage = (e) => this._handleMessage(e.data);
  }

  private _activate(slot: number): void {
    if (this.activePos[slot] >= 0) return;
    this.activePos[slot] = this.activeCount;
    this.activeList[this.activeCount++] = slot;
  }

  private _deactivate(slot: number): void {
    const pos = this.activePos[slot];
    if (pos < 0) return;
    this.activeCount--;
    const last = this.activeList[this.activeCount];
    this.activeList[pos] = last;
    this.activePos[last] = pos;
    this.activePos[slot] = -1;
    this.freeStack[this.freeCount++] = slot;
  }

  private _acquireVoice(): number {
    if (this.freeCount > 0) return this.freeStack[--this.freeCount];
    let oldest = 0, oldestFrame = Infinity;
    for (let i = 0; i < this.activeCount; i++) {
      const s = this.activeList[i];
      if (this.vStartFrame[s] < oldestFrame) { oldestFrame = this.vStartFrame[s]; oldest = s; }
    }
    const noteIdx = this.vNoteIdx[oldest];
    if (this.noteSlots.get(noteIdx) === oldest) this.noteSlots.delete(noteIdx);
    this._deactivate(oldest);
    return oldest;
  }

  private _handleMessage(msg: any): void {
    switch (msg.cmd) {
      case 'init':
        if (msg.sab) {
          this.ctrl = new Int32Array(msg.sab, 0, CTRL_BYTES / 4);
          this.ctrlF32 = new Float32Array(msg.sab, 0, CTRL_BYTES / 4);
          this.ring = new Uint32Array(msg.sab, CTRL_BYTES);
          this.ringF32 = new Float32Array(msg.sab, CTRL_BYTES);
          this.useSAB = true;
        }
        this.sampleRate_ = msg.sampleRate;
        break;
      case 'load': {
        const channels = msg.channels.map((ch: ArrayBuffer) => new Float32Array(ch));
        this.samples.set(msg.noteIdx, { data: channels, length: channels[0].length, rate: msg.sampleRate / this.sampleRate_ });
        break;
      }
      case 'play': case 'stop': case 'stopAllSynth':
        this.msgQueue.push(msg);
        break;
      case 'param':
        (this as any)['_' + msg.key] = msg.value;
        break;
      case 'synthParams':
        this._synthType = msg.type; this._synthAttack = msg.attack;
        this._synthDecay = msg.decay; this._synthSustain = msg.sustain; this._synthRelease = msg.release;
        break;
    }
  }

  private _drainEvents(): void {
    if (this.useSAB) {
      const wh = Atomics.load(this.ctrl!, CTRL_WRITE_HEAD);
      const rh = Atomics.load(this.ctrl!, CTRL_READ_HEAD);
      for (let i = rh; i < wh; i++) {
        const base = (i % RING_CAPACITY) * EVENT_FIELDS;
        this._evt(this.ring![base], this.ring![base + 1], this.ringF32![base + 2], this.ring![base + 3], this.ring![base + 4]);
      }
      Atomics.store(this.ctrl!, CTRL_READ_HEAD, wh);
    } else {
      const q = this.msgQueue;
      for (let i = 0; i < q.length; i++) {
        const m = q[i];
        if (m.cmd === 'play') this._evt(CMD_PLAY, m.noteIdx, m.vol, m.delayFrames, m.partHash);
        else if (m.cmd === 'stop') this._evt(CMD_STOP, m.noteIdx, 0, m.delayFrames, m.partHash);
        else this._evt(CMD_STOP_ALL_SYNTH, 0, 0, 0, 0);
      }
      q.length = 0;
    }
  }

  private _evt(cmd: number, noteIdx: number, vol: number, delayFrames: number, partHash: number): void {
    if (cmd === CMD_PLAY) {
      const prev = this.noteSlots.get(noteIdx);
      if (prev !== undefined && this.activePos[prev] >= 0) this._deactivate(prev);
      if (this.activeCount >= MIX_CAP) {
        const victim = this._findOldest();
        if (victim >= 0) {
          const vn = this.vNoteIdx[victim];
          if (this.noteSlots.get(vn) === victim) this.noteSlots.delete(vn);
          this._deactivate(victim);
        }
      }
      const slot = this._acquireVoice();
      this.vNoteIdx[slot] = noteIdx;
      this.vPartHash[slot] = partHash;
      this.vPos[slot] = 0;
      this.vGain[slot] = vol;
      this.vTargetGain[slot] = vol;
      this.vFadeRate[slot] = 0;
      this.vStartFrame[slot] = this.frameCounter;
      this.vDelayRemaining[slot] = delayFrames;
      const synthOn = this.useSAB ? Atomics.load(this.ctrl!, CTRL_SYNTH_ENABLED) : this._synthEnabled;
      if (synthOn) {
        this.vSynthActive[slot] = 1;
        this.vSynthPhase[slot] = 0;
        this.vSynthFreq[slot] = 440 * Math.pow(2, (noteIdx - 60) / 12);
        this.vSynthEnvStage[slot] = 0;
        this.vSynthEnvLevel[slot] = 0;
        this.vSynthEnvPos[slot] = 0;
      } else {
        this.vSynthActive[slot] = 0;
      }
      this._activate(slot);
      this.noteSlots.set(noteIdx, slot);
    } else if (cmd === CMD_STOP) {
      const slot = this.noteSlots.get(noteIdx);
      if (slot !== undefined && this.activePos[slot] >= 0 && this.vPartHash[slot] === partHash) {
        this.vTargetGain[slot] = 0;
        this.vFadeRate[slot] = -this.vGain[slot] / (this.sampleRate_ * 0.15);
        if (this.vSynthActive[slot]) { this.vSynthEnvStage[slot] = 3; this.vSynthEnvPos[slot] = 0; }
        this.noteSlots.delete(noteIdx);
      }
    } else if (cmd === CMD_STOP_ALL_SYNTH) {
      for (let i = 0; i < this.activeCount; i++) {
        const s = this.activeList[i];
        if (this.vSynthActive[s]) { this.vSynthEnvStage[s] = 3; this.vSynthEnvPos[s] = 0; }
      }
    }
  }

  private _findOldest(): number {
    if (this.activeCount === 0) return -1;
    let oldest = this.activeList[0], oldestFrame = this.vStartFrame[oldest];
    for (let i = 1; i < this.activeCount; i++) {
      const s = this.activeList[i];
      if (this.vStartFrame[s] < oldestFrame) { oldestFrame = this.vStartFrame[s]; oldest = s; }
    }
    return oldest;
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0];
    if (!output || !output[0]) return true;
    const outL = output[0];
    const outR = output[1] || outL;
    const blockSize = outL.length;

    this._drainEvents();

    let masterVol: number, pianoMix: number, synthMix: number, synthType: number;
    let sA: number, sD: number, sS: number, sR: number;
    if (this.useSAB) {
      masterVol = this.ctrlF32![CTRL_VOLUME_F32];
      pianoMix = this.ctrlF32![CTRL_PIANO_GAIN_F32];
      synthMix = this.ctrlF32![CTRL_SYNTH_GAIN_F32];
      synthType = Atomics.load(this.ctrl!, CTRL_SYNTH_TYPE);
      sA = this.ctrlF32![CTRL_SYNTH_ATTACK_F32];
      sD = this.ctrlF32![CTRL_SYNTH_DECAY_F32];
      sS = this.ctrlF32![CTRL_SYNTH_SUSTAIN_F32];
      sR = this.ctrlF32![CTRL_SYNTH_RELEASE_F32];
    } else {
      masterVol = this._volume; pianoMix = this._pianoGain; synthMix = this._synthGain;
      synthType = this._synthType; sA = this._synthAttack; sD = this._synthDecay;
      sS = this._synthSustain; sR = this._synthRelease;
    }

    outL.fill(0);
    if (outR !== outL) outR.fill(0);
    const gP = pianoMix;
    const gS = synthMix;

    for (let ai = this.activeCount - 1; ai >= 0; ai--) {
      const slot = this.activeList[ai];
      if (!this._mix(slot, outL, outR, blockSize, gP, gS, synthType, sA, sD, sS, sR)) {
        const nid = this.vNoteIdx[slot];
        if (this.noteSlots.get(nid) === slot) this.noteSlots.delete(nid);
        this._deactivate(slot);
      }
    }
    this.frameCounter += blockSize;
    return true;
  }

  private _mix(v: number, outL: Float32Array, outR: Float32Array, blockSize: number, gP: number, gS: number, synthType: number, sA: number, sD: number, sS: number, sR: number): boolean {
    const sample = this.samples.get(this.vNoteIdx[v]);
    if (!sample && !this.vSynthActive[v]) return false;
    if (this.vGain[v] < GAIN_FLOOR && this.vFadeRate[v] <= 0) return false;

    const hasSynth = !!this.vSynthActive[v];
    const sLen = sample ? sample.length : 0;
    const sL = sample ? sample.data[0] : null;
    const sR2 = sample ? (sample.data[1] || sample.data[0]) : null;
    const rate = sample ? sample.rate : 1;

    if (!hasSynth && this.vFadeRate[v] === 0 && this.vDelayRemaining[v] <= 0
        && sample && rate > 0.999 && rate < 1.001) {
      const pos = this.vPos[v] | 0;
      const avail = sLen - pos;
      if (avail <= 0) return false;
      const n = avail < blockSize ? avail : blockSize;
      const g = this.vGain[v] * gP;
      for (let i = 0; i < n; i++) {
        outL[i] += sL![pos + i] * g;
        outR[i] += sR2![pos + i] * g;
      }
      this.vPos[v] = pos + n;
      return n >= blockSize;
    }

    const sr = this.sampleRate_;
    for (let i = 0; i < blockSize; i++) {
      if (this.vDelayRemaining[v] > 0) { this.vDelayRemaining[v]--; continue; }
      if (this.vFadeRate[v] !== 0) {
        this.vGain[v] += this.vFadeRate[v];
        if (this.vGain[v] <= GAIN_FLOOR && this.vFadeRate[v] < 0) return false;
        if (this.vFadeRate[v] > 0 && this.vGain[v] >= this.vTargetGain[v]) {
          this.vGain[v] = this.vTargetGain[v]; this.vFadeRate[v] = 0;
        }
      }
      let pL = 0, pR = 0;
      if (sample) {
        const pos = this.vPos[v];
        if (pos >= sLen) { if (!hasSynth) return false; }
        else {
          const idx = pos | 0, frac = pos - idx;
          const ni = idx + 1 < sLen ? idx + 1 : idx;
          pL = sL![idx] + (sL![ni] - sL![idx]) * frac;
          pR = sR2![idx] + (sR2![ni] - sR2![idx]) * frac;
          this.vPos[v] += rate;
        }
      }
      let sv = 0;
      if (hasSynth) {
        const ph = this.vSynthPhase[v];
        switch (synthType) {
          case 0: sv = Math.sin(ph * 6.283185307179586); break;
          case 1: sv = ph < 0.5 ? 1 : -1; break;
          case 2: sv = 2 * ph - 1; break;
          case 3: sv = ph < 0.5 ? 4 * ph - 1 : 3 - 4 * ph; break;
        }
        this.vSynthPhase[v] += this.vSynthFreq[v] / sr;
        if (this.vSynthPhase[v] >= 1) this.vSynthPhase[v] -= 1;
        sv *= this._env(v, sA, sD, sS, sR, sr);
        if (this.vSynthEnvStage[v] === 4) this.vSynthActive[v] = 0;
      }
      const g = this.vGain[v];
      outL[i] += pL * g * gP + sv * g * gS;
      outR[i] += pR * g * gP + sv * g * gS;
    }
    return true;
  }

  private _env(v: number, attack: number, decay: number, sustain: number, release: number, sr: number): number {
    const stage = this.vSynthEnvStage[v];
    const pos = this.vSynthEnvPos[v];
    let level: number;
    if (stage === 0) {
      const n = Math.max(1, attack * sr);
      level = pos / n;
      if (pos >= n) { this.vSynthEnvStage[v] = 1; this.vSynthEnvPos[v] = 0; this.vSynthEnvLevel[v] = 1; return 1; }
    } else if (stage === 1) {
      const n = Math.max(1, decay * sr);
      level = 1 - (1 - sustain) * (pos / n);
      if (pos >= n) { this.vSynthEnvStage[v] = 2; this.vSynthEnvPos[v] = 0; this.vSynthEnvLevel[v] = sustain; return sustain; }
    } else if (stage === 2) {
      level = sustain;
    } else if (stage === 3) {
      const n = Math.max(1, release * sr);
      const start = this.vSynthEnvLevel[v] || sustain;
      level = start * (1 - pos / n);
      if (pos >= n || level <= 0) { this.vSynthEnvStage[v] = 4; this.vSynthEnvLevel[v] = 0; return 0; }
    } else { return 0; }
    this.vSynthEnvPos[v] = pos + 1;
    this.vSynthEnvLevel[v] = level;
    return level;
  }
}

registerProcessor('piano-worklet-processor', PianoWorkletProcessor);
