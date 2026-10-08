import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,stat} from 'node:fs/promises';
import {randomBytes,randomUUID} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {DeploymentStorage} from '../source/deploy/storage';
import {recordProtector} from '../source/deploy/record-crypto';

test('private transaction records reject ciphertext modification, record substitution, and the wrong vault key',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'btcsite-vault-')),key=randomBytes(32),storage=new DeploymentStorage(root,recordProtector(key)),first=randomUUID(),second=randomUUID();
  try{
    await storage.initialize();await storage.create(first);await storage.create(second);
    const original={network:'regtest',planHash:'a'.repeat(64),privateRecovery:'owned fixture only'};await storage.write(first,'package.sealed',original);
    assert.deepEqual(await storage.read(first,'package.sealed'),original);
    const filename=path.join(storage.directory(first),'package.sealed'),ciphertext=await readFile(filename);assert.equal((await stat(filename)).mode&0o777,0o600);assert.ok(!ciphertext.includes(Buffer.from(original.privateRecovery)));
    await writeFile(path.join(storage.directory(second),'package.sealed'),ciphertext);await assert.rejects(storage.read(second,'package.sealed'),{code:'DEPLOYMENT_DAMAGED'});
    await writeFile(path.join(storage.directory(first),'authorization.sealed'),ciphertext);await assert.rejects(storage.read(first,'authorization.sealed'),{code:'DEPLOYMENT_DAMAGED'});
    const damaged=Buffer.from(ciphertext);damaged[damaged.length-1]^=1;await writeFile(filename,damaged);await assert.rejects(storage.read(first,'package.sealed'),{code:'DEPLOYMENT_DAMAGED'});
    await writeFile(filename,ciphertext);const otherVault=new DeploymentStorage(root,recordProtector(randomBytes(32)));await assert.rejects(otherVault.read(first,'package.sealed'),{code:'DEPLOYMENT_DAMAGED'});
    const reopened=new DeploymentStorage(root,recordProtector(key));assert.deepEqual(await reopened.read(first,'package.sealed'),original);
  }finally{await rm(root,{recursive:true,force:true});}
});
