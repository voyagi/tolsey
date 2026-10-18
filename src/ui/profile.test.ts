import { describe, expect, it } from 'vitest';
import demoJson from '../../data/kitchens/demo.json';
import { KitchenProfileSchema } from '../domain/rule';
import { WALL_PROFILE } from './profile';

describe('the profile the page casts', () => {
  it('deep-equals what the server parses from the same demo.json', () => {
    expect(WALL_PROFILE).toEqual(KitchenProfileSchema.parse(demoJson));
  });
});
