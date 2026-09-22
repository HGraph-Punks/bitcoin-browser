import { button, h, pageHeader } from './dom.js';
import { TURTLE_MOON_LOGO, TURTLE_MOON_WEBSITE } from './assets/turtle-moon.js';
import { applicationLogo } from './assets/bitcoin-browser.js';
import { renderDonation } from './donation.js';

// Kept local so About works offline and never loads company assets or payment
// details from a remote page. The license text is checked against LICENSE.
const LICENSE_TEXT = `MIT License

Copyright (c) 2026 Satoshi Browser contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

function buildInfo(model) {
  const app = model.bootstrap?.application ?? {};
  return [
    ['Version', app.version],
    ['Platform', [app.platform, app.arch].filter(Boolean).join(' ')],
    ['Packaged', app.packaged],
    ['State schema', model.bootstrap?.state?.schemaVersion],
    ['Secure storage', model.bootstrap?.secureStorageAvailable]
  ].map(([label, value]) => [label, value === true ? 'Yes' : value === false ? 'No' : String(value ?? '').trim() || 'Unknown']);
}

function creatorCard(ctx) {
  const logo = h('img', {
    className: 'about-creator-logo', src: TURTLE_MOON_LOGO.src, alt: 'Turtle Moon logo',
    width: 72, height: 72, decoding: 'async', referrerpolicy: 'no-referrer',
    // Keep the textual credit and website usable if the bundled image fails.
    onError: () => { logo.hidden = true; }
  });
  const openWebsite = event => {
    event.preventDefault();
    // Use normal external navigation: main-process consent, no embedded page,
    // no extra authority, and existing cancellation/error handling.
    return ctx.navigate(TURTLE_MOON_WEBSITE);
  };
  return h('section', { className: 'about-card about-creator', ariaLabel: 'Created by Turtle Moon' },
    h('div', { className: 'about-creator-heading' }, logo,
      h('div', {}, h('span', { className: 'eyebrow' }, 'Created by'), h('h2', {}, 'Turtle Moon'))),
    h('p', {}, 'Turtle Moon created Bitcoin Browser to make exploring Bitcoin easier. This open-source project brings everyday browsing and deeper Bitcoin tools together, without making you choose between simplicity and control.'),
    h('a', {
      className: 'about-website-link', href: TURTLE_MOON_WEBSITE,
      rel: 'noopener noreferrer', referrerpolicy: 'no-referrer',
      ariaLabel: 'Visit turtlemoon.io (opens in your browser after confirmation)',
      onClick: openWebsite,
      onAuxClick: event => { if (event.button === 1) return openWebsite(event); }
    }, 'turtlemoon.io', h('span', { 'aria-hidden': 'true' }, '↗')),
    h('p', { className: 'about-website-note' }, 'Opens in your system browser after confirmation.'),
    h('p', { className: 'about-credit' }, 'Built with open-source software, and made better by the people who use it.')
  );
}

export function renderAbout(model, ctx) {
  const info = buildInfo(model);
  const owner = model.activeTabId;
  const navigation = model.requestSequence?.[owner];
  const root = h('div', { className: 'about-page' },
    h('section', { className: 'about-hero', ariaLabel: 'About Bitcoin Browser' },
      h('div', { className: 'about-product-heading' }, applicationLogo('about-product-logo', 88),
        pageHeader('About', 'Bitcoin Browser', 'A clearer view of Bitcoin.')),
      h('p', { className: 'about-intro' }, 'Explore inscriptions, discover Runes, and follow the blocks, transactions and addresses that connect them. One place to find your way around Bitcoin.'),
      h('div', { className: 'about-build-tags', role: 'group', ariaLabel: 'Release information' },
        h('span', { className: 'about-tag' }, 'Early beta'),
        h('span', { className: 'about-tag' }, `Version ${info[0][1]}`),
        h('span', { className: 'about-tag' }, 'Open source · MIT'))
    ),
    h('div', { className: 'about-story-grid' },
      creatorCard(ctx),
      renderDonation(ctx)
    ),
    h('section', { className: 'about-principles', ariaLabel: 'Made for your way of exploring' },
      h('div', {}, h('h2', {}, 'Explore at your own pace'), h('p', {}, 'Start with visual galleries and simple lookups. Open the details when you want to go deeper.')),
      h('div', {}, h('h2', {}, 'Choose your sources'), h('p', {}, 'Browse with configured data services, or connect your own Bitcoin Core and Ord. Running a local node is optional.')),
      h('div', {}, h('h2', {}, 'Keep learning, locally'), h('p', {}, 'Connect LM Studio or Ollama in Ask Bitcoin for AI-assisted exploration. AI answers can be wrong; check their source results.'))
    ),
    h('div', { className: 'about-help' },
      h('div', {}, h('h2', {}, 'Getting started or stuck?'), h('p', {}, 'The built-in guide explains browsing, data sources and wallet boundaries.')),
      button('Documentation', { onClick: () => ctx.navigate('satnav://documentation') })),
    h('section', { className: 'about-help about-sponsors', ariaLabel: 'Sponsorship' },
      h('div', {}, h('h2', {}, 'Supported by our community'), h('p', {}, 'Meet our sponsoring partners, or find out how you or your company can help.')),
      button('View sponsors', { onClick: () => ctx.navigate('satnav://sponsors') })),
    h('details', { className: 'about-disclosure about-troubleshooting' },
      h('summary', {}, 'Build & troubleshooting'),
      h('div', { className: 'about-technical-grid' },
        h('section', {}, h('h2', {}, 'This build'), h('dl', { className: 'about-build-info' },
          info.map(([label, value]) => h('div', {}, h('dt', {}, label), h('dd', {}, value))))),
        h('section', {}, h('h2', {}, 'Troubleshooting'),
          h('p', {}, 'Export diagnostics to help reproduce a problem. Redaction is best-effort: review the saved file before sharing it.'),
          button('Export diagnostics', { onClick: () => ctx.exportDiagnostics() }),
          h('h3', {}, 'Local folders'),
          h('div', { className: 'about-folder-actions' },
            button('Reveal application data', { onClick: () => ctx.revealPath('data') }),
            button('Reveal cache', { onClick: () => ctx.revealPath('cache') }),
            button('Reveal logs', { onClick: () => ctx.revealPath('logs') })))),
      h('section', { className: 'about-boundaries' },
        h('h2', {}, 'Data & privacy boundaries'),
        h('p', {}, 'Provider adapters normalize data without tying navigation to one explorer. Recursive resources use bounded resolution, caching, ranges, dependency inspection and explicit provenance.'),
        h('p', {}, 'Inscription frames are untrusted opaque sandboxes and do not share wallet authority. Never enter a seed phrase or private key in the browser.'),
        h('p', {}, 'Analytics are absent in this build. Remote data sources and optional AI connections can still receive browser requests; review your sources and privacy settings.'))),
    h('details', { className: 'about-disclosure about-license' },
      h('summary', {}, 'Open-source license'),
      h('p', {}, 'Bitcoin Browser is released under the MIT license. Bundled third-party software retains its own licenses and notices.'),
      h('pre', { className: 'about-license-text' }, LICENSE_TEXT))
  );
  root.retainAbout = (result, next) => {
    // Background provider/cache publications must not close an expanded license
    // or move someone out of troubleshooting. Actual navigation gets a new view.
    return !result.error && result.target?.kind === 'internal' && result.target.value === 'about'
      && next.activeTabId === owner && next.requestSequence?.[owner] === navigation
      && JSON.stringify(buildInfo(next)) === JSON.stringify(info);
  };
  return root;
}
