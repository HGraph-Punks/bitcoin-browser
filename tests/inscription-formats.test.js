import test from 'node:test';
import assert from 'node:assert/strict';
import { inscriptionPresentation } from '../src/shared/inscription-presentation.js';
import { inscriptionMediaType } from '../src/shared/discovery.js';

// Complete 40-row Ord Media::TABLE snapshot, including charset/codec variants.
// Source: ordinals/ord 899e309424dd60e1c8065a7727a76d9b675a6ac4,
// src/inscriptions/media.rs. Classification is not a claim about every codec.
const registry = [
  ['application/cbor', 'binary'], ['application/json', 'text'], ['application/octet-stream', 'binary'],
  ['application/pdf', 'pdf'], ['application/pgp-signature', 'text'], ['application/protobuf', 'binary'],
  ['application/x-bittorrent', 'binary'], ['application/x-javascript', 'text'], ['application/yaml', 'text'],
  ['audio/flac', 'audio'], ['audio/mpeg', 'audio'], ['audio/ogg', 'audio'], ['audio/ogg;codecs=opus', 'audio'], ['audio/wav', 'audio'],
  ['font/otf', 'font'], ['font/ttf', 'font'], ['font/woff', 'font'], ['font/woff2', 'font'],
  ['image/apng', 'image'], ['image/avif', 'image'], ['image/gif', 'image'], ['image/jpeg', 'image'], ['image/jxl', 'jxl'],
  ['image/png', 'image'], ['image/svg+xml', 'image'], ['image/webp', 'image'],
  ['model/gltf+json', 'model'], ['model/gltf-binary', 'model'], ['model/stl', 'model'],
  ['text/css', 'text'], ['text/html', 'original'], ['text/html;charset=utf-8', 'original'], ['text/javascript', 'text'],
  ['text/markdown', 'markdown'], ['text/markdown;charset=utf-8', 'markdown'], ['text/plain', 'text'], ['text/plain;charset=utf-8', 'text'], ['text/x-python', 'text'],
  ['video/mp4', 'video'], ['video/webm', 'video']
];
assert.equal(registry.length, 40);
const categories = { binary: 'other', text: 'text', pdf: 'documents', font: 'fonts', markdown: 'text', jxl: 'images', image: 'images', model: 'models', original: 'interactive', audio: 'audio', video: 'video' };
for (const [type, expected] of registry) test(`Ord registry: ${type} has an explicit ${expected} view and discoverable category`, () => {
  assert.equal(inscriptionPresentation(type), expected);
  assert.equal(inscriptionPresentation(` ${type.toUpperCase()} `), expected);
  assert.equal(inscriptionMediaType(type), categories[expected]);
});
test('additional observed formats and conventional MIME aliases retain purpose-built views', () => {
  for (const [types, kind] of [
    [['audio/mp4', 'audio/aac', 'audio/x-m4a', 'audio/x-flac', 'audio/opus', 'audio/x-wav', 'application/ogg', 'audio/webm'], 'audio'],
    [['video/ogg', 'video/quicktime', 'video/x-m4v'], 'video'], [['image/bmp', 'image/x-icon', 'image/vnd.microsoft.icon'], 'image'],
    [['application/xml', 'application/ld+json', 'application/javascript', 'application/x-yaml', 'application/toml'], 'text'],
    [['application/font-woff', 'application/x-font-ttf', 'application/vnd.ms-opentype'], 'font'], [['application/sla'], 'model']
  ]) for (const type of types) assert.equal(inscriptionPresentation(type), kind);
  // Microsoft trust lists are NOT STL geometry, despite the matching suffix.
  assert.equal(inscriptionPresentation('application/vnd.ms-pki.stl'), 'binary');
  for (const type of ['', 'image/tiff', 'application/wasm', 'application/x-executable', 'x-custom/file']) assert.equal(inscriptionPresentation(type), 'binary');
});
