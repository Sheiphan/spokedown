// Minimal RIFF/WAVE codec: PCM 8/16/24/32-bit int and 32/64-bit float, any channel count (downmixed to mono).

export interface DecodedAudio {
  pcm: Float32Array;
  sampleRate: number;
}

export function decodeWav(buf: Uint8Array): DecodedAudio {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (o: number) => String.fromCharCode(buf[o]!, buf[o + 1]!, buf[o + 2]!, buf[o + 3]!);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a WAV file");
  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | null = null;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = tag(off);
    let size = dv.getUint32(off + 4, true);
    const body = off + 8;
    if (id === "fmt ") {
      let format = dv.getUint16(body, true);
      if (format === 0xfffe) format = dv.getUint16(body + 24, true); // WAVE_FORMAT_EXTENSIBLE
      fmt = { format, channels: dv.getUint16(body + 2, true), sampleRate: dv.getUint32(body + 4, true), bits: dv.getUint16(body + 14, true) };
    } else if (id === "data") {
      if (!fmt) throw new Error("WAV data before fmt chunk");
      // streamed WAVs may carry 0 or 0xFFFFFFFF as the data size
      if (size === 0 || size === 0xffffffff || body + size > buf.length) size = buf.length - body;
      return { pcm: readSamples(dv, body, size, fmt), sampleRate: fmt.sampleRate };
    }
    off = body + size + (size & 1);
  }
  throw new Error("WAV has no data chunk");
}

function readSamples(dv: DataView, start: number, size: number, f: { format: number; channels: number; bits: number }): Float32Array {
  const bytes = f.bits / 8;
  const frames = Math.floor(size / (bytes * f.channels));
  const out = new Float32Array(frames);
  const read = (o: number): number => {
    if (f.format === 3) return f.bits === 64 ? dv.getFloat64(o, true) : dv.getFloat32(o, true);
    switch (f.bits) {
      case 8: return (dv.getUint8(o) - 128) / 128;
      case 16: return dv.getInt16(o, true) / 32768;
      case 24: return ((dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getInt8(o + 2) << 16)) / 8388608);
      case 32: return dv.getInt32(o, true) / 2147483648;
      default: throw new Error(`unsupported WAV bit depth ${f.bits}`);
    }
  };
  for (let i = 0; i < frames; i++) {
    let s = 0;
    for (let c = 0; c < f.channels; c++) s += read(start + (i * f.channels + c) * bytes);
    out[i] = s / f.channels;
  }
  return out;
}

/** Encode mono float PCM as 16-bit WAV. */
export function encodeWav(pcm: Float32Array, sampleRate: number): Uint8Array {
  const buf = new Uint8Array(44 + pcm.length * 2);
  const dv = new DataView(buf.buffer);
  const str = (o: number, s: string) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  dv.setUint32(4, 36 + pcm.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  str(36, "data");
  dv.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) dv.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i]!)) * 32767, true);
  return buf;
}
