// Explicit, resumable GitHub setup through normal gh authentication. No embedded credentials.
import {spawnSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {root,loadPlan,loadState,validate,render,bodyFor} from './planning.mjs';

const args=process.argv.slice(2).filter(a=>a!=='--');
const plan=validate(await loadPlan());
const apply=args.includes('--apply');
const metadataOnly=args.includes('--metadata-only');
const repoIndex=args.indexOf('--repo');
const repo=repoIndex>=0?args[repoIndex+1]:plan.repository;
if(repo!==plan.repository)throw Error('Change backlog.json deliberately before targeting another repository.');
console.log(`${apply?'APPLY':'DRY RUN'}: ${repo}; ${plan.labels.length} labels, ${plan.milestones.length} milestones, ${plan.issues.length} issues${metadataOnly?'':', one linked Project'}.`);
if(!apply){console.log('No network calls or changes. Use --apply --repo owner/name after authenticating gh. Existing issues and statuses are preserved.');process.exit(0);}
function gh(args,input){
  const result=spawnSync('gh',args,{cwd:root,encoding:'utf8',input,maxBuffer:10*1024*1024});
  if(result.error)throw result.error;
  if(result.status!==0)throw Error(`gh ${args.slice(0,3).join(' ')} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}
function api(endpoint,payload){return JSON.parse(gh(['api',endpoint,...(payload?['--method','POST','--input','-']:[])],payload?JSON.stringify(payload):undefined));}
const state=await loadState();
if(state.repository&&state.repository!==repo)throw Error('State belongs to another repository.');
state.repository=repo;state.issues??={};state.milestones??={};
const save=()=>writeFile(resolve(root,'docs/planning/github-state.json'),JSON.stringify(state,null,2)+'\n');
gh(['auth','status']);
const metadata=JSON.parse(gh(['repo','view',repo,'--json','nameWithOwner,url']));
if(metadata.nameWithOwner.toLowerCase()!==repo.toLowerCase())throw Error('Repository mismatch');
const existingLabels=JSON.parse(gh(['label','list','--repo',repo,'--limit','100','--json','name,description']));
for(const label of plan.labels){
  const existing=existingLabels.find(l=>l.name===label.name);
  if(!existing)gh(['label','create',label.name,'--repo',repo,'--color',label.color,'--description',label.description]);
  else if(!existing.description)gh(['label','edit',label.name,'--repo',repo,'--color',label.color,'--description',label.description]);
}
const milestones=JSON.parse(gh(['api',`repos/${repo}/milestones?state=all&per_page=100`,'--paginate','--slurp'])).flat();
for(const milestone of plan.milestones){
  const match=milestones.find(m=>m.title===milestone.title)||api(`repos/${repo}/milestones`,{title:milestone.title,description:milestone.description});
  state.milestones[milestone.key]={number:match.number,url:match.html_url};await save();
}
const existing=JSON.parse(gh(['api',`repos/${repo}/issues?state=all&per_page=100`,'--paginate','--slurp'])).flat().filter(i=>!i.pull_request);
const created=[];
for(const issue of plan.issues){
  const matches=existing.filter(i=>(i.body||'').includes(`<!-- first-press-plan:${issue.key} -->`));
  if(matches.length>1)throw Error(`Duplicate live planning key ${issue.key}; reconcile manually.`);
  const match=matches[0];
  if(match){
    state.issues[issue.key]={number:match.number,url:match.html_url};await save();
    const labels=[`area:${issue.area}`,`priority:${issue.priority}`,...(issue.kind==='epic'?['epic']:[]),...(issue.decision?['needs:decision']:[])];
    const edit=['issue','edit',String(match.number),'--repo',repo,'--add-label',labels.join(',')];
    if(!match.milestone)edit.push('--milestone',plan.milestones.find(m=>m.key===issue.milestone).title);
    gh(edit);continue;
  }
  if(state.issues[issue.key])throw Error(`Saved ${issue.key} not found remotely; reconcile rather than duplicate.`);
  const labels=[`area:${issue.area}`,`priority:${issue.priority}`,...(issue.kind==='epic'?['epic']:[]),...(issue.decision?['needs:decision']:[])];
  const filename=resolve(root,`docs/planning/issues/${issue.key}.md`);
  await writeFile(filename,bodyFor(issue,plan,state));
  const url=gh(['issue','create','--repo',repo,'--title',`[${issue.key}] ${issue.title}`,'--body-file',filename,'--milestone',plan.milestones.find(m=>m.key===issue.milestone).title,'--label',labels.join(',')]);
  const number=Number(url.split('/').pop());if(!Number.isSafeInteger(number))throw Error('Unexpected issue URL');
  state.issues[issue.key]={number,url};created.push(issue);await save();
}
// Only rewrite issues created in this run, after all dependency URLs are known.
for(const issue of created){
  const filename=resolve(root,`docs/planning/issues/${issue.key}.md`);await writeFile(filename,bodyFor(issue,plan,state));
  gh(['issue','edit',String(state.issues[issue.key].number),'--repo',repo,'--body-file',filename]);
}
await render(plan,state);
if(metadataOnly){state.last_metadata_sync=new Date().toISOString();await save();console.log('Repository metadata synced; existing issue bodies, states and milestone choices preserved.');process.exit(0);}
const owner=repo.split('/')[0];
const projects=JSON.parse(gh(['project','list','--owner',owner,'--limit','100','--format','json']));
let project=projects.projects.find(p=>p.title===plan.project_title);
if(!project)project=JSON.parse(gh(['project','create','--owner',owner,'--title',plan.project_title,'--format','json']));
state.project={number:project.number,id:project.id,url:project.url};await save();
gh(['project','link',String(project.number),'--owner',owner,'--repo',repo]);
const fields=JSON.parse(gh(['project','field-list',String(project.number),'--owner',owner,'--format','json']));
for(const [name,options] of [['Priority','P0,P1,P2'],['Effort','S,M,L'],['Workstream','foundation,backing,data,identity,daily,operations']]){
  if(!fields.fields.some(f=>f.name===name))gh(['project','field-create',String(project.number),'--owner',owner,'--name',name,'--data-type','SINGLE_SELECT','--single-select-options',options]);
}
for(const issue of plan.issues){
  const url=state.issues[issue.key].url;
  gh(['project','item-add',String(project.number),'--owner',owner,'--url',url,'--format','json']);
  for(const [name,value] of [['Priority',issue.priority],['Effort',issue.effort],['Workstream',issue.area]])gh(['project','item-edit',String(project.number),'--owner',owner,'--url',url,'--field',name,'--value',value]);
}
state.last_sync=new Date().toISOString();await save();
console.log(`Synced ${repo}. Project: ${project.url}. Configure/verify views, statuses, auto-add and closed-item workflows via F03.`);
