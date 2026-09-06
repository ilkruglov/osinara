/** Run inside the existing container with a private stdin payload; unchanged files are never rewritten. */
export const SKILL_SYNC_PROGRAM = String.raw`
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
async function main(){
  if(!process.env.HOME||!path.isAbsolute(process.env.HOME))throw new Error('AGENT_SKILL_SYNC_HOME_INVALID');
  let input='';for await(const chunk of process.stdin){input+=chunk;if(Buffer.byteLength(input)>64*1024*1024)throw new Error('AGENT_SKILL_SYNC_TOO_LARGE')}
  const request=JSON.parse(input),root=path.join(process.env.HOME,'.agents','skills');
  async function safeParents(target,create){
    const parts=path.resolve(target).split('/').filter(Boolean);let current='/';
    for(const part of parts){current=path.join(current,part);let info;
      try{info=await fs.lstat(current)}catch(error){if(error.code!=='ENOENT')throw error;if(!create)return false;await fs.mkdir(current);info=await fs.lstat(current)}
      if(info.isSymbolicLink()||!info.isDirectory())throw new Error('AGENT_SKILL_SYNC_PATH_UNSAFE');
    }return true;
  }
  const writes=[];let checked=0,removed=0;
  await safeParents(root,false);
  for(const pkg of request.packages){
    if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(pkg.name))throw new Error('AGENT_SKILL_SYNC_NAME_INVALID');
    for(const file of pkg.files){
      if(file.path.includes('\\')||file.path.includes('\0')||file.path.split('/').some(p=>!p||p==='.'||p==='..'))throw new Error('AGENT_SKILL_SYNC_PATH_INVALID');
      const target=path.join(root,pkg.name,file.path),bytes=Buffer.from(file.contentBase64,'base64');
      const parents=await safeParents(path.dirname(target),false);let existing;
      if(parents){try{const info=await fs.lstat(target);if(!info.isFile()||info.isSymbolicLink())throw new Error('AGENT_SKILL_SYNC_PATH_UNSAFE');existing=await fs.readFile(target,{flag:require('node:fs').constants.O_RDONLY|require('node:fs').constants.O_NOFOLLOW})}catch(error){if(error.code!=='ENOENT')throw error}}
      checked++;if(!existing||!existing.equals(bytes))writes.push({target,bytes});
    }
  }
  for(const name of request.removed){if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name))throw new Error('AGENT_SKILL_SYNC_NAME_INVALID')}
  for(const {target,bytes} of writes){
    await safeParents(path.dirname(target),true);
    const temporary=path.join(path.dirname(target),'.osinara-skill-'+crypto.randomUUID());
    try{await fs.writeFile(temporary,bytes,{flag:'wx',mode:0o644});await fs.rename(temporary,target)}finally{await fs.rm(temporary,{force:true})}
  }
  for(const name of request.removed){const target=path.join(root,name);await safeParents(root,false);await fs.rm(target,{recursive:true,force:true});removed++}
  process.stdout.write(JSON.stringify({checked,written:writes.length,removed}));
}
main().catch(error=>{console.error(error.message);process.exitCode=1});
`;
