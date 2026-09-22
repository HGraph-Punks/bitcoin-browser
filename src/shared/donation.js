// Owner-approved public recipient from donation-ledger-btc.md. The supplied QR
// was independently decoded to this exact address before being bundled locally.
// Never derive a donation destination from a provider, model, profile or wallet.
const address = '1NrPJqSjJ6edVExCQrRv5e7sY367jbiyem';
export const DONATION = Object.freeze({
  address,
  network: 'mainnet',
  recipient: 'Turtle Moon · Bitcoin Browser development',
  // Amount-free, address-only bitcoin: URI. No payment server, callback,
  // remote metadata, Lightning invoice or wallet-signing permission.
  uri: `bitcoin:${address}`,
  qr: './assets/donation-qr.png'
});
