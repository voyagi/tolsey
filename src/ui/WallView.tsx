import type { RuleResult } from '../contract/log-reading';
import { formatValue } from '../domain/words';
import { CHIPS, EXAMPLE_PHRASE, HINT, NOT_LOGGED, SPEAKER_LABEL } from './wall-copy';
import { controlsEnabled, type WallState } from './wall-state';

interface WallActions {
  say(text: string): void;
  edit(text: string): void;
  retryStart(): void;
  selectCook(initials: string): void;
}

type Pass = NonNullable<WallState['pass']>;
type Exchange = NonNullable<WallState['exchange']>;

const [HINT_BEFORE, HINT_AFTER] = HINT.split(EXAMPLE_PHRASE);

function degrees(value: number): string {
  return `${formatValue(value)}°F`;
}

function limitOf(rule: RuleResult): string {
  return `${rule.comparator === 'at_most' ? 'at most' : 'at least'} ${degrees(rule.limit)}`;
}

// Every field here is the server's own: the page writes no verdict of its own, so a reading the
// server judged out of range can never be shown as in range. Out of range is said in words and
// marked by a class beside them, never by colour alone.
function PassView({ pass }: { pass: Pass | null }) {
  if (pass === null) return <p>No reading yet. Log one to see it here.</p>;
  return (
    <dl className={pass.outcome === 'out_of_range' ? 'pass out-of-range' : 'pass'}>
      <dt>Check</dt>
      <dd>{pass.checkPoint?.name}</dd>
      <dt>Reading</dt>
      <dd>{pass.value === undefined ? null : degrees(pass.value)}</dd>
      <dt>Verdict</dt>
      <dd>{pass.verdict}</dd>
      {pass.rule === undefined ? null : (
        <>
          <dt>Limit</dt>
          <dd>{limitOf(pass.rule)}</dd>
        </>
      )}
      <dt>Logged by</dt>
      <dd>{pass.initials}</dd>
      <dt>Record</dt>
      <dd>{pass.recordCode}</dd>
    </dl>
  );
}

function ExchangeView({ exchange, cook }: { exchange: Exchange | null; cook: string }) {
  if (exchange === null) return null;
  return (
    <section aria-label="Conversation">
      <p>
        <span className="speaker">{`${cook}: `}</span>
        {exchange.said}
      </p>
      <p>
        <span className="speaker">{`${SPEAKER_LABEL}: `}</span>
        {exchange.reply}
      </p>
    </section>
  );
}

// The cook can be switched while a call is out: the call already sent keeps the initials it carried.
function RosterPicker({ state, onSelect }: { state: WallState; onSelect: (initials: string) => void }) {
  return (
    <fieldset disabled={state.phase !== 'ready'}>
      <legend>Who is logging</legend>
      {state.roster.map((initials) => (
        <label key={initials}>
          <input type="radio" name="cook" value={initials} checked={state.cook === initials} onChange={() => onSelect(initials)} />
          {initials}
        </label>
      ))}
    </fieldset>
  );
}

// The one live region on the wall. It renders the reducer's announcement and nothing else, and its
// child is keyed by the sequence number so a sentence equal to the last one is read out again.
function StatusRegion({ state }: { state: WallState }) {
  return (
    <div role="status" aria-live="polite">
      {state.announcement === '' ? null : <p key={state.announcementSeq}>{state.announcement}</p>}
    </div>
  );
}

const NOT_LOGGED_ID = 'not-logged';

function Notices({ state, actions }: { state: WallState; actions: WallActions }) {
  if (state.phase === 'stopped') {
    return (
      <section aria-label="Stopped">
        <p>{state.stopMessage}</p>
      </section>
    );
  }
  if (state.phase !== 'start_failed') return null;
  return (
    <section aria-label="Start error">
      <p>{state.startError}</p>
      <button type="button" onClick={() => actions.retryStart()}>
        Retry
      </button>
    </section>
  );
}

// A call that did not land keeps its words in the field, and NOT LOGGED sits beside them and
// describes the field, so the reason is read with the words it is about.
function WordsForm({ state, actions }: { state: WallState; actions: WallActions }) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        actions.say(state.draft);
      }}
    >
      <label htmlFor="cook-words">What the cook says</label>
      <input
        id="cook-words"
        type="text"
        autoComplete="off"
        value={state.draft}
        disabled={state.phase !== 'ready'}
        readOnly={state.inFlight}
        aria-describedby={state.notLogged === null ? undefined : NOT_LOGGED_ID}
        onChange={(event) => actions.edit(event.target.value)}
      />
      <button type="submit" disabled={!controlsEnabled(state)}>
        Send
      </button>
      {state.notLogged === null ? null : (
        <p id={NOT_LOGGED_ID} className="not-logged">
          <strong>{NOT_LOGGED}</strong> {state.notLogged.reason}
        </p>
      )}
    </form>
  );
}

export function WallView({ state, actions }: { state: WallState; actions: WallActions }) {
  const enabled = controlsEnabled(state);
  return (
    <>
      <header>
        <h1>Tolsey</h1>
        <RosterPicker state={state} onSelect={actions.selectCook} />
      </header>
      <main>
        <Notices state={state} actions={actions} />
        <p>
          {HINT_BEFORE}
          <q>{EXAMPLE_PHRASE}</q>
          {HINT_AFTER}
        </p>
        <ExchangeView exchange={state.exchange} cook={state.cook} />
        <section aria-label="Last reading">
          <h2>Last reading</h2>
          <PassView pass={state.pass} />
        </section>
        <WordsForm state={state} actions={actions} />
        <ul aria-label="Phrases to try">
          {CHIPS.map((chip) => (
            <li key={chip}>
              <button type="button" className="chip" disabled={!enabled} onClick={() => actions.say(chip)}>
                {chip}
              </button>
            </li>
          ))}
        </ul>
        <StatusRegion state={state} />
      </main>
    </>
  );
}
