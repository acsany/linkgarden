import { randomInt } from 'node:crypto';
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
// Five case-sensitive letters/digits, used for page slugs and campaign codes. Never add
// a dot: the Markdown routes (/<slug>.md) rely on slugs and codes having none.
export const randomSlug = () =>
  Array.from({ length: 5 }, () => alphabet[randomInt(alphabet.length)]).join('');
