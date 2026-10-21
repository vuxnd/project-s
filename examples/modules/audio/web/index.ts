// audio on the web host: one short tone for every physics.contact, as the audio.cue record for that event describes.
import type { Ctx, Cue } from '../types.gen.ts';

export function play(ctx: Ctx): void {
  const cue = Object.values(ctx.records<Cue>('audio.cue')).find((c) => c.event === 'physics.contact');
  if (cue === undefined) return;
  const { audio } = ctx.host as { audio: AudioContext };
  for (const _ of ctx.events('physics.contact')) {
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.frequency.value = cue.frequency;
    gain.gain.value = ctx.config.volume;
    oscillator.connect(gain);
    gain.connect(audio.destination);
    oscillator.start(audio.currentTime);
    oscillator.stop(audio.currentTime + cue.duration);
  }
}
