import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import type {SecretProtector} from './storage';

const version=Buffer.from('BTCSITE-VAULT-1\0');
/** Standard AES-256-GCM; context binds a ciphertext to its deployment and record. */
export function recordProtector(secret:Buffer):SecretProtector {
  if(secret.length!==32)throw new Error('Invalid deployment vault key.');const key=Buffer.from(secret);
  const aad=(context:string)=>Buffer.concat([version,Buffer.from(context,'utf8')]);
  return {
    async seal(plain,context){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(aad(context));return Buffer.concat([version,iv,cipher.update(plain),cipher.final(),cipher.getAuthTag()]);},
    async open(sealed,context){if(sealed.length<version.length+28||!sealed.subarray(0,version.length).equals(version))throw new Error('Unsupported deployment vault format.');const iv=sealed.subarray(version.length,version.length+12),decipher=createDecipheriv('aes-256-gcm',key,iv);decipher.setAAD(aad(context));decipher.setAuthTag(sealed.subarray(-16));return Buffer.concat([decipher.update(sealed.subarray(version.length+12,-16)),decipher.final()]);}
  };
}
