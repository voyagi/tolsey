import { businessDay, localParts } from '../domain/business-day';
import { PROBE_DAY_START, PROBE_ZONE } from './q4-instants';

// Test-only Worker, never part of the product build: it answers the product's own business-day
// functions as workerd computes them, for comparison with Node.
export default {
  fetch(request: Request): Response {
    const instants = new URL(request.url).searchParams.getAll('at').map(Number);
    return Response.json(
      instants.map((instant) => ({
        instant,
        parts: localParts(instant, PROBE_ZONE),
        businessDay: businessDay(instant, PROBE_ZONE, PROBE_DAY_START),
      })),
    );
  },
};
