import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

export const root=fileURLToPath(new URL('../',import.meta.url));
export async function loadPlan(){return JSON.parse(await readFile(resolve(root,'docs/planning/backlog.json'),'utf8'));}
export async function loadState(){
  try{return JSON.parse(await readFile(resolve(root,'docs/planning/github-state.json'),'utf8'));}
  catch(error){if(error.code!=='ENOENT')throw error;return {repository:null,issues:{},milestones:{}};}
}
export function validate(plan){
  const keys=new Set(),milestones=new Set(plan.milestones.map(m=>m.key));
  if(!/^[\w.-]+\/[\w.-]+$/.test(plan.repository))throw Error('Invalid repository');
  for(const issue of plan.issues){
    if(keys.has(issue.key))throw Error(`Duplicate key ${issue.key}`);
    keys.add(issue.key);
    if(!issue.title||!issue.summary||issue.acceptance.length<2)throw Error(`Incomplete issue ${issue.key}`);
    if(!milestones.has(issue.milestone)||!['P0','P1','P2'].includes(issue.priority)||!['S','M','L'].includes(issue.effort))throw Error(`Invalid fields ${issue.key}`);
    if(!plan.labels.some(l=>l.name===`area:${issue.area}`))throw Error(`Unknown area ${issue.key}`);
  }
  const visiting=new Set(),visited=new Set(),byKey=new Map(plan.issues.map(i=>[i.key,i]));
  function visit(key){
    if(!keys.has(key))throw Error(`Unknown dependency ${key}`);
    if(visiting.has(key))throw Error(`Dependency cycle at ${key}`);
    if(visited.has(key))return;
    visiting.add(key);byKey.get(key).dependencies.forEach(visit);visiting.delete(key);visited.add(key);
  }
  keys.forEach(visit);
  return plan;
}
export function bodyFor(issue,plan,state={issues:{}}){
  const reference=key=>state.issues?.[key]?.url?`[${key}](${state.issues[key].url})`:`[${key}](./${key}.md)`;
  const lines=[`<!-- first-press-plan:${issue.key} -->`,'',issue.summary,'',`Milestone: **${issue.milestone}** · Priority: **${issue.priority}** · Effort: **${issue.effort}** · Workstream: **${issue.area}**`,'','## Acceptance criteria','',...issue.acceptance.map(a=>`- [ ] ${a}`),'','## Dependencies','',issue.dependencies.length?issue.dependencies.map(reference).join(', '):'No implementation dependency. Resolve the decision or spike on its own merits.'];
  if(issue.kind==='epic'){
    lines.push('','## Child issues','',...plan.issues.filter(i=>i.kind==='task'&&i.area===issue.area).map(i=>`- [ ] ${reference(i.key)} — ${i.title}`));
  }else{
    const epic=plan.issues.find(i=>i.kind==='epic'&&i.area===issue.area);
    lines.push('','## Epic','',reference(epic.key));
  }
  lines.push('','## Verification','', 'Link the implementing PR and evidence for the acceptance criteria. Report checks that could not run. Source/demo behavior alone does not prove a connected-beta release gate.');
  return lines.join('\n')+'\n';
}
export async function render(plan,state){
  const dir=resolve(root,'docs/planning/issues');await mkdir(dir,{recursive:true});
  for(const issue of plan.issues)await writeFile(resolve(dir,`${issue.key}.md`),bodyFor(issue,plan,state));
  const lines=['# Development backlog','',`Generated from [backlog.json](backlog.json). ${plan.issues.filter(i=>i.kind==='epic').length} epics and ${plan.issues.filter(i=>i.kind==='task').length} actionable tasks. Relative effort is not a delivery-date estimate.`, '', 'Read [the roadmap](../ROADMAP.md) for sequencing and release gates. Live publication status is in [PUBLICATION.md](PUBLICATION.md).'];
  for(const milestone of plan.milestones){
    lines.push('',`## ${milestone.title}`,'',milestone.description,'','| Key | Issue | Priority | Effort | Depends on |','| --- | --- | --- | --- | --- |');
    for(const i of plan.issues.filter(i=>i.kind==='task'&&i.milestone===milestone.key))lines.push(`| ${i.key} | [${i.title}](issues/${i.key}.md)${state.issues?.[i.key]?.url?` · [GitHub](${state.issues[i.key].url})`:''} | ${i.priority} | ${i.effort} | ${i.dependencies.join(', ')||'—'} |`);
  }
  lines.push('','## Epics','',...plan.issues.filter(i=>i.kind==='epic').map(i=>`- [${i.title}](issues/${i.key}.md)${state.issues?.[i.key]?.url?` · [GitHub](${state.issues[i.key].url})`:''}`));
  await writeFile(resolve(root,'docs/planning/BACKLOG.md'),lines.join('\n')+'\n');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const plan=validate(await loadPlan());
  if(process.argv.includes('--render'))await render(plan,await loadState());
  console.log(`Validated ${plan.issues.length} issues, ${plan.milestones.length} milestones; no missing dependencies or cycles.`);
}
