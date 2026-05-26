export const CTRL_BYTES = 64;
export const EVENT_FIELDS = 5;
export const EVENT_BYTES = EVENT_FIELDS * 4;
export const RING_CAPACITY = 4096;
export const RING_BYTES = RING_CAPACITY * EVENT_BYTES;
export const SAB_BYTES = CTRL_BYTES + RING_BYTES;

export const CTRL_WRITE_HEAD = 0;
export const CTRL_READ_HEAD = 1;
export const CTRL_VOLUME_F32 = 2;
export const CTRL_SYNTH_ENABLED = 3;
export const CTRL_SYNTH_TYPE = 4;
export const CTRL_SYNTH_ATTACK_F32 = 5;
export const CTRL_SYNTH_DECAY_F32 = 6;
export const CTRL_SYNTH_SUSTAIN_F32 = 7;
export const CTRL_SYNTH_RELEASE_F32 = 8;
export const CTRL_PIANO_GAIN_F32 = 9;
export const CTRL_SYNTH_GAIN_F32 = 10;

export const RING_START_U32 = CTRL_BYTES / 4;

export const CMD_PLAY = 1;
export const CMD_STOP = 2;
export const CMD_STOP_ALL_SYNTH = 3;
