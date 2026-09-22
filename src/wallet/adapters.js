export function requestStyle(provider) {
  if (provider?.requestStyle === 'object' || provider?.requestStyle === 'positional') return provider.requestStyle;
  return provider?.request?.length <= 1 ? 'object' : 'positional';
}

export function requestRpc(provider, method, params, style = requestStyle(provider)) {
  if (typeof provider?.request !== 'function') throw new Error('Wallet does not expose a request method');
  if (style === 'object') return provider.request({ method, params });
  if (style === 'positional') return provider.request(method, params);
  throw new Error(`Unsupported wallet request style: ${style}`);
}

export function normalizeAccounts(value) {
  let source = value;
  if (source && typeof source === 'object' && !Array.isArray(source) && Object.hasOwn(source, 'result')) source = source.result;
  if (source && typeof source === 'object' && !Array.isArray(source)) source = source.addresses ?? source.accounts;
  if (!Array.isArray(source)) return [];

  const accounts = [];
  const scanLimit = Math.min(source.length, 200);
  const field = (candidate, limit) => typeof candidate === 'string' && candidate
    ? candidate.slice(0, limit)
    : null;
  for (let index = 0; index < scanLimit && accounts.length < 20; index += 1) {
    const item = source[index];
    if (typeof item === 'string') {
      const address = item.slice(0, 128);
      if (address) accounts.push({ address });
      continue;
    }
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const address = field(item.address ?? item.addresses?.[0]?.address, 128);
    if (!address) continue;
    accounts.push({
      address,
      publicKey: field(item.publicKey ?? item.public_key, 256),
      purpose: field(item.purpose ?? item.type, 50),
      addressType: field(item.addressType ?? item.address_type, 50),
      network: field(item.network, 50)
    });
  }
  return accounts;
}
