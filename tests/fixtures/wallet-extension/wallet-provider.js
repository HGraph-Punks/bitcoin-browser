(() => {
  const account = 'bc1qpackagedsmokewallet000000000000000000000';
  Object.defineProperty(globalThis, 'unisat', {
    configurable: false,
    enumerable: true,
    writable: false,
    value: Object.freeze({
      requestAccounts: async () => [account],
      getAccounts: async () => [account],
      disconnect: async () => true,
      signPsbt: async () => { throw new Error('Packaged beta signing must remain disabled'); },
      signMessage: async () => { throw new Error('Packaged beta signing must remain disabled'); }
    })
  });
})();
