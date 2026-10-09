import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {extractFile,listPackage} from '@electron/asar';
import {getCurrentFuseWire,FuseV1Options,FuseState} from '@electron/fuses';
const reportName=process.argv.find(v=>v.startsWith('--report-name='))?.slice('--report-name='.length)??'creator-package-integrity.json';
if(!/^[a-z0-9][a-z0-9.-]{0,95}\.json$/.test(reportName))throw new Error('Invalid report basename');
const root=fileURLToPath(new URL('..',import.meta.url)),execute=promisify(execFile);
const metadata=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
const directory=path.join(root,'release',metadata.version),manifest=JSON.parse(await fs.readFile(path.join(directory,'release-manifest.json'),'utf8'));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const appPath=path.resolve(root,manifest.appPath),asar=path.join(appPath,'Contents/Resources/app.asar');
if(hash(await fs.readFile(path.resolve(root,manifest.archive)))!==manifest.sha256)throw new Error('Archive hash differs from release manifest');
for(const [file,expected] of Object.entries(manifest.sources)){if(hash(await fs.readFile(path.join(root,file)))!==expected)throw new Error('Source input changed: '+file);if(file.startsWith('src/')&&!file.endsWith('/package-lock.json')&&!file.endsWith('.d.ts')){if(hash(extractFile(asar,file))!==expected)throw new Error('Packaged source differs: '+file);}}
for(const [file,expected] of Object.entries(manifest.creatorManifest.payload)){const name='src/creator/generated/'+file;if(hash(extractFile(asar,name))!==expected)throw new Error('Packaged creator payload differs: '+name);}
for(const [file,expected] of Object.entries(manifest.creatorManifest.inputs))if(hash(await fs.readFile(path.resolve(root,'src/creator',file)))!==expected)throw new Error('Creator source input changed: '+file);
const files=listPackage(asar,{isPack:false});
if(files.some(file=>/(?:^|\/)(?:\.cookie|wallet\.dat|seed\.txt|\.env)$/.test(file)))throw new Error('Secret-bearing filename in package');
if(files.some(file=>file.startsWith('/src/creator/node_modules/')))throw new Error('Creator development dependencies included');
for(const file of ['compiler/worker.cjs','core/merge-worker.cjs']){const unpacked=path.join(appPath,'Contents/Resources/app.asar.unpacked/src/creator/generated',file);if(hash(await fs.readFile(unpacked))!==manifest.creatorManifest.payload[file])throw new Error('Unpacked worker differs: '+file);}
const wire=await getCurrentFuseWire(path.join(appPath,'Contents/MacOS/Bitcoin Browser'));
for(const [name,enabled] of [['RunAsNode',false],['EnableCookieEncryption',true],['EnableNodeOptionsEnvironmentVariable',false],['EnableNodeCliInspectArguments',false],['EnableEmbeddedAsarIntegrityValidation',true],['OnlyLoadAppFromAsar',true],['GrantFileProtocolExtraPrivileges',false]])if(wire[FuseV1Options[name]]!==(enabled?FuseState.ENABLE:FuseState.DISABLE))throw new Error('Release fuse differs: '+name);
await execute('/usr/bin/codesign',['--verify','--deep','--strict',appPath]);
const signature=await execute('/usr/bin/codesign',['-dvv',appPath]);if(!signature.stderr.includes('Authority='+manifest.signing)||!signature.stderr.includes('runtime'))throw new Error('Developer ID or hardened runtime differs');
const evidence={schemaVersion:1,checkedAt:new Date().toISOString(),version:metadata.version,archiveSha256:manifest.sha256,checks:{archiveHash:true,sourceInputs:true,asarSource:true,creatorPayload:true,unpackedWorkers:true,releaseFuses:true,developerId:true,hardenedRuntime:true,noKnownSecrets:true,noCreatorDevelopmentDependencies:true},sourceFiles:Object.keys(manifest.sources).length,payloadFiles:Object.keys(manifest.creatorManifest.payload).length,notarized:false};
await fs.writeFile(path.join(root,'docs/evidence',reportName),JSON.stringify(evidence,null,2)+'\n');
console.log('Candidate archive, source/payload inventory, ASAR workers, signature and seven release fuses verified.');
