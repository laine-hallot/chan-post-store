import type * as z from 'zod';

import chalk from 'chalk';

export const formatZodError = (zodError: z.ZodError): string => {
  return zodError.issues
    .map((error) => {
      const [errorType, ...message] = error.message.split(':');
      return `${chalk.red(errorType)} (${chalk.dim(error.path.join('.'))}): ${message.join().trim()}`;
    })
    .join('\n');
};
