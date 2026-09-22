import { aiResultTarget } from '../shared/local-ai.js';
import { parseNavigationInput } from '../shared/navigation.js';

export function aiAnswerEvidence(turn) {
  if (turn.answerOrigin === 'browser') return 'Browser-generated lookup summary';
  if ((turn.cards ?? []).some(card => !card.editorial)) return 'AI explanation · source snapshots below';
  if (turn.cards?.length) return 'AI explanation · curated examples, not live data';
  return 'AI explanation · no Bitcoin data checked';
}

export function aiCardFacts(card) {
  const preferred = card.kind === 'rune' ? ['Outstanding tokens (source snapshot)', 'Mint status (source snapshot)', 'Mint cap used']
    : ['inscription', 'inscription-number'].includes(card.kind) ? ['Sat rarity', 'Collector traits', 'Format']
    : card.kind === 'network' ? ['Still syncing', 'Verification progress', 'Indexed height'] : [];
  return [...(card.facts ?? [])].sort((a, b) => {
    const rank = fact => preferred.includes(fact.label) ? preferred.indexOf(fact.label) : preferred.length;
    return rank(a) - rank(b);
  });
}

// Only validated browser result targets seed actions. Never turn model prose,
// source metadata or arbitrary URLs into navigation or executable prompts.
export function aiResultFollowUps(turn) {
  const actions = [];
  for (const card of turn.cards ?? []) {
    if (card.editorial || !aiResultTarget(card.target) || card.network !== turn.network) continue;
    let target;
    try { target = parseNavigationInput(card.target); } catch { continue; }
    if (['inscription', 'inscription-number'].includes(target.kind)) {
      actions.push(['Explain sat rarity', `Look up inscription ${target.value}. Explain its sat rarity, collector traits, and any source uncertainty.`],
        ['Inspect recursion', `Inspect the content recursion of inscription ${target.value}. Explain measured references and the limits of the inspection.`]);
    } else if (target.kind === 'rune') {
      actions.push(['Mint & supply', `Look up Rune ${target.value}. Explain its formatted token supply, premine share, burns, remaining mint capacity and mint status. Do not guess market data.`]);
    } else if (target.kind === 'block' && /^\d+$/.test(target.value)) {
      actions.push(['Inscriptions in this block', `Show me inscriptions in block ${target.value}. Explain that this is a source page, not an exhaustive search.`]);
    }
  }
  return actions.filter(([label], index) => actions.findIndex(action => action[0] === label) === index).slice(0, 3);
}
