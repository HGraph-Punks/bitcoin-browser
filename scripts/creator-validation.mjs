import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
const creator=process.argv.includes('--creator');
await fs.mkdir('.creator-test',{recursive:true});
const child=spawn('npm',creator?['--prefix','src/creator','test']:['test'],{stdio:['ignore','pipe','pipe']});
let output='';for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{output+=chunk;if(output.length>10_000_000)child.kill('SIGTERM');});
const code=await new Promise(resolve=>{child.on('error',error=>{output+=error.message;resolve(1);});child.on('exit',resolve);});
const file=creator?'.creator-test/creator-domain.log':'.creator-test/browser-regression.log';await fs.writeFile(file,output);
const lines=output.split('\n');console.log(lines.filter(line=>/^✖|^ℹ|^#|^not ok/.test(line)).join('\n'));
if(code!==0){const offset=output.indexOf('failing tests:');console.log(output.slice(offset<0?-3000:offset,offset<0?undefined:offset+18000));}
console.log('Full validation log: '+file);process.exitCode=Number(code??1);
