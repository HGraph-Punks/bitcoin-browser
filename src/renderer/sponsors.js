import { h, pageHeader } from './dom.js';
import { renderDonation } from './donation.js';

// Public destinations only. Keep this in sync if the project's public GitHub
// repository moves; do not derive a runtime URL from profile or Git credentials.
export const SPONSORSHIP_REPOSITORY = 'https://github.com/HGraphPunks/satoshi-browser-1.0.0-rc.1';
export const HOL_WEBSITE = 'https://hol.org/';
export const SPONSORSHIP_INQUIRY_URL = `${SPONSORSHIP_REPOSITORY}/issues/new?${new URLSearchParams({
  title: 'Sponsorship inquiry',
  body: [
    'Hi Bitcoin Browser team,',
    '',
    "I'd like to inquire about becoming a sponsor.",
    '',
    'About me or my organization (public information only):',
    '',
    "How I'd like to support the project:",
    '',
    'Please share the next steps.',
    '',
    'Privacy reminder: this issue may be public. Do not include private contact details, credentials, seed phrases, or payment information.'
  ].join('\n')
})}`;

function externalLink(ctx, href, label, options = {}) {
  const open = event => {
    event.preventDefault();
    // Preserve the current page and use the normal main-process confirmation.
    // This opens a website, never a GitHub API call or automatic submission.
    return ctx.navigate(href);
  };
  return h('a', {
    className: `button sponsors-link${options.primary ? ' primary' : ''}`,
    href, rel: 'noopener noreferrer', referrerpolicy: 'no-referrer',
    ariaLabel: `${label} (opens in your browser after confirmation)`,
    'aria-describedby': options.describedBy,
    onClick: open,
    onAuxClick: event => { if (event.button === 1) return open(event); }
  }, label, h('span', { 'aria-hidden': 'true' }, '↗'));
}

export function renderSponsors(model, ctx) {
  const owner = model.activeTabId;
  const navigation = model.requestSequence?.[owner];
  const root = h('div', { className: 'sponsors-page' },
    h('section', { className: 'sponsors-hero', ariaLabel: 'Bitcoin Browser sponsors' },
      pageHeader('Community supported', 'Sponsors', 'Helping Bitcoin Browser grow.'),
      h('p', { className: 'sponsors-intro' }, 'Thank you to the people and organizations supporting open-source Bitcoin browsing.')),
    h('div', { className: 'sponsors-grid' },
      h('section', { className: 'sponsors-card sponsors-partner', ariaLabel: 'HOL.org · Sponsoring partner' },
        h('span', { className: 'sponsors-partner-label' }, 'Sponsoring partner'),
        h('h2', {}, 'HOL.org'),
        h('p', {}, 'Thank you to HOL.org for supporting Bitcoin Browser and helping this open-source project move forward.'),
        externalLink(ctx, HOL_WEBSITE, 'Visit HOL.org')),
      h('section', { className: 'sponsors-card sponsors-inquiry', ariaLabel: 'Become a sponsor' },
        h('span', { className: 'eyebrow' }, 'Get involved'),
        h('h2', {}, 'Become a sponsor'),
        h('p', {}, 'Any company or individual can become a sponsor. Open an issue on our GitHub to inquire about sponsoring Bitcoin Browser.'),
        h('p', { className: 'sponsors-inquiry-help' }, "Tell us a little about yourself or your organization and how you'd like to help. Start with the prepared issue draft, then review and submit it on GitHub."),
        externalLink(ctx, SPONSORSHIP_INQUIRY_URL, 'Inquire on GitHub', { primary: true, describedBy: 'sponsorship-issue-note' }),
        h('p', { className: 'sponsors-issue-note', id: 'sponsorship-issue-note' }, 'GitHub account and repository access required. Issues may be public—do not include private contact details, credentials, seed phrases or payment information.'))),
    renderDonation(ctx),
    h('p', { className: 'sponsors-footnote' }, 'Website links open in your system browser after confirmation. Donations are completed in your own wallet; Bitcoin Browser does not sign or send payments.')
  );
  root.retainSponsors = (result, next) => {
    // Live source/cache updates must not reset reading position or link focus.
    return !result.error && result.target?.kind === 'internal' && result.target.value === 'sponsors'
      && next.activeTabId === owner && next.requestSequence?.[owner] === navigation;
  };
  return root;
}
