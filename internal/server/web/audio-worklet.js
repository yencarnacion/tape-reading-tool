const BUY_INTERVALS = [1, 1.25, 1.5, 2];
const SELL_INTERVALS = [1, 0.8, 0.6, 0.5];
const FULL_DETAIL_RATE = 60;
const MIN_SMALL_CUES_PER_SECOND = 12;
const RATE_WINDOW_SECONDS = 0.25;

class TapeMixerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.config = {
      buyPitchHz: 660,
      sellPitchHz: 490,
      durationMS: 110,
      minimumGain: 0.65,
      largeSize: 1000,
      largeBoost: 1.8,
      maxVoices: 192
    };
    this.voices = [];
    this.cursor = 0;
    this.queue = [];
    this.queueOffset = 0;
    this.rateFrames = [];
    this.rateOffset = 0;
    this.smallTokens = 2;
    this.smallTokenFrame = 0;
    this.port.onmessage = (event) => this.onMessage(event.data);
    this.allocate();
  }

  allocate() {
    const count = Math.max(8, Math.min(512, Math.round(this.config.maxVoices)));
    this.voices = Array.from({ length: count }, () => ({
      active: false,
      phase: 0,
      age: 0,
      length: 1,
      decayFrames: 1,
      decay: 1,
      decayFactor: 1,
      attackFrames: 1,
      noteGapFrames: 1,
      noteCount: 1,
      currentNote: -1,
      frequency: 440,
      amplitude: 0,
      side: 0,
      priority: 0
    }));
    this.cursor = 0;
  }

  observeRate(frame) {
    this.rateFrames.push(frame);
    const cutoff = frame - sampleRate * RATE_WINDOW_SECONDS;
    while (this.rateOffset < this.rateFrames.length && this.rateFrames[this.rateOffset] < cutoff) {
      this.rateOffset++;
    }

    const count = this.rateFrames.length - this.rateOffset;
    if (this.rateOffset > 1024) {
      this.rateFrames = this.rateFrames.slice(this.rateOffset);
      this.rateOffset = 0;
    }
    if (count < 2) return 0;
    const span = frame - this.rateFrames[this.rateOffset];
    const minimumSpan = sampleRate * 0.05;
    const rate = (count - 1) * sampleRate / Math.max(minimumSpan, span);
    return Math.min(2000, rate);
  }

  shouldPlaySmall(frame, tapeRate) {
    if (tapeRate <= FULL_DETAIL_RATE) {
      this.smallTokens = 2;
      this.smallTokenFrame = frame;
      return true;
    }

    const targetRate = Math.max(
      MIN_SMALL_CUES_PER_SECOND,
      FULL_DETAIL_RATE * FULL_DETAIL_RATE / tapeRate
    );
    const elapsed = Math.max(0, frame - this.smallTokenFrame);
    this.smallTokens = Math.min(2, this.smallTokens + elapsed * targetRate / sampleRate);
    this.smallTokenFrame = frame;
    if (this.smallTokens < 1) return false;
    this.smallTokens--;
    return true;
  }

  onMessage(message) {
    if (!message) return;
    if (message.type === 'config') {
      const previous = this.config.maxVoices;
      Object.assign(this.config, message.config || {});
      if (previous !== this.config.maxVoices) this.allocate();
      return;
    }
    if (message.type !== 'ticks' || !Array.isArray(message.events)) return;
    const baseFrame = currentFrame;
    const largeSize = Math.max(1, Number(this.config.largeSize) || 1000);
    for (const event of message.events) {
      const delay = Math.max(0, Math.min(100, Number(event.delayMS) || 0));
      const frame = baseFrame + Math.round(delay * sampleRate / 1000);
      const size = Math.max(0, Number(event.size) || 0);
      const tapeRate = this.observeRate(frame);
      if (size < largeSize && !this.shouldPlaySmall(frame, tapeRate)) continue;
      this.queue.push({
        frame,
        side: Math.sign(Number(event.side) || 0),
        size,
        tapeRate
      });
    }
  }

  acquireVoice(priority) {
    let selected = -1;
    let selectedPriority = Infinity;
    let selectedProgress = -1;

    for (let offset = 0; offset < this.voices.length; offset++) {
      const index = (this.cursor + offset) % this.voices.length;
      const voice = this.voices[index];
      if (!voice.active) {
        selected = index;
        break;
      }
      if (priority === 0 && voice.priority > 0) continue;
      const progress = voice.age / voice.length;
      if (voice.priority < selectedPriority || (voice.priority === selectedPriority && progress > selectedProgress)) {
        selected = index;
        selectedPriority = voice.priority;
        selectedProgress = progress;
      }
    }

    if (selected < 0) return null;
    this.cursor = (selected + 1) % this.voices.length;
    return this.voices[selected];
  }

  duckSmallVoices() {
    for (const voice of this.voices) {
      if (voice.active && voice.priority === 0) voice.amplitude *= 0.35;
    }
  }

  startVoice(event) {
    const largeSize = Math.max(1, Number(this.config.largeSize) || 1000);
    const sizeRatio = event.size / largeSize;
    const isLarge = sizeRatio >= 1;
    const isExceptional = sizeRatio >= 4;
    const priority = isExceptional ? 2 : isLarge ? 1 : 0;
    const voice = this.acquireVoice(priority);
    if (!voice) return;
    if (isLarge) this.duckSmallVoices();

    const sizeStrength = Math.sqrt(Math.min(1, sizeRatio));
    const oversizeStrength = Math.min(1, Math.log2(Math.max(1, sizeRatio)) / 4);
    const minimum = Math.max(0.1, Math.min(1.5, Number(this.config.minimumGain) || 0.65));
    const boost = isLarge
      ? Math.max(1, Math.min(4, Number(this.config.largeBoost) || 1.8)) * (1 + oversizeStrength * 0.15)
      : 1;
    const configuredDuration = Math.max(10, Math.min(250, Number(this.config.durationMS) || 110));
    const congestion = isLarge
      ? 0
      : Math.max(0, Math.min(1, ((Number(event.tapeRate) || 0) - FULL_DETAIL_RATE) / (500 - FULL_DETAIL_RATE)));
    const durationMS = configuredDuration * (1 - congestion * 0.65);
    const congestionGain = 1 - Math.sqrt(congestion) * 0.65;

    voice.active = true;
    voice.phase = 0;
    voice.age = 0;
    voice.decayFrames = Math.max(64, Math.round(durationMS * sampleRate / 1000));
    voice.decay = 1;
    voice.decayFactor = Math.pow(0.001, 1 / voice.decayFrames);
    voice.attackFrames = Math.max(8, Math.round(sampleRate * 0.0025));
    voice.noteGapFrames = Math.round(Math.max(55, Math.min(85, durationMS * 0.7)) * sampleRate / 1000);
    voice.noteCount = isExceptional ? 4 : isLarge ? 2 : 1;
    voice.currentNote = -1;
    voice.length = voice.decayFrames + voice.noteGapFrames * (voice.noteCount - 1);
    voice.side = event.side;
    voice.priority = priority;
    voice.frequency = event.side > 0
      ? Math.max(40, Number(this.config.buyPitchHz) || 660)
      : event.side < 0
        ? Math.max(40, Number(this.config.sellPitchHz) || 490)
        : Math.sqrt(
          Math.max(40, Number(this.config.buyPitchHz) || 660) *
          Math.max(40, Number(this.config.sellPitchHz) || 490)
        );
    voice.amplitude = Math.min(
      0.62,
      (0.055 + minimum * 0.07 + sizeStrength * 0.12) * boost
    ) * congestionGain;
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const left = output[0];
    const right = output[1] || output[0];
    left.fill(0);
    if (right !== left) right.fill(0);

    for (let sample = 0; sample < left.length; sample++) {
      const frame = currentFrame + sample;
      while (this.queueOffset < this.queue.length && this.queue[this.queueOffset].frame <= frame) {
        this.startVoice(this.queue[this.queueOffset++]);
      }

      let mixed = 0;
      for (const voice of this.voices) {
        if (!voice.active) continue;
        if (voice.age >= voice.length) {
          voice.active = false;
          continue;
        }

        const intervals = voice.side < 0 ? SELL_INTERVALS : BUY_INTERVALS;
        const note = Math.min(voice.noteCount - 1, Math.floor(voice.age / voice.noteGapFrames));
        const noteAge = voice.age - note * voice.noteGapFrames;
        if (note !== voice.currentNote) {
          voice.currentNote = note;
          voice.phase = 0;
          voice.decay = 1;
        }
        const attack = Math.min(1, noteAge / voice.attackFrames);
        const frequency = voice.frequency * intervals[note];
        let phase = voice.phase + frequency / sampleRate;
        phase -= Math.floor(phase);
        voice.phase = phase;
        const triangle = 1 - 4 * Math.abs(phase - 0.5);
        mixed += triangle * attack * voice.decay * voice.amplitude;
        voice.decay *= voice.decayFactor;
        voice.age++;
      }

      const value = Math.tanh(mixed);
      left[sample] = value;
      right[sample] = value;
    }

    if (this.queueOffset > 4096) {
      this.queue = this.queue.slice(this.queueOffset);
      this.queueOffset = 0;
    }
    return true;
  }
}

registerProcessor('tape-mixer', TapeMixerProcessor);
