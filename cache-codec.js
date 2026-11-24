/* Cache-only gzip wrapper. Response bytes are restored before use or integrity checks. */
(function (scope) {
  'use strict';

  const MARKER = 'X-Benrishi-Cache-Encoding';
  const MIN_BYTES = 2048;

  function isPacked(response) {
    return (response.headers.get(MARKER) || '').trim().toLowerCase() === 'gzip';
  }

  function rebuild(response, bytes, packed) {
    const headers = new scope.Headers(response.headers);
    // These describe the old transport body, not the newly constructed body.
    headers.delete('Content-Encoding');
    headers.delete('Content-Length');
    headers.delete(MARKER);
    if (packed) headers.set(MARKER, 'gzip');
    return new scope.Response(bytes, {
      status: response.status,
      statusText: response.statusText,
      headers: headers
    });
  }

  async function transform(bytes, stream) {
    const input = new scope.Response(bytes);
    // Consume the complete stream here so a corrupt gzip rejects unpack(),
    // rather than returning a response whose body fails later.
    return new scope.Response(input.body.pipeThrough(stream)).arrayBuffer();
  }

  async function pack(response) {
    if (isPacked(response) || response.body === null) return response;
    if (typeof scope.CompressionStream !== 'function' ||
        typeof scope.DecompressionStream !== 'function') return response;

    // Cloning keeps the caller's response readable, including every raw fallback.
    const original = await response.clone().arrayBuffer();
    if (original.byteLength < MIN_BYTES) return response;
    const compressed = await transform(original, new scope.CompressionStream('gzip'));
    if (compressed.byteLength * 100 > original.byteLength * 95) return response;
    return rebuild(response, compressed, true);
  }

  async function unpack(response) {
    if (!isPacked(response)) return response;
    if (typeof scope.DecompressionStream !== 'function') {
      throw new Error('この環境では保存された gzip データを展開できません。');
    }
    if (response.body === null) {
      throw new Error('保存された gzip データの本文がありません。');
    }
    const compressed = await response.clone().arrayBuffer();
    const original = await transform(compressed, new scope.DecompressionStream('gzip'));
    return rebuild(response, original, false);
  }

  scope.CacheCodec = Object.freeze({ pack: pack, unpack: unpack });
})(typeof self !== 'undefined' ? self :
   typeof window !== 'undefined' ? window : globalThis);
