export type AudioLevel = {
  rms: number;
  peak: number;
  active: boolean;
};

export function measurePcm16(audio: Uint8Array): AudioLevel {
  const sampleCount = Math.floor(audio.byteLength / 2);
  if (sampleCount <= 0) return { rms: 0, peak: 0, active: false };
  let sumSquares = 0;
  let peak = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    const offset = index * 2;
    const unsigned = (audio[offset] ?? 0) | ((audio[offset + 1] ?? 0) << 8);
    const signed = unsigned >= 0x8000 ? unsigned - 0x10000 : unsigned;
    const normalized = Math.abs(signed) / 32768;
    sumSquares += normalized * normalized;
    peak = Math.max(peak, normalized);
  }
  return { rms: Math.sqrt(sumSquares / sampleCount), peak, active: peak > 0.01 };
}
