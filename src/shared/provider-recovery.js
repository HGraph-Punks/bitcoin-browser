const explanations = Object.freeze({
  PROVIDER_CREDENTIAL_RECOVERY_REQUIRED: 'A previous sign-in change did not finish. Review the saved sign-in details before this source can be used.',
  PROVIDER_CREDENTIAL_STATE_INVALID: 'The app cannot read the saved sign-in recovery information. Review this source before it can be used.',
  PROVIDER_CREDENTIAL_BINDING_MISMATCH: 'The saved sign-in details belong to a different source address, network, or authentication method. Review this destination before restoring access.',
  PROVIDER_LEGACY_CREDENTIAL_RECOVERY_REQUIRED: 'This source was restored from older saved data. The app cannot confirm which destination its saved sign-in details belong to.',
  SECURE_STORAGE_ROLLBACK_FAILED: 'The app could not restore the previous saved sign-in state after a failed change. Review this source before it can be used.'
});

export function providerRecoveryExplanation(provider) {
  const code = provider?.routingError?.code;
  return provider?.routingBlocked === true && Object.hasOwn(explanations, code) ? explanations[code] : null;
}

export function providerRecoveryReview(provider, requestedMode) {
  if (!providerRecoveryExplanation(provider)) return null;
  const { token, mode } = provider.credentialRecovery ?? {};
  const expectedMode = provider.type === 'bitcoin-core' && !provider.cookieFile ? 'replace-basic' : 'clear-stored';
  if (typeof token !== 'string' || !token || mode !== expectedMode) return null;
  const selectedMode = requestedMode ?? mode;
  if (selectedMode !== mode && !(mode === 'replace-basic' && selectedMode === 'clear-stored')) return null;
  return Object.freeze({
    id: provider.id, name: provider.name, type: provider.type, network: provider.network,
    baseUrl: provider.baseUrl ?? '', cookieFile: provider.cookieFile ?? '',
    enabled: provider.enabled, priority: provider.priority,
    capabilities: JSON.stringify(provider.capabilities), token, mode: selectedMode
  });
}

export function providerRecoveryReviewMatches(provider, review) {
  const current = providerRecoveryReview(provider, review.mode);
  return Boolean(current && Object.keys(review).every((key) => current[key] === review[key]));
}

export function providerRecoveryCredentialError(username, password) {
  if (!username || !password) return 'Enter both a fresh RPC username and password. Neither field can be empty.';
  if (username.length > 256 || /[:\u0000-\u001f\u007f]/.test(username)) return 'The RPC username must be at most 256 characters and contain no colon or control characters.';
  if (password.length > 4096 || /[\u0000-\u001f\u007f]/.test(password)) return 'The RPC password must be at most 4096 characters and contain no control characters.';
  return null;
}
