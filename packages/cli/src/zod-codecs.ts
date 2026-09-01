import * as z from 'zod';

// https://zod.dev/codecs?id=jsonschema#jsonschema
export const jsonCodec = <T extends z.core.$ZodType>(
  schema: T
): z.ZodCodec<z.ZodString, T> =>
  z.codec(z.string(), schema, {
    decode: (jsonString, ctx) => {
      try {
        return JSON.parse(jsonString);
      } catch (err: any) {
        ctx.issues.push({
          code: 'invalid_format',
          format: 'json',
          input: jsonString,
          message: err.message,
        });
        return z.NEVER;
      }
    },
    encode: (value) => JSON.stringify(value),
  });
