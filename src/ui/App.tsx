import { useSyncExternalStore } from 'react';
import type { WallSession } from './wall-session';
import { WallView } from './WallView';

export function App({ session }: { session: WallSession }) {
  const state = useSyncExternalStore(session.subscribe, session.getState);
  const actions = {
    say: (text: string) => void session.say(text),
    edit: (text: string) => session.edit(text),
    retryStart: () => void session.retryStart(),
  };
  return <WallView state={state} actions={actions} />;
}
