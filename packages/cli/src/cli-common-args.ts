import { object, or } from '@optique/core/constructs';
import { message } from '@optique/core/message';
import { optional, withDefault } from '@optique/core/modifiers';
import { flag, option } from '@optique/core/primitives';
import { string } from '@optique/core/valueparser';

// ---- shared option groups ------------------------------------------------

/**
 * Where staging commands run.
 *
 * The archives live on the NAS, and running staging over the mount pays a
 * network round-trip per file operation, so these route the work to the
 * machine holding the data instead.
 */
export const runnerOptions = object({
  remote: optional(
    option('--remote', string(), {
      description: message`Run on this SSH host instead of locally.`,
    })
  ),
  local: withDefault(
    flag('--local', {
      description: message`Force local execution even when .env names a NAS host.`,
    }),
    false
  ),
  key: optional(
    option('--key', string(), {
      description: message`SSH key to use. Passed with IdentitiesOnly, because ~/.ssh/config routes these hosts through an agent whose key set is not stable between invocations.`,
    })
  ),
});

/** Search/count filters, shared by the two query commands. */
export const filterOptions = object({
  phrase: option('--phrase', string(), {
    description: message`Text to match.`,
  }),
  board: optional(
    option('--board', string(), {
      description: message`Restrict to one board.`,
    })
  ),
  site: withDefault(
    option('--site', string(), {
      description: message`Site label; almost always 4chan.`,
    }),
    '4chan'
  ),
  from: optional(
    option('--from', string(), {
      description: message`Inclusive lower bound: YYYY, YYYY-MM or YYYY-MM-DD (UTC).`,
    })
  ),
  to: optional(
    option('--to', string(), {
      description: message`Inclusive upper bound. --to 2018-09 means through the end of September 2018.`,
    })
  ),
});
