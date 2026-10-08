import { decodedContentBytes } from './content-decoding.js';

// Native resolver/cache records retain wire bytes. Creator catalog hashes are
// decoded-content hashes, so decode once with the same byte limit before the
// host verifies the pin and constructs its own response headers.
export function createCreatorResolver(resolver) {
  return {
    async resolve(url, options = {}) {
      const result = await resolver.resolve(url, options);
      const data = Buffer.from(await decodedContentBytes(result, options.maxBytes ?? 8_000_000, options.signal));
      const headers = { ...result.headers };
      delete headers['content-encoding'];
      headers['content-length'] = String(data.length);
      return { ...result, data, headers };
    }
  };
}
