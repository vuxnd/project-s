// Unit tests for audio with a fake ctx and a fake AudioContext: one tone per physics.contact, at the cue's frequency and the configured volume.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { play } from '../web/index.ts';
import type { Ctx, Cue } from '../types.gen.ts';

const CONTACT_CUE: Cue = { event: 'physics.contact', frequency: 440, duration: 0.08 };
const NOW = 1.5;

// An AudioContext that keeps every oscillator and gain node it makes, with the values set on them and what they were connected to, started and stopped at.
function fakeAudio() {
  const oscillators: { frequency: { value: number }; to: unknown[]; started: number[]; stopped: number[] }[] = [];
  const gains: { gain: { value: number }; to: unknown[] }[] = [];
  return {
    currentTime: NOW,
    destination: {},
    oscillators,
    gains,
    createOscillator() {
      const node = {
        frequency: { value: 0 },
        to: [] as unknown[],
        started: [] as number[],
        stopped: [] as number[],
        connect: (target: unknown) => { node.to.push(target); },
        start: (when: number) => { node.started.push(when); },
        stop: (when: number) => { node.stopped.push(when); },
      };
      oscillators.push(node);
      return node;
    },
    createGain() {
      const node = { gain: { value: 0 }, to: [] as unknown[], connect: (target: unknown) => { node.to.push(target); } };
      gains.push(node);
      return node;
    },
  };
}

// Runs play with the given cues and `contacts` physics.contact events delivered, on a fresh fake AudioContext.
function played(cues: Record<string, Cue>, contacts: number) {
  const audio = fakeAudio();
  const ctx = {
    module: 'audio',
    state: undefined,
    config: { volume: 0.8 },
    host: { audio },
    records: (type: string) => (type === 'audio.cue' ? cues : {}),
    events: (id: string) => (id === 'physics.contact' ? Array.from({ length: contacts }, (_, n) => ({ id: `body_${n}`, with: 'ground' })) : []),
  } as unknown as Ctx;
  play(ctx);
  return audio;
}

test('two contacts give two oscillators at 440 Hz, each through a gain of 0.8 to the destination, started now and stopped 0.08 s later', () => {
  const audio = played({ 'audio/contact': CONTACT_CUE }, 2);
  assert.equal(audio.oscillators.length, 2);
  assert.equal(audio.gains.length, 2);
  audio.oscillators.forEach((oscillator, n) => {
    assert.equal(oscillator.frequency.value, 440);
    assert.equal(audio.gains[n].gain.value, 0.8);
    assert.deepEqual(oscillator.to.map((target) => target === audio.gains[n]), [true]);
    assert.deepEqual(audio.gains[n].to.map((target) => target === audio.destination), [true]);
    assert.deepEqual(oscillator.started, [NOW]);
    assert.deepEqual(oscillator.stopped, [NOW + 0.08]);
  });
});

test('no contacts give no oscillator', () => {
  const audio = played({ 'audio/contact': CONTACT_CUE }, 0);
  assert.deepEqual([audio.oscillators.length, audio.gains.length], [0, 0]);
});

test('the cue is the first one for physics.contact; with none, contacts are silent', () => {
  const spawn: Cue = { event: 'physics.spawn', frequency: 220, duration: 0.5 };
  assert.deepEqual(played({ 'audio/a_spawn': spawn, 'audio/contact': CONTACT_CUE }, 1).oscillators.map((o) => o.frequency.value), [440]);
  assert.equal(played({ 'audio/a_spawn': spawn }, 1).oscillators.length, 0);
});
