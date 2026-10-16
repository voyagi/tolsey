import type { RuleRow, RuleTable } from './rule';

const TENTHS_PER_DEGREE = 10;
const CODE_EDITION = 'Food Code 2022';
const CODE_SILENT = 'the Food Code sets no limit here';

function figureOf(row: RuleRow): string {
  switch (row.kind) {
    case 'temperature':
    case 'timed_temperature':
      return `${row.limitFTenths / TENTHS_PER_DEGREE}°F ${row.comparator === 'at_most' ? 'or less' : 'or above'}`;
    case 'duration':
      return `${row.minutes} minutes`;
    case 'observation':
      return row.passingStates.join(' or ');
  }
}

// A house rule's own value is only ever shown as the kitchen's; a Code section appears beside it
// only as the Code value it tightens, and where the Code has none the text says so (N2).
export function describeSource(row: RuleRow, table: RuleTable): string {
  const { source } = row;
  switch (source.kind) {
    case 'food_code':
      return `${CODE_EDITION} ${source.section}`;
    case 'other_law':
      return `${source.name}, which ${CODE_EDITION} ${source.section} defers to`;
    case 'house_rule': {
      const tightened = table.rows.find((candidate) => candidate.id === source.tightens);
      if (tightened === undefined || tightened.source.kind === 'house_rule') {
        return `house rule: ${source.reason}; ${CODE_SILENT}`;
      }
      return `house rule: ${source.reason}, stricter than ${describeSource(tightened, table)}, ${figureOf(tightened)}`;
    }
  }
}
