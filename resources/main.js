// The head is the middle slot, above the record button.
const SLOTS = 51;
const HEAD = (SLOTS - 1) / 2;
const SPIN_UP_SECONDS = 0.4;
// Independent of the starting speed.
const SPIN_DOWN_SECONDS = 0.7;
// A finger resting on a playing tape brakes it after this. A volume drag that
// begins sooner leaves the tape alone.
const PRESS_DELAY_MILLISECONDS = 150;
// In CSS px.
const DRAG_THRESHOLD = 5;
const APPEAR_MILLISECONDS = 300;
// A deleted row fades out faster than it shrinks.
const DELETE_FADE_MILLISECONDS = 200;
const HOLD_TO_DELETE_MILLISECONDS = 2000;
const UPCOMING_OPACITY = 0.35;
const MAX_VOLUME = 2;
// Time constant of bar height changes.
const BAR_EASE_SECONDS = 0.035;
// Throttle scroll speed grows with drag distance up to SCROLL_FULL_DRAG px, where it
// reaches SCROLL_TOP_SPEED px/s.
const SCROLL_FULL_DRAG = 100;
const SCROLL_TOP_SPEED = 1000;
// Sideways drag distance, in CSS px, that changes a tape's speed by 1.
const THROTTLE_DRAG = 100;
// The iOS built-in microphone is super quiet with processing off, and while it is
// open the speaker plays quieter. These gains compensate.
const BUILT_IN_MICROPHONE_GAIN = 20;
const BUILT_IN_PLAYBACK_GAIN = 2;

const tapesElement = document.querySelector('#tapes');
const recordButton = document.querySelector('#record');

// A tape's index is its id on the audio thread. A deleted tape leaves a null behind.
const tapes = [];
let recording = null;
let audio = null;
let deck = null;
let setup = null;
let microphone = null;
let microphoneOpening = null;
// Decides whether the microphone is reopened when the page returns.
let microphoneUsed = false;
let microphoneRepaired = false;

const database = new Promise((resolve, reject) => {
	const request = indexedDB.open('soundstone', 1);
	request.onupgradeneeded = () => {
		request.result.createObjectStore('tapes', {autoIncrement: true});
		request.result.createObjectStore('samples');
	};
	request.onsuccess = () => resolve(request.result);
	request.onerror = () => reject(request.error);
});

const settled = request => new Promise((resolve, reject) => {
	request.onsuccess = () => resolve(request.result);
	request.onerror = () => reject(request.error);
});

// Resolves to the storage key.
async function saveTape(tape, samples) {
	const transaction = (await database).transaction(['tapes', 'samples'], 'readwrite');
	const key = await settled(transaction.objectStore('tapes').add({
		peaks: tape.peaks,
		length: tape.length,
		volume: tape.volume,
		sampleRate: audio.sampleRate,
	}));
	transaction.objectStore('samples').put(samples, key);
	return key;
}

async function saveVolume(tape) {
	const key = await tape.saved;
	const store = (await database).transaction('tapes', 'readwrite').objectStore('tapes');
	const record = await settled(store.get(key));
	record.volume = tape.volume;
	store.put(record, key);
}

async function forgetTape(tape) {
	const key = await tape.saved;
	const transaction = (await database).transaction(['tapes', 'samples'], 'readwrite');
	transaction.objectStore('tapes').delete(key);
	transaction.objectStore('samples').delete(key);
}

// The device rate can change between visits, eg with headphones. Converting keeps the pitch.
async function resample(samples, rate) {
	if (rate === audio.sampleRate) return samples;
	const length = Math.round(samples.length * audio.sampleRate / rate);
	const offline = new OfflineAudioContext(1, length, audio.sampleRate);
	const source = offline.createBufferSource();
	source.buffer = new AudioBuffer({length: samples.length, sampleRate: rate});
	source.buffer.copyToChannel(samples, 0);
	source.connect(offline.destination);
	source.start();
	return (await offline.startRendering()).getChannelData(0);
}

async function loadTapes() {
	const transaction = (await database).transaction(['tapes', 'samples']);
	const [keys, records, takes] = await Promise.all([
		settled(transaction.objectStore('tapes').getAllKeys()),
		settled(transaction.objectStore('tapes').getAll()),
		settled(transaction.objectStore('samples').getAll()),
	]);
	for (const [i, {peaks, length, volume, sampleRate}] of records.entries()) {
		const samples = await resample(takes[i], sampleRate);
		deck.port.postMessage({type: 'load', samples, volume});
		const tape = addTape({peaks, length, volume, saved: keys[i]});
		makeGrabbable(tape, tapes.length);
		tapes.push(tape);
	}
	tapesElement.scrollTop = tapesElement.scrollHeight;
}

// Runs on load. Audio stays suspended until the first touch, but saved tapes load meanwhile.
async function setUpAudio() {
	audio = new AudioContext();
	await audio.audioWorklet.addModule('resources/deck.js');
	deck = new AudioWorkletNode(audio, 'deck', {
		outputChannelCount: [1],
		processorOptions: {
			spinUpSeconds: SPIN_UP_SECONDS,
			spinDownSeconds: SPIN_DOWN_SECONDS,
			deleteSeconds: APPEAR_MILLISECONDS / 1000,
		},
	});
	deck.connect(audio.destination);
	deck.port.onmessage = ({data}) => handlers[data.type](data);
	setAudioSessionType('playback');
	await loadTapes();
}

// Safari only. The type decides whether sound continues while the device is locked.
function setAudioSessionType(type) {
	if (navigator.audioSession) navigator.audioSession.type = type;
}

function openMicrophone() {
	microphoneOpening ??= (async () => {
		setAudioSessionType('play-and-record');
		const stream = await navigator.mediaDevices.getUserMedia({
			audio: {echoCancellation: false, noiseSuppression: false, autoGainControl: false},
		});
		const source = audio.createMediaStreamSource(stream);
		source.connect(deck);
		// iOS names the built-in microphone after the device, as in "iPhone Microphone".
		const builtIn = /iPhone|iPad/.test(stream.getAudioTracks()[0].label);
		deck.port.postMessage({
			type: 'microphone',
			gain: builtIn ? BUILT_IN_MICROPHONE_GAIN : 1,
			playbackGain: builtIn ? BUILT_IN_PLAYBACK_GAIN : 1,
		});
		microphone = {stream, source};
		microphoneUsed = true;
	})().finally(() => microphoneOpening = null);
	return microphoneOpening;
}

function closeMicrophone() {
	microphone.source.disconnect();
	for (const track of microphone.stream.getTracks()) track.stop();
	microphone = null;
	deck.port.postMessage({type: 'playbackGain', value: 1});
}

// iOS can get stuck delivering silence to an unprocessed microphone, across
// launches. A hacky attempt at fixing this.
async function repairMicrophone() {
	if (!microphone || microphoneRepaired) return;
	microphoneRepaired = true;
	const stream = await navigator.mediaDevices.getUserMedia({audio: true});
	for (const track of stream.getTracks()) track.stop();
	if (!microphone) return;
	closeMicrophone();
	await openMicrophone();
}

// In Safari an open microphone stops audio at lock, so it is released while
// hidden unless a take is in progress.
document.addEventListener('visibilitychange', async () => {
	if (!navigator.audioSession || !deck) return;
	if (!document.hidden) {
		audio.resume();
		if (microphoneUsed && !microphone) await openMicrophone();
	}
	if (document.hidden && microphone && !recording) {
		closeMicrophone();
		setAudioSessionType('playback');
	}
});

const handlers = {
	peak({value}) {
		recording.peaks.push(value);
	},

	tape({peaks, length, samples}) {
		const tape = recording;
		recording = null;
		tape.peaks = peaks;
		tape.length = length;
		tape.saved = saveTape(tape, samples);
		tape.recording = false;
		tape.redraw = true;
		makeGrabbable(tape, tapes.length);
		tapes.push(tape);
	},

	silent() {
		repairMicrophone();
	},

	discard() {
		recording.row.remove();
		recording = null;
	},

	direction({id, direction}) {
		if (tapes[id]) tapes[id].direction = direction;
	},

	positions({positions}) {
		positions.forEach((position, id) => {
			if (tapes[id]) tapes[id].position = position;
		});
	},
};

function addTape(fields) {
	const row = document.createElement('div');
	row.className = 'tape';
	const canvas = row.appendChild(document.createElement('canvas'));
	tapesElement.append(row);
	const tape = {
		row,
		canvas,
		peaks: [],
		// In bars; not always whole.
		length: 0,
		// Head position, in bars.
		position: 0,
		recording: false,
		// 1, -1, or 0 when stopped.
		direction: 0,
		volume: 1,
		// Drawn bar lengths in canvas px, trailing their targets.
		lengths: null,
		// Dimming left and right of the head, 0 to 1.
		dim: [0, 0],
		redraw: true,
		// Storage key, or a promise of it while saving.
		saved: null,
		...fields,
	};
	fit(tape);
	return tape;
}

async function toggleRecording() {
	if (recording) {
		deck.port.postMessage({type: 'stop'});
		recordButton.classList.remove('recording');
		return;
	}
	// Only a press may start audio, and it stops counting once the microphone
	// prompt is answered, so resume before awaiting.
	audio.resume();
	await setup;
	if (!microphone) await openMicrophone();
	if (recording) return;
	audio.resume();

	recording = addTape({recording: true});
	const {row} = recording;
	deck.port.postMessage({type: 'record'});
	recordButton.classList.add('recording');

	row.animate(
		[{height: 0, opacity: 0}, {}],
		{duration: APPEAR_MILLISECONDS, easing: 'ease-out'},
	);
	const scrollStart = tapesElement.scrollTop;
	const began = performance.now();
	const follow = now => {
		const progress = Math.min(1, Math.max(0, (now - began) / APPEAR_MILLISECONDS));
		const bottom = tapesElement.scrollHeight - tapesElement.clientHeight;
		tapesElement.scrollTop = scrollStart + (bottom - scrollStart) * (1 - (1 - progress) ** 3);
		if (progress < 1) requestAnimationFrame(follow);
	};
	requestAnimationFrame(follow);
}

// pointerdown, because a second finger on the screen produces no click.
// The click listener serves the keyboard (detail 0).
recordButton.addEventListener('pointerdown', toggleRecording);
recordButton.addEventListener('click', event => {
	if (event.detail === 0) toggleRecording();
});

function makeGrabbable(tape, id) {
	const {row} = tape;
	const send = (type, fields) => deck.port.postMessage({type, id, ...fields});
	let start = null;
	let mode = null;
	let wasPlaying = false;
	// This pointer has started braking the tape.
	let pressed = false;
	let pressTimer = null;
	let holdTimer = null;
	// One pointer per tape, so several tapes can be touched at once.
	let pointerId = null;
	row.classList.add('finished');

	const remove = () => {
		start = null;
		send('delete');
		forgetTape(tape);
		tapes[id] = null;
		row.classList.remove('finished');
		row.animate([{}, {opacity: 0}], {duration: DELETE_FADE_MILLISECONDS, easing: 'ease-out', fill: 'forwards'});
		row.animate(
			[{}, {height: 0}],
			{duration: APPEAR_MILLISECONDS, easing: 'ease-out'},
		).finished.then(() => row.remove());
	};

	row.addEventListener('pointerdown', event => {
		if (pointerId !== null) return;
		if (event.shiftKey) {
			remove();
			return;
		}
		audio.resume();
		pointerId = event.pointerId;
		row.setPointerCapture(pointerId);
		row.classList.add('grabbed');
		start = {x: event.clientX, y: event.clientY, volume: tape.volume};
		mode = null;
		wasPlaying = tape.direction !== 0;
		pressed = false;
		if (wasPlaying) {
			pressTimer = setTimeout(() => {
				pressed = true;
				send('press');
			}, PRESS_DELAY_MILLISECONDS);
		}
		holdTimer = setTimeout(remove, HOLD_TO_DELETE_MILLISECONDS);
	});

	row.addEventListener('pointermove', event => {
		if (event.pointerId !== pointerId || !start) return;
		if (!mode) {
			const acrossTravel = Math.abs(event.clientX - start.x);
			const upTravel = Math.abs(event.clientY - start.y);
			if (Math.max(acrossTravel, upTravel) < DRAG_THRESHOLD) return;
			if (acrossTravel < upTravel && pressed) return;
			mode = acrossTravel >= upTravel ? 'throttle' : 'volume';
			clearTimeout(pressTimer);
			clearTimeout(holdTimer);
			// Browsers suspend audio until the first tap or click; a dragged touch
			// doesn't count. Ignore a throttle drag before then, as the tape can't play.
			if (mode === 'throttle' && audio.state !== 'running') mode = 'ignored';
			if (mode !== 'ignored') row.classList.add(mode);
			if (mode === 'throttle') send('grab');
			pressed = false;
		}
		if (mode === 'throttle') {
			send('throttle', {change: (event.clientX - start.x) / THROTTLE_DRAG});
		} else if (mode === 'volume') {
			const change = (start.y - event.clientY) / row.clientHeight;
			tape.volume = Math.min(MAX_VOLUME, Math.max(0, start.volume + change));
			send('volume', {value: tape.volume});
		}
	});

	const end = event => {
		if (event.pointerId !== pointerId) return;
		pointerId = null;
		// A touch only counts as a user gesture when it lifts without having moved,
		// so the resume on pointerdown fails if this touch is the first one.
		audio.resume();
		clearTimeout(pressTimer);
		clearTimeout(holdTimer);
		row.classList.remove('grabbed', 'throttle', 'volume');
		if (!start) return;
		start = null;
		if (mode === 'volume') saveVolume(tape);
		if (mode === 'throttle') {
			send('release');
		} else if (!mode && event.type === 'pointerup') {
			send(wasPlaying ? 'brake' : 'play');
			tape.direction = wasPlaying ? 0 : 1;
		} else if (pressed) {
			send('drop');
		}
		pressed = false;
	};
	row.addEventListener('pointerup', end);
	row.addEventListener('pointercancel', end);
}

// Throttle control: while held, scroll speed follows the offset from the press point.
const footer = document.querySelector('footer');
let scrollDrag = null;

footer.addEventListener('pointerdown', event => {
	if (scrollDrag || event.target === recordButton) return;
	footer.setPointerCapture(event.pointerId);
	scrollDrag = {pointerId: event.pointerId, startY: event.clientY, y: event.clientY};
	let last = performance.now();
	const step = now => {
		if (!scrollDrag) return;
		const pull = Math.min(1, Math.max(-1, (scrollDrag.y - scrollDrag.startY) / SCROLL_FULL_DRAG));
		tapesElement.scrollTop += pull * SCROLL_TOP_SPEED * Math.max(0, now - last) / 1000;
		last = now;
		requestAnimationFrame(step);
	};
	requestAnimationFrame(step);
});

footer.addEventListener('pointermove', event => {
	if (scrollDrag?.pointerId === event.pointerId) scrollDrag.y = event.clientY;
});

const endScrollDrag = event => {
	if (scrollDrag?.pointerId === event.pointerId) scrollDrag = null;
};
footer.addEventListener('pointerup', endScrollDrag);
footer.addEventListener('pointercancel', endScrollDrag);

function fit(tape) {
	const {width, height} = tape.canvas.getBoundingClientRect();
	tape.canvas.width = Math.round(width * devicePixelRatio);
	tape.canvas.height = Math.round(height * devicePixelRatio);
	tape.lengths = null;
}

addEventListener('resize', () => {
	tapes.filter(Boolean).forEach(fit);
	if (recording) fit(recording);
});

// Null where there is no tape.
function peakAt(tape, slot) {
	const offset = slot - HEAD;
	const {peaks, length} = tape;
	if (tape.recording) {
		const index = peaks.length + offset;
		return offset < 0 && index >= 0 ? peaks[index] : null;
	}
	// Blend the two bars a slot lies between, so motion is smooth across the loop point.
	const bar = ((tape.position + offset) % length + length) % length;
	const index = Math.min(Math.floor(bar), peaks.length - 1);
	const next = (index + 1) % peaks.length;
	// The last bar of a tape can be shorter than the others.
	const span = Math.min(1, length - index);
	return peaks[index] + (peaks[next] - peaks[index]) * (bar - index) / span;
}

// Eases bars and dimming towards their targets; redraws only on change.
function animate(tape, seconds) {
	const {canvas} = tape;
	const {width, height} = canvas;
	const pitch = width / SLOTS;
	const thickness = pitch * 0.42;
	const shortest = thickness * 2.5;
	let changed = tape.redraw;
	tape.redraw = false;

	const snap = !tape.lengths;
	tape.lengths ??= new Float32Array(SLOTS);
	const ease = snap ? 1 : 1 - Math.exp(-seconds / BAR_EASE_SECONDS);
	const recorded = [];
	for (let slot = 0; slot < SLOTS; slot++) {
		const peak = peakAt(tape, slot);
		recorded[slot] = peak !== null;
		const wanted = peak === null
			? thickness
			: shortest + (height * 0.85 - shortest) * Math.min(1, peak * tape.volume) ** 0.6;
		const gap = wanted - tape.lengths[slot];
		if (Math.abs(gap) < 0.1) continue;
		tape.lengths[slot] += gap * ease;
		changed = true;
	}

	// Dim the side about to play, over the spin-down time.
	const wantedDim = [tape.direction < 0 ? 1 : 0, tape.direction > 0 ? 1 : 0];
	for (const side of [0, 1]) {
		const gap = wantedDim[side] - tape.dim[side];
		if (gap === 0) continue;
		tape.dim[side] += Math.sign(gap) * Math.min(Math.abs(gap), seconds / SPIN_DOWN_SECONDS);
		changed = true;
	}

	if (!changed) return;
	const context = canvas.getContext('2d');
	context.clearRect(0, 0, width, height);
	context.lineCap = 'round';
	context.lineWidth = thickness;
	for (let slot = 0; slot < SLOTS; slot++) {
		const reach = Math.max(tape.lengths[slot] - thickness, 0.01) / 2;
		const x = (slot + 0.5) * pitch;
		const dim = slot === HEAD ? 0 : tape.dim[slot < HEAD ? 0 : 1];
		context.globalAlpha = 1 - dim * (1 - UPCOMING_OPACITY);
		context.strokeStyle = tape.recording && recorded[slot] ? '#f00' : '#fff';
		context.beginPath();
		context.moveTo(x, height / 2 - reach);
		context.lineTo(x, height / 2 + reach);
		context.stroke();
	}
}

let lastFrame = performance.now();
function frame(now) {
	const seconds = (now - lastFrame) / 1000;
	lastFrame = now;
	for (const tape of tapes) {
		if (tape) animate(tape, seconds);
	}
	if (recording) animate(recording, seconds);
	requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

if (navigator.mediaSession) {
	navigator.mediaSession.metadata = new MediaMetadata({
		title: 'new soundscape',
		artist: 'soundstone',
		artwork: [{src: 'resources/icon.png', sizes: '1024x1024', type: 'image/png'}],
	});
}

setup = setUpAudio();

// Skipped on localhost so edits show on the first reload.
if ('serviceWorker' in navigator && !['localhost', '127.0.0.1'].includes(location.hostname)) {
	navigator.serviceWorker.register('service-worker.js');
}
