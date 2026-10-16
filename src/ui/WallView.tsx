import type { RuleResult } from '../contract/log-reading';
import { formatValue } from '../domain/words';
import { ScanBand } from './ScanBand';
import { ThemeSwitch } from './ThemeSwitch';
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

const SOURCE_NAMES: Record<RuleResult['sourceKind'], string> = {
  food_code: 'Food Code',
  other_law: 'Other law',
  house_rule: 'House rule',
};

function degrees(value: number): string {
  return `${formatValue(value)}°F`;
}

function limitOf(rule: RuleResult): string {
  return `${rule.comparator === 'at_most' ? 'at most' : 'at least'} ${degrees(rule.limit)}`;
}

function verdictClass(outcome: Pass['outcome']): string {
  if (outcome === 'out_of_range') return 'status status--alert verdict out-of-range';
  if (outcome === 'not_covered') return 'status status--quiet verdict';
  return 'status verdict';
}

// A number cannot wrap, so a longer figure steps down a size instead of running off the ticket:
// a tenth to the count size, five characters (135.5, -12.5) one step more.
function readingClass(figure: string): string {
  if (figure.length >= 5) return 'reading reading--long';
  return figure.includes('.') ? 'reading reading--tenth' : 'reading';
}

function Reading({ value, unit }: { value: number; unit: string | undefined }) {
  const figure = formatValue(value);
  return (
    <p className={readingClass(figure)}>
      {figure}
      <small>{`°${unit ?? 'F'}`}</small>
    </p>
  );
}

function Cell({ label, value }: { label: string; value: string | undefined }) {
  if (value === undefined) return null;
  return (
    <div>
      <span className="label">{label}</span>
      <b>{value}</b>
    </div>
  );
}

// The tear line is a real element, hidden from assistive tech, rather than a pseudo element: a checker
// that meets a painted pseudo element over the pass cannot judge the contrast of any word on it.
function TearLine() {
  return <span className="tear" aria-hidden="true" />;
}

// A control that cannot act while a call is out stays focusable and says so: disabling it would drop
// the keyboard's focus to the page. Before the wall is ready, or once it stops, it is disabled outright.
function unavailable(state: WallState): { disabled?: true; 'aria-disabled'?: true } {
  if (controlsEnabled(state)) return {};
  return state.phase === 'ready' ? { 'aria-disabled': true } : { disabled: true };
}

// Every field here is the server's own: the page writes no verdict of its own, so a reading the
// server judged out of range can never be shown as in range. Out of range is said in words and
// marked by a class on the same tile, never by colour alone.
function PassView({ pass }: { pass: Pass | null }) {
  if (pass === null) {
    return (
      <article className="pass pass--empty">
        <div className="seg seg--main">
          <h2 className="label">Last reading</h2>
          <p className="pass-empty">No reading yet. Log one to see it here.</p>
        </div>
        <TearLine />
      </article>
    );
  }
  return (
    <article className="pass">
      <div className="seg seg--main">
        <h2 className="label">Last reading</h2>
        <p className="point">{pass.checkPoint?.name}</p>
        {pass.value === undefined ? null : <Reading value={pass.value} unit={pass.unit} />}
        <span className={verdictClass(pass.outcome)}>{pass.verdict}</span>
      </div>
      <div className="seg seg--cells">
        <Cell label="Rule" value={pass.rule === undefined ? undefined : limitOf(pass.rule)} />
        <Cell label="Source" value={pass.rule === undefined ? undefined : SOURCE_NAMES[pass.rule.sourceKind]} />
        <Cell label="By" value={pass.initials} />
      </div>
      {pass.recordCode === undefined ? null : (
        <div className="seg seg--code">
          <ScanBand code={pass.recordCode} />
          <p>
            <span className="label">Record</span>
            <b>{pass.recordCode}</b>
          </p>
        </div>
      )}
      <TearLine />
    </article>
  );
}

function ExchangeView({ exchange, cook }: { exchange: Exchange | null; cook: string }) {
  if (exchange === null) {
    return (
      <div className="exchange exchange--empty">
        <p className="said-none">Nothing said yet.</p>
      </div>
    );
  }
  return (
    <section className="exchange" aria-label="Conversation">
      <p>
        <span className="label">{`Cook ${cook}`}</span>
        <span className="said">{exchange.said}</span>
      </p>
      <p>
        <span className="label">{SPEAKER_LABEL}</span>
        <span className="answer">{exchange.reply}</span>
      </p>
    </section>
  );
}

// The cook can be switched while a call is out: the call already sent keeps the initials it carried.
function RosterPicker({ state, onSelect }: { state: WallState; onSelect: (initials: string) => void }) {
  return (
    <fieldset className="roster" disabled={state.phase !== 'ready'}>
      <legend>Who is logging</legend>
      {state.roster.map((initials) => (
        <label key={initials}>
          <input
            className="visually-hidden"
            type="radio"
            name="cook"
            value={initials}
            checked={state.cook === initials}
            onChange={() => onSelect(initials)}
          />
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
      {state.announcement === '' ? null : (
        <p key={state.announcementSeq} className="visually-hidden">
          {state.announcement}
        </p>
      )}
    </div>
  );
}

const NOT_LOGGED_ID = 'not-logged';

function Notices({ state, actions }: { state: WallState; actions: WallActions }) {
  if (state.phase === 'stopped') {
    return (
      <section className="notice" aria-label="Stopped">
        <p>{state.stopMessage}</p>
      </section>
    );
  }
  if (state.phase !== 'start_failed') return null;
  return (
    <section className="notice notice--alert" aria-label="Start error">
      <p>{state.startError}</p>
      <button type="button" className="control" onClick={() => actions.retryStart()}>
        Retry
      </button>
    </section>
  );
}

// A call that did not land keeps its words in the field, and NOT LOGGED sits under them and
// describes the field, so the reason is read with the words it is about.
function WordsForm({ state, actions }: { state: WallState; actions: WallActions }) {
  return (
    <form
      className="words"
      onSubmit={(event) => {
        event.preventDefault();
        if (controlsEnabled(state)) actions.say(state.draft);
      }}
    >
      <label htmlFor="cook-words" className="label">
        What the cook says
      </label>
      <div className="words-row">
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
        <button type="submit" className="control" {...unavailable(state)}>
          Send
        </button>
      </div>
      {state.notLogged === null ? null : (
        <p id={NOT_LOGGED_ID} className="not-logged">
          <strong className="status">{NOT_LOGGED}</strong> {state.notLogged.reason}
        </p>
      )}
    </form>
  );
}

export function WallView({ state, actions }: { state: WallState; actions: WallActions }) {
  const enabled = controlsEnabled(state);
  return (
    <div className="screen">
      <header className="top">
        <h1 className="wordmark">Tolsey</h1>
        <span className="site">Demo kitchen</span>
        <RosterPicker state={state} onSelect={actions.selectCook} />
        <ThemeSwitch />
      </header>
      <main className="wall">
        <section aria-label="Last reading">
          <PassView pass={state.pass} />
        </section>
        <div className="talk">
          <h2 className="talk-head">Say the reading</h2>
          <Notices state={state} actions={actions} />
          <ExchangeView exchange={state.exchange} cook={state.cook} />
          <p className="hint">
            {HINT_BEFORE}
            <q>{EXAMPLE_PHRASE}</q>
            {HINT_AFTER}
          </p>
          <WordsForm state={state} actions={actions} />
          <ul className="chips" aria-label="Phrases to try">
            {CHIPS.map((chip) => (
              <li key={chip}>
                <button
                  type="button"
                  className="chip"
                  {...unavailable(state)}
                  onClick={() => {
                    if (enabled) actions.say(chip);
                  }}
                >
                  {chip}
                </button>
              </li>
            ))}
          </ul>
        </div>
        <StatusRegion state={state} />
      </main>
    </div>
  );
}
