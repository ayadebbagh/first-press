export type Side = 'buy' | 'sell';
export interface Track {
  id: string;
  title: string;
  soundcloud?: string | null;
  soundcloudId?: number;
  soundcloudRecordingMatchStatus?: string;
  soundcloudVersionLabel?: string;
  soundcloudVersionNote?: string;
  dailyPick?: boolean;
  spotifyStatus?: 'available' | 'not_found' | 'unchecked';
  spotifyTrackId?: string;
  spotifyUrl?: string;
  spotifyDurationMs?: number;
  spotifyTitle?: string;
  spotifyArtists?: string[];
  spotifyCheckedAt?: string;
  spotifyPlayability?: string;
  spotifyVersionLabel?: string;
  spotifyVersionNote?: string;
}
export interface Artist {
  id: string;
  name: string;
  lane: string;
  image: string | null;
  listeners: number;
  change: number;
  note: string;
  source: string;
  tracks: Track[];
}
export interface Holding {units: number; cost: number}
interface QueuedOrder {id: string; artistId: string; queuedAt: string; snapshot: number}
export type Order = QueuedOrder & ({side: 'buy'; amount: number} | {side: 'sell'; units: number});
export interface Receipt {id: string; artistId: string; credits: number; units: number; entryPrice: number; listeners: number; snapshot: number; createdAt: string}
export interface DailyState {day: string; votes: string[]; guess: string[]; revealed: boolean}
export interface BetaState {
  version: 1;
  credits: number;
  snapshot: number;
  holdings: Record<string, Holding>;
  orders: Order[];
  receipts: Receipt[];
  watching: string[];
  requests: {name: string; link: string; createdAt: string}[];
  daily: DailyState;
  weeklyClaimed: string | null;
}
export type DialogState = {type: 'listen'; artistId: string; trackId: string} | {type: 'order'; artistId: string; side: Side} | {type: 'demo' | 'about' | 'request' | 'reset'} | {type: 'copy'; text: string};
