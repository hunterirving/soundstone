const BAR_SECONDS = 0.1;
const SPLICE_SECONDS = 0.005;
// Time constant of a held tape's speed chasing the finger.
const FOLLOW_SECONDS = 0.05;
// Extra acceleration for the part of a speed gap beyond 1, so big gaps close fast.
const FAST_DECAY_SECONDS = 0.35;
// A tape jogged slower than this, as a fraction of normal speed, counts as stopped.
const SLOWEST_JOG = 0.05;
// Volume smoothing, against clicks.
const VOLUME_SECONDS = 0.02;
const RENDERS_PER_REPORT = 3;
// A working microphone is never exactly zero for this long.
const SILENT_SECONDS = 0.5;

const BAR_SAMPLES = Math.round(sampleRate * BAR_SECONDS);
const FAST_DECAY_RATE = 1 / (FAST_DECAY_SECONDS * sampleRate);
const FOLLOW_SAMPLES = FOLLOW_SECONDS * sampleRate;
const VOLUME_RATE = 1 / (VOLUME_SECONDS * sampleRate);

class Deck extends AudioWorkletProcessor {
	constructor({processorOptions}) {
		super();
		this.spinUpRate = 1 / (processorOptions.spinUpSeconds * sampleRate);
		this.spinDownSamples = processorOptions.spinDownSeconds * sampleRate;
		this.deleteRate = 1 / (processorOptions.deleteSeconds * sampleRate);
		this.tapes = [];
		this.recording = null;
		this.renders = 0;
		// Samples of exact zeros since the microphone opened; null when not checking.
		this.silence = null;
		this.microphoneGain = 1;
		this.playbackGain = 1;
		this.port.onmessage = ({data}) => {
			const tape = this.tapes[data.id];
			if (data.type === 'record') this.record();
			if (data.type === 'stop') this.stop();
			if (data.type === 'playbackGain') this.playbackGain = data.value;
			if (data.type === 'microphone') {
				this.silence = 0;
				this.microphoneGain = data.gain;
				this.playbackGain = data.playbackGain;
			}
			if (data.type === 'load') this.add(data.samples, data.volume);
			if (data.type === 'play') tape.target = 1;
			if (data.type === 'press' || data.type === 'brake') {
				// Stop time is fixed at any speed. A brake after a press keeps the press's rate.
				if (!tape.pressed) tape.stopRate = Math.abs(tape.speed) / this.spinDownSamples;
				tape.pressed = data.type === 'press';
				if (data.type === 'brake') tape.target = 0;
			}
			if (data.type === 'volume') tape.volume = data.value;
			if (data.type === 'grab') {
				tape.held = true;
				tape.pressed = false;
				tape.base = tape.speed;
				tape.direction = null;
				tape.target = tape.speed;
			}
			// A deleted tape fades out first, so that a playing one does not click.
			if (data.type === 'delete') tape.fadeRate = this.deleteRate;
			if (data.type === 'jog') {
				tape.target = tape.base + data.change;
				this.reportDirection(data.id);
			}
			if (data.type === 'drop') tape.pressed = false;
			if (data.type === 'release') {
				tape.held = false;
				if (Math.abs(tape.target) < SLOWEST_JOG) {
					tape.target = 0;
					tape.speed = 0;
				}
				this.reportDirection(data.id);
			}
		};
	}

	reportDirection(id) {
		const tape = this.tapes[id];
		const direction = Math.abs(tape.target) < SLOWEST_JOG ? 0 : Math.sign(tape.target);
		if (direction === tape.direction) return;
		tape.direction = direction;
		this.port.postMessage({type: 'direction', id, direction});
	}

	record() {
		this.recording = {
			blocks: [],
			block: new Float32Array(sampleRate),
			fill: 0,
			peak: 0,
			peakFill: 0,
		};
	}

	capture(input) {
		const rec = this.recording;
		const gain = this.microphoneGain;
		for (let i = 0; i < input.length; i++) {
			const sample = gain === 1 ? input[i] : Math.tanh(input[i] * gain);
			rec.block[rec.fill++] = sample;
			if (rec.fill === rec.block.length) {
				rec.blocks.push(rec.block);
				rec.block = new Float32Array(sampleRate);
				rec.fill = 0;
			}
			rec.peak = Math.max(rec.peak, Math.abs(sample));
			if (++rec.peakFill === BAR_SAMPLES) {
				this.port.postMessage({type: 'peak', value: rec.peak});
				rec.peak = 0;
				rec.peakFill = 0;
			}
		}
	}

	stop() {
		const rec = this.recording;
		if (!rec) return;
		this.recording = null;

		const length = rec.blocks.length * sampleRate + rec.fill;
		const splice = Math.round(sampleRate * SPLICE_SECONDS);
		if (length < splice * 2) {
			this.port.postMessage({type: 'discard'});
			return;
		}
		const samples = new Float32Array(length);
		rec.blocks.forEach((block, i) => samples.set(block, i * sampleRate));
		samples.set(rec.block.subarray(0, rec.fill), rec.blocks.length * sampleRate);

		// Fade both ends so the loop point does not click.
		for (let i = 0; i < splice; i++) {
			samples[i] *= i / splice;
			samples[length - 1 - i] *= i / splice;
		}

		// The last bar is shorter than the others unless the take ends on a bar boundary.
		const peaks = new Float32Array(Math.ceil(length / BAR_SAMPLES));
		for (let i = 0; i < length; i++) {
			const bar = Math.floor(i / BAR_SAMPLES);
			peaks[bar] = Math.max(peaks[bar], Math.abs(samples[i]));
		}

		this.add(samples, 1);
		this.port.postMessage({type: 'tape', peaks, length: length / BAR_SAMPLES, samples});
	}

	add(samples, volume) {
		this.tapes.push({
			samples,
			position: 0,
			reported: 0,
			// Samples per output sample; negative is backwards.
			speed: 0,
			// Speed a free tape eases towards.
			target: 0,
			held: false,
			// A resting finger brakes the tape towards zero.
			pressed: false,
			// Speed lost per sample while stopping.
			stopRate: 0,
			// Speed when a jog began.
			base: 0,
			// Last direction reported to the main thread during this jog.
			direction: null,
			volume,
			// Smoothed `volume`.
			gain: volume,
			// Falls from 1 to 0 at `fadeRate` per sample once the tape is deleted.
			fade: 1,
			fadeRate: 0,
		});
	}

	process(inputs, outputs) {
		const input = inputs[0][0];
		const output = outputs[0][0];
		if (this.recording && input) this.capture(input);
		if (this.silence !== null && input) {
			if (input.some(sample => sample !== 0)) {
				this.silence = null;
			} else if ((this.silence += input.length) >= SILENT_SECONDS * sampleRate) {
				this.silence = null;
				this.port.postMessage({type: 'silent'});
			}
		}

		for (const [id, tape] of this.tapes.entries()) {
			if (!tape) continue;
			const goal = tape.pressed ? 0 : tape.target;
			// Nulled, not spliced, so the other ids stay valid.
			if (tape.fade === 0 || (tape.fadeRate && tape.speed === 0)) {
				this.tapes[id] = null;
				continue;
			}
			if (tape.speed === 0 && goal === 0) {
				tape.gain = tape.volume;
				continue;
			}
			const {samples} = tape;
			const length = samples.length;
			for (let i = 0; i < output.length; i++) {
				if (tape.held) {
					tape.speed += (tape.target - tape.speed) / FOLLOW_SAMPLES;
				} else if (tape.speed !== goal) {
					const gap = goal - tape.speed;
					const distance = Math.abs(gap);
					const change = goal
						? this.spinUpRate + Math.max(0, distance - 1) * FAST_DECAY_RATE
						: tape.stopRate;
					tape.speed += Math.sign(gap) * Math.min(distance, change);
				}
				tape.gain += (tape.volume - tape.gain) * VOLUME_RATE;
				tape.fade = Math.max(0, tape.fade - tape.fadeRate);
				const index = Math.floor(tape.position);
				const fraction = tape.position - index;
				const a = samples[index];
				const b = samples[index + 1 === length ? 0 : index + 1];
				// Level follows speed up to 1, like a real playback head.
				output[i] += (a + (b - a) * fraction) * Math.min(1, Math.abs(tape.speed)) * tape.gain * tape.fade;
				tape.position += tape.speed;
				if (tape.position < 0 || tape.position >= length) {
					tape.position = (tape.position % length + length) % length;
					// Rounding can land a tiny negative position exactly on `length`.
					if (tape.position >= length) tape.position = 0;
				}
			}
			if (tape.held && tape.target === 0 && Math.abs(tape.speed) < 1e-4) tape.speed = 0;
		}

		// Soft-clip the raised mix, as in capture().
		if (this.playbackGain !== 1) {
			for (let i = 0; i < output.length; i++) {
				output[i] = Math.tanh(output[i] * this.playbackGain);
			}
		}

		const moved = tape => tape && tape.position !== tape.reported;
		if (++this.renders % RENDERS_PER_REPORT === 0 && this.tapes.some(moved)) {
			this.port.postMessage({
				type: 'positions',
				positions: this.tapes.map(tape => tape && (tape.reported = tape.position) / BAR_SAMPLES),
			});
		}
		return true;
	}
}

registerProcessor('deck', Deck);
