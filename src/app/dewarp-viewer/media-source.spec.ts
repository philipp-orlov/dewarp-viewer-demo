import { detectSourceKind } from './media-source';

describe('detectSourceKind', () => {
  it('detects HLS, even with query strings', () => {
    expect(detectSourceKind('https://x/live/stream.m3u8')).toBe('hls');
    expect(detectSourceKind('https://x/live/stream.M3U8?token=a.b#t')).toBe('hls');
  });
  it('detects images', () => {
    for (const u of ['a.jpg', 'a.JPEG', 'a.png', 'a.webp', 'a.avif', '/p/a.png?v=2']) {
      expect(detectSourceKind(u)).toBe('image');
    }
  });
  it('defaults to video', () => {
    expect(detectSourceKind('a.mp4')).toBe('video');
    expect(detectSourceKind('a.webm')).toBe('video');
    expect(detectSourceKind('https://x/stream')).toBe('video');
  });
  it('an explicit hint wins', () => {
    expect(detectSourceKind('https://x/stream', 'hls')).toBe('hls');
    expect(detectSourceKind('a.m3u8', 'video')).toBe('video');
  });
});
