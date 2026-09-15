export function classifyOrigin(raw){
  if(typeof raw!=='string'||raw.length===0) return {classification:'missing'};
  try{
    const value=new URL(raw);
    if(value.username||value.password||value.search||value.hash||(value.pathname!==''&&value.pathname!=='/')) return {classification:'invalid'};
    const scheme=value.protocol.slice(0,-1).toLowerCase();
    const lowercaseHost=value.hostname.toLowerCase();
    if(!scheme||!lowercaseHost) return {classification:'invalid'};
    let effectivePort=null;
    if(value.port) effectivePort=Number(value.port);
    else if(scheme==='https'||scheme==='wss') effectivePort=443;
    else if(scheme==='http'||scheme==='ws') effectivePort=80;
    if(effectivePort!==null&&(!Number.isInteger(effectivePort)||effectivePort<1||effectivePort>65535)) return {classification:'invalid'};
    return {classification:'valid',scheme,lowercaseHost,effectivePort};
  }catch{return {classification:'invalid'};}
}
