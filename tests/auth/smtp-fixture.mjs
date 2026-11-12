// Isolated, loopback-only SMTP/STARTTLS capture. Never imported by the app.
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import {readFileSync} from 'node:fs';
if(!process.env.TEST_AUTH_DATABASE_URL||!new URL(process.env.TEST_AUTH_DATABASE_URL).pathname.endsWith('_auth_test'))throw Error('SMTP fixture requires isolated auth test database.');
const secureContext=tls.createSecureContext({key:readFileSync(process.env.TEST_SMTP_KEY),cert:readFileSync(process.env.TEST_SMTP_CERT)});
const messages=[];
function serve(socket,secure=false){
  socket.setEncoding('utf8');let buffer='',data=false,message='';
  socket.on('error',()=>{});
  socket.on('data',chunk=>{
    buffer+=chunk;
    while(buffer.includes('\r\n')){
      const at=buffer.indexOf('\r\n'),line=buffer.slice(0,at);buffer=buffer.slice(at+2);
      if(data){if(line==='.'){
        data=false;messages.push(message.replace(/=\r?\n/g,'').replace(/=([a-f0-9]{2})/gi,(_,h)=>String.fromCharCode(parseInt(h,16))));message='';socket.write('250 captured\r\n');
      }else message+=(line.startsWith('..')?line.slice(1):line)+'\r\n';continue;}
      if(/^EHLO|^HELO/i.test(line))socket.write(secure?'250-localhost\r\n250 SIZE 100000\r\n':'250-localhost\r\n250 STARTTLS\r\n');
      else if(/^STARTTLS/i.test(line)){
        socket.write('220 ready for TLS\r\n');socket.removeAllListeners('data');
        serve(new tls.TLSSocket(socket,{isServer:true,secureContext}),true);return;
      }else if(/^DATA/i.test(line)){data=true;socket.write('354 send data\r\n');}
      else if(/^QUIT/i.test(line)){socket.end('221 bye\r\n');}
      else socket.write(secure?'250 ok\r\n':'530 STARTTLS required\r\n');
    }
  });
}
const smtp=net.createServer(socket=>{socket.write('220 localhost SMTP fixture\r\n');serve(socket);});
smtp.listen(2587,'127.0.0.1');
const control=http.createServer((request,response)=>{
  response.setHeader('Content-Type','application/json');
  response.end(JSON.stringify(request.url==='/health'?{status:'ok'}:messages));
});
control.listen(8026,'127.0.0.1');
function stop(){smtp.close();control.close();process.exit(0);}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
