import { createInterface, emitKeypressEvents } from 'node:readline';
import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { hashPassword } from '../server/auth.js';
const rl = createInterface({ input: process.stdin, output: process.stdout });
const email = z
  .email()
  .parse((await new Promise<string>((r) => rl.question('Admin email: ', r))).trim().toLowerCase());
rl.close();
async function hidden(prompt: string) {
  if (!process.stdin.isTTY)
    throw new Error(
      'Run admin:setup in a terminal. Passwords must not be passed in shell arguments.',
    );
  process.stdout.write(prompt);
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise<string>((resolve, reject) => {
    let text = '';
    const listener = (str: string, key: any) => {
      if (key?.ctrl && key.name === 'c') {
        cleanup();
        reject(new Error('Cancelled'));
      } else if (key?.name === 'return') {
        cleanup();
        resolve(text);
      } else if (key?.name === 'backspace') text = text.slice(0, -1);
      else if (str && !key?.ctrl && !/[\x00-\x1f]/.test(str)) text += str;
    };
    function cleanup() {
      process.stdin.off('keypress', listener);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
    }
    process.stdin.on('keypress', listener);
  });
}
const password = await hidden('Password (minimum 12 characters): ');
if (password.length < 12 || password.length > 1024) throw new Error('Use 12–1024 characters.');
const confirmation = await hidden('Repeat password: ');
if (password !== confirmation) throw new Error('Passwords differ.');
const hash = await hashPassword(password);
if (process.argv.includes('--hash-only')) {
  console.log(`ADMIN_EMAIL=${email}\nADMIN_PASSWORD_HASH=${hash}`);
} else {
  let env = '';
  try {
    env = await readFile('.env', 'utf8');
  } catch {}
  env = env.replace(/^ADMIN_(?:EMAIL|PASSWORD_HASH)=.*\r?\n?/gm, '');
  env += `\nADMIN_EMAIL=${email}\nADMIN_PASSWORD_HASH='${hash}'\n`;
  await writeFile('.env', env, { mode: 0o600 });
  console.log('Admin credentials saved to ignored .env. Restart the app to apply.');
}
