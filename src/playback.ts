import type {Artist,Track} from './types.ts';

// Catalog availability is an editorial fact, separate from a listener's playback eligibility.
// Provider errors, missing previews and regional restrictions never change this selection.
export function getPlayback(track: Partial<Track> = {}) {
  if (/^[A-Za-z0-9]{22}$/.test(track.spotifyTrackId || '')) {
    const url = `https://open.spotify.com/track/${track.spotifyTrackId}`;
    return {
      provider: 'spotify',
      url,
      embedUrl: `https://open.spotify.com/embed/track/${track.spotifyTrackId}?theme=0`,
      label: track.spotifyVersionLabel || 'Spotify release',
      note: track.spotifyVersionNote || 'The Spotify recording. Preview availability and length are controlled by Spotify.',
    };
  }
  let soundcloudUrl;
  try {
    const url = new URL(track.soundcloud || '');
    if (url.protocol === 'https:' && ['soundcloud.com', 'www.soundcloud.com'].includes(url.hostname)) soundcloudUrl = url.href;
  } catch { /* Unmapped source. */ }
  if (track.spotifyStatus === 'not_found' && soundcloudUrl) {
    const different = track.soundcloudRecordingMatchStatus === 'different';
    return {
      provider: 'soundcloud',
      url: soundcloudUrl,
      label: track.soundcloudVersionLabel || (different ? 'SoundCloud fallback · alternate version' : 'SoundCloud fallback'),
      note: track.soundcloudVersionNote || 'No Spotify listing was found in our catalog review. This plays the SoundCloud upload; its version may differ from other releases.',
      different,
    };
  }
  return {provider: null, label: 'Player pending', note: 'We’re still checking the Spotify listing for this recording.'};
}

export function getDailyTrack(artist: Artist) {
  return artist.tracks.find(track => track.dailyPick)
    || artist.tracks.find(track => getPlayback(track).provider === 'spotify')
    || artist.tracks.find(track => getPlayback(track).provider === 'soundcloud')
    || artist.tracks[0];
}
