import { button, h } from './dom.js';
import { DONATION } from '../shared/donation.js';

export function renderDonation(ctx) {
  let feedbackSequence = 0;
  const status = h('p', { className: 'donation-status', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const report = (sequence, text) => { if (sequence === feedbackSequence) status.textContent = text; };
  const address = h('code', { className: 'donation-address', dir: 'ltr', tabIndex: '0', ariaLabel: 'Bitcoin mainnet donation address' }, DONATION.address);
  const copy = button('Copy address', { primary: true, className: 'donation-copy', ariaLabel: 'Copy Bitcoin donation address', onClick: async () => {
    if (copy.disabled) return;
    copy.disabled = true;
    const sequence = ++feedbackSequence;
    status.textContent = '';
    try {
      const copied = await ctx.copy(DONATION.address);
      report(sequence, copied === true ? 'Address copied. Paste it into your wallet to choose an amount.'
        : 'Could not copy. Select the full address above and copy it manually.');
    } catch {
      report(sequence, 'Could not copy. Select the full address above and copy it manually.');
    } finally { copy.disabled = false; }
  } });
  const open = button('Open in wallet', { className: 'donation-open', ariaLabel: 'Open donation request in your system wallet after confirmation', onClick: async () => {
    if (open.disabled) return;
    open.disabled = true;
    const sequence = ++feedbackSequence;
    status.textContent = '';
    try {
      // Existing trusted IPC performs Cancel-default native confirmation.
      // Keep the page in place and never invoke the extension signing bridge.
      await ctx.openExternal(DONATION.uri);
      report(sequence, 'Wallet request opened—not a payment confirmation. Review the address and choose an amount in your wallet.');
    } catch (error) {
      report(sequence, error?.code === 'USER_REJECTED' ? 'Wallet request canceled. You can still copy the address or scan the QR code.'
        : 'Could not open a wallet. Copy the address or scan the QR code with your Bitcoin wallet instead.');
    } finally { open.disabled = false; }
  } });
  const caption = h('figcaption', { className: 'donation-qr-caption' }, 'Scan with your Bitcoin wallet');
  const qr = h('img', { className: 'donation-qr', src: DONATION.qr,
    alt: 'QR code for the Bitcoin mainnet donation address shown alongside',
    width: 168, height: 168, decoding: 'async', draggable: 'false', referrerpolicy: 'no-referrer',
    onError: () => { qr.hidden = true; caption.textContent = 'QR unavailable. Use the full address alongside.'; }
  });
  return h('section', { className: 'donation-card about-support', ariaLabel: 'Donate to Bitcoin Browser development' },
    h('span', { className: 'eyebrow' }, 'Optional support'),
    h('h2', {}, 'Donate Bitcoin'),
    h('p', { className: 'donation-intro' }, 'Help Turtle Moon build and maintain this open-source browser. Choose any amount in your own wallet.'),
    h('div', { className: 'donation-body' },
      h('figure', { className: 'donation-scan' }, qr, caption),
      h('div', { className: 'donation-details' },
        h('span', { className: 'donation-network' }, 'Bitcoin · mainnet'),
        h('p', { className: 'donation-recipient' }, DONATION.recipient),
        address,
        h('div', { className: 'donation-actions' }, copy, open),
        h('p', { className: 'donation-wallet-note' }, 'No wallet connection needed. Opening a wallet asks for confirmation; it never sends funds automatically.'))),
    status,
    h('p', { className: 'donation-safety' }, 'On-chain BTC only—not Lightning. Check the full address and fee in your wallet. Choose regular BTC, not inscriptions or Runes.'),
    h('p', { className: 'donation-thanks' }, 'Thank you for supporting independent, open-source Bitcoin browsing.')
  );
}
