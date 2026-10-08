import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,execFile} from 'node:child_process';
import {promisify,parseArgs} from 'node:util';
import {createHash} from 'node:crypto';
import {signAsync} from '@electron/osx-sign';
const execute=promisify(execFile),root=fileURLToPath(new URL('..',import.meta.url));
const {values}=parseArgs({options:{'developer-id':{type:'string'}}});
const identity=values['developer-id'];
if(process.platform!=='darwin'||process.arch!=='arm64')throw new Error('This local candidate workflow targets macOS arm64.');
if(identity&&!/^Developer ID Application: .+ \([A-Z0-9]{10}\)$/.test(identity))throw new Error('Provide the complete public Developer ID Application display name.');
const metadata=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
const directory=path.join(root,'release',metadata.version);
try{await fs.access(directory);throw new Error('This candidate version already exists. Choose a new version before packaging.');}catch(error){if(error.code!=='ENOENT')throw error;}
// This explicitly local candidate is not a distributable notarized release.
// The normal dist workflow retains its mandatory notarization policy.
if(path.resolve(root,metadata.build.directories.output)!==directory)throw new Error('Set the reviewed build output to release/'+metadata.version+' in package.json before packaging.');
const child=spawn(process.execPath,[path.join(root,'scripts/package.mjs'),'--unsigned','--dir','--mac','--arm64'],{cwd:root,stdio:'inherit'});
const exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});if(exit!==0)throw new Error('Local candidate packaging failed.');
// The existing unsigned-directory policy fixes its staging output to
// release/developer. Move this owned result into the versioned candidate path.
await fs.mkdir(directory,{recursive:true});
await fs.rename(path.join(root,'release/developer/mac-arm64'),path.join(directory,'mac-arm64'));
const appPath=path.join(directory,'mac-arm64','Bitcoin Browser.app');
if(identity)await signAsync({app:appPath,identity,platform:'darwin',type:'distribution',preAutoEntitlements:false,preEmbedProvisioningProfile:false,strictVerify:true,optionsForFile:()=>({hardenedRuntime:true,entitlements:path.join(root,'build/entitlements.mac.plist')})});
await execute('/usr/bin/codesign',['--verify','--deep','--strict',appPath],{timeout:60000});
const signature=await execute('/usr/bin/codesign',['-dvv',appPath]);if(identity&&(!signature.stderr.includes('Authority='+identity)||!signature.stderr.includes('runtime')))throw new Error('Local Developer ID signature verification failed.');
const archive=path.join(directory,`bitcoin-browser-${metadata.version}-macos-arm64-creator.zip`);
await execute('/usr/bin/ditto',['-c','-k','--sequesterRsrc','--keepParent',appPath,archive],{timeout:120000});
const bytes=await fs.readFile(archive),sha256=createHash('sha256').update(bytes).digest('hex');
const sourceBrowserCommit=(await execute('/usr/bin/git',['rev-parse','HEAD'],{cwd:root})).stdout.trim();
const sourceBranch=(await execute('/usr/bin/git',['rev-parse','--abbrev-ref','HEAD'],{cwd:root})).stdout.trim();
const creatorManifest=JSON.parse(await fs.readFile(path.join(root,'src/creator/generated/build-manifest.json'),'utf8'));
const sources={};
async function inventory(directory){for(const entry of await fs.readdir(directory,{withFileTypes:true})){const file=path.join(directory,entry.name),relative=path.relative(root,file);if(relative==='src/creator/node_modules'||relative==='src/creator/generated'||relative==='src/creator/tests')continue;if(entry.isDirectory())await inventory(file);else if(entry.isFile())sources[relative]=createHash('sha256').update(await fs.readFile(file)).digest('hex');}}
await inventory(path.join(root,'src'));
for(const file of ['package.json','package-lock.json','README.md','SECURITY.md','LICENSE','scripts/build-creator.mjs','build/entitlements.mac.plist'])sources[file]=createHash('sha256').update(await fs.readFile(path.join(root,file))).digest('hex');
const manifest={schemaVersion:1,version:metadata.version,platform:'darwin',architecture:'arm64',electron:metadata.devDependencies.electron,createdAt:new Date().toISOString(),appPath:path.relative(root,appPath),archive:path.relative(root,archive),archiveBytes:bytes.length,sha256,signing:identity??'ad-hoc local candidate',notarized:false,published:false,publicReleaseReady:false,mainnetExecutionQualified:false,walletRecovery:false,sourceBuilderCommit:'96141f4',sourceBrowserCommit,sourceBranch,deliveredBrowserCommit:sourceBrowserCommit,reviewWorkspace:'local-data/creator-review-'+metadata.version,sources,creatorManifest};
await fs.writeFile(path.join(directory,'release-manifest.json'),JSON.stringify(manifest,null,2)+'\n');await fs.writeFile(path.join(directory,'SHA256SUMS'),sha256+'  '+path.basename(archive)+'\n');
console.log('Local creator candidate: '+appPath+'\nArchive: '+archive+'\nSHA-256: '+sha256+'\nNot notarized or published.');
