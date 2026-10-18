// A stand-in drawn from the record code, so the same line draws the same band on every load: four
// stacked rows between fixed start and stop bars, the shape of the code on a boarding pass. It is
// a picture of the code printed under it, never a code anything reads.
interface Bar {
  x: number;
  y: number;
  width: number;
}

const ROW_HEIGHT = 4;
const ROWS = 4;
const FIRST_DATA_X = 8;
const LAST_DATA_X = 112;

function seedOf(text: string): number {
  let hash = 2166136261;
  for (const character of text) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

function nextOf(state: number): number {
  let next = (state ^ (state << 13)) >>> 0;
  next ^= next >>> 17;
  return (next ^ (next << 5)) >>> 0;
}

function barsOf(code: string): Bar[] {
  const bars: Bar[] = [];
  let state = seedOf(code) || 1;
  for (let y = 0; y < ROWS * ROW_HEIGHT; y += ROW_HEIGHT) {
    bars.push({ x: 0, y, width: 4 }, { x: 5, y, width: 1 });
    let ink = true;
    for (let x = FIRST_DATA_X; x < LAST_DATA_X; ) {
      state = nextOf(state);
      const width = Math.min(1 + (state % 3), LAST_DATA_X - x);
      if (ink) bars.push({ x, y, width });
      x += width;
      ink = !ink;
    }
    bars.push({ x: 114, y, width: 1 }, { x: 116, y, width: 4 });
  }
  return bars;
}

export function ScanBand({ code }: { code: string }) {
  return (
    <svg className="scan" viewBox="0 0 120 16" preserveAspectRatio="none" shapeRendering="crispEdges" aria-hidden="true" focusable="false">
      {barsOf(code).map((bar) => (
        <rect key={`${bar.y}-${bar.x}`} x={bar.x} y={bar.y} width={bar.width} height={ROW_HEIGHT} />
      ))}
    </svg>
  );
}
