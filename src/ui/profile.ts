import demo from '../../data/kitchens/demo.json';
import type { KitchenProfile } from '../domain/rule';

// Cast, never parsed: the schema check pulls zod into the page bundle and past its size gate.
export const WALL_PROFILE = demo as unknown as KitchenProfile;
