import {artists} from '../catalog.ts';
import type {BetaState,DailyState} from '../types.ts';
import {day} from './format.ts';
export const dailyArtists=[artists[2],artists[1],artists[0],artists[3],artists[4],artists[5],artists[6],artists[7]];
export const referenceOrder=[dailyArtists[1],dailyArtists[0],dailyArtists[4],dailyArtists[2],dailyArtists[5],dailyArtists[3],dailyArtists[7],dailyArtists[6]].map(a=>a.id);
export function getDaily(state: BetaState,today=day()): DailyState{return state.daily.day===today?state.daily:{day:today,votes:[],guess:dailyArtists.map(a=>a.id),revealed:false};}
export function vote(state: BetaState,id: string,today=day()): BetaState{const d=getDaily(state,today);if(d.votes.length>=4||!dailyArtists.slice(d.votes.length*2,d.votes.length*2+2).some(a=>a.id===id))return state;return {...state,daily:{...d,votes:[...d.votes,id]}};}
export function moveRank(state: BetaState,index: number,delta: -1|1,today=day()): BetaState{const d=getDaily(state,today),target=index+delta;if(d.votes.length<4||d.revealed||index<0||index>7||target<0||target>7)return state;const guess=[...(d.guess.length?d.guess:dailyArtists.map(a=>a.id))];[guess[index],guess[target]]=[guess[target],guess[index]];return {...state,daily:{...d,guess}};}
