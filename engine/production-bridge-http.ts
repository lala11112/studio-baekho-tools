import http from 'node:http';
/** Explicit total deadline; unlike fetch, no separate 5-minute response-header timer. */
export function postProductionBridge(port:number,token:string,body:unknown,timeoutMs:number):Promise<unknown>{
 return new Promise((resolve,reject)=>{
  const req=http.request({hostname:'127.0.0.1',port,path:'/tools',method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'}},res=>{
   const chunks:Buffer[]=[];let bytes=0;
   res.on('data',chunk=>{bytes+=chunk.length;if(bytes>8*1024*1024)req.destroy(Error('Production bridge response too large'));else chunks.push(chunk);});
   res.on('error',fail);res.on('end',()=>{clearTimeout(timer);if(res.statusCode!==200)return reject(Error('Production browser bridge rejected the request'));try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{reject(Error('Invalid production bridge response'));}});
  });
  const timer=setTimeout(()=>req.destroy(Error('Production bridge deadline exceeded')),timeoutMs);
  function fail(error:Error){clearTimeout(timer);reject(error);}
  req.on('error',fail);req.end(JSON.stringify(body));
 });
}
