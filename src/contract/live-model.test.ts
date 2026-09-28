import { describe, expect, it } from 'vitest';
import * as liveModel from './live-model';
import { LIVE_MODEL_DISCLOSURE } from './live-model';

describe('the live-model disclosure (AI Act Article 50(1))', () => {
  it.fails('tells the person they are talking to an AI system, first', () => {
    expect(LIVE_MODEL_DISCLOSURE).toMatch(/^You are talking to an AI system\./);
  });

  it.fails('is one plain spoken sentence or two, with no markdown and no degree sign', () => {
    expect(LIVE_MODEL_DISCLOSURE.trim()).toBe(LIVE_MODEL_DISCLOSURE);
    expect(LIVE_MODEL_DISCLOSURE).toMatch(/^[A-Z][^\n]*\.$/);
    expect(LIVE_MODEL_DISCLOSURE).not.toMatch(/[*_`#[\]<>|~]/);
    expect(LIVE_MODEL_DISCLOSURE).not.toContain('°');
  });

  it('is the single exported disclosure', () => {
    expect(Object.keys(liveModel)).toEqual(['LIVE_MODEL_DISCLOSURE']);
  });
});
