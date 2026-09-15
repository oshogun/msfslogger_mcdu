import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyOrigin} from './origin-probe-lib.mjs';

const sentinel='ORIGIN_PROBE_CREDENTIAL_SENTINEL';
test('origin classification retains only a normalized tuple',()=>{
  assert.deepEqual(classifyOrigin('CoUi://Example.Host'),{classification:'valid',scheme:'coui',lowercaseHost:'example.host',effectivePort:null});
  assert.deepEqual(classifyOrigin(undefined),{classification:'missing'});
});
test('credential-like or decorated origins fail closed without retaining input',()=>{
  for(const raw of [`http://${sentinel}@example.test`, `http://example.test/?token=${sentinel}`, `http://example.test/#${sentinel}`, sentinel, `http://example.test/${sentinel}`]){
    const encoded=JSON.stringify(classifyOrigin(raw));
    assert.deepEqual(JSON.parse(encoded),{classification:'invalid'});
    assert.equal(encoded.includes(sentinel),false);
  }
});
