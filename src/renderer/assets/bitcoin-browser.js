import { h } from '../dom.js';

// Local, generated from the owner-supplied bitcoin-browser-logo.png. Never use
// a provider/model response or a remote URL as application branding.
export const BITCOIN_BROWSER_LOGO = Object.freeze({ src: './assets/bitcoin-browser-logo.png', width: 256, height: 256 });

export function applicationLogo(className, size) {
  const image = h('img', {
    className: `app-logo ${className}`, src: BITCOIN_BROWSER_LOGO.src,
    alt: '', 'aria-hidden': 'true', width: size, height: size,
    decoding: 'async', draggable: 'false', referrerpolicy: 'no-referrer',
    // Each placement keeps its adjacent textual product/assistant name.
    onError: () => { image.hidden = true; }
  });
  return image;
}
