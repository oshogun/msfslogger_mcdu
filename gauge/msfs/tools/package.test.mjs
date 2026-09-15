import test from 'node:test';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('staged package preserves synchronized-host ordering and CSP',async()=>{
  const script=fileURLToPath(new URL('./package-inspect.mjs',import.meta.url));
  await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[script],{stdio:'inherit'});child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(`package inspection exited ${code}`)));});
});
