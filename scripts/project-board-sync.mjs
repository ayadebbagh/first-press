// F03 #9: synchronize only items in the already verified Project; never edit issues.
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {root,loadPlan,loadState,validate} from './planning.mjs';

export function syncProjectBoard(plan,state,gh){
  const project=state.project;
  if(!project?.id||!project.fields)throw Error('Configure and verify the Project first; see docs/planning/PROJECT.md.');
  const gql=(query,variables={})=>{
    const result=JSON.parse(gh(['api','graphql','--input','-'],JSON.stringify({query,variables})));
    if(result.errors)throw Error(JSON.stringify(result.errors));
    return result.data;
  };
  const remote=gql('query($id:ID!){node(id:$id){...on ProjectV2{id title number public owner{...on User{login}} repositories(first:100){nodes{nameWithOwner}} fields(first:100){nodes{...on ProjectV2SingleSelectField{id name options{id name}}}}}}}',{id:project.id}).node;
  if(!remote||remote.title!==plan.project_title||remote.number!==project.number||remote.public||remote.owner.login!==plan.repository.split('/')[0]||!remote.repositories.nodes.some(r=>r.nameWithOwner===plan.repository))throw Error('Project identity, privacy or repository link changed; reconcile manually.');
  const fields=Object.fromEntries(remote.fields.nodes.filter(f=>f.name).map(f=>[f.name,f]));
  for(const name of ['Status','Priority','Effort','Workstream']){
    if(fields[name]?.id!==project.fields[name].id)throw Error(`Project field changed: ${name}`);
  }
  const issues=JSON.parse(gh(['api',`repos/${plan.repository}/issues?state=all&per_page=100`,'--paginate','--slurp'])).flat().filter(i=>!i.pull_request);
  const tasks=new Map(plan.issues.map(t=>[state.issues[t.key]?.number,t]));
  const byKey=new Map(plan.issues.map(t=>[t.key,issues.find(i=>i.number===state.issues[t.key]?.number)]));
  if([...byKey.values()].some(i=>!i)||issues.some(i=>!tasks.has(i.number)))throw Error('Issue mapping incomplete; update backlog.json and github-state.json before applying.');
  const items=[];let cursor=null;
  do{
    const page=gql(`query($id:ID!,$cursor:String){
      node(id:$id){...on ProjectV2{
        items(first:100,after:$cursor){
          pageInfo{hasNextPage endCursor}
          nodes{
            id content{...on Issue{number repository{nameWithOwner}}}
            fieldValues(first:100){nodes{
              ...on ProjectV2ItemFieldSingleSelectValue{name field{...on ProjectV2FieldCommon{name}}}
            }}
          }
        }
      }}
    }`,{id:project.id,cursor}).node.items;
    items.push(...page.nodes);cursor=page.pageInfo.hasNextPage?page.pageInfo.endCursor:null;
  }while(cursor);
  const blocked=new Set(project.decision_blocked_keys);
  const changes=[];
  for(const issue of issues){
    const task=tasks.get(issue.number);
    const matches=items.filter(i=>i.content?.number===issue.number&&i.content.repository?.nameWithOwner===plan.repository);
    if(matches.length>1)throw Error(`Duplicate project item for #${issue.number}`);
    const item=matches[0];
    const current=Object.fromEntries((item?.fieldValues.nodes||[]).filter(v=>v.field).map(v=>[v.field.name,v.name]));
    const eligible=task.kind!=='epic'&&!blocked.has(task.key)&&task.dependencies.every(key=>byKey.get(key)?.state==='closed');
    // Reopened issues must leave Done; stale hints must never auto-close open issues.
    const fallback=blocked.has(task.key)?'Blocked':eligible?'Ready':'Backlog';
    const hint=project.initial_statuses[task.key];
    const initial=hint&&hint!=='Done'&&(hint!=='Ready'||eligible)?hint:fallback;
    const openStatus=current.Status&&current.Status!=='Done'?current.Status:initial;
    const status=issue.state==='closed'?'Done':openStatus==='Ready'&&!eligible?fallback:openStatus;
    const values={Status:status,Priority:task.priority,Effort:task.effort,Workstream:task.area};
    for(const [name,value] of Object.entries(values)){
      if(!fields[name].options.some(o=>o.name===value))throw Error(`Missing option ${name}: ${value}`);
    }
    if(!item||Object.entries(values).some(([name,value])=>current[name]!==value))changes.push({issue,item,values,current});
  }
  const apply=process.argv.includes('--apply');
  console.log(`${apply?'APPLY':'READ ONLY'} ${project.url}: ${issues.length} repository issues; ${changes.length} items need changes.`);
  for(const change of changes){
    console.log(`#${change.issue.number}: ${JSON.stringify(change.values)}`);
    if(!apply)continue;
    const itemId=change.item?.id||gql('mutation($input:AddProjectV2ItemByIdInput!){addProjectV2ItemById(input:$input){item{id}}}',{input:{projectId:project.id,contentId:change.issue.node_id}}).addProjectV2ItemById.item.id;
    for(const [name,value] of Object.entries(change.values)){
      if(change.current[name]===value)continue;
      gql('mutation($input:UpdateProjectV2ItemFieldValueInput!){updateProjectV2ItemFieldValue(input:$input){projectV2Item{id}}}',{input:{projectId:project.id,itemId,fieldId:fields[name].id,value:{singleSelectOptionId:fields[name].options.find(o=>o.name===value).id}}});
    }
  }
  return changes.length;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const plan=validate(await loadPlan()),state=await loadState();
  if(state.repository!==plan.repository)throw Error('Repository mapping mismatch.');
  if(!process.argv.includes('--apply')&&!process.argv.includes('--check')){
    console.log(`DRY RUN: ${plan.repository}; no network calls. Use --check for read-only comparison or --apply to sync Project items.`);
  }else{
    const gh=(args,input)=>{
      const result=spawnSync('gh',args,{cwd:root,encoding:'utf8',input,maxBuffer:20*1024*1024});
      if(result.error)throw result.error;
      if(result.status!==0)throw Error(result.stderr.trim());
      return result.stdout;
    };
    syncProjectBoard(plan,state,gh);
  }
}
