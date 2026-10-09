// Voice on the browser's own WebRTC and Web Audio — what every browser uses,
// and the desktop app's fallback. The playout graph and the speaking analyser
// here were lifted out of useWebRTCVoice and useSpeakingDetection unchanged.

import { DISTANCE_MODEL, glide } from "@/lib/spatialAudio";
import type {
  AudioDevice,
  LocalMic,
  MicOptions,
  MicTest,
  VoiceMediaBackend,
  VoicePeer,
  VoiceTrackEvent,
  WorldPosition,
} from "./types";

type SinkCapable = { setSinkId?: (id: string) => Promise<void> };

function micConstraints(options: MicOptions): MediaStreamConstraints {
  return {
    audio: {
      deviceId: options.deviceId !== "default" ? { exact: options.deviceId } : undefined,
      echoCancellation: options.echoCancellation,
      noiseSuppression: options.noiseSuppression !== "none",
      autoGainControl: options.autoGainControl,
      sampleRate: 48000,
    },
    video: false,
  };
}

/** Whether two option sets need a new capture rather than a gain change. */
function captureChanged(a: MicOptions, b: MicOptions): boolean {
  return (
    a.deviceId !== b.deviceId ||
    a.echoCancellation !== b.echoCancellation ||
    a.noiseSuppression !== b.noiseSuppression ||
    a.autoGainControl !== b.autoGainControl
  );
}

// ─── Microphone ──────────────────────────────────────────────────────────────

class BrowserMic implements LocalMic {
  private raw: MediaStream;
  private options: MicOptions;
  /** Only built when the gain isn't 1, so the default path sends the capture
   *  track exactly as getUserMedia produced it. */
  private gainGraph: { ctx: AudioContext; gain: GainNode; out: MediaStreamAudioDestinationNode } | null = null;
  private sender: RTCRtpSender | null = null;
  private enabled = true;
  private speaking: { ctx: AudioContext; analyser: AnalyserNode; streamId: string } | null = null;
  private readonly freq = new Uint8Array(128);

  constructor(raw: MediaStream, options: MicOptions) {
    this.raw = raw;
    this.options = options;
    this.syncGain();
  }

  /** The track that goes on the wire. */
  private get sentTrack(): MediaStreamTrack {
    const stream = this.gainGraph ? this.gainGraph.out.stream : this.raw;
    return stream.getAudioTracks()[0];
  }

  private syncGain(): void {
    if (this.options.gain === 1) {
      if (this.gainGraph) {
        this.gainGraph.ctx.close().catch(() => {});
        this.gainGraph = null;
      }
      return;
    }
    if (!this.gainGraph) {
      const ctx = new AudioContext({ sampleRate: 48000 });
      const gain = ctx.createGain();
      const out = ctx.createMediaStreamDestination();
      ctx.createMediaStreamSource(this.raw).connect(gain);
      gain.connect(out);
      this.gainGraph = { ctx, gain, out };
    }
    this.gainGraph.gain.gain.value = this.options.gain;
  }

  attachTo(peer: VoicePeer): void {
    const pc = peer as unknown as RTCPeerConnection;
    const track = this.sentTrack;
    track.enabled = this.enabled;
    this.sender = pc.addTrack(track, this.raw);
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.raw.getAudioTracks().forEach((t) => { t.enabled = on; });
    this.sentTrack.enabled = on;
  }

  isSpeaking(): boolean {
    const SPEAKING_THRESHOLD = 15; // average frequency magnitude, 0-255
    if (!this.speaking || this.speaking.streamId !== this.raw.id) {
      this.speaking?.ctx.close().catch(() => {});
      try {
        const ctx = new AudioContext();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        ctx.createMediaStreamSource(this.raw).connect(analyser);
        this.speaking = { ctx, analyser, streamId: this.raw.id };
      } catch {
        return false;
      }
    }
    this.speaking.analyser.getByteFrequencyData(this.freq);
    let sum = 0;
    for (let i = 0; i < this.freq.length; i++) sum += this.freq[i];
    return sum / this.freq.length > SPEAKING_THRESHOLD;
  }

  async update(options: MicOptions): Promise<void> {
    const recapture = captureChanged(this.options, options);
    this.options = options;
    if (recapture) {
      const next = await navigator.mediaDevices.getUserMedia(micConstraints(options));
      const previous = this.raw;
      this.raw = next;
      if (this.gainGraph) {
        this.gainGraph.ctx.close().catch(() => {});
        this.gainGraph = null;
      }
      this.syncGain();
      previous.getTracks().forEach((t) => t.stop());
    } else {
      const hadGraph = !!this.gainGraph;
      this.syncGain();
      // Only the gain moved and the graph was already there: nothing to swap.
      if (hadGraph === !!this.gainGraph) return;
    }
    this.setEnabled(this.enabled);
    if (this.sender) await this.sender.replaceTrack(this.sentTrack);
  }

  stop(): void {
    this.raw.getTracks().forEach((t) => t.stop());
    this.gainGraph?.ctx.close().catch(() => {});
    this.gainGraph = null;
    this.speaking?.ctx.close().catch(() => {});
    this.speaking = null;
    this.sender = null;
  }
}

// ─── Backend ─────────────────────────────────────────────────────────────────

class BrowserVoiceBackend implements VoiceMediaBackend {
  readonly kind = "browser" as const;
  readonly noiseSuppressionModes = ["none", "browser"] as const;

  // One AudioContext for the whole call, with a gain node per slot hanging off
  // it. A context per speaker capped call size far below anything else here —
  // browsers limit how many a single document may hold.
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private output = { deviceId: "default", volume: 1 };
  private readonly slotAudio = new Map<number, HTMLAudioElement>();
  private readonly slotGain = new Map<number, GainNode>();
  // One panner per slot, between the slot's gain and the destination. A slot
  // outlives its speakers, so the panner is re-aimed when the slot changes
  // hands rather than rebuilt — rebuilding would drop the audio mid-word.
  private readonly slotPanner = new Map<number, PannerNode>();

  createPeer(config: RTCConfiguration): VoicePeer {
    return new RTCPeerConnection(config) as unknown as VoicePeer;
  }

  async acquireMic(options: MicOptions): Promise<LocalMic> {
    const stream = await navigator.mediaDevices.getUserMedia(micConstraints(options));
    return new BrowserMic(stream, options);
  }

  // Built on first use and reused for every speaker. A context that was closed
  // by an earlier call is replaced rather than revived — closing is final.
  private graph(): { ctx: AudioContext; master: GainNode } {
    if (!this.ctx || this.ctx.state === "closed" || !this.master) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.output.volume;
      this.master.connect(this.ctx.destination);
      this.applySink();
    }
    return { ctx: this.ctx, master: this.master };
  }

  private applySink(): void {
    const ctx = this.ctx as (AudioContext & SinkCapable) | null;
    if (!ctx?.setSinkId) return;
    // "" is the system default for AudioContext.setSinkId.
    ctx.setSinkId(this.output.deviceId === "default" ? "" : this.output.deviceId).catch(() => {});
  }

  attachSlot(slot: number, event: VoiceTrackEvent): void {
    let audioEl = this.slotAudio.get(slot);
    if (!audioEl) {
      audioEl = new Audio();
      audioEl.autoplay = true;
      this.slotAudio.set(slot, audioEl);
    }
    const stream = (event.streams[0] as MediaStream | undefined) || new MediaStream([event.track as MediaStreamTrack]);
    audioEl.srcObject = stream;

    // Route through a GainNode so per-user volume can exceed 100%, then a
    // PannerNode so a spatial channel can place the speaker. The panner is
    // built for every call, spatial or not: it is inert at the listener's own
    // position, and adding one mid-call would mean rebuilding the graph under
    // a live stream.
    if (!this.slotGain.has(slot)) {
      const { ctx, master } = this.graph();
      const source = ctx.createMediaStreamSource(stream);
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const panner = ctx.createPanner();
      panner.panningModel = "equalpower";
      panner.distanceModel = "inverse";
      panner.refDistance = DISTANCE_MODEL.refDistance;
      panner.rolloffFactor = DISTANCE_MODEL.rolloffFactor;
      panner.maxDistance = DISTANCE_MODEL.maxDistance;
      source.connect(gain);
      gain.connect(panner);
      panner.connect(master);
      this.slotGain.set(slot, gain);
      this.slotPanner.set(slot, panner);
      // Mute the HTML element since GainNode handles playback
      audioEl.volume = 0;
    }
    audioEl.play().catch(() => {});
  }

  setSlotGain(slot: number, gain: number): void {
    const node = this.slotGain.get(slot);
    if (node) node.gain.value = gain;
  }

  setSlotPosition(slot: number, at: WorldPosition): void {
    const panner = this.slotPanner.get(slot);
    if (!panner || !this.ctx) return;
    const now = this.ctx.currentTime;
    glide(panner.positionX, at.x, now);
    glide(panner.positionY, at.y, now);
    glide(panner.positionZ, at.z, now);
  }

  // The listener is the person at the keyboard. Moving them rather than
  // offsetting every source keeps one definition of where anybody is.
  setListenerPosition(at: WorldPosition): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    const listener = ctx.listener as AudioListener & {
      positionX?: AudioParam;
      setPosition?: (x: number, y: number, z: number) => void;
    };
    if (listener.positionX) {
      glide(listener.positionX, at.x, now);
      glide(listener.positionY, at.y, now);
      glide(listener.positionZ, at.z, now);
    } else {
      // Safari until recently: no AudioParams on the listener, only the
      // deprecated setter. It jumps rather than glides, which is the cost.
      listener.setPosition?.(at.x, at.y, at.z);
    }
  }

  setOutput(options: { deviceId: string; volume: number }): void {
    const deviceChanged = options.deviceId !== this.output.deviceId;
    this.output = options;
    if (this.master) this.master.gain.value = options.volume;
    if (deviceChanged) this.applySink();
  }

  // Drop every slot's gain node and the context they share.
  closeGraph(): void {
    this.slotGain.forEach((gain) => { try { gain.disconnect(); } catch { /* already gone */ } });
    this.slotGain.clear();
    this.slotPanner.forEach((panner) => { try { panner.disconnect(); } catch { /* already gone with the context */ } });
    this.slotPanner.clear();
    this.slotAudio.forEach((el) => { el.pause(); el.srcObject = null; });
    this.slotAudio.clear();
    if (this.ctx) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
      this.master = null;
    }
  }

  async listDevices(): Promise<{ inputs: AudioDevice[]; outputs: AudioDevice[] }> {
    // Labels are hidden until the page has had microphone access once.
    const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
    probe.getTracks().forEach((t) => t.stop());
    const all = await navigator.mediaDevices.enumerateDevices();
    const toDevice = (d: MediaDeviceInfo, fallback: string): AudioDevice => ({
      id: d.deviceId,
      label: d.label || `${fallback} (${d.deviceId.slice(0, 8)})`,
    });
    return {
      inputs: all.filter((d) => d.kind === "audioinput").map((d) => toDevice(d, "Microphone")),
      outputs: all.filter((d) => d.kind === "audiooutput").map((d) => toDevice(d, "Speaker")),
    };
  }

  onDevicesChanged(listener: () => void): () => void {
    navigator.mediaDevices.addEventListener("devicechange", listener);
    return () => navigator.mediaDevices.removeEventListener("devicechange", listener);
  }

  async startMicTest(
    options: MicOptions & { outputDeviceId: string },
    onLevel: (level: number) => void,
  ): Promise<MicTest> {
    const stream = await navigator.mediaDevices.getUserMedia(micConstraints(options));
    const ctx = new AudioContext({ sampleRate: 48000 });
    await ctx.resume();
    const source = ctx.createMediaStreamSource(stream);
    const gainNode = ctx.createGain();
    gainNode.gain.value = options.gain;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(gainNode);
    gainNode.connect(analyser);

    let frame = 0;
    const data = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      analyser.getByteTimeDomainData(data);
      const rms = Math.sqrt(data.reduce((sum, v) => sum + (v - 128) ** 2, 0) / data.length);
      onLevel(Math.min(100, rms * 5));
      frame = requestAnimationFrame(tick);
    };
    tick();

    let monitor: HTMLAudioElement | null = null;
    const stopMonitor = () => {
      if (!monitor) return;
      monitor.pause();
      monitor.srcObject = null;
      monitor = null;
    };
    return {
      setMonitoring: async (on) => {
        stopMonitor();
        if (!on) return;
        const el = new Audio() as HTMLAudioElement & SinkCapable;
        el.srcObject = stream;
        if (el.setSinkId && options.outputDeviceId !== "default") await el.setSinkId(options.outputDeviceId);
        await el.play();
        monitor = el;
      },
      setGain: (gain) => { gainNode.gain.value = gain; },
      stop: () => {
        stopMonitor();
        cancelAnimationFrame(frame);
        stream.getTracks().forEach((t) => t.stop());
        ctx.close().catch(() => {});
        onLevel(0);
      },
    };
  }
}

export const browserVoiceBackend: VoiceMediaBackend = new BrowserVoiceBackend();
