import test from 'node:test';
import assert from 'node:assert/strict';
import spec from '../../pet-spec.json';
import { petPose, usesBreathing } from '../../src/renderer/pet/pose-motion';
import { PetStateMachine } from '../../src/renderer/pet/state-machine';
import type { PetState } from '../../src/shared/contracts';

test('click animation leaves the floor, lands, and returns to normal idle size', () => {
  const machine = new PetStateMachine(spec.states as PetState[], 0);
  assert.equal(machine.start('happy', 0), true);
  const at = (time: number) => {
    const state = machine.tick(time);
    return petPose(state.stateId, state.frame);
  };
  assert.deepEqual(at(0), { liftPercent: 0, scale: 1 });
  const ascent = at(110).liftPercent;
  assert.ok(ascent > 0, 'bent legs must be above the floor');
  assert.ok(at(220).liftPercent >= ascent, 'spread pose reaches the apex');
  assert.equal(at(330).liftPercent, 0, 'landing returns to the same floor');
  assert.equal(at(440).scale, 1, 'registered standing cutout must not be scaled twice');
  assert.deepEqual(at(550), { liftPercent: 0, scale: 1 });
});

test('idle and original sleep poses breathe; walking and feeding remain rigid', () => {
  assert.equal(usesBreathing('idle', spec.states, true), true);
  assert.equal(usesBreathing('sleep', spec.states, true), true);
  for (const id of ['happy', 'walk-left', 'walk-right', 'eat', 'pet', 'notify'])
    assert.equal(usesBreathing(id, spec.states, true), false);
  assert.equal(usesBreathing('sleep', spec.states, false), false);
});

test('interrupting a jump with another activity clears lift and scale', () => {
  const machine = new PetStateMachine(spec.states as PetState[], 0);
  machine.start('happy', 0);
  machine.tick(220);
  assert.equal(machine.start('eat', 230, 1800, true), true);
  const state = machine.tick(230);
  assert.deepEqual(petPose(state.stateId, state.frame), { liftPercent: 0, scale: 1 });
});
