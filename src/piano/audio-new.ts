// <experimental audio engine>
//
import { Notification } from '../libs/Notification';
import {
	SAB_BYTES, CTRL_BYTES, RING_CAPACITY, EVENT_FIELDS,
	CTRL_WRITE_HEAD, CTRL_READ_HEAD, CTRL_VOLUME_F32,
	CTRL_SYNTH_ENABLED, CTRL_SYNTH_TYPE,
	CTRL_SYNTH_ATTACK_F32, CTRL_SYNTH_DECAY_F32,
	CTRL_SYNTH_SUSTAIN_F32, CTRL_SYNTH_RELEASE_F32,
	CTRL_PIANO_GAIN_F32, CTRL_SYNTH_GAIN_F32,
	CMD_PLAY, CMD_STOP, CMD_STOP_ALL_SYNTH,
} from './ring-buffer-layout';

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

const _idToIdx = new Map<string, number>();
let _nextIdx = 0;
function internId(id: string): number {
	let i = _idToIdx.get(id);
	if (i === undefined) { i = _nextIdx++; _idToIdx.set(id, i); }
	return i;
}

function fnv1a(str: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

export class AudioEngineWeb extends AudioEngine {
	context!: AudioContext;
	masterGain!: GainNode;
	limiterNode!: DynamicsCompressorNode;
	pianoGain!: GainNode;
	synthGain!: GainNode;

	private sab!: SharedArrayBuffer | null;
	private ctrl!: Int32Array | null;
	private ctrlF32!: Float32Array | null;
	private ring!: Uint32Array | null;
	private ringF32!: Float32Array | null;
	private useSAB: boolean = false;
	private node!: AudioWorkletNode;
	private ready: boolean = false;
	private pendingQueue: any[] = [];
	private loadedNotes: Set<string> = new Set();

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

		this._initWorklet();
		return this;
	}

	private async _initWorklet(): Promise<void> {
		try {
			await this.context.audioWorklet.addModule('./piano-worklet-processor.js');
		} catch (e) {
			new Notification({
				id: 'worklet-load-error',
				title: 'Problem',
				text: `AudioWorklet failed to load: ${(e as Error).message}`,
				target: '#piano',
				duration: 10000,
			});
			return;
		}

		this.node = new AudioWorkletNode(this.context, 'piano-worklet-processor', {
			numberOfInputs: 0,
			numberOfOutputs: 1,
			outputChannelCount: [2],
		});
		this.node.connect(this.masterGain);

		this.useSAB = typeof SharedArrayBuffer !== 'undefined' && crossOriginIsolated;
		if (!this.useSAB) {
			console.warn('[AudioEngineWorklet] SharedArrayBuffer unavailable — using MessagePort fallback (higher latency)');
		}
		if (this.useSAB) {
			this.sab = new SharedArrayBuffer(SAB_BYTES);
			this.ctrl = new Int32Array(this.sab, 0, CTRL_BYTES / 4);
			this.ctrlF32 = new Float32Array(this.sab, 0, CTRL_BYTES / 4);
			this.ring = new Uint32Array(this.sab, CTRL_BYTES);
			this.ringF32 = new Float32Array(this.sab, CTRL_BYTES);
			this.ctrlF32[CTRL_VOLUME_F32] = this.volume;
			this.ctrlF32[CTRL_PIANO_GAIN_F32] = 0.5;
			this.ctrlF32[CTRL_SYNTH_GAIN_F32] = 0.025;
			this.node.port.postMessage({ cmd: 'init', sab: this.sab, sampleRate: this.context.sampleRate });
		} else {
			this.sab = null;
			this.ctrl = null;
			this.ctrlF32 = null;
			this.ring = null;
			this.ringF32 = null;
			this.node.port.postMessage({ cmd: 'init', sab: null, sampleRate: this.context.sampleRate });
		}

		this.ready = true;
		this._flushPending();
	}

	private _flushPending(): void {
		for (const msg of this.pendingQueue) {
			this.node.port.postMessage(msg);
		}
		this.pendingQueue.length = 0;
	}

	stopAllSynthVoices(): void {
		if (this.useSAB && this.ctrl && this.ring && this.ringF32) {
			this._writeEvent(CMD_STOP_ALL_SYNTH, 0, 0, 0, 0);
		} else if (this.ready) {
			this.node.port.postMessage({ cmd: 'stopAllSynth' });
		}
	}

	load(id: string, url: string, cb?: () => void): void {
		fetch(url)
			.then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); })
			.then(buf => this.context.decodeAudioData(buf))
			.then(decoded => {
				this.sounds[id] = decoded;
				this.loadedNotes.add(id);
				this._transferSample(id, decoded);
				cb?.();
			})
			.catch(e => new Notification({
				id: 'audio-download-error',
				title: 'Problem',
				text: `Audio download failed: ${(e as Error).message}`,
				target: '#piano',
				duration: 10000,
			}));
	}

	private _transferSample(id: string, buffer: AudioBuffer): void {
		const noteIdx = internId(id);
		const channels: ArrayBuffer[] = [];
		const channelData: Float32Array[] = [];
		for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
			const data = buffer.getChannelData(ch);
			const copy = new Float32Array(data.length);
			copy.set(data);
			channelData.push(copy);
			channels.push(copy.buffer);
		}
		const msg = {
			cmd: 'load',
			noteIdx,
			sampleRate: buffer.sampleRate,
			channels: channelData,
		};
		if (this.ready) {
			this.node.port.postMessage(msg, channels);
		} else {
			this.pendingQueue.push(msg);
		}
	}

	play(id: string, vol: number, delay_ms: number, part_id: string): void {
		if (this.paused || !this.loadedNotes.has(id)) return;
		const noteIdx = internId(id);
		const delayFrames = Math.round((delay_ms / 1000) * this.context.sampleRate);
		const partHash = fnv1a(part_id);

		if (this.useSAB && this.ctrl && this.ring && this.ringF32) {
			this._writeEvent(CMD_PLAY, noteIdx, vol, delayFrames, partHash);
		} else if (this.ready) {
			this.node.port.postMessage({ cmd: 'play', noteIdx, vol, delayFrames, partHash });
		} else {
			this.pendingQueue.push({ cmd: 'play', noteIdx, vol, delayFrames, partHash });
		}
	}

	stop(id: string, delay_ms: number, part_id: string): void {
		const noteIdx = internId(id);
		const delayFrames = Math.round((delay_ms / 1000) * this.context.sampleRate);
		const partHash = fnv1a(part_id);

		if (this.useSAB && this.ctrl && this.ring && this.ringF32) {
			this._writeEvent(CMD_STOP, noteIdx, 0, delayFrames, partHash);
		} else if (this.ready) {
			this.node.port.postMessage({ cmd: 'stop', noteIdx, vol: 0, delayFrames, partHash });
		} else {
			this.pendingQueue.push({ cmd: 'stop', noteIdx, vol: 0, delayFrames, partHash });
		}
	}

	private _writeEvent(cmd: number, noteIdx: number, vol: number, delayFrames: number, partHash: number): void {
		const ctrl = this.ctrl!;
		const ring = this.ring!;
		const ringF32 = this.ringF32!;
		const writeHead = Atomics.load(ctrl, CTRL_WRITE_HEAD);
		const readHead = Atomics.load(ctrl, CTRL_READ_HEAD);
		if (writeHead - readHead >= RING_CAPACITY) return;

		const slot = (writeHead % RING_CAPACITY) * EVENT_FIELDS;
		ring[slot] = cmd;
		ring[slot + 1] = noteIdx;
		ringF32[slot + 2] = vol;
		ring[slot + 3] = delayFrames;
		ring[slot + 4] = partHash;
		Atomics.store(ctrl, CTRL_WRITE_HEAD, writeHead + 1);
	}

	setVolume(vol: number): void {
		super.setVolume(vol);
		if (this.masterGain) this.masterGain.gain.value = vol;
		if (this.useSAB && this.ctrlF32) {
			this.ctrlF32[CTRL_VOLUME_F32] = vol;
		} else if (this.ready) {
			this.node.port.postMessage({ cmd: 'param', key: 'volume', value: vol });
		}
	}

	resume(): void {
		this.paused = false;
		this.context.resume();
	}

	setSynthEnabled(enabled: boolean): void {
		if (this.useSAB && this.ctrl) {
			Atomics.store(this.ctrl, CTRL_SYNTH_ENABLED, enabled ? 1 : 0);
		} else if (this.ready) {
			this.node.port.postMessage({ cmd: 'param', key: 'synthEnabled', value: enabled ? 1 : 0 });
		}
	}

	setSynthParams(type: number, attack: number, decay: number, sustain: number, release: number): void {
		if (this.useSAB && this.ctrl && this.ctrlF32) {
			Atomics.store(this.ctrl, CTRL_SYNTH_TYPE, type);
			this.ctrlF32[CTRL_SYNTH_ATTACK_F32] = attack;
			this.ctrlF32[CTRL_SYNTH_DECAY_F32] = decay;
			this.ctrlF32[CTRL_SYNTH_SUSTAIN_F32] = sustain;
			this.ctrlF32[CTRL_SYNTH_RELEASE_F32] = release;
		} else if (this.ready) {
			this.node.port.postMessage({ cmd: 'synthParams', type, attack, decay, sustain, release });
		}
	}
}
