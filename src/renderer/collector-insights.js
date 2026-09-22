import { absoluteTime, button, formatNumber, h, shorten } from './dom.js';
import { ADDRESS_RE, INSCRIPTION_ID_RE, OUTPOINT_RE } from '../shared/navigation.js';
import { inscriptionCollectorProfile, ordinalSatNumber, SAT_RARITIES } from '../shared/ordinal-traits.js';

const bounded = (value, pattern, limit) => typeof value === 'string' && value.length <= limit && pattern.test(value) ? value : null;
const integer = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value)
  : typeof value === 'string' && /^\d{1,16}$/.test(value) ? BigInt(value).toString() : null;
const fact = (label, value) => h('div', {}, h('dt', {}, label), h('dd', {}, value ?? 'Not supplied'));

function profileFor(entity, ctx) {
  const summary = entity?.summary ?? {}, raw = entity?.data ?? {};
  const record = { sat: summary.sat ?? raw.sat, charms: raw.charms ?? summary.charms, number: summary.number ?? raw.number };
  return inscriptionCollectorProfile(record, entity?.network ?? ctx.model?.settings?.network);
}

export function renderInscriptionHighlights(entity, ctx) {
  const profile = profileFor(entity, ctx);
  return h('div', { className: 'inscription-collector-strip', role: 'group', ariaLabel: 'Collector highlights' },
    h('span', { className: `collector-badge${profile.rarity && profile.rarity.key !== 'common' ? ' collector-special' : ''}` }, `Sat rarity: ${profile.rarity?.label ?? 'Unavailable'}`),
    profile.traits.slice(0, 3).map(trait => h('span', { className: 'collector-badge', title: trait.description }, trait.label)),
    profile.traits.length > 3 ? h('span', { className: 'collector-strip-note' }, `+${profile.traits.length - 3} in Details`) : null,
    profile.conflict ? h('span', { className: 'collector-strip-note' }, 'Source traits disagree · see Details') : null);
}

export function renderInscriptionCollectorDetails(entity, ctx) {
  const summary = entity?.summary ?? {}, raw = entity?.data ?? {};
  const profile = profileFor(entity, ctx);
  const sat = ordinalSatNumber(summary.sat ?? raw.sat);
  const network = entity?.network ?? ctx.model?.settings?.network;
  const id = bounded(summary.id ?? raw.id, INSCRIPTION_ID_RE, 80);
  const address = bounded(summary.address ?? raw.address, ADDRESS_RE, 100);
  const output = bounded(summary.output ?? raw.output, OUTPOINT_RE, 90);
  const delegate = bounded(raw.delegate, INSCRIPTION_ID_RE, 80);
  const height = integer(summary.height ?? raw.height);
  const timestamp = integer(summary.timestamp ?? raw.timestamp);
  const fee = integer(raw.fee), value = integer(raw.value);
  const parents = [...new Set((Array.isArray(raw.parents) ? raw.parents : []).slice(0, 24)
    .filter(parent => bounded(parent, INSCRIPTION_ID_RE, 80)))];
  const navigate = (label, target) => button(label, { small: true, onClick: () => ctx.navigate(target) });
  return h('div', { className: 'collector-details' },
    h('section', { className: 'collector-section' }, h('h3', {}, 'Sat rarity & traits'),
      h('strong', { className: 'collector-rarity' }, profile.rarity?.label ?? 'Sat rarity unavailable'),
      h('p', {}, profile.rarity?.description ?? 'A sat number or an explicit rarity charm is needed. Missing data does not mean this is a common sat.'),
      profile.rarity && network === 'mainnet' ? h('p', { className: 'collector-note' }, `Scheduled sats in this class: ${formatNumber(profile.rarity.supply)}. Includes future issuance, not just sats in circulation.`) : null,
      h('p', { className: 'collector-note' }, profile.rarity?.origin === 'calculated'
        ? 'Calculated locally from the source-provided sat number using the mainnet issuance schedule.'
        : profile.rarity ? 'Rarity reported by your source; no local sat calculation was available.'
          : network !== 'mainnet' ? 'Local sat calculations currently support mainnet only.' : 'Your Ord source may need sat indexing to supply the sat number.'),
      profile.conflict ? h('p', { className: 'collector-warning', role: 'status' }, 'Source-reported traits disagree with the sat calculation or with each other. Review the raw data before relying on them.') : null,
      profile.traits.length ? h('dl', { className: 'collector-traits' }, profile.traits.map(trait => h('div', {},
        h('dt', {}, trait.label), h('dd', {}, trait.description, h('span', { className: 'collector-origin' },
          trait.origin === 'calculated' ? 'Calculated from sat number' : trait.origin === 'number' ? 'From negative inscription number' : 'Reported by source')))))
        : h('p', { className: 'collector-note' }, 'No additional recognized traits were supplied or calculated.'),
      h('details', { className: 'collector-guide' }, h('summary', {}, 'What does sat rarity mean?'),
        h('p', {}, 'These definitions describe Bitcoin mainnet sat rarity, not the artwork’s rarity, collection rank or market value.'),
        h('dl', { className: 'collector-traits' }, Object.values(SAT_RARITIES).map(rarity => h('div', {},
          h('dt', {}, rarity.label), h('dd', {}, rarity.description,
            network === 'mainnet' ? h('span', { className: 'collector-origin' }, `${formatNumber(rarity.supply)} sats across the full issuance schedule`) : null)))),
        h('p', { className: 'collector-note' }, 'Full-schedule counts include future sats and are not counts of inscriptions, available listings or sats currently in circulation.'))),
    h('section', { className: 'collector-section' }, h('h3', {}, 'Inscription history'),
      h('dl', { className: 'collector-facts' },
        fact('Inscribed', timestamp !== null && BigInt(timestamp) <= 0xffffffffn ? absoluteTime(Number(timestamp) * 1000) : null),
        fact('Inscription block', height !== null ? navigate(formatNumber(height), `block:${height}`) : null),
        fact('Inscription fee', fee === null ? null : `${formatNumber(fee)} sats`),
        fact('Postage · output value', value === null ? null : `${formatNumber(value)} sats`)),
      h('p', { className: 'collector-note' }, 'Postage is the value of the containing Bitcoin output, not an asking price. Fees and locations reflect this source snapshot.'),
      id ? navigate('Reveal transaction', `tx:${id.slice(0, 64)}`) : null),
    h('section', { className: 'collector-section' }, h('h3', {}, 'The inscribed sat'),
      h('dl', { className: 'collector-facts' },
        fact('Sat number', sat === null ? null : navigate(formatNumber(sat), `sat:${sat}`)),
        fact('Sat name', profile.sat?.name),
        fact('Sat mined in block', profile.sat ? navigate(formatNumber(profile.sat.block), `block:${profile.sat.block}`) : null),
        fact('Position in mined block', profile.sat ? `${formatNumber(profile.sat.offset)} · zero-based` : null)),
      profile.sat ? h('details', { className: 'collector-guide' }, h('summary', {}, 'Sat notation & mining cycle'),
        h('dl', { className: 'collector-facts' }, fact('Decimal', profile.sat.decimal), fact('Degree', profile.sat.degree),
          fact('Halving epoch', profile.sat.epoch), fact('Difficulty period', profile.sat.period), fact('Cycle', profile.sat.cycle)),
        h('p', { className: 'collector-note' }, 'Epochs, periods and cycles are zero-based. The sat’s mined block is different from the later block in which it was inscribed.')) : null),
    h('section', { className: 'collector-section' }, h('h3', {}, 'Location & provenance'),
      h('dl', { className: 'collector-facts' },
        fact('Current address', address ? navigate(shorten(address, 12, 8), `address:${address}`) : null),
        fact('Current output', output && !/^0{64}:/.test(output) ? navigate(shorten(output, 12, 8), `output:${output}`) : null)),
      delegate ? navigate('Delegated content inscription', `inscription:${delegate}`) : null,
      parents.length ? h('div', { className: 'collector-parents' }, h('h4', {}, 'Parents reported in this record'),
        parents.map((parent, index) => navigate(`Parent ${index + 1} · ${shorten(parent, 8, 5)}`, `inscription:${parent}`)),
        h('p', { className: 'collector-note' }, 'Up to 24 supplied references are shown. Parent links describe declared provenance, not recursive content depth or verified collection membership.')) : null,
      h('p', { className: 'collector-note' }, 'Missing fields are not proof of no owner, no parents or no traits. Source data is not a collection-verification badge.')));
}
