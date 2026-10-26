import assert from 'node:assert/strict';
import test from 'node:test';
import {CodexRpcError} from '../electron/services/codex-transport';

test('Codex RPC errors retain safe diagnostic categories without persisting raw server details',()=>{
  for(const [message,category] of [
    ['Maximum context window length exceeded','context'],['Invalid output schema: missing additionalProperties','schema'],['Model unknown-model is not supported','model'],['Authentication failed for token secret-value','auth'],['Request timeout','timeout'],['Rate limit exceeded','rate_limit'],['Required delegation capability is unavailable','capability'],['Internal server error','server'],['Unrecognized request','request']
  ] as const){
    const error=new CodexRpcError({code:-32602,message:`${message}; privateMarker=PRIVATE_SECRET`,data:{token:'ANOTHER_SECRET'}});
    assert.equal(error.category,category);assert.equal(error.code,-32602);assert.match(error.message,/RPC -32602/);assert.doesNotMatch(JSON.stringify(error)+error.message,/PRIVATE_SECRET|ANOTHER_SECRET|secret-value|unknown-model/);
  }
  const unknown=new CodexRpcError({code:'unsafe-code',message:'Sensitive path: C:/private/account',data:'secret'});assert.equal(unknown.category,'unknown');assert.equal(unknown.code,undefined);assert.doesNotMatch(unknown.message,/private|secret/);
});
