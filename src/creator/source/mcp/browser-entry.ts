// Bitcoin Browser owns Electron startup. This entry has no stdio side effect
// until its --creator-mcp process explicitly starts the scoped connection.
export {startStdio} from './stdio';
