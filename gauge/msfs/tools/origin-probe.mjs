import {createServer} from 'node:http';
import {classifyOrigin} from './origin-probe-lib.mjs';

const port=Number(process.env.MSFSLOGGER_ORIGIN_PROBE_PORT||39092);
if(!Number.isInteger(port)||port<1024||port>65535||port===3000||port===39091) throw new Error('Choose a non-live probe port other than 3000 or 39091');
const observations=new Map();
const server=createServer((_req,res)=>{res.writeHead(404,{'content-type':'text/plain'});res.end('probe accepts WebSocket upgrades only');});
server.on('upgrade',(req,socket)=>{
  const observation=classifyOrigin(req.headers.origin);
  observations.set(JSON.stringify(observation),observation);
  console.log(JSON.stringify(observation));
  socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
});
server.listen(port,'127.0.0.1',()=>console.log(JSON.stringify({event:'probe-ready',bind:`127.0.0.1:${port}`,productionAllowlistChanged:false,instructions:'Point a temporary simulator-only gauge build at this port; perform three cold starts per supported simulator; preserve each normalized observation plus negative local-page controls.'})));
function stop(){server.close(()=>{console.log(JSON.stringify({event:'probe-complete',observationCount:observations.size}));process.exit(0);});}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
