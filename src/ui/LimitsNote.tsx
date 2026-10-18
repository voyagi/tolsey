import { LIMITS, LIMITS_HEADING, WHATS_NEXT, WHATS_NEXT_HEADING } from './wall-copy';

const LIMITS_HEAD_ID = 'limits-head';
const NEXT_HEAD_ID = 'next-head';

// The page speaking about the demo, set outside the device it describes: what runs today is listed
// apart from what is not built yet, so nothing under Limits can read as a promise.
export function LimitsNote() {
  return (
    <aside className="limits" aria-label="About this demo">
      <section className="limits-part" aria-labelledby={LIMITS_HEAD_ID}>
        <h2 id={LIMITS_HEAD_ID} className="limits-head">
          {LIMITS_HEADING}
        </h2>
        <ul className="limits-lines">
          {LIMITS.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </section>
      <section className="limits-part" aria-labelledby={NEXT_HEAD_ID}>
        <h2 id={NEXT_HEAD_ID} className="limits-head">
          {WHATS_NEXT_HEADING}
        </h2>
        <ul className="next-names">
          {WHATS_NEXT.map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
      </section>
    </aside>
  );
}
