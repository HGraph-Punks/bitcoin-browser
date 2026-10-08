export const CREATOR_URL='app://app/creator/generated/renderer/index.html';
export const BROWSER_URL='app://app/renderer/index.html';
export function trustedModeSender(event,window,url){return Boolean(window&&!window.isDestroyed()&&event.sender===window.webContents&&event.senderFrame===window.webContents.mainFrame&&event.senderFrame?.url===url);}
