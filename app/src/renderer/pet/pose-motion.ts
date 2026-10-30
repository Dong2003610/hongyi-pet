export interface PetPose {
  liftPercent: number;
  scale: number;
}

// The cutouts are registered to the same body scale and foot baseline.
// The two airborne poses need clearance above that baseline.
// Move the artwork inside the window so repeated jumps cannot move the pet.
export function petPose(stateId: string, frame: string): PetPose {
  if (stateId !== 'happy') return { liftPercent: 0, scale: 1 };
  switch (frame) {
    case 'happy-02.png': return { liftPercent: 16, scale: 1 };
    case 'happy-03.png': return { liftPercent: 18, scale: 1 };
    default: return { liftPercent: 0, scale: 1 };
  }
}

export function usesBreathing(stateId: string, states: { id: string; proceduralMotion?: string }[], enabled: boolean): boolean {
  return enabled && (stateId === 'idle' || stateId === 'sleep' || states.some(state => state.id === stateId && state.proceduralMotion === 'breathing'));
}
