import test from 'node:test';
import assert from 'node:assert/strict';
import {artists} from '../src/catalog.ts';
import {getPlayback,getDailyTrack} from '../src/playback.ts';

const spotifyTrackId='75Wgg4LerPD3mVO5hEyUN9';
const soundcloud='https://soundcloud.com/janeremover/dreamflasher';

test('Spotify wins when both providers are mapped, regardless of an old preference',()=>{
 const source=getPlayback({spotifyTrackId,soundcloud,preferredProvider:'soundcloud'});
 assert.equal(source.provider,'spotify');
 assert.equal(source.embedUrl,`https://open.spotify.com/embed/track/${spotifyTrackId}?theme=0`);
});
test('regional restrictions and missing previews do not switch the recording',()=>{
 for(const spotifyPlayability of ['COUNTRY_RESTRICTED','NOT_PLAYABLE','ERROR']){
  assert.equal(getPlayback({spotifyTrackId,soundcloud,spotifyPlayability,preview_url:null}).provider,'spotify');
 }
});
test('SoundCloud is selected only after Spotify absence is recorded',()=>{
 for(const spotifyStatus of [undefined,'unchecked','available','error'])assert.equal(getPlayback({soundcloud,spotifyStatus}).provider,null);
 const source=getPlayback({soundcloud,spotifyStatus:'not_found',soundcloudRecordingMatchStatus:'different'});
 assert.equal(source.provider,'soundcloud');assert.equal(source.different,true);
 assert.match(source.label,/alternate version/);
 assert.equal(getPlayback({spotifyStatus:'not_found'}).provider,null);
});
test('invalid source URLs and Spotify identifiers never become embed destinations',()=>{
 for(const soundcloud of ['javascript:alert(1)','https://soundcloud.com.attacker.test/song','http://soundcloud.com/artist/song'])assert.equal(getPlayback({soundcloud,spotifyStatus:'not_found'}).provider,null);
 for(const spotifyTrackId of ['bad','x?theme=0','https://open.spotify.com/track/test'])assert.equal(getPlayback({spotifyTrackId}).provider,null);
});
test('Dreamflasher preserves the exact original release and daily picks stay stable',()=>{
 const jane=artists.find(a=>a.name==='Jane Remover'),dream=jane.tracks.find(t=>t.title==='Dreamflasher');
 assert.equal(dream.spotifyTrackId,spotifyTrackId);assert.equal(dream.spotifyDurationMs,224486);
 assert.equal(getDailyTrack(jane).id,dream.id);
 assert.equal(getDailyTrack(artists[3]).title,'SPEED DEMON');
 assert.equal(getPlayback(dream).provider,'spotify');
 assert.match(getPlayback(dream).note,/SoundCloud upload differs/);
});
test('every enabled Spotify mapping has checked source metadata; pending tracks stay pending',()=>{
 for(const a of artists)for(const t of a.tracks){
  const source=getPlayback(t);
  if(t.spotifyStatus==='available'){
   assert.equal(source.provider,'spotify',t.id);assert.ok(t.spotifyCheckedAt,t.id);
   assert.ok(t.spotifyDurationMs>0,t.id);assert.ok(t.spotifyArtists.length>0,t.id);
   assert.equal(source.url,t.spotifyUrl,t.id);
  }else assert.equal(source.provider,null,t.id);
 }
});
