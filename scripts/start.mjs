import {access,cp} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const server=resolve('.next/standalone/server.js');
await access(server);
await cp('public','.next/standalone/public',{recursive:true});
await cp('.next/static','.next/standalone/.next/static',{recursive:true});
process.env.HOSTNAME=process.env.FIRST_PRESS_HOST || '127.0.0.1';
await import(pathToFileURL(server).href);
