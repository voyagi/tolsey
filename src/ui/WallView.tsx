import type { WallState } from './wall-state';

interface WallActions {
  say(text: string): void;
  edit(text: string): void;
  retryStart(): void;
}

export function WallView(props: { state: WallState; actions: WallActions }) {
  void props;
  return <main />;
}
