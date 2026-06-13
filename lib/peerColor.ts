// A peer's identity colour — stable from their map dot through to the
// connection prompt and chat header.
//
// Saturation and lightness are pinned so the field reads as one cohesive
// "signal" palette rather than confetti, and a hue wedge around the reserved
// signal mint (130–189°) is excluded so a peer's colour never collides with
// the system accent (--color-signal). That keeps "the green is *the* signal"
// meaningful.

const SAT = 85;
const LIGHT = 64;

export function peerHue(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  // Map into a 300° span, then lift everything from 130° up by 60° so the
  // 130–190° mint wedge is never produced.
  const h = Math.abs(hash) % 300;
  return h >= 130 ? h + 60 : h;
}

export function peerColor(id: string): string {
  return `hsl(${peerHue(id)}, ${SAT}%, ${LIGHT}%)`;
}
