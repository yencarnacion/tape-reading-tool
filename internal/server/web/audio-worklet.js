class TapeMixerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.config = {
      buyPitchHz: 920,
      sellPitchHz: 330,
      durationMS: 42,
      largeSize: 1000,
      largeBoost: 1.8,
      maxVoices: 192
    };
    this.voices = [];
    this.cursor = 0;
    this.queue = [];
    this.queueOffset = 0;
    this.port.onmessage = (event) => this.onMessage(event.data);
    this.allocate();
  }

  allocate() {
    const count = Math.max(8, Math.min(512, Math.round(this.config.maxVoices)));
    this.voices = Array.from({ length: count }, () => ({ active: false, phase: 0, age: 0, length: 1, frequency: 440, amplitude: 0, side: 0, large: false }));
    this.cursor = 0;
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
    for (const event of message.events) {
      const delay = Math.max(0, Math.min(100, Number(event.delayMS) || 0));
      this.queue.push({
        frame: baseFrame + Math.round(delay * sampleRate / 1000),
        side: Math.sign(Number(event.side) || 0),
        size: Math.max(0, Number(event.size) || 0)
      });
    }
  }

  startVoice(event) {
    const voice = this.voices[this.cursor];
    this.cursor = (this.cursor + 1) % this.voices.length;
    const large = event.size >= this.config.largeSize;
    const sizeRange = Math.max(10, this.config.largeSize);
    const weight = Math.min(1.35, Math.log10(1 + event.size) / Math.log10(1 + sizeRange));
    voice.active = true;
    voice.phase = 0;
    voice.age = 0;
    voice.length = Math.max(64, Math.round(this.config.durationMS * (large ? 1.45 : 1) * sampleRate / 1000));
    voice.frequency = event.side > 0 ? this.config.buyPitchHz : event.side < 0 ? this.config.sellPitchHz : 610;
    voice.amplitude = Math.min(1.5, (0.18 + weight * 0.45) * (large ? this.config.largeBoost : 1));
    voice.side = event.side;
    voice.large = large;
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
      let l = 0;
      let r = 0;
      for (const voice of this.voices) {
        if (!voice.active) continue;
        const progress = voice.age / voice.length;
        if (progress >= 1) {
          voice.active = false;
          continue;
        }
        const chirp = voice.side > 0 ? 1 + progress * 0.16 : voice.side < 0 ? 1 - progress * 0.13 : 1;
        voice.phase += 2 * Math.PI * voice.frequency * chirp / sampleRate;
        const envelope = Math.exp(-5.2 * progress) * (1 - progress);
        let wave;
        if (voice.side > 0) {
          wave = Math.sin(voice.phase) + 0.28 * Math.sin(voice.phase * 2);
        } else if (voice.side < 0) {
          wave = 0.52 * Math.sign(Math.sin(voice.phase)) + 0.48 * Math.sin(voice.phase);
        } else {
          wave = Math.sin(voice.phase) * (1 - progress);
        }
        if (voice.large) wave += 0.3 * Math.sin(voice.phase * 0.5);
        const value = wave * envelope * voice.amplitude * 0.11;
        l += value * (voice.side > 0 ? 0.72 : 1);
        r += value * (voice.side < 0 ? 0.72 : 1);
        voice.age++;
      }
      left[sample] = Math.tanh(l);
      right[sample] = Math.tanh(r);
    }
    if (this.queueOffset > 4096) {
      this.queue = this.queue.slice(this.queueOffset);
      this.queueOffset = 0;
    }
    return true;
  }
}

registerProcessor('tape-mixer', TapeMixerProcessor);
