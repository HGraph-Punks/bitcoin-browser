import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {readConnection,BridgeClient} from '../agent/client';
import {createMcpServer} from './server';
import {AppError} from '../core/errors';

export async function startStdio(args:string[],onClose:()=>void=()=>{}){
  const index=args.indexOf('--connection');
  if(index<0||!args[index+1])throw new AppError('CONNECTION_REQUIRED','Connect an AI assistant in Bitcoin Website Builder and use its generated settings.');
  const client=new BridgeClient(await readConnection(args[index+1]));
  const server=createMcpServer(client);
  const transport=new StdioServerTransport(process.stdin,process.stdout,{maxBufferSize:3_000_000});
  await server.connect(transport);
  process.stdin.once('end',()=>{void server.close().finally(onClose);});
  return server;
}
