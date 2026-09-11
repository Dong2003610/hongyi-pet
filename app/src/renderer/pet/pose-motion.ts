export interface PetPose {
  liftPercent: number;
  scale: number;
}

// These cutouts are all foot-aligned. The two airborne poses need clearance
// above that baseline; the final standing cutout is larger than the idle art.
// Move the artwork inside the window so repeated jumps cannot move the pet.
export function petPose(stateId: string, frame: string): PetPose {
  if (stateId !== 'happy') return { liftPercent: 0, scale: 1 };
  switch (frame) {
    case 'happy-02.png': return { liftPercent: 16, scale: 1 };
    case 'happy-03.png': return { liftPercent: 18, scale: 1 };
    case 'happy-05.png': return { liftPercent: 0, scale: 0.73 };
    default: return { liftPercent: 0, scale: 1 };
  }
}
